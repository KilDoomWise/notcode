import { Elysia } from "elysia";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { createServer, toolCount } from "@/mcp";
import {
    CONFIG_FILE,
    getProfile,
    getWorkspaceRoot,
    loadConfig,
    saveConfig,
    type NotCodeConfig,
    type SecurityMode
} from "@/config";
import { readAudit } from "@/utils/audit";
import { terminals } from "@/utils/terminal-manager";
import { watchers } from "@/utils/watch-manager";

type Session = { transport: SSEServerTransport; server: ReturnType<typeof createServer> };

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

async function runCli(): Promise<void> {
    const args = process.argv.slice(2);
    const command = args[0] ?? "start";
    const config = await loadConfig();

    switch (command) {
        case "start":
            startServer(config);
            return;

        case "mode": {
            const newMode = args[1] as SecurityMode | undefined;
            if (!newMode || !["paranoic", "auto", "bypass"].includes(newMode)) {
                console.error("❌ Укажи корректный режим: paranoic | auto | bypass");
                process.exit(1);
            }
            config.mode = newMode;
            await saveConfig(config);
            console.log(`✅ Режим безопасности: [${newMode.toUpperCase()}]`);
            process.exit(0);
        }

        case "allow": {
            const targetPath = args[1];
            if (!targetPath) {
                console.error("❌ Укажи путь к папке");
                process.exit(1);
            }
            const absPath = resolve(getWorkspaceRoot(config), targetPath);
            const profile = getProfile(config);
            if (!profile.allowedPaths.includes(absPath)) profile.allowedPaths.push(absPath);
            await saveConfig(config);
            console.log(`✅ Разрешено (профиль ${profile.name}): ${absPath}`);
            process.exit(0);
        }

        case "token": {
            if (args[1] === "--reset") {
                config.token = crypto.randomUUID();
                await saveConfig(config);
                console.log("🔄 Сгенерирован новый токен!");
            }
            console.log(`🔑 Bearer Token: ${config.token}`);
            process.exit(0);
        }

        case "workspace": {
            const sub = args[1] ?? "list";
            if (sub === "list") {
                for (const profile of config.profiles) {
                    const active = profile.name === config.activeProfile ? "*" : " ";
                    console.log(`${active} ${profile.name.padEnd(16)} ${profile.root}`);
                }
            } else if (sub === "use" && args[2]) {
                if (!config.profiles.some(profile => profile.name === args[2])) {
                    console.error(`❌ Профиль '${args[2]}' не найден`);
                    process.exit(1);
                }
                config.activeProfile = args[2] as string;
                await saveConfig(config);
                console.log(`✅ Активный воркспейс: ${args[2]} → ${getWorkspaceRoot(config)}`);
            } else if (sub === "add" && args[2] && args[3]) {
                const root = resolve(args[3] as string);
                const name = args[2] as string;
                const existing = config.profiles.find(profile => profile.name === name);
                if (existing) existing.root = root;
                else config.profiles.push({ name, root, allowedPaths: [] });
                await saveConfig(config);
                console.log(`✅ Профиль '${name}' → ${root}`);
            } else {
                console.log("Использование: workspace list | workspace use <name> | workspace add <name> <path>");
            }
            process.exit(0);
        }

        case "status": {
            console.log(
                box([
                    `NOTCODE STATUS`,
                    "-",
                    `Режим:        ${config.mode.toUpperCase()}`,
                    `Воркспейс:   ${config.activeProfile} → ${getWorkspaceRoot(config)}`,
                    `Разрешено:    ${getProfile(config).allowedPaths.length} доп. папок`,
                    `Тулов:        ${toolCount()}`,
                    `Аудит:        ${config.audit.enabled ? "вкл" : "выкл"} (max ${config.audit.maxEntries})`,
                    `Снапшоты:    ${config.snapshots.enabled ? "вкл" : "выкл"} (${config.snapshots.keepPerFile} на файл)`,
                    `Конфиг:       ${CONFIG_FILE}`
                ])
            );
            process.exit(0);
        }

        case "audit": {
            const limit = Number.parseInt(args[1] ?? "20", 10);
            const entries = await readAudit({ limit: Number.isFinite(limit) ? limit : 20 });
            if (entries.length === 0) console.log("Аудит-лог пуст.");
            for (const entry of entries) {
                console.log(`${entry.ts}  ${entry.ok ? "OK  " : "FAIL"}  ${entry.tool.padEnd(16)} ${entry.action.padEnd(11)} ${entry.target ?? ""}`);
            }
            process.exit(0);
        }

        default: {
            console.log(`
Использование: bun run src/index.ts <command>

Команды:
  start                        Запустить MCP сервер NotCode
  status                       Показать текущие настройки
  mode <type>                  Режим безопасности (paranoic | auto | bypass)
  allow <path>                 Разрешить доступ к папке (для auto)
  token [--reset]              Посмотреть / пересоздать токен
  workspace list|use|add       Профили проектов (свой root у каждого)
  audit [n]                    Последние n записей аудит-лога
            `);
            process.exit(0);
        }
    }
}

