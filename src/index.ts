import { Elysia } from "elysia";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { createServer, toolCount } from "@/mcp";
import {
    CONFIG_FILE,
    ConfigError,
    envListenOverrides,
    getProfile,
    getWorkspaceRoot,
    isSecurityMode,
    loadConfig,
    updateConfig,
    type NotCodeConfig
} from "@/config";
import { allTools } from "@/tools/index";
import { readAudit, trimAuditLog } from "@/utils/audit";
import { createLogger, describeError, errorCode, errorMessage } from "@/utils/logger";
import { formatBytes, formatDuration } from "@/utils/output";
import { gcSnapshots } from "@/utils/snapshot";
import { terminals } from "@/utils/terminal-manager";
import { watchers } from "@/utils/watch-manager";

const log = createLogger("server");

const SERVER_NAME = "notcode";
const SERVER_VERSION = "2.0.0";

const SSE_LOG_THROTTLE_MS = 2_000;

interface Session {
    id: string;
    transport: SSEServerTransport;
    server: ReturnType<typeof createServer>;
    createdAt: number;
    lastActivityAt: number;
    close(reason: string): Promise<void>;
}

const transports = new Map<string, Session>();

function sanitizeHeader(value: unknown): string {
    return String(value ?? "").replace(/[^\x00-\xFF]/g, "");
}

const MCP_ACCEPT = "application/json, text/event-stream";

/**
 * Клиенты часто присылают неполный Accept (только "application/json") —
 * спека Streamable HTTP требует оба типа, и транспорт отвечает 406.
 * Дополняем заголовки и отдаём синтетический Request: тело всё равно
 * передаётся отдельно через parsedBody.
 */
function normalizeMcpRequest(request: Request): Request {
    const headers = new Headers(request.headers);
    const accept = headers.get("accept") ?? "";

    if (!accept.includes("application/json") || !accept.includes("text/event-stream")) {
        headers.set("accept", MCP_ACCEPT);
    }

    if (request.method === "POST" && !(headers.get("content-type") ?? "").includes("application/json")) {
        headers.set("content-type", "application/json");
    }

    return new Request(request.url, { method: request.method, headers });
}

function safeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
        diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Вывод в консоль
// ─────────────────────────────────────────────────────────────────────────────

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

function paint(code: string, value: string): string {
    return useColor ? `\u001b[${code}m${value}\u001b[0m` : value;
}

const dim = (v: string) => paint("2", v);
const bold = (v: string) => paint("1", v);
const cyan = (v: string) => paint("36", v);
const yellow = (v: string) => paint("33", v);
const green = (v: string) => paint("32", v);

const WORDMARK = [
    "███╗   ██╗ ██████╗ ████████╗ ██████╗ ██████╗ ██████╗ ███████╗",
    "████╗  ██║██╔═══██╗╚══██╔══╝██╔════╝██╔═══██╗██╔══██╗██╔════╝",
    "██╔██╗ ██║██║   ██║   ██║   ██║     ██║   ██║██║  ██║█████╗",
    "██║╚██╗██║██║   ██║   ██║   ██║     ██║   ██║██║  ██║██╔══╝",
    "██║ ╚████║╚██████╔╝   ██║   ╚██████╗╚██████╔╝██████╔╝███████╗",
    "╚═╝  ╚═══╝ ╚═════╝    ╚═╝    ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝"
];

function rows(entries: Array<[string, string]>): string {
    const width = Math.max(...entries.map(([l]) => l.length));
    return entries.map(([l, v]) => `  ${dim(l.padEnd(width))}   ${v}`).join("\n");
}

function wordmark(): string {
    if (!process.stdout.isTTY) return bold(`${SERVER_NAME.toUpperCase()} v${SERVER_VERSION}`);
    return WORDMARK.map(line => cyan(line)).join("\n");
}

function displayHost(host: string): string {
    if (host === "0.0.0.0" || host === "::" || host === "") return "127.0.0.1";
    if (host.includes(":")) return `[${host}]`;
    return host;
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

interface ParsedArgs {
    positional: string[];
    flags: Map<string, string>;
}

function parseArgs(argv: string[]): ParsedArgs {
    const positional: string[] = [];
    const flags = new Map<string, string>();

    for (let i = 0; i < argv.length; i++) {
        const token = argv[i] ?? "";
        if (!token.startsWith("--")) {
            positional.push(token);
            continue;
        }

        const body = token.slice(2);
        const eq = body.indexOf("=");
        if (eq !== -1) {
            flags.set(body.slice(0, eq), body.slice(eq + 1));
            continue;
        }

        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
            flags.set(body, next);
            i++;
        } else {
            flags.set(body, "true");
        }
    }

    return { positional, flags };
}

