import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { mkdir, rename } from "node:fs/promises";
import { writeJsonAtomic } from "@/utils/fs-atomic";
import { Mutex } from "@/utils/lock";
import { createLogger, errorMessage } from "@/utils/logger";

const log = createLogger("config");

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
    maxFileBytes: number;
}

export interface SnapshotSettings {
    enabled: boolean;
    keepPerFile: number;
    maxFileBytes: number;
    maxTotalBytes: number;
    maxAgeDays: number;
    orphanTtlHours: number;
}

export interface LimitSettings {
    execTimeoutMs: number;
    maxOutputChars: number;
    maxReadChars: number;
    maxSessions: number;
    sessionBufferChars: number;
    maxWatchers: number;
    watcherIdleMs: number;
    terminalIdleMs: number;
    gcIntervalMs: number;
}

export interface SecuritySettings {
    allowRuntimeModeChange: boolean;
    allowRuntimeWorkspaceChange: boolean;
}

export interface SseSettings {
    heartbeatMs: number;
    idleTimeoutSec: number;
    maxSessions: number;
    sessionIdleMs: number;
    /**
     * Путь основного Streamable-HTTP эндпоинта. По умолчанию "/mcp".
     * Это главный транспорт: один POST = запрос + ответ, без висящих
     * соединений и без sessionId.
     */
    mcpPath: string;
    /**
     * Путь legacy SSE-эндпоинта. По умолчанию "/sse".
     * Смени на "/socket" или другой, если клиент не находит "/sse"
     * или Notion кеширует старый путь.
     * Должен начинаться с "/".
     */
    ssePath: string;
    /**
     * Путь для POST-сообщений MCP. По умолчанию "/messages".
     * Меняй вместе с ssePath при необходимости.
     */
    messagesPath: string;
}

export interface NotCodeConfig {
    token: string;
    mode: SecurityMode;
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
    /**
     * Публичные алиасы тулов: { "realName": "publicName" }.
     * Если Notion заблокировал тул из-за смены аннотаций — переименуй его здесь.
     * Команда: bun run src/index.ts tools alias <realName> <newName>
     * Сбросить всё разом: bun run src/index.ts fix
     */
    toolAliases: Record<string, string>;
}

export const CONFIG_DIR = join(homedir(), ".notcode");
export const CONFIG_FILE = join(CONFIG_DIR, "config.json");
export const AUDIT_FILE = join(CONFIG_DIR, "audit.jsonl");
export const SNAPSHOT_DIR = join(CONFIG_DIR, "snapshots");
export const SNAPSHOT_INDEX = join(SNAPSHOT_DIR, "index.jsonl");

export const DEFAULT_PROFILE = "default";
export const DEFAULT_ROOT = resolve(process.env.WORKSPACE_ROOT || process.cwd());

/** @deprecated Используй getWorkspaceRoot(config) */
export const WORKSPACE_ROOT = DEFAULT_ROOT;

const CACHE_TTL_MS = 1_000;

let cache: { config: NotCodeConfig; at: number } | null = null;
let passthrough: Record<string, unknown> = {};

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
    "sse",
    "toolAliases"
]);

function defaults(): NotCodeConfig {
    return {
        token: crypto.randomUUID(),
        mode: "auto",
        allowedPaths: [],
        port: 3000,
        host: "127.0.0.1",
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
            maxWatchers: 16,
            watcherIdleMs: 30 * 60_000,
            terminalIdleMs: 60 * 60_000,
            gcIntervalMs: 5 * 60_000
        },
        security: {
            allowRuntimeModeChange: false,
            allowRuntimeWorkspaceChange: false
        },
        sse: {
            heartbeatMs: 15_000,
            idleTimeoutSec: 255,
            maxSessions: 32,
            // 5 минут вместо 30: мёртвый SSE-канал не должен занимать слот
            // полчаса. Основной транспорт (mcpPath) сессий вообще не держит.
            sessionIdleMs: 5 * 60_000,
            mcpPath: "/mcp",
            ssePath: "/sse",
            messagesPath: "/messages"
        },
        toolAliases: {}
    };
}

function asStringArray(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function asStringRecord(value: unknown): Record<string, string> {
    const out: Record<string, string> = {};
    if (typeof value === "object" && value !== null) {
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            if (typeof v === "string" && v.trim().length > 0) out[k] = v.trim();
        }
    }
    return out;
}

