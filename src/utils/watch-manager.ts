import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { loadConfig, type NotCodeConfig } from "@/config";
import { createLogger } from "@/utils/logger";

/**
 * Наблюдение за файлами: агент может узнать, что файлы изменились извне
 * (ты правишь руками, идёт сборка, дев-сервер перегенерил файлы).
 * Модель pull-based: события копятся в кольцевой буфер, тул fs_watch_poll их забирает.
 */

const log = createLogger("watch");

/**
 * Дефолты до первого чтения конфига (limits.maxWatchers / limits.watcherIdleMs / limits.gcIntervalMs).
 * Каждый recursive-watcher — это дескрипторы и CPU, а забытый без poll'ов должен гаснуть сам.
 */
const DEFAULT_MAX_WATCHERS = 16;
const DEFAULT_IDLE_TTL_MS = 30 * 60 * 1000;
const DEFAULT_GC_INTERVAL_MS = 5 * 60 * 1000;
const DEBOUNCE_MS = 200;

export interface WatchEvent {
    ts: string;
    type: string;
    path: string;
}

export interface WatcherInfo {
    id: string;
    path: string;
    recursive: boolean;
    createdAt: string;
    lastActivity: string;
    pendingEvents: number;
    totalEvents: number;
    dropped: number;
    /** Заполняется, если ОС отвалила наблюдение (удалили папку, потеряли права). */
    error?: string;
}

interface WatcherState {
    id: string;
    path: string;
    recursive: boolean;
    createdAt: number;
    lastActivity: number;
    watcher: FSWatcher;
    events: WatchEvent[];
    totalEvents: number;
    dropped: number;
    maxEvents: number;
    lastKey: string;
    lastAt: number;
    error?: string;
}

let watcherCounter = 0;

class WatchManager {
    private readonly watchers = new Map<string, WatcherState>();
    private gcTimer: ReturnType<typeof setInterval> | null = null;
    private maxWatchers = DEFAULT_MAX_WATCHERS;
    private idleTtlMs = DEFAULT_IDLE_TTL_MS;

    async start(options: { path: string; recursive?: boolean; maxEvents?: number }): Promise<WatcherInfo> {
        const config = await loadConfig();
        this.maxWatchers = config.limits.maxWatchers;
        this.idleTtlMs = config.limits.watcherIdleMs;
        this.gc();

        if (this.watchers.size >= this.maxWatchers) {
            throw new Error(
                `Достигнут лимит наблюдателей (${this.maxWatchers}). Останови ненужные через fs_watch_stop (список — fs_watch_list).`
            );
        }

        // Не плодим дубликаты на одну и ту же папку — возвращаем существующий.
        for (const state of this.watchers.values()) {
            if (state.path === options.path && state.recursive === (options.recursive ?? true) && !state.error) {
                return this.info(state);
            }
        }

        const id = `w${++watcherCounter}-${Math.random().toString(36).slice(2, 6)}`;
        const recursive = options.recursive ?? true;
        const now = Date.now();

        const state: Partial<WatcherState> & { events: WatchEvent[] } = {
            id,
            path: options.path,
            recursive,
            createdAt: now,
            lastActivity: now,
            events: [],
            totalEvents: 0,
            dropped: 0,
            maxEvents: options.maxEvents ?? 500,
            lastKey: "",
            lastAt: 0
        };

        const handler = (eventType: string, filename: string | Buffer | null): void => {
            const name = typeof filename === "string" ? filename : (filename?.toString() ?? "");
            const fullPath = name ? join(options.path, name) : options.path;
            const key = `${eventType}:${fullPath}`;
            const at = Date.now();

            // fs.watch любит дублировать события — гасим дребезг.
            if (key === state.lastKey && at - (state.lastAt ?? 0) < DEBOUNCE_MS) return;
            state.lastKey = key;
            state.lastAt = at;
            state.lastActivity = at;

            state.totalEvents = (state.totalEvents ?? 0) + 1;
            state.events.push({ ts: new Date(at).toISOString(), type: eventType, path: fullPath });
            if (state.events.length > (state.maxEvents ?? 500)) {
                state.events.shift();
                state.dropped = (state.dropped ?? 0) + 1;
            }
        };

        let watcher: FSWatcher;
        try {
            watcher = watch(options.path, { recursive, persistent: false }, handler);
        } catch (error) {
            if (!recursive) throw error;
            // Не все платформы умеют recursive — деградируем до плоского наблюдения.
            state.recursive = false;
            watcher = watch(options.path, { persistent: false }, handler);
        }

        const full = { ...state, watcher } as WatcherState;

        /**
         * Критично: без этого обработчика ошибка FSWatcher (удалили наблюдаемую папку,
         * отвалился сетевой диск) — это необработанное событие 'error' и падение всего сервера.
         */
        watcher.on("error", error => {
            full.error = error instanceof Error ? error.message : String(error);
            log.warn("наблюдатель остановлен из-за ошибки ФС", { id, path: full.path, error: full.error });
            try {
                watcher.close();
            } catch {
                // уже закрыт
            }
        });

        this.watchers.set(id, full);
        this.startGc(config);

        return this.info(full);
    }