const USAGE = `
Использование: bun run src/index.ts <command>

Команды:
  start [--port N] [--host H]        Запустить MCP-сервер
  status                             Показать настройки
  mode <type>                        Режим (paranoic | auto | bypass)
  allow <path>                       Разрешить доступ к папке
  token [--reset]                    Посмотреть / пересоздать токен
  workspace list|use|add             Профили проектов
  security <flag> <on|off>           runtime-mode | runtime-workspace
  audit [n]                          Последние n записей аудита

  tools list                         Показать тулы и их публичные имена
  tools alias <realName> <newName>   Переименовать тул для клиента
  tools clear <realName>             Убрать алиас
  tools mcp <path>                   Сменить путь основного MCP-эндпоинта
  tools path <ssePath> [msgPath]     Сменить пути legacy SSE-эндпоинтов

  fix                                Полный сброс: новые алиасы для всех тулов
                                     + сброс пути SSE. Решает проблему блокировки
                                     тулов в Notion AI и других MCP-клиентах.

Переменные окружения:
  NOTCODE_PORT, NOTCODE_HOST, NOTCODE_LOG_LEVEL, WORKSPACE_ROOT, E2E_PORT
`;

/**
 * Генерирует алиасы для всех тулов: добавляет суффикс чтобы MCP-клиент
 * воспринял их как новые (никогда не виденные) тулы и показал нормальный
 * approve-флоу вместо "changed operation type".
 */
function buildFreshAliases(suffix: string): Record<string, string> {
    const aliases: Record<string, string> = {};
    for (const tool of allTools) {
        aliases[tool.name] = `${tool.name}_${suffix}`;
    }
    return aliases;
}

