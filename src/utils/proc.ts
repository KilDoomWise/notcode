/**
 * Корректное завершение дочерних процессов.
 *
 * `proc.kill()` убивает только сам shell. Всё, что shell успел запустить
 * (dev-сервер, bun --watch, npm), остаётся жить и держать порты — на Windows
 * особенно, потому что там нет сигналов и process groups в привычном виде.
 * Поэтому дерево процессов гасим явно: taskkill /T на Windows, kill по группе
 * с откатом на одиночный pid на POSIX.
 */

import { createLogger, errorMessage } from "@/utils/logger";

const log = createLogger("proc");

const isWindows = process.platform === "win32";

export interface KillableProcess {
    readonly pid?: number | undefined;
    kill(signal?: number): void;
    readonly exited: Promise<number>;
}

/** Гасит процесс вместе со всеми потомками. Никогда не бросает. */
export async function killTree(pid: number | undefined, options: { force?: boolean } = {}): Promise<void> {
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return;

    if (isWindows) {
        // /T — вместе с деревом потомков, /F — принудительно.
        // Без /F консольные процессы без окна попросту игнорируют запрос.
        try {
            const killer = Bun.spawn({
                cmd: ["taskkill", "/pid", String(pid), "/T", "/F"],
                stdin: "ignore",
                stdout: "ignore",
                stderr: "ignore"
            });
            await killer.exited;
        } catch (error) {
            log.debug("taskkill не сработал", { pid, error: errorMessage(error) });
        }
        return;
    }

    const signal = options.force ? "SIGKILL" : "SIGTERM";

    // Отрицательный pid = вся группа процессов; работает не всегда, поэтому есть откат.
    try {
        process.kill(-pid, signal);
        return;
    } catch {
        // группы нет — гасим одиночный процесс
    }

    try {
        process.kill(pid, signal);
    } catch (error) {
        log.debug("kill не сработал", { pid, error: errorMessage(error) });
    }
}

export interface TerminateOptions {
    /** Сколько ждать добровольного выхода перед SIGKILL (по умолчанию 1500 мс). */
    graceMs?: number;
}

/**
 * Мягко завершает процесс, затем добивает.
 * Возвращает true, если процесс действительно завершился.
 */
export async function terminateProcess(proc: KillableProcess, options: TerminateOptions = {}): Promise<boolean> {
    const graceMs = Math.max(0, options.graceMs ?? 1500);
    const exited = proc.exited.then(
        () => true,
        () => true
    );

    await killTree(proc.pid);
    try {
        proc.kill();
    } catch {
        // уже мёртв
    }

    if (await Promise.race([exited, Bun.sleep(graceMs).then(() => false)])) {
        return true;
    }

    await killTree(proc.pid, { force: true });
    try {
        proc.kill(9);
    } catch {
        // уже мёртв
    }

    return Promise.race([exited, Bun.sleep(1000).then(() => false)]);
}