    poll(id: string, options: { clear?: boolean; limit?: number } = {}): { info: WatcherInfo; events: WatchEvent[] } {
        const state = this.require(id);
        state.lastActivity = Date.now();

        const limit = options.limit ?? 200;
        const events = state.events.slice(-limit);
        if (options.clear ?? true) state.events = [];

        return { info: this.info(state), events };
    }

    list(): WatcherInfo[] {
        return [...this.watchers.values()].map(state => this.info(state));
    }

    stop(id: string): WatcherInfo {
        const state = this.require(id);
        try {
            state.watcher.close();
        } catch {
            // уже закрыт
        }
        this.watchers.delete(id);
        if (this.watchers.size === 0) this.clearGcTimer();
        return this.info(state);
    }

    stopAll(): number {
        const ids = [...this.watchers.keys()];
        for (const id of ids) {
            try {
                this.stop(id);
            } catch {
                // игнорируем
            }
        }
        this.clearGcTimer();
        return ids.length;
    }

    /** Сносит отвалившиеся и давно заброшенные наблюдатели. */
    gc(): number {
        const now = Date.now();
        let removed = 0;

        for (const [id, state] of [...this.watchers.entries()]) {
            const idle = now - state.lastActivity > this.idleTtlMs;
            if (!state.error && !idle) continue;
            try {
                state.watcher.close();
            } catch {
                // уже закрыт
            }
            this.watchers.delete(id);
            removed++;
        }

        if (this.watchers.size === 0) this.clearGcTimer();
        return removed;
    }

    startGc(config: NotCodeConfig): void {
        this.maxWatchers = config.limits.maxWatchers;
        this.idleTtlMs = config.limits.watcherIdleMs;
        if (this.gcTimer) return;
        this.gcTimer = setInterval(() => this.gc(), config.limits.gcIntervalMs || DEFAULT_GC_INTERVAL_MS);
        // Таймер не должен удерживать процесс в живых.
        this.gcTimer.unref?.();
    }

    stopGc(): void {
        this.clearGcTimer();
    }

    private clearGcTimer(): void {
        if (!this.gcTimer) return;
        clearInterval(this.gcTimer);
        this.gcTimer = null;
    }

    private require(id: string): WatcherState {
        const state = this.watchers.get(id);
        if (!state) {
            const known = [...this.watchers.keys()];
            throw new Error(
                `Watcher '${id}' не найден. Активные: ${known.length > 0 ? known.join(", ") : "нет"} (fs_watch_list).`
            );
        }
        return state;
    }

    private info(state: WatcherState): WatcherInfo {
        return {
            id: state.id,
            path: state.path,
            recursive: state.recursive,
            createdAt: new Date(state.createdAt).toISOString(),
            lastActivity: new Date(state.lastActivity).toISOString(),
            pendingEvents: state.events.length,
            totalEvents: state.totalEvents,
            dropped: state.dropped,
            ...(state.error ? { error: state.error } : {})
        };
    }
}

export const watchers = new WatchManager();
