import { appendFile, readdir, readFile, rm, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import { basename, join } from "node:path";
import { ensureConfigDirs, loadConfig, SNAPSHOT_DIR, SNAPSHOT_INDEX, type NotCodeConfig } from "@/config";
import { writeFileAtomic } from "@/utils/fs-atomic";
import { Mutex } from "@/utils/lock";
import { createLogger, errorMessage } from "@/utils/logger";
import { formatBytes } from "@/utils/output";

const log = createLogger("snapshot");

/**
 * Снапшоты: перед каждой перезаписью/патчем файла кладём копию в ~/.notcode/snapshots.
 * Это страховка для bypass-режима — агент работает без подтверждений, но откат всегда возможен.
 *
 * Все операции с индексом идут через мьютекс: без этого два параллельных fs_write_file
 * делали read-modify-write index.jsonl и теряли записи друг друга — снапшот лежал на диске,
 * а восстановиться по нему было нельзя.
 *
 * Дисциплина по месту (иначе папка растёт до бесконечности):
 *  - файлы больше snapshots.maxFileBytes не копируются вообще;
 *  - keepPerFile последних версий на каждый путь;
 *  - глобальный GC: возраст, общий объём, осиротевшие записи и файлы без записи в индексе.
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
    /** Человекочитаемое пояснение для ответа тула, если копия не сделана. */
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
/** Файлы моложе этого возраста не считаем мусором без индекса — их может писать соседний вызов. */
const STRAY_GRACE_MS = 60_000;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

let createsSinceGc = 0;

const indexMutex = new Mutex();

function sanitize(name: string): string {
    return name.replace(/[^\w.-]+/g, "_").slice(-80);
}

/** На Windows и macOS пути регистронезависимы, на Linux — нет. Глобальный toLowerCase() склеивал File.txt и file.txt. */
const caseInsensitive = process.platform === "win32" || process.platform === "darwin";

function pathKey(value: string): string {
    return caseInsensitive ? value.toLowerCase() : value;
}

function samePath(a: string, b: string): boolean {
    return pathKey(a) === pathKey(b);
}

function timeOf(ts: string): number {
    const parsed = Date.parse(ts);
    return Number.isFinite(parsed) ? parsed : 0;
}

function ageMs(ts: string, now: number): number {
    const parsed = Date.parse(ts);
    return Number.isFinite(parsed) ? now - parsed : Number.POSITIVE_INFINITY;
}

async function pathExists(path: string): Promise<boolean> {
    try {
        await stat(path);
        return true;
    } catch {
        return false;
    }
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

/** Создаёт снапшот существующего файла. Если копия не сделана — объясняет, почему. */
export async function createSnapshot(absPath: string, reason: string): Promise<SnapshotResult> {
    const config = await loadConfig();
    if (!config.snapshots.enabled) return { meta: null, skipped: "disabled", note: null };

    let info: Stats;
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

    /**
     * Bun.write(dest, BunFile) при копировании файл-в-файл на Windows возвращает 0,
     * хотя копия проходит корректно (тихий fallback на fs.copyFile без отчёта о размере).
     * Поэтому не доверяем возвращаемому значению и статим уже записанный файл.
     */
    let bytes = info.size;
    try {
        bytes = (await stat(snapshotPath)).size;
    } catch {
        // остаётся размер исходника — он всё равно ближе к правде, чем 0
    }

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

    // Полный GC — вне мьютекса: он берёт его сам, а Mutex не реентерабельный.
    if (++createsSinceGc >= GC_EVERY_CREATES) {
        createsSinceGc = 0;
        await gcSnapshots(config).catch(error => {
            log.warn("не удалось прибраться в снапшотах", { error: errorMessage(error) });
        });
    }

    return { meta, skipped: null, note: null };
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

    log.info("снапшот восстановлен", { id, restoredTo, backupId: backup.meta?.id ?? null });

    return { meta, restoredTo, bytes: bytes.byteLength, backupId: backup.meta?.id ?? null };
}

/** Оставляет только N последних снапшотов на файл. Вызывается только внутри indexMutex. */
async function pruneUnlocked(absPath: string, keep: number): Promise<void> {
    try {
        const items = await readIndexUnlocked();
        const forPath = items.filter(item => samePath(item.originalPath, absPath));
        if (forPath.length <= keep) return;

        const stale = forPath.slice(0, forPath.length - keep);
        const staleIds = new Set(stale.map(item => item.id));

        await Promise.all(stale.map(item => rm(item.snapshotPath, { force: true }).catch(() => undefined)));
        await writeIndexUnlocked(items.filter(item => !staleIds.has(item.id)));
    } catch (error) {
        log.warn("не удалось почистить старые снапшоты", { path: absPath, error: errorMessage(error) });
    }
}

/**
 * Полная уборка папки снапшотов: возраст, осиротевшие, лимит на файл, общий объём
 * и файлы, которых нет в индексе. Вызывается при старте, по таймеру и раз в N снапшотов.
 */
export async function gcSnapshots(config?: NotCodeConfig): Promise<SnapshotGcStats> {
    const cfg = config ?? (await loadConfig());
    const { keepPerFile, maxAgeDays, maxTotalBytes, orphanTtlHours } = cfg.snapshots;

    return indexMutex.run(async () => {
        const items = await readIndexUnlocked();
        const now = Date.now();
        const doomed = new Map<string, SnapshotMeta>();
        const alive: SnapshotMeta[] = [];

        // 1) слишком старые и осиротевшие (исходник удалён давно)
        for (const item of items) {
            const age = ageMs(item.ts, now);
            if (age > maxAgeDays * DAY_MS) {
                doomed.set(item.id, item);
                continue;
            }
            if (age > orphanTtlHours * HOUR_MS && !(await pathExists(item.originalPath))) {
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

        // от старых к новым: при переполнении объёма первыми уходят самые древние
        afterPerFile.sort((a, b) => timeOf(a.ts) - timeOf(b.ts));

        // 3) общий объём папки
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
            await writeIndexUnlocked(kept);
        }

        // 5) файлы в папке, на которые никто не ссылается (остатки от падений и старых версий)
        freedBytes += await removeStrayFiles(new Set(kept.map(item => pathKey(item.snapshotPath))));

        if (doomed.size > 0) {
            log.debug("уборка снапшотов", { removed: doomed.size, freedBytes, remaining: kept.length });
        }

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
            // Свежий файл может писать соседний вызов, у которого ещё нет записи в индексе.
            if (Date.now() - info.mtimeMs < STRAY_GRACE_MS) continue;
            await rm(full, { force: true });
            freed += info.size;
        } catch {
            // недоступен — пропускаем
        }
    }

    return freed;
}
