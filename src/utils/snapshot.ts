import { appendFile, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { ensureConfigDirs, loadConfig, SNAPSHOT_DIR, SNAPSHOT_INDEX } from "@/config";

/**
 * Снапшоты: перед каждой перезаписью/патчем файла кладём копию в ~/.notcode/snapshots.
 * Это страховка для bypass-режима — агент работает без подтверждений, но откат всегда возможен.
 */
export interface SnapshotMeta {
    id: string;
    ts: string;
    originalPath: string;
    snapshotPath: string;
    bytes: number;
    reason: string;
}

function sanitize(name: string): string {
    return name.replace(/[^\w.-]+/g, "_").slice(-80);
}

async function readIndex(): Promise<SnapshotMeta[]> {
    try {
        const raw = await readFile(SNAPSHOT_INDEX, "utf8");
        const items: SnapshotMeta[] = [];
        for (const line of raw.split("\n")) {
            if (!line.trim()) continue;
            try {
                items.push(JSON.parse(line) as SnapshotMeta);
            } catch {
                // пропускаем битую строку
            }
        }
        return items;
    } catch {
        return [];
    }
}

async function writeIndex(items: SnapshotMeta[]): Promise<void> {
    const body = items.map(item => JSON.stringify(item)).join("\n");
    await writeFile(SNAPSHOT_INDEX, body.length > 0 ? `${body}\n` : "", "utf8");
}

/** Создаёт снапшот существующего файла. Возвращает null, если файла нет или снапшоты отключены. */
export async function createSnapshot(absPath: string, reason: string): Promise<SnapshotMeta | null> {
    const config = await loadConfig();
    if (!config.snapshots.enabled) return null;

    const source = Bun.file(absPath);
    if (!(await source.exists())) return null;

    await ensureConfigDirs();

    const id = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}`;
    const snapshotPath = join(SNAPSHOT_DIR, `${id}-${sanitize(basename(absPath))}`);
    const bytes = await Bun.write(snapshotPath, source);

    const meta: SnapshotMeta = {
        id,
        ts: new Date().toISOString(),
        originalPath: absPath,
        snapshotPath,
        bytes,
        reason
    };

    await appendFile(SNAPSHOT_INDEX, `${JSON.stringify(meta)}\n`, "utf8");
    await prune(absPath, config.snapshots.keepPerFile);

    return meta;
}

export async function listSnapshots(options: { path?: string; limit?: number } = {}): Promise<SnapshotMeta[]> {
    const items = await readIndex();
    const filtered = options.path
        ? items.filter(item => item.originalPath.toLowerCase() === options.path!.toLowerCase())
        : items;
    return filtered.slice(-(options.limit ?? 30)).reverse();
}

export async function restoreSnapshot(
    id: string,
    toPath?: string
): Promise<{ meta: SnapshotMeta; restoredTo: string; bytes: number }> {
    const items = await readIndex();
    const meta = items.find(item => item.id === id);
    if (!meta) {
        throw new Error(`Снапшот '${id}' не найден. Список: fs_snapshots`);
    }

    const snapshot = Bun.file(meta.snapshotPath);
    if (!(await snapshot.exists())) {
        throw new Error(`Файл снапшота пропал: ${meta.snapshotPath}`);
    }

    const restoredTo = toPath ?? meta.originalPath;
    const bytes = await Bun.write(restoredTo, snapshot);
    return { meta, restoredTo, bytes };
}

/** Оставляет только N последних снапшотов на файл, остальные удаляет с диска и из индекса. */
async function prune(absPath: string, keep: number): Promise<void> {
    const items = await readIndex();
    const forPath = items.filter(item => item.originalPath.toLowerCase() === absPath.toLowerCase());
    if (forPath.length <= keep) return;

    const stale = forPath.slice(0, forPath.length - keep);
    const staleIds = new Set(stale.map(item => item.id));

    await Promise.all(stale.map(item => rm(item.snapshotPath, { force: true })));
    await writeIndex(items.filter(item => !staleIds.has(item.id)));
}