function positive(value: unknown, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

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

function normalizeSsePath(value: unknown, fallback: string): string {
    if (typeof value !== "string" || value.trim().length === 0) return fallback;
    const p = value.trim();
    return p.startsWith("/") ? p : `/${p}`;
}

function normalize(raw: Record<string, unknown>): NotCodeConfig {
    const base = defaults();
    const legacyAllowed = asStringArray(raw.allowedPaths);

    const rawProfiles = Array.isArray(raw.profiles) ? (raw.profiles as Record<string, unknown>[]) : [];
    const profiles: WorkspaceProfile[] = rawProfiles
        .filter(p => typeof p?.name === "string" && typeof p?.root === "string")
        .map(p => ({
            name: String(p.name),
            root: resolve(String(p.root)),
            allowedPaths: asStringArray(p.allowedPaths).map(i => resolve(i))
        }));

    if (!profiles.some(p => p.name === DEFAULT_PROFILE)) {
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
        allowedPaths: legacyAllowed.map(i => resolve(i)),
        port: clamp(Math.trunc(nonNegative(raw.port, base.port)), 0, 65_535),
        host: typeof raw.host === "string" && raw.host.length > 0 ? raw.host : base.host,
        activeProfile: profiles.some(p => p.name === activeProfile) ? activeProfile : DEFAULT_PROFILE,
        profiles,
        audit: {
            enabled: bool(audit.enabled, base.audit.enabled),
            maxEntries: Math.trunc(nonNegative(audit.maxEntries, base.audit.maxEntries)),
            maxFileBytes: Math.trunc(positive(audit.maxFileBytes, base.audit.maxFileBytes))
        },
        snapshots: {
            enabled: bool(snapshots.enabled, base.snapshots.enabled),
            keepPerFile: Math.trunc(positive(snapshots.keepPerFile, base.snapshots.keepPerFile)),
            maxFileBytes: Math.trunc(positive(snapshots.maxFileBytes, base.snapshots.maxFileBytes)),
            maxTotalBytes: Math.trunc(positive(snapshots.maxTotalBytes, base.snapshots.maxTotalBytes)),
            maxAgeDays: positive(snapshots.maxAgeDays, base.snapshots.maxAgeDays),
            orphanTtlHours: positive(snapshots.orphanTtlHours, base.snapshots.orphanTtlHours)
        },
        limits: {
            execTimeoutMs: positive(limits.execTimeoutMs, base.limits.execTimeoutMs),
            maxOutputChars: positive(limits.maxOutputChars, base.limits.maxOutputChars),
            maxReadChars: positive(limits.maxReadChars, base.limits.maxReadChars),
            maxSessions: positive(limits.maxSessions, base.limits.maxSessions),
            sessionBufferChars: positive(limits.sessionBufferChars, base.limits.sessionBufferChars),
            maxWatchers: Math.trunc(clamp(positive(limits.maxWatchers, base.limits.maxWatchers), 1, 256)),
            watcherIdleMs: positive(limits.watcherIdleMs, base.limits.watcherIdleMs),
            terminalIdleMs: positive(limits.terminalIdleMs, base.limits.terminalIdleMs),
            gcIntervalMs: positive(limits.gcIntervalMs, base.limits.gcIntervalMs)
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
            idleTimeoutSec: clamp(Math.trunc(positive(sse.idleTimeoutSec, base.sse.idleTimeoutSec)), 10, 255),
            maxSessions: Math.trunc(clamp(positive(sse.maxSessions, base.sse.maxSessions), 1, 1_024)),
            sessionIdleMs: positive(sse.sessionIdleMs, base.sse.sessionIdleMs),
            mcpPath: normalizeSsePath(sse.mcpPath, base.sse.mcpPath),
            ssePath: normalizeSsePath(sse.ssePath, base.sse.ssePath),
            messagesPath: normalizeSsePath(sse.messagesPath, base.sse.messagesPath)
        },
        toolAliases: asStringRecord(raw.toolAliases)
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
                    `Восстанови токен из копии вручную или выполни \`bun run setup\` для чистой настройки.`
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
        config.profiles.find(p => p.name === target) ??
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
