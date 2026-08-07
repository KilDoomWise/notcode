import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "@/config";

/**
 * Наблюдение за файлами: агент может узнать, что файлы изменились извне
 * (ты правишь руками, идёт сборка, дев-сервер перегенерил файлы).
 * Модель pull-based: события копятся в буфер, тул fs_watch_poll их забирает.
 */
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
    lastPolledAt: string;
    idleTimeoutMs: number;
    pendingEvents: number;
    totalEvents: number;
    dropped: number;
}

interface WatcherState {
    id: string;
    path: string;
    recursive: boolean;
    createdAt: number;
    watcher: FSWatcher;
    events: WatchEvent[];
    totalEvents: number;
    dropped: number;
    maxEvents: number;
    lastKey: string;
    lastAt: number;
    lastPolledAt: number;
    idleMs: number;
}

class WatchManager {
    private readonly watchers = new Map<string, WatcherState>();
    private gcTimer: ReturnType<typeof setInterval> | null = null;

    async start(options: { path: string; recursive?: boolean; maxEvents?: number }): Promise<WatcherInfo> {
        const config = await loadConfig();
        this.gc();

        if (this.watchers.size >= config.limits.maxWatchers) {
            throw new Error(
                `Достигнут лимит watcher'ов (${config.limits.maxWatchers}). ` +
                    `Каждый держит хендл ОС и копит события — останови ненужные через fs_watch_stop (список: fs_watch_list).`
            );
        }

        const id = `w-${crypto.randomUUID().slice(0, 6)}`;
        const recursive = options.recursive ?? true;
        const maxEvents = options.maxEvents ?? 500;

        const state: WatcherState = {
            id,
            path: options.path,
            recursive,
            createdAt: Date.now(),
            lastPolledAt: Date.now(),
            idleMs: config.limits.watcherIdleMs,
            watcher: undefined as unknown as FSWatcher,
            events: [],
            totalEvents: 0,
            dropped: 0,
            maxEvents,
            lastKey: "",
            lastAt: 0
        };

        const handler = (eventType: string, filename: string | Buffer | null): void => {
            const name = typeof filename === "string" ? filename : filename?.toString() ?? "";
            const fullPath = name ? join(options.path, name) : options.path;
            const key = `${eventType}:${fullPath}`;
            const now = Date.now();

            // fs.watch любит дублировать события — гасим дребезг.
            if (key === state.lastKey && now - state.lastAt < 200) return;
            state.lastKey = key;
            state.lastAt = now;

            state.totalEvents++;
            state.events.push({ ts: new Date(now).toISOString(), type: eventType, path: fullPath });
            if (state.events.length > state.maxEvents) {
                state.events.shift();
                state.dropped++;
            }
        };

        try {
            state.watcher = watch(options.path, { recursive, persistent: false }, handler);
        } catch (error) {
            if (!recursive) throw error;
            // Не все платформы умеют recursive — деградируем до плоского наблюдения.
            state.recursive = false;
            state.watcher = watch(options.path, { persistent: false }, handler);
        }

        this.watchers.set(id, state);
        return this.info(state);
    }

    poll(id: string, options: { clear?: boolean; limit?: number } = {}): { info: WatcherInfo; events: WatchEvent[] } {
        const state = this.require(id);
        state.lastPolledAt = Date.now();
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
        return ids.length;
    }

    /**
     * Останавливает watcher'ы, за которыми никто не следит.
     * Без этого забытый fs_watch_start живёт до перезапуска сервера и бесконечно копит события.
     */
    gc(): { stopped: number } {
        const now = Date.now();
        let stopped = 0;

        for (const [id, state] of this.watchers) {
            if (now - state.lastPolledAt < state.idleMs) continue;
            try {
                this.stop(id);
            } catch {
                this.watchers.delete(id);
            }
            stopped++;
        }

        return { stopped };
    }

    startGc(intervalMs: number): void {
        if (this.gcTimer) return;
        this.gcTimer = setInterval(() => this.gc(), Math.max(30_000, intervalMs));
        this.gcTimer.unref?.();
    }

    stopGc(): void {
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
            lastPolledAt: new Date(state.lastPolledAt).toISOString(),
            idleTimeoutMs: state.idleMs,
            pendingEvents: state.events.length,
            totalEvents: state.totalEvents,
            dropped: state.dropped
        };
    }
}

export const watchers = new WatchManager();
