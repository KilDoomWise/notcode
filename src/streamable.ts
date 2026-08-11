import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

/**
 * Транспорт без сети: сообщение приходит прямо из HTTP-хендлера, ответ уезжает в колбэк.
 *
 * Нужен для stateless Streamable HTTP: на каждый POST /mcp поднимается свой MCP-сервер,
 * поэтому нет ни долгоживущего SSE-стрима, ни sessionId, который может протухнуть.
 */
class InlineTransport implements Transport {
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: Transport["onmessage"];
    sessionId?: string;

    constructor(private readonly emit: (message: JSONRPCMessage) => void) {}

    async start(): Promise<void> {
        // Нечего запускать: входящие сообщения подаются вручную через deliver().
    }

    async send(message: JSONRPCMessage): Promise<void> {
        this.emit(message);
    }

    async close(): Promise<void> {
        this.onclose?.();
    }

    deliver(message: JSONRPCMessage): void {
        this.onmessage?.(message);
    }
}

export type StreamableResult = {
    status: number;
    /** null — тело не нужно (например, 202 на чистые нотификации). */
    body: unknown | null;
};

function messageId(message: unknown): string | null {
    const id = (message as { id?: unknown } | null)?.id;
    return id === undefined || id === null ? null : String(id);
}

export function jsonRpcError(status: number, code: number, message: string): StreamableResult {
    return {
        status,
        body: { jsonrpc: "2.0", id: null, error: { code, message } }
    };
}

/**
 * Обрабатывает один POST /mcp по спеке Streamable HTTP в stateless-режиме.
 *
 * На каждый запрос создаётся свежий MCP-сервер, поэтому клиенту не нужен mcp-session-id,
 * а обрыв соединения больше не приводит к 404 "Session not found", как это было с legacy SSE.
 */
export async function handleStreamableRequest(
    createServer: () => McpServer,
    payload: unknown,
    timeoutMs: number
): Promise<StreamableResult> {
    const isBatch = Array.isArray(payload);
    const messages = (isBatch ? payload : [payload]) as JSONRPCMessage[];

    if (messages.length === 0 || messages.some(message => typeof message !== "object" || message === null)) {
        return jsonRpcError(400, -32600, "Invalid Request: expected a JSON-RPC message or a non-empty batch");
    }

    const pending = new Set<string>();
    for (const message of messages) {
        const id = messageId(message);
        if (id !== null) pending.add(id);
    }

    const responses: JSONRPCMessage[] = [];
    let settle: () => void = () => undefined;
    const completed = new Promise<void>(resolve => {
        settle = resolve;
    });

    const transport = new InlineTransport(message => {
        const id = messageId(message);
        // Серверные нотификации в stateless-режиме отдавать некуда — ответом идут только результаты запросов.
        if (id === null) return;
        responses.push(message);
        pending.delete(id);
        if (pending.size === 0) settle();
    });

    const server = createServer();
    await server.connect(transport);

    try {
        const expectsResponse = pending.size > 0;
        for (const message of messages) transport.deliver(message);

        // Только нотификации (например, notifications/initialized) — по спеке отвечаем 202 без тела.
        if (!expectsResponse) return { status: 202, body: null };

        const timer = setTimeout(settle, timeoutMs);
        await completed;
        clearTimeout(timer);

        if (responses.length === 0) {
            return jsonRpcError(504, -32001, `Request timed out after ${timeoutMs} ms`);
        }

        return { status: 200, body: isBatch ? responses : responses[0] };
    } finally {
        await server.close().catch(() => undefined);
    }
}
