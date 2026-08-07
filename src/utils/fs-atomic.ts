/**
 * Атомарная запись файлов: temp-файл рядом с целью + rename.
 *
 * Обычный `Bun.write` поверх существующего файла не атомарен: падение процесса,
 * Ctrl+C или разряженный ноут в середине записи оставляют обрезанный файл.
 * Для config.json и index.jsonl это означало потерю токена и истории снапшотов.
 *
 * rename в пределах одной файловой системы атомарен и на POSIX, и на Windows
 * (MoveFileEx с REPLACE_EXISTING), поэтому temp кладём именно в целевую папку.
 */

import { basename, dirname, join } from "node:path";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";

/** Коды, при которых на Windows имеет смысл повторить rename (антивирус/индексатор держат файл). */
const RETRYABLE = new Set(["EPERM", "EBUSY", "EACCES"]);
const RENAME_ATTEMPTS = 5;

function tempPathFor(path: string): string {
    const unique = `${process.pid.toString(36)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    return join(dirname(path), `.${basename(path)}.${unique}.tmp`);
}

export interface AtomicWriteOptions {
    /** Создавать недостающие родительские папки (по умолчанию true). */
    createDirs?: boolean;
}

export async function writeFileAtomic(
    path: string,
    data: string | Uint8Array,
    options: AtomicWriteOptions = {}
): Promise<void> {
    if (options.createDirs !== false) {
        await mkdir(dirname(path), { recursive: true });
    }

    const tmp = tempPathFor(path);

    try {
        await writeFile(tmp, data);

        for (let attempt = 1; ; attempt++) {
            try {
                await rename(tmp, path);
                return;
            } catch (error) {
                const code = (error as { code?: string }).code;
                if (attempt >= RENAME_ATTEMPTS || code === undefined || !RETRYABLE.has(code)) {
                    throw error;
                }
                await Bun.sleep(20 * attempt);
            }
        }
    } catch (error) {
        await rm(tmp, { force: true }).catch(() => undefined);
        throw error;
    }
}

/** Атомарная запись JSON с человекочитаемым форматированием. */
export async function writeJsonAtomic(path: string, value: unknown, options: AtomicWriteOptions = {}): Promise<void> {
    await writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, options);
}

/** Число байт, которое реально ляжет на диск (Bun.write возвращает его, writeFile — нет). */
export function byteLength(data: string | Uint8Array): number {
    return typeof data === "string" ? Buffer.byteLength(data, "utf8") : data.byteLength;
}
