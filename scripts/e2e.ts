/**
 * E2E-проверка ЖИВОГО транспорта, а не тулов по отдельности.
 *
 * Именно здесь ловится главная жалоба пользователей «Failed to connect to MCP server / работает пару минут и сдох»:
 * без heartbeat SSE-соединение рвалось по idle-таймауту. Смок-тест это пропускает, потому что дёргает handler'ы напрямую.
 *
 * Запуск: bun run e2e   (поднимает СВОЙ сервер на отдельном порту, рабочий на 3000 не трогает)
 */
import { loadConfig } from "@/config";
import { terminateProcess } from "@/utils/proc";

const PORT = Number(process.env.E2E_PORT ?? 3999);
const HOST = "127.0.0.1";
const BASE = `http://${HOST}:${PORT}`;
const BOOT_TIMEOUT_MS = 20_000;
const RPC_TIMEOUT_MS = 15_000;
/** При heartbeatMs = 15 000 первый ping обязан прийти раньше этого срока. */
const HEARTBEAT_TIMEOUT_MS = 25_000;

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, info = ""): void {
    if (condition) {
        passed++;
        console.log(`\u2705 ${name}`);
    } else {
        failed++;
        console.log(`\u274c ${name}${info ? `\n   ${info.slice(0, 600)}` : ""}`);
    }
}

interface SseFrame {
    event: string;
    data: string;
}

interface JsonRpcMessage {
    jsonrpc: string;
    id?: number | string;
    result?: Record<string, unknown>;
    error?: { code: number; message: string };
    method?: string;
}

/** Структурный минимум от ридера потока: типы web-stream и bun-stream различаются деталями. */
interface StreamReader {
    read(): Promise<{ done: boolean; value?: Uint8Array | undefined }>;
    cancel(): Promise<void>;
}

/** Минимальный SSE-клиент: копит кадры и комментарии-heartbeat в очередь. */
class SseClient {
    readonly frames: SseFrame[] = [];
    comments = 0;
    closed = false;
    error: string | null = null;

    private buffer = "";

    constructor(private readonly reader: StreamReader) {
        void this.pump();
    }

    private async pump(): Promise<void> {
        const decoder = new TextDecoder();
        try {
            for (;;) {
                const { done, value } = await this.reader.read();
                if (done || !value) break;
                this.buffer += decoder.decode(value, { stream: true });

                let separator = this.buffer.indexOf("\n\n");
                while (separator !== -1) {
                    this.consume(this.buffer.slice(0, separator));
                    this.buffer = this.buffer.slice(separator + 2);
                    separator = this.buffer.indexOf("\n\n");
                }

                // Heartbeat приходит как комментарий ": ping\n\n", но может прийти и кусками.
                if (this.buffer.startsWith(":") && this.buffer.includes("\n")) {
                    this.comments++;
                    this.buffer = this.buffer.slice(this.buffer.indexOf("\n") + 1);
                }
            }
        } catch (error) {
            this.error = error instanceof Error ? error.message : String(error);
        } finally {
            this.closed = true;
        }
    }

    private consume(chunk: string): void {
        const trimmed = chunk.replace(/\r/g, "");
        if (trimmed.trim().length === 0) return;

        if (trimmed.startsWith(":")) {
            this.comments++;
            return;
        }

        let event = "message";
        const dataLines: string[] = [];

        for (const line of trimmed.split("\n")) {
            if (line.startsWith(":")) {
                this.comments++;
            } else if (line.startsWith("event:")) {
                event = line.slice(6).trim();
            } else if (line.startsWith("data:")) {
                dataLines.push(line.slice(5).trim());
            }
        }

        if (dataLines.length > 0) this.frames.push({ event, data: dataLines.join("\n") });
    }

    async waitForFrame(predicate: (frame: SseFrame) => boolean, timeoutMs: number): Promise<SseFrame | null> {
        const deadline = Date.now() + timeoutMs;
        let cursor = 0;
        for (;;) {
            while (cursor < this.frames.length) {
                const frame = this.frames[cursor++];
                if (frame && predicate(frame)) return frame;
            }
            if (Date.now() > deadline || this.closed) return null;
            await Bun.sleep(50);
        }
    }

    async waitForHeartbeat(timeoutMs: number): Promise<boolean> {
        const start = this.comments;
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (this.comments > start) return true;
            if (this.closed) return false;
            await Bun.sleep(200);
        }
        return false;
    }

    async close(): Promise<void> {
        try {
            await this.reader.cancel();
        } catch {
            // уже закрыт
        }
    }
}

async function waitForServer(): Promise<boolean> {
    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) });
            if (response.ok) return true;
        } catch {
            // ещё поднимается
        }
        await Bun.sleep(250);
    }
    return false;
}

