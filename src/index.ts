import { Elysia } from "elysia";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
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
import { readAudit } from "@/utils/audit";
import { createLogger, describeError, errorCode, errorMessage } from "@/utils/logger";
import { terminals } from "@/utils/terminal-manager";
import { watchers } from "@/utils/watch-manager";

const log = createLogger("server");

const SERVER_NAME = "notcode";
const SERVER_VERSION = "2.0.0";

interface Session {
    id: string;
    transport: SSEServerTransport;
    server: ReturnType<typeof createServer>;
    createdAt: number;
    close(reason: string): Promise<void>;
}

const transports = new Map<string, Session>();

function sanitizeHeader(value: unknown): string {
    return String(value ?? "").replace(/[^\x00-\xFF]/g, "");
}

/** Сравнение токенов без утечки по времени. */
function safeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
        diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
}

function box(lines: string[]): string {
    const width = Math.max(...lines.map(line => line.length), 60);
    const top = `┌${"─".repeat(width + 2)}┐`;
    const bottom = `└${"─".repeat(width + 2)}┘`;
    const body = lines.map(line => (line === "-" ? `├${"─".repeat(width + 2)}┤` : `│ ${line.padEnd(width)} │`));
    return [top, ...body, bottom].join("\n");
}

/** Адрес, по которому реально можно подключиться: по 0.0.0.0 клиент не ходит. */
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
  start [--port N] [--host H]  Запустить MCP сервер NotCode
  status                       Показать текущие настройки
  mode <type>                  Режим безопасности (paranoic | auto | bypass)
  allow <path>                 Разрешить доступ к папке (для auto)
  token [--reset]              Посмотреть / пересоздать токен
  workspace list|use|add       Профили проектов (свой root у каждого)
  security <flag> <on|off>     runtime-mode | runtime-workspace
  audit [n]                    Последние n записей аудит-лога

Переменные окружения:
  NOTCODE_PORT, NOTCODE_HOST   Разовое переопределение адреса (не пишется в конфиг)
  NOTCODE_LOG_LEVEL            debug | info | warn | error | silent
  WORKSPACE_ROOT               Корень воркспейса при первом запуске
