import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/**
 * Пишет команду во временный скрипт-файл и возвращает argv для его запуска.
 * Раньше команда шла строкой прямо в `cmd.exe /c "<command>"` через Bun.spawn:
 * Bun пересобирает argv в командную строку по правилам Windows, из-за чего
 * вложенные кавычки и спецсимволы (git-сообщения, пути с пробелами) переэкранировались
 * неверно и команда либо не находилась, либо ломалась на парсинге. Скрипт-файл
 * убирает этот слой пересборки — Bun.spawn получает только путь к файлу.
 */
const TEMP_PREFIX = "notcode-";

async function writeScript(command: string): Promise<{ argv: string[]; cleanup: () => Promise<void> }> {
    const dir = await mkdtemp(join(tmpdir(), TEMP_PREFIX));

    if (process.platform === "win32") {
        const scriptPath = join(dir, "run.cmd");
        await writeFile(scriptPath, `@echo off\r\n${command}\r\n`, "utf8");
        return {
            argv: ["cmd.exe", "/d", "/s", "/c", scriptPath],
            cleanup: () => rm(dir, { recursive: true, force: true })
        };
    }

    const scriptPath = join(dir, "run.sh");
    await writeFile(scriptPath, `#!/bin/sh\nset -e\n${command}\n`, "utf8");
    return {
        argv: ["/bin/sh", scriptPath],
        cleanup: () => rm(dir, { recursive: true, force: true })
    };
}

export async function runOnce(options: RunOnceOptions): Promise<RunOnceResult> {
    const config = await loadConfig();
    const cwd = options.cwd ?? getWorkspaceRoot(config);
    const timeoutMs = Math.max(1000, options.timeoutMs ?? config.limits.execTimeoutMs);
    const maxOutputChars = options.maxOutputChars ?? config.limits.maxOutputChars;
    const startedAt = Date.now();

    const { argv, cleanup } = await writeScript(options.command);

    try {
        const proc = Bun.spawn({
            cmd: argv,
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
    } finally {
        await cleanup().catch(() => {
            // временный файл не критичен
        });
    }
}

export interface RunArgvOptions {
    argv: string[];
    cwd?: string;
    timeoutMs?: number;
    maxOutputChars?: number;
    env?: Record<string, string>;
}

/**
 * Запускает программу напрямую по argv, без промежуточного shell/скрипта.
 * В отличие от runOnce() тут нет никакого текстового квотирования: Bun.spawn сам собирает argv
 * в вызов ОС (на Windows — по стандартному CreateProcess-алгоритму), поэтому кавычки, `%`, `&`
 * и другие спецсимволы в аргументах (например, в сообщении git-коммита) не требуют экранирования
 * и не могут сломать разбор команды. Используй для программ с чётким списком аргументов (git и
 * т.п.); для произвольного пользовательского shell-синтаксиса (pipe, redirect, `&&`) по-прежнему
 * нужен runOnce()/terminal-сессия.
 */
export async function runArgv(options: RunArgvOptions): Promise<RunOnceResult> {
    const config = await loadConfig();
    const cwd = options.cwd ?? getWorkspaceRoot(config);
    const timeoutMs = Math.max(1000, options.timeoutMs ?? config.limits.execTimeoutMs);
    const maxOutputChars = options.maxOutputChars ?? config.limits.maxOutputChars;
    const startedAt = Date.now();

    const proc = Bun.spawn({
        cmd: options.argv,
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
        command: options.argv.join(" "),
        cwd,
        exitCode: typeof exitCode === "number" ? exitCode : null,
        stdout: stdout.text,
        stderr: stderr.text,
        timedOut,
        truncated: stdout.truncated || stderr.truncated,
        durationMs: Date.now() - startedAt
    };
}

/**
 * Подчищает временные папки скриптов, оставшиеся от упавших/убитых процессов.
 * cleanup() в runOnce отрабатывает только при штатном завершении, поэтому нужен старт-GC.
 */
export async function cleanupTempScripts(maxAgeMs = 60 * 60_000): Promise<{ removed: number; freedBytes: number }> {
    const dir = tmpdir();
    const cutoff = Date.now() - maxAgeMs;
    let removed = 0;
    let freedBytes = 0;

    let names: string[];
    try {
        names = await readdir(dir);
    } catch {
        return { removed, freedBytes };
    }

    for (const name of names) {
        if (!name.startsWith(TEMP_PREFIX)) continue;

        const full = join(dir, name);
        try {
            const info = await stat(full);
            if (!info.isDirectory()) continue;
            if (info.mtimeMs > cutoff) continue;

            let size = 0;
            try {
                for (const child of await readdir(full)) {
                    size += (await stat(join(full, child))).size;
                }
            } catch {
                // размер не критичен
            }

            await rm(full, { recursive: true, force: true });
            removed++;
            freedBytes += size;
        } catch {
            // папка занята другим процессом — оставляем
        }
    }

    return { removed, freedBytes };
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
