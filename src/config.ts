import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { mkdir, rename } from "node:fs/promises";
import { writeJsonAtomic } from "@/utils/fs-atomic";
import { Mutex } from "@/utils/lock";
import { createLogger, errorMessage } from "@/utils/logger";

const log = createLogger("config");

/**
 * Режимы безопасности:
 *  - paranoic: только внутри корня активного воркспейса
 *  - auto: корень + явно разрешённые папки (allowedPaths)
 *  - bypass: без ограничений (полностью автономный агент)
 *
 * ВАЖНО: режим ограничивает только файловые пути. Команды в терминале выполняются
 * с правами пользователя в любом режиме — сандбоксится лишь рабочая директория.
 */
export type SecurityMode = "paranoic" | "auto" | "bypass";

export const SECURITY_MODES: readonly SecurityMode[] = ["paranoic", "auto", "bypass"] as const;

export function isSecurityMode(value: unknown): value is SecurityMode {
    return typeof value === "string" && (SECURITY_MODES as readonly string[]).includes(value);
}

export interface WorkspaceProfile {
    name: string;
    root: string;
    allowedPaths: string[];
}

export interface AuditSettings {
    enabled: boolean;
    maxEntries: number;
}

export interface SnapshotSettings {
    enabled: boolean;
    keepPerFile: number;
}

export interface LimitSettings {
    execTimeoutMs: number;
    maxOutputChars: number;
    maxReadChars: number;
    maxSessions: number;
    sessionBufferChars: number;
}

/**
 * Разрешения на самомодификацию. По умолчанию выключены: иначе одна prompt injection
 * в чужом README превращает paranoic в bypass без ведома человека.
 */
export interface SecuritySettings {
    /** Разрешить тулу notcode_set_mode менять режим на лету. */
    allowRuntimeModeChange: boolean;
    /** Разрешить тулам workspace_add / workspace_allow расширять доступ на лету. */
    allowRuntimeWorkspaceChange: boolean;
}