async function main(): Promise<void> {
    const config = await loadConfig();

    console.log(`\n\u2500\u2500 NotCode E2E (живой SSE) \u2500\u2500\nпорт: ${PORT}\nheartbeat: ${config.sse.heartbeatMs} ms\n`);

    const server = Bun.spawn(["bun", "run", "src/index.ts", "start"], {
        env: {
            ...process.env,
            NOTCODE_PORT: String(PORT),
            NOTCODE_HOST: HOST,
            NOTCODE_LOG_LEVEL: "warn"
        },
        stdout: "pipe",
        stderr: "pipe"
    });

    let sse: SseClient | null = null;

    try {
        const up = await waitForServer();
        check("сервер поднялся и отвечает на /health", up);
        if (!up) return;

        const noAuth = await fetch(`${BASE}/sse`, { headers: { Accept: "text/event-stream" } });
        check("/sse без токена отвечает 401", noAuth.status === 401, `status=${noAuth.status}`);
        await noAuth.body?.cancel();

        const response = await fetch(`${BASE}/sse`, {
            headers: {
                Accept: "text/event-stream",
                Authorization: `Bearer ${config.token}`
            }
        });
        check("/sse с токеном отдаёт 200", response.ok, `status=${response.status}`);
        check(
            "Content-Type правильный",
            (response.headers.get("content-type") ?? "").includes("text/event-stream"),
            response.headers.get("content-type") ?? ""
        );
        check(
            "отключён прокси-буферинг (X-Accel-Buffering)",
            response.headers.get("x-accel-buffering") === "no",
            response.headers.get("x-accel-buffering") ?? "нет заголовка"
        );

        const body = response.body;
        if (!body) {
            check("у SSE-ответа есть тело", false);
            return;
        }

        sse = new SseClient(body.getReader());

        const endpointFrame = await sse.waitForFrame(frame => frame.event === "endpoint", RPC_TIMEOUT_MS);
        check("пришёл event: endpoint", endpointFrame !== null);
        if (!endpointFrame) return;

        const endpoint = endpointFrame.data.startsWith("http") ? endpointFrame.data : `${BASE}${endpointFrame.data}`;
        check("endpoint содержит sessionId", endpoint.includes("sessionId="), endpoint);

        const send = async (payload: Record<string, unknown>): Promise<number> => {
            const result = await fetch(endpoint, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${config.token}`
                },
                body: JSON.stringify(payload)
            });
            await result.body?.cancel();
            return result.status;
        };

        const initStatus = await send({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
                protocolVersion: "2024-11-05",
                capabilities: {},
                clientInfo: { name: "notcode-e2e", version: "1.0.0" }
            }
        });
        check("POST /messages принят", initStatus >= 200 && initStatus < 300, `status=${initStatus}`);

        const initFrame = await sse.waitForFrame(frame => frame.data.includes('"id":1'), RPC_TIMEOUT_MS);
        check("пришёл ответ на initialize", initFrame !== null);

        const serverInfo = initFrame ? (JSON.parse(initFrame.data) as JsonRpcMessage).result : undefined;
        check("initialize вернул serverInfo", serverInfo !== undefined && "serverInfo" in serverInfo);

        await send({ jsonrpc: "2.0", method: "notifications/initialized" });

        await send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
        const toolsFrame = await sse.waitForFrame(frame => frame.data.includes('"id":2'), RPC_TIMEOUT_MS);
        check("tools/list ответил", toolsFrame !== null);

        if (toolsFrame) {
            const parsed = JSON.parse(toolsFrame.data) as JsonRpcMessage;
            const tools = (parsed.result?.tools ?? []) as Array<{ name: string; annotations?: unknown }>;
            check(`тулов в списке: ${tools.length}`, tools.length >= 30, JSON.stringify(tools.map(t => t.name)));
            check(
                "annotations доехали до клиента",
                tools.every(tool => tool.annotations !== undefined),
                JSON.stringify(tools.filter(tool => tool.annotations === undefined).map(tool => tool.name))
            );
        }

        await send({
            jsonrpc: "2.0",
            id: 3,
            method: "tools/call",
            params: { name: "notcode_status", arguments: {} }
        });
        const statusFrame = await sse.waitForFrame(frame => frame.data.includes('"id":3'), RPC_TIMEOUT_MS);
        check("notcode_status выполнился через живой транспорт", statusFrame !== null);
        if (statusFrame) {
            check("ответ содержит workspaceRoot", statusFrame.data.includes("workspaceRoot"), statusFrame.data.slice(0, 300));
        }

        // ГЛАВНАЯ ПРОВЕРКА: соединение живёт без трафика и сервер сам шлёт ping.
        console.log(`\nЖдём heartbeat до ${HEARTBEAT_TIMEOUT_MS / 1000} с без единого запроса…`);
        const gotHeartbeat = await sse.waitForHeartbeat(HEARTBEAT_TIMEOUT_MS);
        check("SSE присылает heartbeat (лечит 'работает пару минут и сдох')", gotHeartbeat);
        check("соединение всё ещё открыто", !sse.closed, sse.error ?? "");

        // И после идла сервер всё ещё отвечает на вызовы.
        await send({ jsonrpc: "2.0", id: 4, method: "tools/list" });
        const afterIdle = await sse.waitForFrame(frame => frame.data.includes('"id":4'), RPC_TIMEOUT_MS);
        check("после простоя сессия жива", afterIdle !== null);

        const badPost = await fetch(`${BASE}/messages?sessionId=неттакой`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.token}` },
            body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" })
        });
        check("неизвестная сессия → 404 без падения сервера", badPost.status === 404, `status=${badPost.status}`);
        await badPost.body?.cancel();

        const stillAlive = await fetch(`${BASE}/health`);
        check("сервер жив после всех ошибочных сценариев", stillAlive.ok);
        await stillAlive.body?.cancel();
    } finally {
        await sse?.close();
        await terminateProcess(server, { graceMs: 1000 });
    }
}

try {
    await main();
} catch (error) {
    failed++;
    console.log(`\u274c E2E упал: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
}

console.log(`\n\u2500\u2500 Итог E2E: ${passed} прошло, ${failed} упало \u2500\u2500\n`);
process.exit(failed > 0 ? 1 : 0);
