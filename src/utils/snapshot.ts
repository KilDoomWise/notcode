import { appendFile, readFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { ensureConfigDirs, loadConfig, SNAPSHOT_DIR, SNAPSHOT_INDEX } from "@/config";
import { writeFileAtomic } from "@/utils/fs-atomic";
import { Mutex } from "@/utils/lock";
import { createLogger, errorMessage } from "@/utils/logger";

const log = createLogger("snapshot");

/**
 * Снапшоты: перед каждой перезаписью/патчем файла кладём копию в ~/.notcode/snapshots.
 * Это страховка для bypass-режима — агент работает без подтверждений, но откат всегда возможен.
 *
 * Все операции с индексом идут через мьютекс: без этого два параллельных fs_write_file
 * делали read-modify-write index.jsonl и теряли записи друг друга:
 * снапшот лежал на диске, а восстановиться по нему было нельзя.
 */
export interface SnapshotMeta {
    id: string;
    ts: string;
    originalPath: string;
    snapshotPath: string;
    bytes: number;
    reason: string;
}

const indexMutex = new Mutex();

function sanitize(name: string): string {
    return name.replace(/[^\w.-]+/g, "_").slice(-80);
}

/** На Windows пути регистронезависимы, на POSIX — нет. Глобальный toLowerCase() склеивал File.txt и file.txt. */
const caseInsensitive = process.platform === "win32" || process.platform === "darwin";

function pathKey(value: string): string {
    return caseInsensitive ? value.toLowerCase() : value;
}

function samePath(a: string, b: string): boolean {
    return pathKey(a) === pathKey(b);
}

async function readIndexUnlocked(): Promise<SnapshotMeta[]> {
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

async function writeIndexUnlocked(items: SnapshotMeta[]): Promise<void> {
    const body = items.map(item => JSON.stringify(item)).join("\n");
    await writeFileAtomic(SNAPSHOT_INDEX, body.length > 0 ? `${body}\n` : "");
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

    await indexMutex.run(async () => {
        await appendFile(SNAPSHOT_INDEX, `${JSON.stringify(meta)}\n`, "utf8");
        await pruneUnlocked(absPath, config.snapshots.keepPerFile);
    });

    return meta;
}

export async function listSnapshots(options: { path?: string; limit?: number } = {}): Promise<SnapshotMeta[]> {
    const items = await indexMutex.run(() => readIndexUnlocked());
    const target = options.path;
    const filtered = target ? items.filter(item => samePath(item.originalPath, target)) : items;
    return filtered.slice(-(options.limit ?? 30)).reverse();
}

/** Находит метаданные снапшота. Нужен тулам, чтобы проверить сандбокс ДО восстановления. */
export async function findSnapshot(id: string): Promise<SnapshotMeta | null> {
    const items = await indexMutex.run(() => readIndexUnlocked());
    return items.find(item => item.id === id) ?? null;
}

export interface RestoreResult {
    meta: SnapshotMeta;
    restoredTo: string;
    bytes: number;
    /** Снапшот того, что было на месте до восстановления — чтобы откат тоже можно было откатить. */
    backupId: string | null;
}

export async function restoreSnapshot(id: string, toPath?: string): Promise<RestoreResult> {
    const meta = await findSnapshot(id);
    if (!meta) {
        throw new Error(`Снапшот '${id}' не найден. Список: fs_snapshots`);
    }

    const snapshot = Bun.file(meta.snapshotPath);
    if (!(await snapshot.exists())) {
        throw new Error(`Файл снапшота пропал: ${meta.snapshotPath}`);
    }

    const restoredTo = toPath ?? meta.originalPath;

    // Восстановление — такая же деструктивная операция, как запись. Раньше она была необратимой.
    const backup = await createSnapshot(restoredTo, `fs_restore:before(${id})`);

    const bytes = await snapshot.arrayBuffer();
    await writeFileAtomic(restoredTo, new Uint8Array(bytes));

    log.info("снапшот восстановлен", { id, restoredTo, backupId: backup?.id ?? null });

    return { meta, restoredTo, bytes: bytes.byteLength, backupId: backup?.id ?? null };
}

/** Оставляет только N последних снапшотов на файл. Вызывается только внутри indexMutex. */
async function pruneUnlocked(absPath: string, keep: number): Promise<void> {
    try {
        const items = await readIndexUnlocked();
        const forPath = items.filter(item => samePath(item.originalPath, absPath));
        if (forPath.length <= keep) return;

        const stale = forPath.slice(0, forPath.length - keep);
        const staleIds = new Set(stale.map(item => item.id));

        await Promise.all(stale.map(item => rm(item.snapshotPath, { force: true })));
        await writeIndexUnlocked(items.filter(item => !staleIds.has(item.id)));
    } catch (error) {
        log.warn("не удалось почистить старые снапшоты", { path: absPath, error: errorMessage(error) });
    }
}
