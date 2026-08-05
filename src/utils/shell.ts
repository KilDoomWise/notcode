import { getWorkspaceRoot, loadConfig } from "@/config";
import { truncate } from "@/utils/output";

/**
 * Одноразовый запуск команды через Bun.spawn.
 * Раньше здесь был `$.raw`, которого нет в актуальном рантайме — тул падал всегда.
 */
export interface RunOnceOptions {
    command: string;
    cwd?: string;
    timeoutMs?: number;
    maxOutputChars?: number;
    env?: Record<string, string>;
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

/** Обёртка команды в системный shell. */
export function shellCommand(command: string): string[] {
    return process.platform === "win32"
        ? ["cmd.exe", "/d", "/s", "/c", command]
        : ["/bin/sh", "-lc", command];
}

export async function runOnce(options: RunOnceOptions): Promise<RunOnceResult> {
    const config = await loadConfig();
    const cwd = options.cwd ?? getWorkspaceRoot(config);
    const timeoutMs = Math.max(1000, options.timeoutMs ?? config.limits.execTimeoutMs);
    const maxOutputChars = options.maxOutputChars ?? config.limits.maxOutputChars;
    const startedAt = Date.now();

    const proc = Bun.spawn({
        cmd: shellCommand(options.command),
        cwd,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, ...options.env }
    });

    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        try {
            proc.kill(9);
        } catch {
            // процесс уже умер
        }
    }, timeoutMs);

    const [stdoutRaw, stderrRaw, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited
    ]);
    clearTimeout(timer);

    const stdout = truncate(stdoutRaw.trim(), maxOutputChars);
    const stderr = truncate(stderrRaw.trim(), Math.min(maxOutputChars, 20_000));

    return {
        command: options.command,
        cwd,
        exitCode: typeof exitCode === "number" ? exitCode : null,
        stdout: stdout.text,
        stderr: stderr.text,
        timedOut,
        truncated: stdout.truncated || stderr.truncated,
        durationMs: Date.now() - startedAt
    };
}

/** Человекочитаемый рендер результата команды. */
export function formatRunResult(result: RunOnceResult): string {
    const lines = [
        `$ ${result.command}`,
        `cwd: ${result.cwd}  |  exit: ${result.exitCode}  |  ${result.durationMs}ms${result.timedOut ? "  |  TIMEOUT" : ""}`
    ];

    if (result.stdout) lines.push("", result.stdout);
    if (result.stderr) lines.push("", "--- STDERR ---", result.stderr);
    if (!result.stdout && !result.stderr) lines.push("", "(нет вывода)");

    return lines.join("\n");
}
