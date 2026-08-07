/** Хелперы форматирования: усечение вывода, срезы по строкам, определение бинарников. */

export interface TruncateResult {
    text: string;
    truncated: boolean;
    originalChars: number;
}

/** Режет длинный текст, сохраняя начало и конец — там обычно и находится суть (команда + ошибка). */
export function truncate(value: string, maxChars: number): TruncateResult {
    if (value.length <= maxChars) {
        return { text: value, truncated: false, originalChars: value.length };
    }

    const head = Math.max(1, Math.floor(maxChars * 0.7));
    const tail = Math.max(0, maxChars - head);
    const skipped = value.length - head - tail;
    const tailPart = tail > 0 ? value.slice(value.length - tail) : "";

    return {
        text: `${value.slice(0, head)}\n\n… [notcode: пропущено ${skipped} символов] …\n\n${tailPart}`,
        truncated: true,
        originalChars: value.length
    };
}

export interface LineSliceResult {
    text: string;
    totalLines: number;
    startLine: number;
    endLine: number;
    partial: boolean;
}

export function sliceLines(value: string, options: { lineStart?: number; lineCount?: number } = {}): LineSliceResult {
    const lines = value.split(/\r?\n/);
    const totalLines = lines.length;
    const requestedStart = Math.max(1, options.lineStart ?? 1);
    const from = Math.min(requestedStart - 1, Math.max(totalLines - 1, 0));
    const count = Math.max(1, options.lineCount ?? totalLines);
    const slice = lines.slice(from, from + count);

    return {
        text: slice.join("\n"),
        totalLines,
        startLine: from + 1,
        endLine: from + slice.length,
        partial: from > 0 || slice.length < totalLines
    };
}

/** Эвристика: нулевой байт в первых килобайтах => бинарник, текстом отдавать нельзя. */
export function looksBinary(bytes: Uint8Array): boolean {
    const limit = Math.min(bytes.length, 8000);
    for (let i = 0; i < limit; i++) {
        if (bytes[i] === 0) return true;
    }
    return false;
}

export function formatBytes(bytes: number): string {
    const units = ["B", "KB", "MB", "GB"];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

export function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    const minutes = Math.floor(ms / 60_000);
    const seconds = Math.round((ms % 60_000) / 1000);
    return `${minutes}m ${seconds}s`;
}

const CMD_META_CHARS = /([()%!^"<>&|;,])/g;

/**
 * Экранирование аргумента для cmd.exe, когда команда идёт через .cmd-скрипт (см. utils/shell.ts).
 * cmd.exe перетокенизирует строку скрипта дважды (сам .cmd, затем целевая программа), поэтому
 * простое "оберни в кавычки и заэкранируй \" бэкслешем" (старое поведение) ломается на любом
 * значении с кавычкой внутри (например, в сообщении git-коммита). Алгоритм ниже — тот же,
 * которым эту проблему решает cross-spawn для .bat/.cmd файлов: экранируем кавычки с учётом
 * хвостовых бэкслешей, оборачиваем в кавычки, затем экранируем метасимволы cmd.exe через `^`.
 * Там, где можно, предпочитай runArgv() (utils/shell.ts) — argv-спавн вообще не требует
 * квотирования и не подвержен этой проблеме.
 */
export function quoteForCmd(value: string): string {
    let arg = value.replace(/(\\*)"/g, '$1$1\\"');
    arg = arg.replace(/(\\*)$/, "$1$1");
    arg = `"${arg}"`;
    return arg.replace(CMD_META_CHARS, "^$1");
}

/** Экранирование для PowerShell: одинарные кавычки — единственный настоящий литеральный синтаксис
 *  (двойные кавычки в PowerShell всё ещё интерполируют $переменные и обратные апострофы). */
export function quoteForPowerShell(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

/** Экранирование для POSIX sh/bash: одинарные кавычки с классическим выходом для встроенных `'`. */
export function quoteForPosixSh(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}
