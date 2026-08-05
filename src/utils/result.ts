/** Единый формат ответа тулов MCP + хелперы, чтобы не дублировать try/catch в каждом файле. */

export interface ToolTextContent {
    type: "text";
    text: string;
}

export interface ToolResult {
    content: ToolTextContent[];
    isError: boolean;
}

export function text(value: string): ToolTextContent {
    return { type: "text", text: value };
}

export function ok(message: string): ToolResult {
    return { content: [text(message)], isError: false };
}

export function fail(message: string): ToolResult {
    return { content: [text(message)], isError: true };
}

/** Структурированный ответ: заголовок + JSON. Модели проще парсить, человеку — читать. */
export function okJson(data: unknown, note?: string): ToolResult {
    const body = JSON.stringify(data, null, 2);
    return ok(note ? `${note}\n${body}` : body);
}

export function errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
}

export function fromError(context: string, error: unknown): ToolResult {
    return fail(`${context}: ${errorMessage(error)}`);
}
