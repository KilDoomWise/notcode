import { appendFile, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { ensureConfigDirs, loadConfig, SNAPSHOT_DIR, SNAPSHOT_INDEX, type NotCodeConfig } from "@/config";
import { formatBytes } from "@/utils/output";

/**
 * Снапшоты: перед каждой перезаписью/патчем файла кладём копию в ~/.notcode/snapshots.
 * Это страховка для bypass-режима — агент работает без подтверждений, но откат всегда возможен.
 *
 * Дисциплина по месту (без неё папка растёт вечно):
 *  - файлы больше snapshots.maxFileBytes не копируются вообще;
 *  - keepPerFile последних версий на каждый путь;
 *  - глобальный GC: возраст, общий объём, осиротевшие записи и файлы без записи в индексе;
 *  - все операции с индексом сериализованы, запись атомарна (tmp + rename).
 */
export interface SnapshotMeta {
    id: string;
    ts: string;
    originalPath: string;
    snapshotPath: string;
    bytes: number;
    reason: string;
}

export type SnapshotSkipReason = "disabled" | "missing" | "too_large";

export interface SnapshotResult {
    meta: SnapshotMeta | null;
    skipped: SnapshotSkipReason | null;
    /** Человекочитаемое пояснение для ответа тула, если снапшот не сделан. */
    note: string | null;
}

export interface SnapshotGcStats {
    removed: number;
    freedBytes: number;
    remaining: number;
    remainingBytes: number;
}

/** Раз в столько созданных снапшотов запускаем полный GC, даже если сервер не перезапускался. */
const GC_EVERY_CREATES = 25;
/** Файлы моложе этого возраста не считаем «мусором без индекса» — их может писать соседний вызов. */
const STRAY_GRACE_MS = 60_000;

let createsSinceGc = 0;

/** Все чтения/записи индекса идут строго по очереди: иначе параллельные тулы затирают чужие записи. */
let indexQueue: Promise<unknown> = Promise.resolve();

function withIndexLock<T>(task: () => Promise<T>): Promise<T> {
    const next = indexQueue.then(task, task);
    indexQueue = next.then(
        () => undefined,
        () => undefined
    );
    return next;
}

function sanitize(name: string): string {
    return name.replace(/[^\w.-]+/g, "_").slice(-80);
}

function pathKey(value: string): string {
    return process.platform === "win32" ? value.toLowerCase() : value;
}

function ageMs(ts: string, now: number): number {
    const parsed = Date.parse(ts);
    return Number.isFinite(parsed) ? now - parsed : Number.POSITIVE_INFINITY;
}

async function exists(path: string): Promise<boolean> {
    try {
        await stat(path);
        return true;
    } catch {
        return false;
    }
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

/** Атомарная перезапись индекса: сначала tmp, потом rename — оборванная запись не бьёт файл. */
async function writeIndexAtomic(items: SnapshotMeta[]): Promise<void> {
    const body = items.map(item => JSON.stringify(item)).join("\n");
    const tmpPath = `${SNAPSHOT_INDEX}.${process.pid}.tmp`;
    await writeFile(tmpPath, body.length > 0 ? `${body}\n` : "", "utf8");
    await rename(tmpPath, SNAPSHOT_INDEX);
}

/** Создаёт снапшот существующего файла. Возвращает причину отказа, если копия не сделана. */
export async function createSnapshot(absPath: string, reason: string): Promise<SnapshotResult> {
    const config = await loadConfig();
    if (!config.snapshots.enabled) return { meta: null, skipped: "disabled", note: null };

    let info;
    try {
        info = await stat(absPath);
    } catch {
        return { meta: null, skipped: "missing", note: null };
    }
    if (!info.isFile()) return { meta: null, skipped: "missing", note: null };

    if (info.size > config.snapshots.maxFileBytes) {
        return {
            meta: null,
            skipped: "too_large",
            note:
                `Снапшот не создан: файл ${formatBytes(info.size)} больше лимита ` +
                `${formatBytes(config.snapshots.maxFileBytes)} (snapshots.maxFileBytes). Откат через fs_restore недоступен.`
        };
    }

    await ensureConfigDirs();

    const id = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}`;
    const snapshotPath = join(SNAPSHOT_DIR, `${id}-${sanitize(basename(absPath))}`);
    await Bun.write(snapshotPath, Bun.file(absPath));
    // Bun.write(dest, BunFile) при копировании файл-в-файл на Windows возвращает 0,
    // хотя сама копия проходит корректно (нет copy_file_range/sendfile — тихий fallback
    // на fs.copyFile без отчёта о фактическом размере). Поэтому не доверяем возврату
    // функции и берём реальный размер уже записанного файла через отдельный stat().
    const bytes = (await stat(snapshotPath)).size;

    const meta: SnapshotMeta = {
        id,
        ts: new Date().toISOString(),
        originalPath: absPath,
        snapshotPath,
        bytes,
        reason
    };

    await withIndexLock(() => appendFile(SNAPSHOT_INDEX, `${JSON.stringify(meta)}\n`, "utf8"));
    await prunePerFile(absPath, config.snapshots.keepPerFile);

    if (++createsSinceGc >= GC_EVERY_CREATES) {
        createsSinceGc = 0;
        await gcSnapshots(config).catch(() => undefined);
    }

    return { meta, skipped: null, note: null };
}

export async function listSnapshots(options: { path?: string; limit?: number } = {}): Promise<SnapshotMeta[]> {
    const items = await withIndexLock(() => readIndex());
    const filtered = options.path
        ? items.filter(item => pathKey(item.originalPath) === pathKey(options.path as string))
        : items;
    return filtered.slice(-(options.limit ?? 30)).reverse();
}

export async function restoreSnapshot(
    id: string,
    toPath?: string
): Promise<{ meta: SnapshotMeta; restoredTo: string; bytes: number; backupId: string | null }> {
    const items = await withIndexLock(() => readIndex());
    const meta = items.find(item => item.id === id);
    if (!meta) {
        throw new Error(`Снапшот '${id}' не найден. Список: fs_snapshots`);
    }

    const snapshot = Bun.file(meta.snapshotPath);
    if (!(await snapshot.exists())) {
        throw new Error(`Файл снапшота пропал: ${meta.snapshotPath}`);
    }

    const restoredTo = toPath ?? meta.originalPath;

    // Откат тоже должен быть обратимым: сохраняем то, что лежит сейчас.
    const backup = await createSnapshot(restoredTo, "fs_restore:before");
    await Bun.write(restoredTo, snapshot);
    // Тот же баг Bun.write на Windows при копировании файл-в-файл (см. createSnapshot
    // выше) — возвращаемое значение не отражает реальный размер, статим результат сами.
    const bytes = (await stat(restoredTo)).size;

    return { meta, restoredTo, bytes, backupId: backup.meta?.id ?? null };
}

/** Оставляет только N последних снапшотов конкретного файла. */
async function prunePerFile(absPath: string, keep: number): Promise<void> {
    await withIndexLock(async () => {
        const items = await readIndex();
        const key = pathKey(absPath);
        const forPath = items.filter(item => pathKey(item.originalPath) === key);
        if (forPath.length <= keep) return;

        const stale = forPath.slice(0, forPath.length - keep);
        const staleIds = new Set(stale.map(item => item.id));

        await Promise.all(stale.map(item => rm(item.snapshotPath, { force: true }).catch(() => undefined)));
        await writeIndexAtomic(items.filter(item => !staleIds.has(item.id)));
    });
}

/**
 * Полная уборка папки снапшотов: возраст, осиротевшие, лимит на файл, общий объём
 * и файлы, которых нет в индексе. Вызывается при старте, по таймеру и раз в N снапшотов.
 */
export async function gcSnapshots(config?: NotCodeConfig): Promise<SnapshotGcStats> {
    const cfg = config ?? (await loadConfig());
    const { keepPerFile, maxAgeDays, maxTotalBytes, orphanTtlHours } = cfg.snapshots;

    return withIndexLock(async () => {
        const items = await readIndex();
        const now = Date.now();
        const doomed = new Map<string, SnapshotMeta>();
        const alive: SnapshotMeta[] = [];

        // 1) слишком старые и осиротевшие (исходник удалён давно)
        for (const item of items) {
            const age = ageMs(item.ts, now);
            if (age > maxAgeDays * 86_400_000) {
                doomed.set(item.id, item);
                continue;
            }
            if (age > orphanTtlHours * 3_600_000 && !(await exists(item.originalPath))) {
                doomed.set(item.id, item);
                continue;
            }
            alive.push(item);
        }

        // 2) не больше keepPerFile версий на каждый путь
        const byPath = new Map<string, SnapshotMeta[]>();
        for (const item of alive) {
            const key = pathKey(item.originalPath);
            const list = byPath.get(key);
            if (list) list.push(item);
            else byPath.set(key, [item]);
        }

        const afterPerFile: SnapshotMeta[] = [];
        for (const list of byPath.values()) {
            const cut = Math.max(0, list.length - keepPerFile);
            for (const item of list.slice(0, cut)) doomed.set(item.id, item);
            afterPerFile.push(...list.slice(cut));
        }
        afterPerFile.sort((a, b) => ageMs(b.ts, now) - ageMs(a.ts, now));

        // 3) общий объём папки: сносим самые старые, пока не влезем в лимит
        let total = afterPerFile.reduce((sum, item) => sum + (item.bytes || 0), 0);
        const kept: SnapshotMeta[] = [];
        for (const item of afterPerFile) {
            if (total > maxTotalBytes) {
                doomed.set(item.id, item);
                total -= item.bytes || 0;
                continue;
            }
            kept.push(item);
        }

        // 4) физическое удаление + перезапись индекса
        let freedBytes = 0;
        for (const item of doomed.values()) {
            try {
                await rm(item.snapshotPath, { force: true });
                freedBytes += item.bytes || 0;
            } catch {
                // файл уже мог исчезнуть
            }
        }
        if (doomed.size > 0) {
            await writeIndexAtomic(kept);
        }

        // 5) файлы в папке, на которые никто не ссылается (остатки от падений и старых версий)
        freedBytes += await removeStrayFiles(new Set(kept.map(item => pathKey(item.snapshotPath))));

        return {
            removed: doomed.size,
            freedBytes,
            remaining: kept.length,
            remainingBytes: kept.reduce((sum, item) => sum + (item.bytes || 0), 0)
        };
    });
}

async function removeStrayFiles(keepKeys: Set<string>): Promise<number> {
    let freed = 0;
    let names: string[];
    try {
        names = await readdir(SNAPSHOT_DIR);
    } catch {
        return 0;
    }

    for (const name of names) {
        if (name.startsWith("index.jsonl")) continue;

        const full = join(SNAPSHOT_DIR, name);
        if (keepKeys.has(pathKey(full))) continue;

        try {
            const info = await stat(full);
            if (!info.isFile()) continue;
            if (Date.now() - info.mtimeMs < STRAY_GRACE_MS) continue;
            await rm(full, { force: true });
            freed += info.size;
        } catch {
            // недоступен — пропускаем
        }
    }

    return freed;
}