function startServer(config: NotCodeConfig): void {
    const app = new Elysia()
        .onRequest(({ request, set }) => {
            set.headers["Access-Control-Allow-Origin"] = "*";
            set.headers["Access-Control-Allow-Headers"] = "*";
            set.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";

            if (request.method === "OPTIONS") return;
            if (new URL(request.url).pathname === "/health") return;

            const authHeader = request.headers.get("authorization");
            const token = authHeader?.replace(/^Bearer\s+/i, "").trim();

            if (!token || !safeEqual(token, config.token)) {
                set.status = 401;
                return "Unauthorized: Invalid or missing Bearer token";
            }
        })
        .options("*", ({ set }) => {
            set.status = 204;
            return "";
        })
        .get("/health", () => ({
            status: "ok",
            name: "notcode",
            version: "2.0.0",
            mode: config.mode,
            tools: toolCount(),
            sessions: transports.size,
            terminals: terminals.list().length,
            watchers: watchers.list().length,
            workspaceRoot: getWorkspaceRoot(config)
        }))
        .get("/sse", ({ request, set }) => {
            let streamController: ReadableStreamDefaultController;
            const body = new ReadableStream({
                start(controller) {
                    streamController = controller;
                }
            });

            const resMock = {
                writeHead: (statusCode: number, headers?: Record<string, string>) => {
                    set.status = statusCode;
                    if (headers) {
                        for (const [key, value] of Object.entries(headers)) {
                            set.headers[key] = sanitizeHeader(value);
                        }
                    }
                    return resMock;
                },
                write: (chunk: string | Uint8Array) => {
                    const data = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
                    streamController.enqueue(data);
                    return true;
                },
                end: () => {
                    try {
                        streamController.close();
                    } catch {
                        // уже закрыт
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

            transports.set(sessionId, { transport, server });

            request.signal.addEventListener("abort", () => {
                const session = transports.get(sessionId);
                if (session) {
                    void session.server.close().catch(() => undefined);
                    transports.delete(sessionId);
                }
            });

            server.connect(transport).catch(console.error);

            return new Response(body, {
                headers: {
                    "Content-Type": "text/event-stream",
                    "Cache-Control": "no-cache",
                    Connection: "keep-alive"
                }
            });
        })
        .post("/messages", async ({ request, query, body, set }) => {
            const sessionId = query.sessionId as string;

            if (!sessionId || !transports.has(sessionId)) {
                set.status = 404;
                return { error: "Session not found" };
            }

            const session = transports.get(sessionId)!;

            const reqMock = {
                method: "POST",
                headers: {
                    "content-type": sanitizeHeader(request.headers.get("content-type") || "application/json")
                },
                on: () => {}
            } as unknown as IncomingMessage;

            const resMock = {
                writeHead: (statusCode: number) => {
                    set.status = statusCode;
                    return resMock;
                },
                end: () => resMock
            } as unknown as ServerResponse;

            await session.transport.handlePostMessage(reqMock, resMock, body);

            set.status = 202;
            return "Accepted";
        })
        .listen({ port: config.port, hostname: config.host });

    const shutdown = async (signal: string): Promise<void> => {
        console.log(`\n🛑 ${signal}: гасим терминалы и watcher'ы…`);
        await terminals.closeAll();
        watchers.stopAll();
        for (const session of transports.values()) {
            await session.server.close().catch(() => undefined);
        }
        await app.stop();
        process.exit(0);
    };

    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));

    console.log(
        box([
            "🚀 NOTCODE MCP SERVER v2.0 IS RUNNING",
            "-",
            `🛡️  Режим:        ${config.mode.toUpperCase()}`,
            `📁 Воркспейс:    ${config.activeProfile} → ${getWorkspaceRoot(config)}`,
            `🧰 Тулов:         ${toolCount()} (fs / terminal-сессии / git / meta)`,
            `🌐 SSE:           http://${config.host}:${config.port}/sse`,
            `❤️  Health:        http://${config.host}:${config.port}/health`,
            `🔑 Bearer Token:  ${config.token}`,
            "-",
            "📌 Подключение MCP-клиента (Notion AI / Claude / Cursor):",
            "  1. MCP server URL: адрес SSE выше (или HTTPS-адрес твоего реверс-прокси)",
            "  2. Authentication: Bearer token",
            `  3. Token: ${config.token}`
        ])
    );
}

void runCli();
