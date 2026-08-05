import { appendFile, readFile, writeFile } from "node:fs/promises";
import { AUDIT_FILE, ensureConfigDirs, loadConfig } from "@/config";

/**
 * Аудит-лог: компромисс для bypass-режима — агент ничего не спрашивает,
 * но каждое изменяющее действие остаётся в истории (JSONL в ~/.notcode/audit.jsonl).
 */
export interface AuditEntry {
    ts: string;
    tool: string;
    action: string;
    target?: string;
    ok: boolean;
    detail?: Record<string, unknown>;
}

let appendsSinceTrim = 0;

export async function audit(entry: Omit<AuditEntry, "ts">): Promise<void> {
    try {
        const config = await loadConfig();
        if (!config.audit.enabled) return;

        await ensureConfigDirs();
        const line = JSON.stringify({ ts: new Date().toISOString(), ...entry } satisfies AuditEntry);
        await appendFile(AUDIT_FILE, `${line}\n`, "utf8");

        if (++appendsSinceTrim >= 200) {
            appendsSinceTrim = 0;
            await trim(config.audit.maxEntries);
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

async function trim(maxEntries: number): Promise<void> {
    try {
        const raw = await readFile(AUDIT_FILE, "utf8");
        const lines = raw.split("\n").filter(line => line.trim().length > 0);
        if (lines.length <= maxEntries) return;
        await writeFile(AUDIT_FILE, `${lines.slice(-maxEntries).join("\n")}\n`, "utf8");
    } catch {
        // не критично
    }
}
