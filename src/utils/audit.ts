import { appendFile, readFile, rename, stat, writeFile } from "node:fs/promises";
import { AUDIT_FILE, ensureConfigDirs, loadConfig, type NotCodeConfig } from "@/config";

/**
 * Аудит-лог: компромисс для bypass-режима — агент ничего не спрашивает,
 * но каждое изменяющее действие остаётся в истории (JSONL в ~/.notcode/audit.jsonl).
 *
 * Ротация раньше висела на счётчике в памяти: при рестарте сервера чаще, чем раз в 200 записей,
 * trim не вызывался вообще и файл рос бесконечно. Теперь ротация опирается на РАЗМЕР файла
 * и обязательно выполняется один раз в начале работы процесса.
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

const CHECK_EVERY_APPENDS = 200;
/** Грубая оценка средней длины строки — чтобы не читать файл целиком без нужды. */
const APPROX_BYTES_PER_ENTRY = 200;

let appendsSinceCheck = 0;
let checkedThisRun = false;

let fileQueue: Promise<unknown> = Promise.resolve();

function withFileLock<T>(task: () => Promise<T>): Promise<T> {
    const next = fileQueue.then(task, task);
    fileQueue = next.then(
        () => undefined,
        () => undefined
    );
    return next;
}

export async function audit(entry: Omit<AuditEntry, "ts">): Promise<void> {
    try {
        const config = await loadConfig();
        if (!config.audit.enabled) return;

        await ensureConfigDirs();
        const line = JSON.stringify({ ts: new Date().toISOString(), ...entry } satisfies AuditEntry);
        await withFileLock(() => appendFile(AUDIT_FILE, `${line}\n`, "utf8"));

        appendsSinceCheck++;
        if (!checkedThisRun || appendsSinceCheck >= CHECK_EVERY_APPENDS) {
            checkedThisRun = true;
            appendsSinceCheck = 0;
            await trim(config);
        }
    } catch {
        // Аудит не имеет права ломать основную операцию.
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
    for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
            entries.push(JSON.parse(line) as AuditEntry);
        } catch {
            // пропускаем битую строку
        }
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
    checkedThisRun = true;
    appendsSinceCheck = 0;
    return trim(cfg);
}

async function trim(config: NotCodeConfig): Promise<AuditTrimResult> {
    return withFileLock(async () => {
        let bytesBefore = 0;
        try {
            bytesBefore = (await stat(AUDIT_FILE)).size;
        } catch {
            return { trimmed: false, bytesBefore: 0, bytesAfter: 0, entriesKept: 0 };
        }

        const sizeBudget = config.audit.maxFileBytes;
        const entryBudget = config.audit.maxEntries * APPROX_BYTES_PER_ENTRY;

        // Пока файл заведомо меньше обоих лимитов — не тратим память на чтение.
        if (bytesBefore <= sizeBudget && bytesBefore <= entryBudget) {
            return { trimmed: false, bytesBefore, bytesAfter: bytesBefore, entriesKept: 0 };
        }

        let raw: string;
        try {
            raw = await readFile(AUDIT_FILE, "utf8");
        } catch {
            return { trimmed: false, bytesBefore, bytesAfter: bytesBefore, entriesKept: 0 };
        }

        const lines = raw.split("\n").filter(line => line.trim().length > 0);
        let kept = lines.slice(-config.audit.maxEntries);
        let body = kept.length > 0 ? `${kept.join("\n")}\n` : "";

        // Записи бывают жирными (detail с объектами) — дожимаем по фактическому размеру.
        while (Buffer.byteLength(body, "utf8") > sizeBudget && kept.length > 50) {
            kept = kept.slice(Math.ceil(kept.length / 2));
            body = `${kept.join("\n")}\n`;
        }

        if (kept.length === lines.length) {
            return { trimmed: false, bytesBefore, bytesAfter: bytesBefore, entriesKept: kept.length };
        }

        const tmpPath = `${AUDIT_FILE}.${process.pid}.tmp`;
        await writeFile(tmpPath, body, "utf8");
        await rename(tmpPath, AUDIT_FILE);

        return {
            trimmed: true,
            bytesBefore,
            bytesAfter: Buffer.byteLength(body, "utf8"),
            entriesKept: kept.length
        };
    });
}
