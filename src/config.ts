import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { mkdir, rename } from "node:fs/promises";

/**
 * Режимы безопасности:
 *  - paranoic: только внутри корня активного воркспейса
 *  - auto: корень + явно разрешённые папки (allowedPaths)
 *  - bypass: без ограничений (полностью автономный агент)
 */
export type SecurityMode = "paranoic" | "auto" | "bypass";

export interface WorkspaceProfile {
    name: string;
    root: string;
    allowedPaths: string[];
}

export interface AuditSettings {
    enabled: boolean;
    maxEntries: number;
    /** Потолок размера audit.jsonl: превышен — лог ротируется, не дожидаясь счётчика записей. */
    maxFileBytes: number;
}

export interface SnapshotSettings {
    enabled: boolean;
    keepPerFile: number;
    /** Файлы больше этого размера не снапшотятся (иначе один бинарь/лог съедает диск). */
    maxFileBytes: number;
    /** Общий потолок папки снапшотов: старые версии сносятся, пока не влезем. */
    maxTotalBytes: number;
    /** Снапшоты старше N дней удаляются. */
    maxAgeDays: number;
    /** Осиротевшие снапшоты (исходный файл удалён) живут не дольше N часов. */
    orphanTtlHours: number;
}

export interface LimitSettings {
    execTimeoutMs: number;
    maxOutputChars: number;
    maxReadChars: number;
    maxSessions: number;
    sessionBufferChars: number;
    /** Сколько одновременных fs.watch разрешено (хендлы ОС не бесплатны). */
    maxWatchers: number;
    /** Watcher без fs_watch_poll дольше этого времени останавливается сам. */
    watcherIdleMs: number;
    /** Простаивающая терминал-сессия закрывается сама (running-команды не трогаем). */
    sessionIdleMs: number;
    /** SSE-сессия (подключение MCP-клиента) без единого сообщения дольше этого времени закрывается и удаляется. */
    sseSessionIdleMs: number;
    /** Период фонового обслуживания: GC сессий, watcher'ов, снапшотов, ротация лога. */
    gcIntervalMs: number;
}

export interface NotCodeConfig {
    token: string;
    mode: SecurityMode;
    /** Легаси-список разрешённых папок (учитывается вместе с профильным). */
    allowedPaths: string[];
    port: number;
    host: string;
    activeProfile: string;
    profiles: WorkspaceProfile[];
    audit: AuditSettings;
    snapshots: SnapshotSettings;
    limits: LimitSettings;
}

export const CONFIG_DIR = join(homedir(), ".notcode");
export const CONFIG_FILE = join(CONFIG_DIR, "config.json");
export const AUDIT_FILE = join(CONFIG_DIR, "audit.jsonl");
export const SNAPSHOT_DIR = join(CONFIG_DIR, "snapshots");
export const SNAPSHOT_INDEX = join(SNAPSHOT_DIR, "index.jsonl");

export const DEFAULT_PROFILE = "default";
export const DEFAULT_ROOT = resolve(process.env.WORKSPACE_ROOT || process.cwd());

/** @deprecated Используй getWorkspaceRoot(config) — корень зависит от активного профиля. */
export const WORKSPACE_ROOT = DEFAULT_ROOT;

const CACHE_TTL_MS = 1_000;
let cache: { config: NotCodeConfig; at: number } | null = null;

function defaults(): NotCodeConfig {
    return {
        token: crypto.randomUUID(),
        mode: "auto",
        allowedPaths: [],
        port: 3000,
        host: "0.0.0.0",
        activeProfile: DEFAULT_PROFILE,
        profiles: [{ name: DEFAULT_PROFILE, root: DEFAULT_ROOT, allowedPaths: [] }],
        audit: { enabled: true, maxEntries: 5000, maxFileBytes: 5 * 1024 * 1024 },
        snapshots: {
            enabled: true,
            keepPerFile: 10,
            maxFileBytes: 10 * 1024 * 1024,
            maxTotalBytes: 512 * 1024 * 1024,
            maxAgeDays: 30,
            orphanTtlHours: 24
        },
        limits: {
            execTimeoutMs: 120_000,
            maxOutputChars: 60_000,
            maxReadChars: 200_000,
            maxSessions: 12,
            sessionBufferChars: 400_000,
            maxWatchers: 8,
            watcherIdleMs: 30 * 60_000,
            sessionIdleMs: 60 * 60_000,
            sseSessionIdleMs: 24 * 60 * 60_000,
            gcIntervalMs: 5 * 60_000
        }
    };
}