`;

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

        case "mode": {
            const newMode = positional[1];
            if (!isSecurityMode(newMode)) {
                console.error("❌ Укажи корректный режим: paranoic | auto | bypass");
                process.exit(1);
            }
            await updateConfig(draft => {
                draft.mode = newMode;
            });
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
                const updated = await updateConfig(draft => {
                    draft.token = crypto.randomUUID();
                });
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
                if (!name || !config.profiles.some(profile => profile.name === name)) {
                    console.error(`❌ Профиль '${name ?? ""}' не найден`);
                    process.exit(1);
                }
                const updated = await updateConfig(draft => {
                    draft.activeProfile = name;
                });
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
                    const existing = draft.profiles.find(profile => profile.name === name);
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
                console.log("");
                console.log("Оба выключены по умолчанию: иначе агент может сам себе расширить права.");
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
            console.log(
                box([
                    `NOTCODE STATUS`,
                    "-",
                    `Режим:            ${config.mode.toUpperCase()}`,
                    `Воркспейс:        ${config.activeProfile} → ${getWorkspaceRoot(config)}`,
                    `Разрешено:        ${getProfile(config).allowedPaths.length} доп. папок`,
                    `Тулов:            ${toolCount()}`,
                    `Аудит:            ${config.audit.enabled ? "вкл" : "выкл"} (max ${config.audit.maxEntries})`,
                    `Снапшоты:         ${config.snapshots.enabled ? "вкл" : "выкл"} (${config.snapshots.keepPerFile} на файл)`,
                    `Адрес:            ${displayHost(config.host)}:${config.port}`,
                    `Runtime-права:    mode=${config.security.allowRuntimeModeChange ? "on" : "off"}, workspace=${
                        config.security.allowRuntimeWorkspaceChange ? "on" : "off"
                    }`,
                    `Конфиг:           ${CONFIG_FILE}`
                ])
            );
            process.exit(0);
            return;
        }

        case "audit": {
            const limit = Number.parseInt(positional[1] ?? "20", 10);
            const entries = await readAudit({ limit: Number.isFinite(limit) ? limit : 20 });
            if (entries.length === 0) console.log("Аудит-лог пуст.");
            for (const entry of entries) {
                console.log(
                    `${entry.ts}  ${entry.ok ? "OK  " : "FAIL"}  ${entry.tool.padEnd(16)} ${entry.action.padEnd(11)} ${
                        entry.target ?? ""
                    }`
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
// HTTP / SSE
// ─────────────────────────────────────────────────────────────────────────────

function startServer(config: NotCodeConfig, listen: { port: number; host: string }): void {
    const heartbeatMs = config.sse.heartbeatMs;

    const app = new Elysia()
        .onError(({ error, code, set, request }) => {
            log.error("необработанная ошибка запроса", {
                code,
                path: new URL(request.url).pathname,
                error: errorMessage(error)
            });
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
            set.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";

            if (request.method === "OPTIONS") return;
            if (new URL(request.url).pathname === "/health") return;

            // Читаем токен из конфига (кэш 1 с): после `token --reset` не нужен перезапуск.
            let expected = config.token;
            try {
                expected = (await loadConfig()).token;
            } catch (error) {
                log.error("не удалось перечитать конфиг, использую токен из памяти", {
                    error: errorMessage(error)
                });
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
        // Публичный эндпоинт — минимум информации, без путей и режимов.
        .get("/health", () => ({ status: "ok", name: SERVER_NAME, version: SERVER_VERSION }))
        // Детали — только по токену.
        .get("/status", () => ({
            status: "ok",
            name: SERVER_NAME,
            version: SERVER_VERSION,
            mode: config.mode,
            tools: toolCount(),
            sessions: transports.size,
            terminals: terminals.list().length,
            watchers: watchers.list().length,
            workspaceRoot: getWorkspaceRoot(config),
            heartbeatMs,
            uptimeSec: Math.round(process.uptime())
        }))
        .get("/sse", async ({ request, set }) => {
            let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
            let closed = false;
            let heartbeat: ReturnType<typeof setInterval> | null = null;
            let teardown: (reason: string) => Promise<void> = async () => undefined;

            const encoder = new TextEncoder();

            const stream = new ReadableStream<Uint8Array>({
                start(streamController) {
                    controller = streamController;
                },
                // ОСНОВНОЙ сигнал об отвалившемся клиенте в Bun.
                cancel(reason) {
                    void teardown(`клиент закрыл поток (${String(reason ?? "cancel")})`);
                }
            });

            /**
             * Запись в поток С ПЕРЕХВАТОМ ошибки.
             * Раньше enqueue() в закрытый controller кидал исключение внутри промиса SDK,
             * а без обработчика unhandledRejection это убивало весь процесс.
             */
            const push = (chunk: Uint8Array): boolean => {
                if (closed || controller === null) return false;
                try {
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
                        try {
                            controller.close();
                        } catch {
                            // уже закрыт
                        }
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

            const transport = new SSEServerTransport("/messages", resMock);
            const server = createServer();
            const sessionId = transport.sessionId;

            teardown = async (reason: string): Promise<void> => {
                if (closed) return;
                closed = true;

                if (heartbeat !== null) {
                    clearInterval(heartbeat);
                    heartbeat = null;
                }

                transports.delete(sessionId);

                try {
                    controller?.close();
                } catch {
                    // уже закрыт
                }

                await transport.close().catch(() => undefined);
                await server.close().catch(() => undefined);

                log.info("SSE-сессия закрыта", { sessionId, reason, active: transports.size });
            };

            const session: Session = {
                id: sessionId,
                transport,
                server,
                createdAt: Date.now(),
                close: teardown
            };
            transports.set(sessionId, session);

            try {
                // connect() синхронно вызывает transport.start(): тот выставляет заголовки
                // и кладёт в поток событие endpoint — до того, как мы отдаём Response.
                await server.connect(transport);
            } catch (error) {
                log.error("не удалось поднять MCP-сессию", { sessionId, error: errorMessage(error) });
                await teardown("ошибка инициализации");
                set.status = 500;
                return { error: "Failed to start MCP session" };
            }

            /**
             * КЛЮЧЕВОЙ ФИКС. Без периодических байтов в потоке соединение рвёт первый,
             * кто устал ждать: idleTimeout самого Bun, реверс-прокси, туннель, NAT.
             * Клиент при этом считает сессию живой и получает 404 на следующий вызов тула.
             * `:` — SSE-комментарий, любой корректный парсер его игнорирует.
             */
            if (heartbeatMs > 0) {
                heartbeat = setInterval(() => {
                    push(encoder.encode(": ping\n\n"));
                }, heartbeatMs);
            }

            request.signal.addEventListener("abort", () => {
                void teardown("клиент оборвал запрос");
            });

            log.info("SSE-сессия открыта", { sessionId, active: transports.size, heartbeatMs });

            return new Response(stream, {
                status: 200,
                headers: {
                    ...collectedHeaders,
                    "Content-Type": "text/event-stream",
                    "Cache-Control": "no-cache, no-transform",
                    Connection: "keep-alive",
                    // Запрещает nginx и подобным буферизовать поток — иначе события не доходят.
                    "X-Accel-Buffering": "no",
                    "Access-Control-Allow-Origin": "*"
                }
            });
        })
        .post("/messages", async ({ request, query, body, set }) => {
            const sessionId = typeof query.sessionId === "string" ? query.sessionId : "";
            const session = sessionId ? transports.get(sessionId) : undefined;

            if (!session) {
                set.status = 404;
                log.warn("POST /messages для неизвестной сессии", { sessionId, active: transports.size });
                return {
                    error: "Session not found",
                    hint: "SSE-соединение закрыто или сервер был перезапущен. Переподключись к /sse."
                };
            }

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

            // Не затираем статус, который транспорт уже выставил (400/404/500).
            set.status = statusFromTransport ?? 202;
            return payload ?? "Accepted";
        });

    try {
        app.listen({
            port: listen.port,
            hostname: listen.host,
            // Без этого Bun рвёт молчащий SSE-поток примерно через 10 секунд.
            idleTimeout: config.sse.idleTimeoutSec
        });
    } catch (error) {
        if (errorCode(error) === "EADDRINUSE") {
            console.error(
                `❌ Порт ${listen.port} уже занят.\n` +
                    `   Возможно, NotCode уже запущен. Закрой старый процесс или укажи другой порт:\n` +
                    `   bun run start -- --port ${listen.port + 1}`
            );
            process.exit(1);
        }
        console.error(`❌ Не удалось запустить сервер: ${errorMessage(error)}`);
        process.exit(1);
    }

    let shuttingDown = false;

    const shutdown = async (signal: string): Promise<void> => {
        if (shuttingDown) return;
        shuttingDown = true;

        console.log(`\n🛑 ${signal}: гасим сессии, терминалы и watcher'ы…`);

        // Жёсткий дедлайн: зависший дочерний процесс не должен держать сервер вечно.
        const forceExit = setTimeout(() => {
            log.warn("грациозное завершение не уложилось в 10 с, выходим принудительно");
            process.exit(1);
        }, 10_000);

        try {
            await Promise.all([...transports.values()].map(session => session.close(`сервер остановлен (${signal})`)));
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

    /**
     * Сеть последней защиты. Локальный dev-сервер обязан переживать одиночную ошибку
     * в одной сессии, а не умирать целиком, унося с собой все остальные.
     */
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

    console.log(
        box([
            "🚀 NOTCODE MCP SERVER v2.0 IS RUNNING",
            "-",
            `🛡️  Режим:        ${config.mode.toUpperCase()}`,
            `📁 Воркспейс:    ${config.activeProfile} → ${getWorkspaceRoot(config)}`,
            `🧰 Тулов:         ${toolCount()} (fs / terminal-сессии / git / meta)`,
            `🌐 SSE:           ${baseUrl}/sse`,
            `❤️  Health:        ${baseUrl}/health`,
            `💓 Heartbeat:     ${heartbeatMs > 0 ? `каждые ${Math.round(heartbeatMs / 1000)} с` : "выключен (!)"}`,
            `🔌 Слушаем:       ${listen.host}:${listen.port}`,
            `🔑 Bearer Token:  ${config.token}`,
            "-",
            "📌 Подключение MCP-клиента (Notion AI / Claude / Cursor):",
            "  1. MCP server URL: адрес SSE выше (или HTTPS-адрес твоего реверс-прокси)",
            "  2. Authentication: Bearer token",
            `  3. Token: ${config.token}`
        ])
    );

    if (listen.host === "0.0.0.0" || listen.host === "::") {
        console.warn(
            "⚠️  Сервер слушает все интерфейсы. У него полный доступ к ФС и shell — " +
                "держи его за реверс-прокси с TLS или вернись на 127.0.0.1."
        );
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
