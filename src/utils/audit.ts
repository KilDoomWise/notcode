import { appendFile, readFile } from "node:fs/promises";
import { AUDIT_FILE, ensureConfigDirs, loadConfig } from "@/config";
import { writeFileAtomic } from "@/utils/fs-atomic";
import { Mutex } from "@/utils/lock";
import { createLogger, errorMessage } from "@/utils/logger";

const log = createLogger("audit");

/**
 * Аудит-лог: компромисс для bypass-режима — агент ничего не спрашивает,
 * но каждое изменяющее действие остаётся в истории (JSONL в ~/.notcode/audit.jsonl).
 *
 * Все записи сериализованы мьютексом: параллельные appendFile больших строк
 * не атомарны и бьют JSONL, а trim() поверх чужого append теряет записи.
 */
export interface AuditEntry {
    ts: string;
    tool: string;
    action: string;
    target?: string;
    ok: boolean;
    detail?: Record<string, unknown>;
}

/** Жёсткий потолок на размер detail: одна запись не должна раздувать журнал на мегабайты. */
const MAX_LINE_CHARS = 8_000;
const TRIM_EVERY = 200;

const writeMutex = new Mutex();

let appendsSinceTrim = 0;

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

            if (++appendsSinceTrim >= TRIM_EVERY) {
                appendsSinceTrim = 0;
                await trim(config.audit.maxEntries);
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

/** Вызывается только внутри writeMutex. */
async function trim(maxEntries: number): Promise<void> {
    if (maxEntries <= 0) return;

    try {
        const raw = await readFile(AUDIT_FILE, "utf8");
        const lines = raw.split("\n").filter(line => line.trim().length > 0);
        if (lines.length <= maxEntries) return;

        // Атомарно: падение посреди перезаписи раньше стирало всю историю.
        await writeFileAtomic(AUDIT_FILE, `${lines.slice(-maxEntries).join("\n")}\n`);
        log.debug("аудит-лог подрезан", { kept: maxEntries, removed: lines.length - maxEntries });
    } catch (error) {
        log.warn("не удалось подрезать аудит-лог", { error: errorMessage(error) });
    }
}
