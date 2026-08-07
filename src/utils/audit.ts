import { appendFile, readFile, stat } from "node:fs/promises";
import { AUDIT_FILE, ensureConfigDirs, loadConfig, type NotCodeConfig } from "@/config";
import { writeFileAtomic } from "@/utils/fs-atomic";
import { Mutex } from "@/utils/lock";
import { createLogger, errorMessage } from "@/utils/logger";

const log = createLogger("audit");

/**
 * Аудит-лог: компромисс для bypass-режима — агент ничего не спрашивает,
 * но каждое изменяющее действие остаётся в истории (JSONL в ~/.notcode/audit.jsonl).
 *
 * Все записи сериализованы мьютексом: параллельные appendFile больших строк
 * не атомарны и бьют JSONL, а ротация поверх чужого append теряет записи.
 *
 * Ротация опирается на РАЗМЕР файла, а не только на счётчик записей в памяти:
 * при перезапуске сервера чаще, чем раз в 200 записей, счётчик обнулялся и подрезка
 * не выполнялась вообще — файл рос бесконечно. Поэтому один раз за жизнь процесса
 * проверка делается принудительно.
 */
export interface AuditEntry {
    ts: string;
    tool: string;
    action: string;
    target?: string;
    ok: boolean;
    detail?: Record<string, unknown>;
}

export interface AuditTrimResult {
    trimmed: boolean;
    bytesBefore: number;
    bytesAfter: number;
    entriesKept: number;
}

/** Жёсткий потолок на размер одной записи: detail не должен раздувать журнал на мегабайты. */
const MAX_LINE_CHARS = 8_000;
const CHECK_EVERY_APPENDS = 200;
/** Грубая оценка средней длины строки — чтобы не читать файл целиком без нужды. */
const APPROX_BYTES_PER_ENTRY = 200;

const writeMutex = new Mutex();

let appendsSinceCheck = 0;
let checkedThisRun = false;

function serialize(entry: AuditEntry): string {
    let line = JSON.stringify(entry);
    if (line.length <= MAX_LINE_CHARS) return line;

    // Лучше потерять detail, чем строку целиком.
    line = JSON.stringify({
        ...entry,
        detail: { truncated: true, originalChars: line.length }
    } satisfies AuditEntry);

    return line.length <= MAX_LINE_CHARS ? line : JSON.stringify({ ...entry, detail: undefined });
}

export async function audit(entry: Omit<AuditEntry, "ts">): Promise<void> {
    try {
        const config = await loadConfig();
        if (!config.audit.enabled) return;

        await ensureConfigDirs();

        const line = serialize({ ts: new Date().toISOString(), ...entry });

        await writeMutex.run(async () => {
            await appendFile(AUDIT_FILE, `${line}\n`, "utf8");

            appendsSinceCheck++;
            if (!checkedThisRun || appendsSinceCheck >= CHECK_EVERY_APPENDS) {
                checkedThisRun = true;
                appendsSinceCheck = 0;
                await trimUnlocked(config);
            }
        });
    } catch (error) {
        // Аудит не имеет права ломать основную операцию — но молчать о проблеме тоже нельзя.
        log.warn("не удалось записать аудит", { tool: entry.tool, error: errorMessage(error) });
    }
}

export async function readAudit(
    options: { limit?: number; tool?: string; onlyErrors?: boolean } = {}
): Promise<AuditEntry[]> {
    const limit = options.limit ?? 50;

    let raw = "";
    try {
        raw = await readFile(AUDIT_FILE, "utf8");
    } catch {
        return [];
    }

    const entries: AuditEntry[] = [];
    let broken = 0;

    for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
            entries.push(JSON.parse(line) as AuditEntry);
        } catch {
            broken++;
        }
    }

    if (broken > 0) {
        log.debug("в аудит-логе есть нечитаемые строки", { broken });
    }

    return entries
        .filter(entry => (options.tool ? entry.tool === options.tool : true))
        .filter(entry => (options.onlyErrors ? !entry.ok : true))
        .slice(-limit)
        .reverse();
}

/** Принудительная ротация: вызывается при старте сервера и по таймеру обслуживания. */
export async function trimAuditLog(config?: NotCodeConfig): Promise<AuditTrimResult> {
    const cfg = config ?? (await loadConfig());
    return writeMutex.run(async () => {
        checkedThisRun = true;
        appendsSinceCheck = 0;
        return trimUnlocked(cfg);
    });
}

/** Вызывается только внутри writeMutex. */
async function trimUnlocked(config: NotCodeConfig): Promise<AuditTrimResult> {
    const nothing: AuditTrimResult = { trimmed: false, bytesBefore: 0, bytesAfter: 0, entriesKept: 0 };

    try {
        let bytesBefore = 0;
        try {
            bytesBefore = (await stat(AUDIT_FILE)).size;
        } catch {
            return nothing;
        }

        const sizeBudget = config.audit.maxFileBytes;
        const entryBudget = config.audit.maxEntries * APPROX_BYTES_PER_ENTRY;

        // Пока файл заведомо меньше обоих лимитов — не тратим память на чтение целиком.
        if (bytesBefore <= sizeBudget && bytesBefore <= entryBudget) {
            return { trimmed: false, bytesBefore, bytesAfter: bytesBefore, entriesKept: 0 };
        }

        const raw = await readFile(AUDIT_FILE, "utf8");
        const lines = raw.split("\n").filter(line => line.trim().length > 0);

        let kept = config.audit.maxEntries > 0 ? lines.slice(-config.audit.maxEntries) : [];
        let body = kept.length > 0 ? `${kept.join("\n")}\n` : "";

        // Записи бывают жирными (detail с объектами) — дожимаем по фактическому размеру.
        while (Buffer.byteLength(body, "utf8") > sizeBudget && kept.length > 50) {
            kept = kept.slice(Math.ceil(kept.length / 2));
            body = `${kept.join("\n")}\n`;
        }

        if (kept.length === lines.length) {
            return { trimmed: false, bytesBefore, bytesAfter: bytesBefore, entriesKept: kept.length };
        }

        // Атомарно: падение посреди перезаписи раньше стирало всю историю.
        await writeFileAtomic(AUDIT_FILE, body);

        const bytesAfter = Buffer.byteLength(body, "utf8");
        log.debug("аудит-лог подрезан", {
            kept: kept.length,
            removed: lines.length - kept.length,
            bytesBefore,
            bytesAfter
        });

        return { trimmed: true, bytesBefore, bytesAfter, entriesKept: kept.length };
    } catch (error) {
        log.warn("не удалось подрезать аудит-лог", { error: errorMessage(error) });
        return nothing;
    }
}
