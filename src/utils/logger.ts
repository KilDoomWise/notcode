/**
 * Минималистичный структурированный логгер.
 *
 * Пишет ТОЛЬКО в stderr: stdout зарезервирован под возможный stdio-транспорт MCP,
 * и любая посторонняя запись туда ломает протокол.
 *
 * Уровень задаётся переменной окружения NOTCODE_LOG_LEVEL
 * (debug | info | warn | error | silent), по умолчанию info.
 */

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const ORDER: Record<LogLevel, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
    silent: 100
};

function parseLevel(value: string | undefined): LogLevel | null {
    if (!value) return null;
    const normalized = value.trim().toLowerCase();
    return normalized in ORDER ? (normalized as LogLevel) : null;
}

let currentLevel: LogLevel = parseLevel(process.env.NOTCODE_LOG_LEVEL) ?? "info";

export function setLogLevel(level: LogLevel): void {
    currentLevel = level;
}

export function getLogLevel(): LogLevel {
    return currentLevel;
}

export interface ErrorInfo {
    name: string;
    message: string;
    code?: string;
    stack?: string;
}

/** Приводит любое брошенное значение к предсказуемой форме (throw умеет кидать что угодно). */
export function describeError(error: unknown): ErrorInfo {
    if (error instanceof Error) {
        const info: ErrorInfo = { name: error.name, message: error.message };
        const code = (error as { code?: unknown }).code;
        if (typeof code === "string") info.code = code;
        if (typeof error.stack === "string") info.stack = error.stack;
        return info;
    }
    if (typeof error === "string") return { name: "Error", message: error };
    return { name: "UnknownError", message: safeStringify(error) };
}

export function errorMessage(error: unknown): string {
    return describeError(error).message;
}

/** Код ошибки node/bun (ENOENT, EADDRINUSE, ...), если он есть. */
export function errorCode(error: unknown): string | undefined {
    return describeError(error).code;
}

function safeStringify(value: unknown): string {
    try {
        return JSON.stringify(value, replacer) ?? String(value);
    } catch {
        return "[unserializable]";
    }
}

function replacer(_key: string, value: unknown): unknown {
    if (value instanceof Error) {
        const { stack: _stack, ...rest } = describeError(value);
        return rest;
    }
    if (typeof value === "bigint") return value.toString();
    return value;
}

function inspect(detail: unknown): string {
    if (detail === undefined) return "";
    if (detail instanceof Error) return ` ${safeStringify(detail)}`;
    return ` ${safeStringify(detail)}`;
}

function emit(level: LogLevel, scope: string, message: string, detail?: unknown): void {
    if (ORDER[level] < ORDER[currentLevel]) return;
    const stamp = new Date().toISOString();
    const line = `${stamp} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}${inspect(detail)}\n`;
    try {
        process.stderr.write(line);
    } catch {
        // stderr может быть закрыт при завершении процесса — логирование не должно ничего ронять
    }
}

export interface Logger {
    debug(message: string, detail?: unknown): void;
    info(message: string, detail?: unknown): void;
    warn(message: string, detail?: unknown): void;
    error(message: string, detail?: unknown): void;
    child(suffix: string): Logger;
}

export function createLogger(scope: string): Logger {
    return {
        debug: (message, detail) => emit("debug", scope, message, detail),
        info: (message, detail) => emit("info", scope, message, detail),
        warn: (message, detail) => emit("warn", scope, message, detail),
        error: (message, detail) => emit("error", scope, message, detail),
        child: suffix => createLogger(`${scope}:${suffix}`)
    };
}

export const log: Logger = createLogger("notcode");
