/** Хелперы форматирования: усечение вывода, срезы по строкам, декодирование текста. */

export interface TruncateResult {
    text: string;
    truncated: boolean;
    originalChars: number;
}

function skipMarker(skipped: number): string {
    return `\n\n… [notcode: пропущено ${skipped} символов] …\n\n`;
}

/**
 * Режет длинный текст, сохраняя начало и конец — там обычно и находится суть (команда + ошибка).
 *
 * Результат гарантированно не длиннее maxChars: служебная плашка входит в бюджет,
 * а не добавляется сверху (раньше усечённый вывод мог превышать лимит).
 */
export function truncate(value: string, maxChars: number): TruncateResult {
    const limit = Math.max(80, Math.trunc(maxChars));

    if (value.length <= limit) {
        return { text: value, truncated: false, originalChars: value.length };
    }

    // Длина маркера с запасом: число пропущенных символов меньше длины исходной строки.
    const reserve = skipMarker(value.length).length;
    const budget = Math.max(40, limit - reserve);
    const head = Math.max(1, Math.floor(budget * 0.7));
    const tail = Math.max(0, budget - head);
    const skipped = value.length - head - tail;

    const text = `${value.slice(0, head)}${skipMarker(skipped)}${tail > 0 ? value.slice(value.length - tail) : ""}`;

    return { text, truncated: true, originalChars: value.length };
}

/**
 * Разбивает текст на строки, СОХРАНЯЯ терминаторы (\n или \r\n) в конце каждой.
 *
 * Это критично: раньше срез делался через split(/\r?\n/) и join("\n"), т.е. CRLF-файл
 * отдавался агенту с LF. Агент копировал фрагмент в oldStr для fs_patch_file,
 * а на диске было \r\n — и патч никогда не находился.
 */
export function splitLinesKeepEol(value: string): string[] {
    if (value.length === 0) return [];
    const parts = value.split(/(?<=\n)/);
    if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
    return parts;
}

/** Преобладающий перевод строки в тексте. */
export function detectEol(value: string): "\r\n" | "\n" {
    const crlf = (value.match(/\r\n/g) ?? []).length;
    if (crlf === 0) return "\n";
    const lf = (value.match(/\n/g) ?? []).length;
    return crlf >= lf - crlf ? "\r\n" : "\n";
}

export interface LineSliceResult {
    text: string;
    totalLines: number;
    startLine: number;
    endLine: number;
    partial: boolean;
    /** lineStart указывает за пределы файла — вызывающий код должен сообщить об этом, а не молчать. */
    outOfRange: boolean;
}

export function sliceLines(
    value: string,
    options: { lineStart?: number | undefined; lineCount?: number | undefined } = {}
): LineSliceResult {
    const lines = splitLinesKeepEol(value);
    const totalLines = lines.length;
    const requestedStart = Math.max(1, Math.trunc(options.lineStart ?? 1));

    if (totalLines === 0) {
        return { text: "", totalLines: 0, startLine: 0, endLine: 0, partial: false, outOfRange: requestedStart > 1 };
    }

    if (requestedStart > totalLines) {
        return {
            text: "",
            totalLines,
            startLine: requestedStart,
            endLine: requestedStart - 1,
            partial: true,
            outOfRange: true
        };
    }

    const from = requestedStart - 1;
    const count = Math.max(1, Math.trunc(options.lineCount ?? totalLines));
    const slice = lines.slice(from, from + count);

    // Последний перевод строки срезаем: он всегда добавляет пустую строку в выводе.
    const text = slice.join("").replace(/\r?\n$/, "");

    return {
        text,
        totalLines,
        startLine: from + 1,
        endLine: from + slice.length,
        partial: from > 0 || slice.length < totalLines,
        outOfRange: false
    };
}

export interface DecodedText {
    text: string;
    encoding: "utf-8" | "utf-16le" | "utf-16be";
    hadBom: boolean;
}

function hasBom(bytes: Uint8Array, ...signature: number[]): boolean {
    if (bytes.length < signature.length) return false;
    return signature.every((byte, index) => bytes[index] === byte);
}

/**
 * Ручное декодирование UTF-16: рантаймовый TextDecoder в Bun не гарантирует эти метки,
 * а падать на файле из PowerShell — не вариант.
 */
function decodeUtf16(bytes: Uint8Array, littleEndian: boolean): string {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const units: number[] = [];
    for (let offset = 0; offset + 1 < view.byteLength; offset += 2) {
        units.push(view.getUint16(offset, littleEndian));
    }

    // Собираем чанками: fromCharCode(...) на сотнях тысяч аргументов переполняет стек.
    const CHUNK = 8192;
    let text = "";
    for (let index = 0; index < units.length; index += CHUNK) {
        text += String.fromCharCode(...units.slice(index, index + CHUNK));
    }
    return text;
}

/**
 * Декодирует текст с учётом BOM.
 * PowerShell по умолчанию пишет файлы в UTF-16LE — раньше они отвергались как «бинарник».
 */
export function decodeText(bytes: Uint8Array): DecodedText {
    if (hasBom(bytes, 0xff, 0xfe)) {
        return { text: decodeUtf16(bytes.subarray(2), true), encoding: "utf-16le", hadBom: true };
    }
    if (hasBom(bytes, 0xfe, 0xff)) {
        return { text: decodeUtf16(bytes.subarray(2), false), encoding: "utf-16be", hadBom: true };
    }
    if (hasBom(bytes, 0xef, 0xbb, 0xbf)) {
        return { text: new TextDecoder("utf-8").decode(bytes.subarray(3)), encoding: "utf-8", hadBom: true };
    }
    return { text: new TextDecoder("utf-8").decode(bytes), encoding: "utf-8", hadBom: false };
}

/**
 * Эвристика: нулевой байт в первых килобайтах => бинарник.
 * Исключение — текст в UTF-16 с BOM: там нулевые байты штатны.
 */
export function looksBinary(bytes: Uint8Array): boolean {
    if (hasBom(bytes, 0xff, 0xfe) || hasBom(bytes, 0xfe, 0xff)) return false;

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
    return `${unit === 0 ? value : value.toFixed(1)} ${units[unit] ?? "B"}`;
}

export function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    const minutes = Math.floor(ms / 60_000);
    const seconds = Math.round((ms % 60_000) / 1000);
    return `${minutes}m ${seconds}s`;
}