/** Настройки SSE-транспорта — именно они отвечают за то, чтобы сессия не умирала в простое. */
export interface SseSettings {
    /** Период keepalive-комментариев в поток. 0 — выключить (не рекомендуется). */
    heartbeatMs: number;
    /** idleTimeout сервера Bun в секундах (максимум 255). */
    idleTimeoutSec: number;
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
    security: SecuritySettings;
    sse: SseSettings;
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
/** Неизвестные ключи из файла — сохраняем их, чтобы ручные правки не исчезали при первой же записи. */
let passthrough: Record<string, unknown> = {};

/** Все записи конфига сериализуются: без этого два параллельных updateConfig теряют правки. */
const configMutex = new Mutex();

export class ConfigError extends Error {
    override readonly name = "ConfigError";
}

const KNOWN_KEYS = new Set([
    "token",
    "mode",
    "allowedPaths",
    "port",
    "host",
    "activeProfile",
    "profiles",
    "audit",
    "snapshots",
    "limits",
    "security",
    "sse"
]);

function defaults(): NotCodeConfig {
    return {
        token: crypto.randomUUID(),
        mode: "auto",
        allowedPaths: [],
        port: 3000,
        // Слушать всю сеть опасно: у сервера полный доступ к ФС и shell.
        host: "127.0.0.1",
        activeProfile: DEFAULT_PROFILE,
        profiles: [{ name: DEFAULT_PROFILE, root: DEFAULT_ROOT, allowedPaths: [] }],
        audit: { enabled: true, maxEntries: 5000 },
        snapshots: { enabled: true, keepPerFile: 10 },
        limits: {
            execTimeoutMs: 120_000,
            maxOutputChars: 60_000,
            maxReadChars: 200_000,
            maxSessions: 12,
            sessionBufferChars: 400_000
        },
        security: {
            allowRuntimeModeChange: false,
            allowRuntimeWorkspaceChange: false
        },
        sse: {
            heartbeatMs: 15_000,
            idleTimeoutSec: 255
        }
    };
}

function asStringArray(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** Положительное число (для лимитов, где 0 не имеет смысла). */
function positive(value: unknown, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Неотрицательное число: 0 — осмысленное значение (выключить heartbeat, случайный порт). */
function nonNegative(value: unknown, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function bool(value: unknown, fallback: boolean): boolean {
    return typeof value === "boolean" ? value : fallback;
}

function record(value: unknown): Record<string, unknown> {
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
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

    const audit = record(raw.audit);
    const snapshots = record(raw.snapshots);
    const limits = record(raw.limits);
    const security = record(raw.security);
    const sse = record(raw.sse);
    const activeProfile = typeof raw.activeProfile === "string" ? raw.activeProfile : base.activeProfile;

    return {
        token: typeof raw.token === "string" && raw.token.length > 0 ? raw.token : base.token,
        mode: isSecurityMode(raw.mode) ? raw.mode : base.mode,
        allowedPaths: legacyAllowed.map(item => resolve(item)),
        port: clamp(Math.trunc(nonNegative(raw.port, base.port)), 0, 65_535),
        host: typeof raw.host === "string" && raw.host.length > 0 ? raw.host : base.host,
        activeProfile: profiles.some(profile => profile.name === activeProfile) ? activeProfile : DEFAULT_PROFILE,
        profiles,
        audit: {
            enabled: bool(audit.enabled, base.audit.enabled),
            maxEntries: Math.trunc(nonNegative(audit.maxEntries, base.audit.maxEntries))
        },
        snapshots: {
            enabled: bool(snapshots.enabled, base.snapshots.enabled),
            keepPerFile: Math.trunc(positive(snapshots.keepPerFile, base.snapshots.keepPerFile))
        },
        limits: {
            execTimeoutMs: positive(limits.execTimeoutMs, base.limits.execTimeoutMs),
            maxOutputChars: positive(limits.maxOutputChars, base.limits.maxOutputChars),
            maxReadChars: positive(limits.maxReadChars, base.limits.maxReadChars),
            maxSessions: positive(limits.maxSessions, base.limits.maxSessions),
            sessionBufferChars: positive(limits.sessionBufferChars, base.limits.sessionBufferChars)
        },
        security: {
            allowRuntimeModeChange: bool(security.allowRuntimeModeChange, base.security.allowRuntimeModeChange),
            allowRuntimeWorkspaceChange: bool(
                security.allowRuntimeWorkspaceChange,
                base.security.allowRuntimeWorkspaceChange
            )
        },
        sse: {
            heartbeatMs: clamp(Math.trunc(nonNegative(sse.heartbeatMs, base.sse.heartbeatMs)), 0, 120_000),
            idleTimeoutSec: clamp(Math.trunc(positive(sse.idleTimeoutSec, base.sse.idleTimeoutSec)), 10, 255)
        }
    };
}

function collectPassthrough(raw: Record<string, unknown>): Record<string, unknown> {
    const extra: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw)) {
        if (!KNOWN_KEYS.has(key)) extra[key] = value;
    }
    return extra;
}

export async function ensureConfigDirs(): Promise<void> {
    await mkdir(CONFIG_DIR, { recursive: true });
    await mkdir(SNAPSHOT_DIR, { recursive: true });
}

/**
 * Загружает конфиг с коротким кэшем — sandbox дёргает его на каждый вызов тула.
 *
 * Битый файл НЕ пересоздаётся молча: раньше это генерировало новый токен,
 * все клиенты получали 401 и "Failed to connect to MCP server" без объяснений.
 */
export async function loadConfig(options: { force?: boolean } = {}): Promise<NotCodeConfig> {
    if (!options.force && cache && Date.now() - cache.at < CACHE_TTL_MS) {
        return cache.config;
    }

    const file = Bun.file(CONFIG_FILE);

    if (await file.exists()) {
        let raw: Record<string, unknown>;
        try {
            raw = (await file.json()) as Record<string, unknown>;
        } catch (error) {
            const backup = `${CONFIG_FILE}.broken-${Date.now()}`;
            await rename(CONFIG_FILE, backup).catch(() => undefined);
            log.error("конфиг повреждён", { file: CONFIG_FILE, backup, error: errorMessage(error) });
            throw new ConfigError(
                `Конфиг повреждён и не разобран как JSON: ${CONFIG_FILE}\n` +
                    `Копия сохранена: ${backup}\n` +
                    `Восстанови токен из копии вручную или выполни \`bun run setup\` для чистой настройки ` +
                    `(токен сменится — придётся обновить его в клиенте).`
            );
        }

        const config = normalize(raw);
        passthrough = collectPassthrough(raw);
        cache = { config, at: Date.now() };
        return config;
    }

    const fresh = defaults();
    await saveConfig(fresh);
    log.info("создан новый конфиг", { file: CONFIG_FILE, mode: fresh.mode, root: DEFAULT_ROOT });
    return fresh;
}

export async function saveConfig(config: NotCodeConfig): Promise<void> {
    await ensureConfigDirs();
    await writeJsonAtomic(CONFIG_FILE, { ...passthrough, ...config });
    cache = { config, at: Date.now() };
}

/** Атомарно читает, мутирует и сохраняет конфиг (с сериализацией конкурентных вызовов). */
export async function updateConfig(
    mutator: (config: NotCodeConfig) => void | Promise<void>
): Promise<NotCodeConfig> {
    return configMutex.run(async () => {
        const config = await loadConfig({ force: true });
        await mutator(config);
        await saveConfig(config);
        return config;
    });
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

export interface ListenOverrides {
    port?: number | undefined;
    host?: string | undefined;
}

/**
 * Переопределения адреса из окружения. Намеренно НЕ попадают в файл конфига:
 * это разовые настройки запуска (CI, тесты, второй экземпляр рядом).
 */
export function envListenOverrides(): ListenOverrides {
    const overrides: ListenOverrides = {};

    const rawPort = process.env.NOTCODE_PORT;
    if (rawPort !== undefined && rawPort !== "") {
        const parsed = Number.parseInt(rawPort, 10);
        if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 65_535) {
            overrides.port = parsed;
        } else {
            log.warn("NOTCODE_PORT проигнорирован: ожидается число 0..65535", { value: rawPort });
        }
    }

    const rawHost = process.env.NOTCODE_HOST;
    if (rawHost !== undefined && rawHost !== "") {
        overrides.host = rawHost;
    }

    return overrides;
}