async function runCli(): Promise<void> {
    const { positional, flags } = parseArgs(process.argv.slice(2));
    const command = positional[0] ?? "start";
    const config = await loadConfig();

    switch (command) {
        case "start": {
            const env = envListenOverrides();
            const flagPort = flags.get("port");
            const flagHost = flags.get("host");

            const parsedFlagPort = flagPort === undefined ? undefined : Number.parseInt(flagPort, 10);
            if (parsedFlagPort !== undefined && !Number.isInteger(parsedFlagPort)) {
                console.error(`❌ --port ожидает число, получено: ${flagPort}`);
                process.exit(1);
            }

            startServer(config, {
                port: parsedFlagPort ?? env.port ?? config.port,
                host: flagHost ?? env.host ?? config.host
            });
            return;
        }

        case "fix": {
            /**
             * Полный сброс для Notion AI и других клиентов, которые показывают
             * "Tool has changed its operation type since the last admin approval"
             * и не дают кнопку для повторного одобрения.
             *
             * Что делает:
             * 1. Генерирует новые уникальные суффиксы для всех 31 тула.
             *    Для клиента это будут совершенно новые тулы — он попросит
             *    одобрения как при первом подключении.
             * 2. Меняет путь SSE-эндпоинта (/sse → /mcp или любой другой).
             *    Некоторые клиенты кешируют метаданные по URL — смена пути
             *    гарантирует чистый старт.
             * 3. После: перезапусти сервер и переподключи интеграцию в Notion.
             */
            const ts = Date.now().toString(36);
            const newMcpPath = `/mcp${ts.slice(-4)}`;
            const newSsePath = `/sse${ts.slice(-4)}`;
            const newMsgPath = `/msg${ts.slice(-4)}`;

            const updated = await updateConfig(draft => {
                draft.toolAliases = buildFreshAliases(ts);
                draft.sse.mcpPath = newMcpPath;
                draft.sse.ssePath = newSsePath;
                draft.sse.messagesPath = newMsgPath;
                // Заодно приводим таймауты legacy-сессий в норму.
                draft.sse.sessionIdleMs = 5 * 60_000;
            });

            const aliasCount = Object.keys(updated.toolAliases).length;

            console.log("");
            console.log(`  ${green("✅")} fix применён`);
            console.log("");
            console.log(
                rows([
                    ["Тулов переименовано", `${aliasCount}`],
                    ["Новый MCP-путь", updated.sse.mcpPath],
                    ["Новый SSE-путь (legacy)", updated.sse.ssePath],
                    ["Новый messages-путь", updated.sse.messagesPath],
                    ["Суффикс", ts]
                ])
            );
            console.log("");
            console.log("  Дальше:");
            console.log("    1. bun run start                     — перезапустить сервер");
            console.log("    2. В Notion: удалить интеграцию и добавить заново с новым URL");
            console.log(`       URL: http://${displayHost(updated.host)}:${updated.port}${updated.sse.mcpPath}`);
            console.log("    3. Одобрить тулы — теперь у них новые имена, кнопка появится.");
            console.log("");
            process.exit(0);
            return;
        }

        case "tools": {
            const sub = positional[1] ?? "list";

            if (sub === "list") {
                const aliases = config.toolAliases;
                const hasAliases = Object.keys(aliases).length > 0;
                console.log(`\n  Тулов: ${allTools.length}${hasAliases ? ` (${Object.keys(aliases).length} с алиасами)` : ""}\n`);
                for (const tool of allTools) {
                    const alias = aliases[tool.name];
                    const display = alias ? `${tool.name} ${dim("→")} ${green(alias)}` : tool.name;
                    console.log(`  ${display}`);
                }
                if (config.sse.ssePath !== "/sse") {
                    console.log(`\n  SSE-путь: ${cyan(config.sse.ssePath)}`);
                }
                console.log("");
                process.exit(0);
            }

            if (sub === "alias") {
                const real = positional[2];
                const alias = positional[3];
                if (!real || !alias) {
                    console.error("❌ Использование: tools alias <realName> <newPublicName>");
                    process.exit(1);
                }
                const toolExists = allTools.some(t => t.name === real);
                if (!toolExists) {
                    console.error(`❌ Тул '${real}' не найден. Список: bun run src/index.ts tools list`);
                    process.exit(1);
                }
                await updateConfig(draft => {
                    draft.toolAliases[real] = alias;
                });
                console.log(`✅ ${real} → ${alias}`);
                console.log("   Перезапусти сервер и переподключи интеграцию в Notion.");
                process.exit(0);
            }

            if (sub === "clear") {
                const real = positional[2];
                if (real) {
                    await updateConfig(draft => {
                        delete draft.toolAliases[real];
                    });
                    console.log(`✅ Алиас для '${real}' снят.`);
                } else {
                    // clear без аргумента — сброс всех алиасов
                    await updateConfig(draft => {
                        draft.toolAliases = {};
                    });
                    console.log("✅ Все алиасы сброшены.");
                }
                process.exit(0);
            }

            if (sub === "mcp") {
                const newPath = positional[2];
                if (!newPath) {
                    console.error("❌ Использование: tools mcp <path>");
                    console.error(`   Текущий MCP-путь: ${config.sse.mcpPath}`);
                    process.exit(1);
                }
                const updated = await updateConfig(draft => {
                    draft.sse.mcpPath = newPath.startsWith("/") ? newPath : `/${newPath}`;
                });
                console.log(`✅ MCP-путь: ${updated.sse.mcpPath}`);
                console.log("   Перезапусти сервер и обнови URL в клиенте.");
                process.exit(0);
            }

            if (sub === "path") {
                const ssePath = positional[2];
                const msgPath = positional[3];
                if (!ssePath) {
                    console.error("❌ Использование: tools path <ssePath> [messagesPath]");
                    console.error(`   Текущие: sse=${config.sse.ssePath} messages=${config.sse.messagesPath}`);
                    process.exit(1);
                }
                const updated = await updateConfig(draft => {
                    draft.sse.ssePath = ssePath.startsWith("/") ? ssePath : `/${ssePath}`;
                    if (msgPath) draft.sse.messagesPath = msgPath.startsWith("/") ? msgPath : `/${msgPath}`;
                });
                console.log(`✅ SSE-путь: ${updated.sse.ssePath}`);
                console.log(`   Messages-путь: ${updated.sse.messagesPath}`);
                console.log("   Перезапусти сервер.");
                process.exit(0);
            }

            console.log(USAGE);
            process.exit(0);
            return;
        }

        case "mode": {
            const newMode = positional[1];
            if (!isSecurityMode(newMode)) {
                console.error("❌ Укажи корректный режим: paranoic | auto | bypass");
                process.exit(1);
            }
            await updateConfig(draft => { draft.mode = newMode; });
            console.log(`✅ Режим безопасности: [${newMode.toUpperCase()}]`);
            process.exit(0);
            return;
        }

        case "allow": {
            const targetPath = positional[1];
            if (!targetPath) {
                console.error("❌ Укажи путь к папке");
                process.exit(1);
            }
            const absPath = resolve(getWorkspaceRoot(config), targetPath);
            const updated = await updateConfig(draft => {
                const profile = getProfile(draft);
                if (!profile.allowedPaths.includes(absPath)) profile.allowedPaths.push(absPath);
            });
            console.log(`✅ Разрешено (профиль ${getProfile(updated).name}): ${absPath}`);
            process.exit(0);
            return;
        }

        case "token": {
            if (positional[1] === "--reset" || flags.has("reset")) {
                const updated = await updateConfig(draft => { draft.token = crypto.randomUUID(); });
                console.log("🔄 Сгенерирован новый токен! Обнови его в клиенте.");
                console.log(`🔑 Bearer Token: ${updated.token}`);
            } else {
                console.log(`🔑 Bearer Token: ${config.token}`);
            }
            process.exit(0);
            return;
        }

        case "workspace": {
            const sub = positional[1] ?? "list";

            if (sub === "list") {
                for (const profile of config.profiles) {
                    const active = profile.name === config.activeProfile ? "*" : " ";
                    console.log(`${active} ${profile.name.padEnd(16)} ${profile.root}`);
                }
                process.exit(0);
            }

            if (sub === "use") {
                const name = positional[2];
                if (!name || !config.profiles.some(p => p.name === name)) {
                    console.error(`❌ Профиль '${name ?? ""}' не найден`);
                    process.exit(1);
                }
                const updated = await updateConfig(draft => { draft.activeProfile = name; });
                console.log(`✅ Активный воркспейс: ${name} → ${getWorkspaceRoot(updated)}`);
                process.exit(0);
            }

            if (sub === "add") {
                const name = positional[2];
                const rawRoot = positional[3];
                if (!name || !rawRoot) {
                    console.error("❌ Использование: workspace add <name> <path>");
                    process.exit(1);
                }
                const root = resolve(rawRoot);
                await updateConfig(draft => {
                    const existing = draft.profiles.find(p => p.name === name);
                    if (existing) existing.root = root;
                    else draft.profiles.push({ name, root, allowedPaths: [] });
                });
                console.log(`✅ Профиль '${name}' → ${root}`);
                process.exit(0);
            }

            console.log("Использование: workspace list | workspace use <name> | workspace add <name> <path>");
            process.exit(0);
            return;
        }

        case "security": {
            const flag = positional[1];
            const value = positional[2];

            if ((flag !== "runtime-mode" && flag !== "runtime-workspace") || (value !== "on" && value !== "off")) {
                console.log("Использование: security runtime-mode|runtime-workspace on|off");
                console.log("");
                console.log(`  runtime-mode:      ${config.security.allowRuntimeModeChange ? "on" : "off"}`);
                console.log(`  runtime-workspace: ${config.security.allowRuntimeWorkspaceChange ? "on" : "off"}`);
                process.exit(0);
            }

            const enabled = value === "on";
            await updateConfig(draft => {
                if (flag === "runtime-mode") draft.security.allowRuntimeModeChange = enabled;
                else draft.security.allowRuntimeWorkspaceChange = enabled;
            });
            console.log(`✅ ${flag} = ${value}`);
            process.exit(0);
            return;
        }

        case "status": {
            const fresh = await loadConfig({ force: true });
            const aliasCount = Object.keys(fresh.toolAliases).length;
            console.log("");
            console.log(`  ${bold(`NotCode v${SERVER_VERSION}`)}  ${dim("—")}  статус`);
            console.log("");
            console.log(
                rows([
                    ["Режим", fresh.mode.toUpperCase()],
                    ["Воркспейс", `${fresh.activeProfile} → ${getWorkspaceRoot(fresh)}`],
                    ["Доп. папки", `${getProfile(fresh).allowedPaths.length}`],
                    ["Тулов", `${toolCount()}${aliasCount > 0 ? ` (алиасов: ${aliasCount})` : ""}`],
                    ["MCP-путь", `${fresh.sse.mcpPath}`],
                    ["SSE-путь (legacy)", `${fresh.sse.ssePath}`],
                    [
                        "Аудит",
                        `${fresh.audit.enabled ? "вкл" : "выкл"}, до ${fresh.audit.maxEntries} записей / ${formatBytes(fresh.audit.maxFileBytes)}`
                    ],
                    [
                        "Снапшоты",
                        `${fresh.snapshots.enabled ? "вкл" : "выкл"}, ${fresh.snapshots.keepPerFile} на файл`
                    ],
                    ["Адрес", `${displayHost(fresh.host)}:${fresh.port}`],
                    [
                        "Runtime-права",
                        `mode=${fresh.security.allowRuntimeModeChange ? "on" : "off"}, workspace=${fresh.security.allowRuntimeWorkspaceChange ? "on" : "off"}`
                    ],
                    ["Конфиг", CONFIG_FILE]
                ])
            );
            console.log("");
            process.exit(0);
            return;
        }

        case "audit": {
            const limit = Number.parseInt(positional[1] ?? "20", 10);
            const entries = await readAudit({ limit: Number.isFinite(limit) ? limit : 20 });
            if (entries.length === 0) console.log("Аудит-лог пуст.");
            for (const entry of entries) {
                console.log(
                    `${entry.ts}  ${entry.ok ? "OK  " : "FAIL"}  ${entry.tool.padEnd(16)} ${entry.action.padEnd(11)} ${entry.target ?? ""}`
                );
            }
            process.exit(0);
            return;
        }

        default: {
            console.log(USAGE);
            process.exit(0);
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Учёт SSE-сессий
// ─────────────────────────────────────────────────────────────────────────────

let openedSinceReport = 0;
let reportTimer: ReturnType<typeof setTimeout> | null = null;

function reportSessionOpened(): void {
    openedSinceReport++;
    if (reportTimer !== null) return;

    reportTimer = setTimeout(() => {
        reportTimer = null;
        const opened = openedSinceReport;
        openedSinceReport = 0;
        log.debug(`SSE: +${opened} ${opened === 1 ? "сессия" : "сессий"}, активно ${transports.size}`);
    }, SSE_LOG_THROTTLE_MS);

    reportTimer.unref?.();
}

// СТАЛО - только вытесняем реально мёртвые (без активности > 60 сек)
function enforceSessionCap(limit: number): boolean {
    if (transports.size < limit) return true;

    const now = Date.now();
    // Сначала пробуем убрать только реально мёртвые сессии (нет активности > 60 сек)
    const dead = [...transports.values()]
        .filter(s => now - s.lastActivityAt > 60_000)
        .sort((a, b) => a.lastActivityAt - b.lastActivityAt);

    for (const victim of dead) {
        log.warn("убираю мёртвую SSE-сессию", {
            sessionId: victim.id,
            idleFor: formatDuration(now - victim.lastActivityAt)
        });
        void victim.close("мёртвая сессия (нет активности > 60 сек)");
        if (transports.size < limit) return true;
    }

    // Если всё ещё переполнено — не вытесняем живые, просто отказываем
    if (transports.size >= limit) {
        log.warn("лимит SSE исчерпан, отказываю в новом подключении", {
            active: transports.size,
            limit
        });
        return false; // сигнал что надо вернуть 503
    }

    return true;
}

function sweepSessions(idleMs: number): number {
    const now = Date.now();
    let closed = 0;
    for (const session of [...transports.values()]) {
        if (now - session.lastActivityAt <= idleMs) continue;
        closed++;
        void session.close("простой дольше sse.sessionIdleMs");
    }
    return closed;
}

async function runMaintenance(): Promise<void> {
    try {
        const config = await loadConfig();
        const sessionsClosed = sweepSessions(config.sse.sessionIdleMs);
        const terminalsClosed = await terminals.gc();
        const watchersStopped = watchers.gc();
        const snapshots = await gcSnapshots(config);
        const auditTrim = await trimAuditLog(config);

        if (sessionsClosed > 0 || terminalsClosed > 0 || watchersStopped > 0 || snapshots.removed > 0 || auditTrim.trimmed) {
            log.info("обслуживание", {
                sessionsClosed,
                terminalsClosed,
                watchersStopped,
                snapshotsRemoved: snapshots.removed,
                freed: formatBytes(snapshots.freedBytes),
                auditTrimmed: auditTrim.trimmed
            });
        }
    } catch (error) {
        log.warn("сбой фонового обслуживания", { error: errorMessage(error) });
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP / SSE
// ─────────────────────────────────────────────────────────────────────────────

function startServer(config: NotCodeConfig, listen: { port: number; host: string }): void {
    const heartbeatMs = config.sse.heartbeatMs;
    const maxSessions = config.sse.maxSessions;
    const mcpPath = config.sse.mcpPath;

    // Legacy-SSE не должен занимать тот же путь, что основной транспорт:
    // иначе Elysia получит два обработчика на один маршрут.
    let ssePath = config.sse.ssePath;
    let messagesPath = config.sse.messagesPath;
    if (ssePath === mcpPath) ssePath = mcpPath === "/sse" ? "/sse-legacy" : "/sse";
    if (messagesPath === mcpPath) messagesPath = "/messages-legacy";

    const app = new Elysia()
        .onError(({ error, code, set, request }) => {
            // HEAD на SSE-путь — это нормальный "прощупывающий" запрос, не ошибка.
            const method = request.method;
            const path = new URL(request.url).pathname;
            const isProbe = method === "HEAD" && path === ssePath;

            if (!isProbe) {
                log.error("необработанная ошибка запроса", {
                    code,
                    method,
                    path,
                    error: errorMessage(error)
                });
            }

            if (code === "NOT_FOUND") {
                set.status = 404;
                return { error: "Not found" };
            }
            set.status = 500;
            return { error: "Internal error", detail: errorMessage(error) };
        })
        .onRequest(async ({ request, set }) => {
            set.headers["Access-Control-Allow-Origin"] = "*";
            set.headers["Access-Control-Allow-Headers"] = "*";
            set.headers["Access-Control-Allow-Methods"] = "GET, POST, HEAD, OPTIONS";

            if (request.method === "OPTIONS") return;
            if (new URL(request.url).pathname === "/health") return;

            let expected = config.token;
            try {
                expected = (await loadConfig()).token;
            } catch (error) {
                log.error("не удалось перечитать конфиг", { error: errorMessage(error) });
            }

            const authHeader = request.headers.get("authorization");
            const token = authHeader?.replace(/^Bearer\s+/i, "").trim();

            if (!token || !safeEqual(token, expected)) {
                set.status = 401;
                return "Unauthorized: Invalid or missing Bearer token";
            }
        })
        .options("*", ({ set }) => {
            set.status = 204;
            return "";
        })
        // HEAD на SSE-путь: клиенты часто «прощупывают» эндпоинт перед подключением.
        // Без явного хендлера Elysia возвращает 404 и пишет в лог ошибку — хотя ничего не сломано.
        .head(ssePath, ({ set }) => {
            set.status = 200;
            set.headers["Content-Type"] = "text/event-stream";
            return "";
        })
        .get("/health", () => ({ status: "ok", name: SERVER_NAME, version: SERVER_VERSION }))
        .get("/status", async () => {
            // Читаем свежий конфиг, а не snapshot с момента старта:
            // CLI-команды (mode, workspace, fix, tools alias) меняют файл без перезапуска сервера.
            const fresh = await loadConfig();
            return {
                status: "ok",
                name: SERVER_NAME,
                version: SERVER_VERSION,
                mode: fresh.mode,
                tools: toolCount(),
                toolAliases: fresh.toolAliases,
                sessions: transports.size,
                maxSessions,
                terminals: terminals.list().length,
                watchers: watchers.list().length,
                workspaceRoot: getWorkspaceRoot(fresh),
                transport: "streamable-http (stateless) + legacy sse",
                mcpPath,
                ssePath,
                messagesPath,
                heartbeatMs,
                uptimeSec: Math.round(process.uptime())
            };
        })
        // ─── Основной транспорт: Streamable HTTP, stateless ─────────────────
        // Один POST = запрос + ответ в том же соединении. Нет висящих
        // каналов, sessionId и heartbeat — отваливаться и утекать нечему.
        .post(mcpPath, async ({ request, body, set }) => {
            let parsedBody: unknown = body;
            if (parsedBody === undefined || parsedBody === null) {
                try {
                    parsedBody = await request.json();
                } catch {
                    parsedBody = undefined;
                }
            }

            // Свежий конфиг на каждый запрос: алиасы и режим могут поменяться
            // без перезапуска сервера.
            const freshConfig = await loadConfig();
            const server = createServer(freshConfig);
            const transport = new WebStandardStreamableHTTPServerTransport({
                sessionIdGenerator: undefined,
                enableJsonResponse: true
            });

            try {
                await server.connect(transport);
                // В JSON-режиме транспорт отдаёт полностью готовый Response,
                // поэтому закрывать его в finally безопасно.
                return await transport.handleRequest(normalizeMcpRequest(request), { parsedBody });
            } catch (error) {
                log.error("ошибка обработки MCP-запроса", { error: errorMessage(error) });
                set.status = 500;
                return {
                    jsonrpc: "2.0",
                    error: { code: -32603, message: "Internal error", data: errorMessage(error) },
                    id: null
                };
            } finally {
                await transport.close().catch(() => undefined);
                await server.close().catch(() => undefined);
            }
        })
        .get(mcpPath, ({ set }) => {
            // Серверных пушей в stateless-режиме нет, GET-стрим не нужен.
            set.status = 405;
            set.headers["Allow"] = "POST, DELETE";
            return {
                jsonrpc: "2.0",
                error: { code: -32000, message: "Method not allowed. Используй POST." },
                id: null
            };
        })
        .head(mcpPath, ({ set }) => {
            set.status = 200;
            return "";
        })
        .delete(mcpPath, ({ set }) => {
            // Сессий нет — удалять нечего, но клиент ждёт корректный ответ.
            set.status = 204;
            return "";
        })
        .get(ssePath, async ({ request, set }) => {
            let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
            let closed = false;
            let heartbeat: ReturnType<typeof setInterval> | null = null;
            let teardown: (reason: string) => Promise<void> = async () => undefined;

            const encoder = new TextEncoder();

            const allowed = enforceSessionCap(maxSessions);
            if (!allowed) {
                set.status = 503;
                set.headers["Retry-After"] = "5";
                return new Response("Too many connections. Retry later.", {
                    status: 503,
                    headers: { "Retry-After": "5" }
                });
            }

            const stream = new ReadableStream<Uint8Array>({
                start(streamController) {
                    controller = streamController;
                },
                cancel(reason) {
                    void teardown(`клиент закрыл поток (${String(reason ?? "cancel")})`);
                }
            });

            const push = (chunk: Uint8Array): boolean => {
                if (closed || controller === null) return false;
                try {
                    // desiredSize === null означает, что поток уже закрыт или
                    // отменён клиентом. Без этой проверки enqueue в Bun молча
                    // проглатывает запись, и сессия навсегда остаётся «живой».
                    if (controller.desiredSize === null) {
                        void teardown("поток закрыт клиентом");
                        return false;
                    }
                    controller.enqueue(chunk);
                    return true;
                } catch (error) {
                    log.debug("запись в закрытый SSE-поток", { error: errorMessage(error) });
                    void teardown("поток уже закрыт");
                    return false;
                }
            };

            const collectedHeaders: Record<string, string> = {};

            const resMock = {
                writeHead: (statusCode: number, headers?: Record<string, string>) => {
                    set.status = statusCode;
                    if (headers) {
                        for (const [key, value] of Object.entries(headers)) {
                            collectedHeaders[key] = sanitizeHeader(value);
                        }
                    }
                    return resMock;
                },
                write: (chunk: string | Uint8Array) => {
                    const data = typeof chunk === "string" ? encoder.encode(chunk) : chunk;
                    return push(data);
                },
                end: () => {
                    if (!closed && controller !== null) {
                        try { controller.close(); } catch { /* уже закрыт */ }
                    }
                    return resMock;
                },
                on: (event: string, listener: () => void) => {
                    if (event === "close") {
                        request.signal.addEventListener("abort", listener);
                    }
                    return resMock;
                }
            } as unknown as ServerResponse;

            // Читаем свежий конфиг для каждой новой сессии:
            // после `fix` или `tools alias` алиасы могут измениться без перезапуска.
            const freshConfig = await loadConfig();
            const transport = new SSEServerTransport(messagesPath, resMock);
            const server = createServer(freshConfig);
            const sessionId = transport.sessionId;

            teardown = async (reason: string): Promise<void> => {
                if (closed) return;
                closed = true;

                if (heartbeat !== null) {
                    clearInterval(heartbeat);
                    heartbeat = null;
                }

                transports.delete(sessionId);

                try { controller?.close(); } catch { /* уже закрыт */ }

                await transport.close().catch(() => undefined);
                await server.close().catch(() => undefined);

                log.debug("SSE-сессия закрыта", { sessionId, reason, active: transports.size });
            };

            const now = Date.now();
            const session: Session = {
                id: sessionId,
                transport,
                server,
                createdAt: now,
                lastActivityAt: now,
                close: teardown
            };
            transports.set(sessionId, session);

            try {
                await server.connect(transport);
            } catch (error) {
                log.error("не удалось поднять MCP-сессию", { sessionId, error: errorMessage(error) });
                await teardown("ошибка инициализации");
                set.status = 500;
                return { error: "Failed to start MCP session" };
            }

            if (heartbeatMs > 0) {
                let missedPings = 0;
                heartbeat = setInterval(() => {
                    if (push(encoder.encode(": ping\n\n"))) {
                        missedPings = 0;
                        return;
                    }
                    // Два подряд недоставленных ping — клиента больше нет.
                    // Раньше такие сессии висели до sessionIdleMs.
                    missedPings++;
                    if (missedPings >= 2) {
                        void teardown("heartbeat не доставляется — клиент отвалился");
                    }
                }, heartbeatMs);
                heartbeat.unref?.();
            }

            request.signal.addEventListener("abort", () => {
                void teardown("клиент оборвал запрос");
            });

            log.debug("SSE-сессия открыта", { sessionId, active: transports.size, heartbeatMs });
            reportSessionOpened();

            return new Response(stream, {
                status: 200,
                headers: {
                    ...collectedHeaders,
                    "Content-Type": "text/event-stream",
                    "Cache-Control": "no-cache, no-transform",
                    Connection: "keep-alive",
                    "X-Accel-Buffering": "no",
                    "Access-Control-Allow-Origin": "*"
                }
            });
        })
        .post(messagesPath, async ({ request, query, body, set }) => {
            const sessionId = typeof query.sessionId === "string" ? query.sessionId : "";
            const session = sessionId ? transports.get(sessionId) : undefined;

            if (!session) {
                set.status = 404;
                // Штатная ситуация при переподключении клиента — не повод
                // засорять консоль warn'ами на каждый ретрай.
                log.debug("POST для неизвестной сессии", { sessionId, path: messagesPath, active: transports.size });
                return {
                    error: "Session not found",
                    hint: `SSE-соединение закрыто или сервер перезапущен. Переподключись к ${ssePath}.`
                };
            }

            session.lastActivityAt = Date.now();

            let statusFromTransport: number | null = null;
            let payload: string | undefined;

            const reqMock = {
                method: "POST",
                headers: {
                    "content-type": sanitizeHeader(request.headers.get("content-type") || "application/json")
                },
                on: () => reqMock
            } as unknown as IncomingMessage;

            const resMock = {
                writeHead: (statusCode: number) => {
                    statusFromTransport = statusCode;
                    return resMock;
                },
                end: (chunk?: string) => {
                    if (typeof chunk === "string") payload = chunk;
                    return resMock;
                }
            } as unknown as ServerResponse;

            try {
                await session.transport.handlePostMessage(reqMock, resMock, body);
            } catch (error) {
                log.error("ошибка обработки сообщения", { sessionId, error: errorMessage(error) });
                set.status = 400;
                return { error: "Failed to handle message", detail: errorMessage(error) };
            }

            set.status = statusFromTransport ?? 202;
            return payload ?? "Accepted";
        });

    try {
        app.listen({
            port: listen.port,
            hostname: listen.host,
            idleTimeout: config.sse.idleTimeoutSec
        });
    } catch (error) {
        if (errorCode(error) === "EADDRINUSE") {
            console.error(
                `❌ Порт ${listen.port} уже занят.\n` +
                    `   Закрой старый процесс или укажи другой порт:\n` +
                    `   bun run start -- --port ${listen.port + 1}`
            );
            process.exit(1);
        }
        console.error(`❌ Не удалось запустить сервер: ${errorMessage(error)}`);
        process.exit(1);
    }

    void runMaintenance();
    const maintenanceTimer = setInterval(() => void runMaintenance(), config.limits.gcIntervalMs);
    maintenanceTimer.unref?.();

    // Отдельная частая уборка legacy-сессий: общий GC ходит раз в несколько
    // минут, а мёртвые SSE-каналы надо убирать быстро, иначе они копятся.
    const sessionSweeper = setInterval(() => {
        const closed = sweepSessions(config.sse.sessionIdleMs);
        if (closed > 0) log.debug("закрыты простаивающие SSE-сессии", { closed, active: transports.size });
    }, 30_000);
    sessionSweeper.unref?.();

    let shuttingDown = false;

    const shutdown = async (signal: string): Promise<void> => {
        if (shuttingDown) return;
        shuttingDown = true;

        console.log(`\n🛑 ${signal}: гасим сессии, терминалы и watcher'ы…`);

        clearInterval(maintenanceTimer);
        clearInterval(sessionSweeper);
        terminals.stopGc();
        watchers.stopGc();

        const forceExit = setTimeout(() => {
            log.warn("грациозное завершение не уложилось в 10 с, выходим принудительно");
            process.exit(1);
        }, 10_000);

        try {
            await Promise.all([...transports.values()].map(s => s.close(`сервер остановлен (${signal})`)));
            await terminals.closeAll();
            watchers.stopAll();
            await app.stop();
        } catch (error) {
            log.error("ошибка при остановке", { error: errorMessage(error) });
        } finally {
            clearTimeout(forceExit);
        }

        process.exit(0);
    };

    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));

    process.on("unhandledRejection", reason => {
        log.error("необработанный промис (сервер продолжает работу)", describeError(reason));
    });

    process.on("uncaughtException", error => {
        if (errorCode(error) === "EADDRINUSE") {
            console.error(`❌ Порт ${listen.port} уже занят.`);
            process.exit(1);
        }
        log.error("необработанное исключение (сервер продолжает работу)", describeError(error));
    });

    const shown = displayHost(listen.host);
    const baseUrl = `http://${shown}:${listen.port}`;
    const sseUrl = `${baseUrl}${ssePath}`;
    const mcpUrl = `${baseUrl}${mcpPath}`;

    const aliasCount = Object.keys(config.toolAliases).length;

    console.log("");
    console.log(wordmark());
    console.log("");
    console.log(
        `  ${bold(`MCP-сервер v${SERVER_VERSION}`)}  ${dim("·")}  режим ${bold(config.mode.toUpperCase())}  ${dim("·")}  тулов: ${toolCount()}${aliasCount > 0 ? ` ${dim(`(алиасов: ${aliasCount})`)}` : ""}`
    );
    console.log("");
    console.log(
        rows([
            ["MCP (основной)", cyan(mcpUrl)],
            ["SSE (legacy)", dim(sseUrl)],
            ["Messages (legacy)", dim(`${baseUrl}${messagesPath}`)],
            ["Health", `${baseUrl}/health`],
            ["Токен", config.token],
            ["Воркспейс", `${config.activeProfile} → ${getWorkspaceRoot(config)}`],
            ["Слушаем", `${listen.host}:${listen.port}`],
            [
                "Legacy-сессии",
                `heartbeat ${heartbeatMs > 0 ? formatDuration(heartbeatMs) : "выключен (!)"}, лимит ${maxSessions}, простой ${formatDuration(config.sse.sessionIdleMs)}`
            ],
            ["Уборка", `каждые ${formatDuration(config.limits.gcIntervalMs)}`],
            ["Конфиг", CONFIG_FILE]
        ])
    );
    console.log("");
    console.log(`  ${dim("Подключение клиента (Notion AI / Claude / Cursor)")}`);
    console.log(rows([["URL", mcpUrl], ["Авторизация", "Bearer token"], ["Token", config.token]]));
    console.log("");

    if (aliasCount > 0) {
        console.log(`  ${yellow("ℹ")}  Активны алиасы для ${aliasCount} тулов. Клиент видит переименованные имена.`);
        console.log(`     Сбросить: bun run src/index.ts tools clear`);
        console.log("");
    }

    if (listen.host === "0.0.0.0" || listen.host === "::") {
        console.log(
            `  ${yellow("⚠")}  Сервер слушает все интерфейсы, а у него полный доступ к ФС и shell.\n` +
                `     Держи его за реверс-прокси с TLS или вернись на 127.0.0.1 (--host 127.0.0.1).`
        );
        console.log("");
    }
}

void runCli().catch((error: unknown) => {
    if (error instanceof ConfigError) {
        console.error(`❌ ${error.message}`);
        process.exit(1);
    }
    console.error(`❌ Непредвиденная ошибка: ${errorMessage(error)}`);
    process.exit(1);
});