function asStringArray(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function num(value: unknown, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
    return typeof value === "boolean" ? value : fallback;
}

/** Приводит конфиг любой (в т.ч. старой) формы к актуальной схеме. */
function normalize(raw: Record<string, unknown>): NotCodeConfig {
    const base = defaults();
    const legacyAllowed = asStringArray(raw.allowedPaths);

    const rawProfiles = Array.isArray(raw.profiles) ? (raw.profiles as Record<string, unknown>[]) : [];
    const profiles: WorkspaceProfile[] = rawProfiles
        .filter(profile => typeof profile?.name === "string" && typeof profile?.root === "string")
        .map(profile => ({
            name: String(profile.name),
            root: resolve(String(profile.root)),
            allowedPaths: asStringArray(profile.allowedPaths).map(item => resolve(item))
        }));

    if (!profiles.some(profile => profile.name === DEFAULT_PROFILE)) {
        profiles.unshift({ name: DEFAULT_PROFILE, root: DEFAULT_ROOT, allowedPaths: [...legacyAllowed] });
    }

    const audit = (raw.audit ?? {}) as Record<string, unknown>;
    const snapshots = (raw.snapshots ?? {}) as Record<string, unknown>;
    const limits = (raw.limits ?? {}) as Record<string, unknown>;
    const mode = raw.mode as SecurityMode;
    const activeProfile = typeof raw.activeProfile === "string" ? raw.activeProfile : base.activeProfile;

    return {
        token: typeof raw.token === "string" && raw.token.length > 0 ? raw.token : base.token,
        mode: mode === "paranoic" || mode === "auto" || mode === "bypass" ? mode : base.mode,
        allowedPaths: legacyAllowed.map(item => resolve(item)),
        port: num(raw.port, base.port),
        host: typeof raw.host === "string" && raw.host.length > 0 ? raw.host : base.host,
        activeProfile: profiles.some(profile => profile.name === activeProfile) ? activeProfile : DEFAULT_PROFILE,
        profiles,
        audit: {
            enabled: bool(audit.enabled, base.audit.enabled),
            maxEntries: num(audit.maxEntries, base.audit.maxEntries),
            maxFileBytes: num(audit.maxFileBytes, base.audit.maxFileBytes)
        },
        snapshots: {
            enabled: bool(snapshots.enabled, base.snapshots.enabled),
            keepPerFile: num(snapshots.keepPerFile, base.snapshots.keepPerFile),
            maxFileBytes: num(snapshots.maxFileBytes, base.snapshots.maxFileBytes),
            maxTotalBytes: num(snapshots.maxTotalBytes, base.snapshots.maxTotalBytes),
            maxAgeDays: num(snapshots.maxAgeDays, base.snapshots.maxAgeDays),
            orphanTtlHours: num(snapshots.orphanTtlHours, base.snapshots.orphanTtlHours)
        },
        limits: {
            execTimeoutMs: num(limits.execTimeoutMs, base.limits.execTimeoutMs),
            maxOutputChars: num(limits.maxOutputChars, base.limits.maxOutputChars),
            maxReadChars: num(limits.maxReadChars, base.limits.maxReadChars),
            maxSessions: num(limits.maxSessions, base.limits.maxSessions),
            sessionBufferChars: num(limits.sessionBufferChars, base.limits.sessionBufferChars),
            maxWatchers: num(limits.maxWatchers, base.limits.maxWatchers),
            watcherIdleMs: num(limits.watcherIdleMs, base.limits.watcherIdleMs),
            sessionIdleMs: num(limits.sessionIdleMs, base.limits.sessionIdleMs),
            sseSessionIdleMs: num(limits.sseSessionIdleMs, base.limits.sseSessionIdleMs),
            gcIntervalMs: num(limits.gcIntervalMs, base.limits.gcIntervalMs)
        }
    };
}

export async function ensureConfigDirs(): Promise<void> {
    await mkdir(CONFIG_DIR, { recursive: true });
    await mkdir(SNAPSHOT_DIR, { recursive: true });
}

/** Загружает конфиг с коротким кэшем — sandbox дергает его на каждый вызов тула. */
export async function loadConfig(options: { force?: boolean } = {}): Promise<NotCodeConfig> {
    if (!options.force && cache && Date.now() - cache.at < CACHE_TTL_MS) {
        return cache.config;
    }

    const file = Bun.file(CONFIG_FILE);
    if (await file.exists()) {
        try {
            const config = normalize((await file.json()) as Record<string, unknown>);
            cache = { config, at: Date.now() };
            return config;
        } catch {
            // битый конфиг — пересоздаём ниже
        }
    }

    const fresh = defaults();
    await saveConfig(fresh);
    return fresh;
}

export async function saveConfig(config: NotCodeConfig): Promise<void> {
    await ensureConfigDirs();
    // Пишем во временный файл и переименовываем — rename атомарен на той же ФС, так что
    // параллельный loadConfig() никогда не увидит наполовину записанный JSON, и обрыв
    // процесса посреди записи не бьёт config.json.
    const tmpFile = `${CONFIG_FILE}.${process.pid}.${Date.now()}.tmp`;
    await Bun.write(tmpFile, JSON.stringify(config, null, 2));
    await rename(tmpFile, CONFIG_FILE);
    cache = { config, at: Date.now() };
}

/** Сериализует все read-modify-write конфига в одну очередь. Без этого два параллельных
 *  updateConfig() (например, workspace_allow и notcode_set_mode одновременно) читают один
 *  и тот же конфиг до того, как первый успеет сохраниться, и один из результатов теряется. */
let configQueue: Promise<unknown> = Promise.resolve();

/** Атомарно (в рамках процесса) читает, мутирует и сохраняет конфиг. */
export function updateConfig(mutator: (config: NotCodeConfig) => void | Promise<void>): Promise<NotCodeConfig> {
    const run = configQueue.then(async () => {
        const config = await loadConfig({ force: true });
        await mutator(config);
        await saveConfig(config);
        return config;
    });
    configQueue = run.catch(() => undefined);
    return run;
}

export function invalidateConfigCache(): void {
    cache = null;
}

export function getProfile(config: NotCodeConfig, name?: string): WorkspaceProfile {
    const target = name ?? config.activeProfile;
    return (
        config.profiles.find(profile => profile.name === target) ??
        config.profiles[0] ?? { name: DEFAULT_PROFILE, root: DEFAULT_ROOT, allowedPaths: [] }
    );
}

export function getWorkspaceRoot(config: NotCodeConfig): string {
    return getProfile(config).root || DEFAULT_ROOT;
}

export async function currentWorkspaceRoot(): Promise<string> {
    return getWorkspaceRoot(await loadConfig());
}

export function allowedPathsFor(config: NotCodeConfig): string[] {
    return [...getProfile(config).allowedPaths, ...config.allowedPaths];
}
