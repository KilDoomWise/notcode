import { getWorkspaceRoot, loadConfig } from "@/config";
import { createLogger, errorMessage } from "@/utils/logger";
import { truncate } from "@/utils/output";
import { terminateProcess } from "@/utils/proc";

const log = createLogger("shell");

const isWindows = process.platform === "win32";

/**
 * Одноразовый запуск команды через Bun.spawn.
 *
 * Два режима:
 *  - argv: прямой запуск без shell. Единственный безопасный способ подставлять
 *    пользовательские данные (сообщение коммита, имя ветки, путь).
 *  - command: строка для системного shell. Только для того, что пользователь написал сам.
 */
export interface RunOnceOptions {
    /** Командная строка для shell. Взаимоисключается с argv. */
    command?: string;
    /** Аргументы без shell: argv[0] — исполняемый файл. Предпочтительный вариант. */
    argv?: string[];
    cwd?: string;
    timeoutMs?: number;
    maxOutputChars?: number;
    env?: Record<string, string>;
    /** Что подать на stdin дочернему процессу. */
    stdin?: string;
}

export interface RunOnceResult {
    command: string;
    cwd: string;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    truncated: boolean;
    durationMs: number;
}

/**
 * Обёртка команды в системный shell.
 *
 * На Windows принудительно включаем UTF-8 (chcp 65001): иначе cmd.exe отдаёт cp866
 * и любой русский вывод приезжает кракозябрами.
 * На POSIX используется `-c`, а не `-lc`: login-shell перечитывает профили и может
 * непредсказуемо подменить PATH относительно того, что видит сам сервер.
 */
export function shellCommand(command: string): string[] {
    return isWindows
        ? ["cmd.exe", "/d", "/s", "/c", `chcp 65001>nul & ${command}`]
        : ["/bin/sh", "-c", command];
}

/**
 * Читает поток с жёстким потолком по памяти.
 * `new Response(stream).text()` буферизовал весь вывод целиком: команда вроде `yes`
 * или сборка с потоком логов съедала память до OOM ещё до всякого truncate.
 */
async function readCapped(stream: ReadableStream<Uint8Array> | null, capChars: number): Promise<string> {
    if (!stream) return "";

    const reader = stream.getReader();
    const decoder = new TextDecoder("utf-8");
    let text = "";
    let overflow = false;

    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;

            if (overflow) continue;

            text += decoder.decode(value, { stream: true });
            if (text.length > capChars) {
                text = text.slice(0, capChars);
                overflow = true;
            }
        }
        if (!overflow) text += decoder.decode();
    } catch (error) {
        log.debug("ошибка чтения потока процесса", { error: errorMessage(error) });
    } finally {
        reader.releaseLock();
    }

    return text;
}

export async function runOnce(options: RunOnceOptions): Promise<RunOnceResult> {
    if (!options.command && (!options.argv || options.argv.length === 0)) {
        throw new Error("runOnce: нужно указать либо command, либо непустой argv");
    }

    const config = await loadConfig();
    const cwd = options.cwd ?? getWorkspaceRoot(config);
    const timeoutMs = Math.max(1000, options.timeoutMs ?? config.limits.execTimeoutMs);
    const maxOutputChars = options.maxOutputChars ?? config.limits.maxOutputChars;
    const startedAt = Date.now();

    const cmd = options.argv && options.argv.length > 0 ? options.argv : shellCommand(options.command ?? "");
    const display = options.command ?? (options.argv ?? []).join(" ");

    const proc = Bun.spawn({
        cmd,
        cwd,
        stdin: options.stdin === undefined ? "ignore" : new TextEncoder().encode(options.stdin),
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, ...options.env }
    });

    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        // Гасим всё дерево: иначе умирает только shell, а запущенный им процесс остаётся висеть.
        void terminateProcess(proc, { graceMs: 500 });
    }, timeoutMs);

    // Потолок чтения шире лимита ответа, чтобы truncate видел, что данные реально обрезаны.
    const readCap = Math.max(maxOutputChars * 2, maxOutputChars + 10_000);

    let stdoutRaw = "";
    let stderrRaw = "";
    let exitCode: number | null = null;

    try {
        const [out, err, code] = await Promise.all([
            readCapped(proc.stdout as ReadableStream<Uint8Array> | null, readCap),
            readCapped(proc.stderr as ReadableStream<Uint8Array> | null, readCap),
            proc.exited
        ]);
        stdoutRaw = out;
        stderrRaw = err;
        exitCode = typeof code === "number" ? code : null;
    } finally {
        clearTimeout(timer);
    }

    const stdout = truncate(stdoutRaw.trim(), maxOutputChars);
    const stderr = truncate(stderrRaw.trim(), Math.min(maxOutputChars, 20_000));

    return {
        command: display,
        cwd,
        exitCode,
        stdout: stdout.text,
        stderr: stderr.text,
        timedOut,
        truncated: stdout.truncated || stderr.truncated,
        durationMs: Date.now() - startedAt
    };
}

/** Человекочитаемый рендер результата команды. */
export function formatRunResult(result: RunOnceResult): string {
    const flags = [
        result.timedOut ? "TIMEOUT" : null,
        result.truncated ? "вывод усечён" : null
    ].filter((flag): flag is string => flag !== null);

    const lines = [
        `$ ${result.command}`,
        `cwd: ${result.cwd}  |  exit: ${result.exitCode}  |  ${result.durationMs}ms${
            flags.length > 0 ? `  |  ${flags.join("  |  ")}` : ""
        }`
    ];

    if (result.stdout) lines.push("", result.stdout);
    if (result.stderr) lines.push("", "--- STDERR ---", result.stderr);
    if (!result.stdout && !result.stderr) lines.push("", "(нет вывода)");

    return lines.join("\n");
}
