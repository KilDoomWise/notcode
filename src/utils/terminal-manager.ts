import { getWorkspaceRoot, loadConfig } from "@/config";
import { Mutex } from "@/utils/lock";
import { createLogger, errorMessage } from "@/utils/logger";
import { terminateProcess } from "@/utils/proc";

const log = createLogger("terminal");

/**
 * Менеджер долгоживущих терминал-сессий.
 *
 * Идея: держим настоящий shell-процесс с открытым stdin. Команды пишем в него построчно,
 * а факт завершения команды детектим по служебному маркеру, который печатает сам shell:
 *   __NOTCODE_DONE_<token>__<exitCode>|<cwd>
 * Маркер вырезается из видимого вывода, а из него же берём exit code и актуальный cwd
 * (то есть `cd` внутри сессии сохраняется между командами — в отличие от одноразового exec).
 *
 * Критично: stdout и stderr буферизуются ОТДЕЛЬНО. Раньше оба потока писали в одно
 * поле `pending`, чанки чередовались и маркер мог быть разорван чужим байтом — тогда сессия
 * навсегда оставалась в статусе running и больше не принимала команд.
 */
const MARKER_PREFIX = "__NOTCODE_DONE_";
const MARKER_RE = /__NOTCODE_DONE_([0-9a-zA-Z]+)__(-?\d+)\|?([^\r\n]*)/;

/** Сколько держать завершённую сессию, если её никто не читает. */
const GC_IDLE_MS = 30 * 60_000;
const GC_INTERVAL_MS = 5 * 60_000;

export type SessionStatus = "idle" | "running" | "exited";
export type ShellKind = "cmd" | "powershell" | "bash" | "sh";

export interface SessionInfo {
    id: string;
    name: string;
    shell: ShellKind;
    cwd: string;
    status: SessionStatus;
    createdAt: string;
    lastActivityAt: string;
    lastCommand: string | null;
    lastExitCode: number | null;
    shellExitCode: number | null;
    runningForMs: number | null;
    bufferedChars: number;
    cursor: number;
}

export interface ReadResult {
    text: string;
    cursor: number;
    droppedChars: number;
    bufferedChars: number;
}

export interface RunResult {
    completed: boolean;
    status: SessionStatus;
    exitCode: number | null;
    output: string;
    cursor: number;
    elapsedMs: number;
    cwd: string;
}

function defaultShell(): ShellKind {
    return process.platform === "win32" ? "cmd" : "bash";
}

function shellArgv(shell: ShellKind): string[] {
    switch (shell) {
        case "cmd":
            // /Q — без эха команд, /D — без AutoRun-скриптов реестра.
            return ["cmd.exe", "/Q", "/D"];
        case "powershell":
            return process.platform === "win32"
                ? ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "-"]
                : ["pwsh", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "-"];
        case "bash":
            return ["bash", "-s"];
        case "sh":
            return ["sh", "-s"];
    }
}

/**
 * Команда перевода сессии в UTF-8.
 * Без неё cmd.exe на русской Windows пишет в cp866, а мы декодируем как UTF-8 —
 * любой русский вывод превращался в кракозябры.
 */
function encodingSetupCommand(shell: ShellKind): string | null {
    switch (shell) {
        case "cmd":
            return "chcp 65001>nul";
        case "powershell":
            return "$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)";
        case "bash":
        case "sh":
            return null;
    }
}

function markerCommand(shell: ShellKind, token: string): string {
    switch (shell) {
        case "cmd":
            return `echo ${MARKER_PREFIX}${token}__%ERRORLEVEL%^|%CD%`;
        case "powershell":
            return `Write-Output "${MARKER_PREFIX}${token}__$(if ($LASTEXITCODE -ne $null) { $LASTEXITCODE } elseif ($?) { 0 } else { 1 })|$($PWD.Path)"`;
        case "bash":
        case "sh":
            return `echo "${MARKER_PREFIX}${token}__$?|$PWD"`;
    }
}

/** Длина «опасного» хвоста, который может оказаться началом маркера, разорванного между чанками. */
function riskySuffixLength(value: string): number {
    const tail = value.slice(-MARKER_PREFIX.length);
    for (let i = 0; i < tail.length; i++) {
        if (MARKER_PREFIX.startsWith(tail.slice(i))) {
            return tail.length - i;
        }
    }
    return 0;
}

let sessionCounter = 0;

class TerminalSession {
    readonly id: string;
    readonly name: string;
    readonly shell: ShellKind;
    readonly createdAt = Date.now();

    cwd: string;
    status: SessionStatus = "idle";
    lastCommand: string | null = null;
    lastExitCode: number | null = null;
    shellExitCode: number | null = null;
    lastActivityAt = Date.now();

    private readonly proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
    private readonly maxBufferChars: number;
    private readonly eol: string;
    private readonly stdinQueue = new Mutex();

    private buffer = "";
    private bufferStart = 0;
    /** Отдельные незавершённые строки на каждый поток — иначе они склеиваются и ломают маркер. */
    private pendingOut = "";
    private pendingErr = "";
    private token: string | null = null;
    private commandStartedAt: number | null = null;
    private doneWaiters: Array<() => void> = [];

    constructor(options: {
        id: string;
        name: string;
        shell: ShellKind;
        cwd: string;
        maxBufferChars: number;
        env?: Record<string, string> | undefined;
    }) {
        this.id = options.id;
        this.name = options.name;
        this.shell = options.shell;
        this.cwd = options.cwd;
        this.maxBufferChars = options.maxBufferChars;
        this.eol = options.shell === "cmd" ? "\r\n" : "\n";

        this.proc = Bun.spawn({
            cmd: shellArgv(options.shell),
            cwd: options.cwd,
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
            env: { ...process.env, ...options.env }
        }) as Bun.Subprocess<"pipe", "pipe", "pipe">;

        this.pump(this.proc.stdout as ReadableStream<Uint8Array>, true);
        this.pump(this.proc.stderr as ReadableStream<Uint8Array>, false);

        void this.proc.exited.then(code => {
            this.status = "exited";
            this.shellExitCode = typeof code === "number" ? code : null;
            this.lastActivityAt = Date.now();
            // Кто ждёт завершения команды — не должен висеть до таймаута, если shell умер.
            this.signalDone();
        });
    }

    get cursor(): number {
        return this.bufferStart + this.buffer.length;
    }

    get bufferedChars(): number {
        return this.buffer.length;
    }

    info(): SessionInfo {
        return {
            id: this.id,
            name: this.name,
            shell: this.shell,
            cwd: this.cwd,
            status: this.status,
            createdAt: new Date(this.createdAt).toISOString(),
            lastActivityAt: new Date(this.lastActivityAt).toISOString(),
            lastCommand: this.lastCommand,
            lastExitCode: this.lastExitCode,
            shellExitCode: this.shellExitCode,
            runningForMs:
                this.status === "running" && this.commandStartedAt !== null ? Date.now() - this.commandStartedAt : null,
            bufferedChars: this.bufferedChars,
            cursor: this.cursor
        };
    }

    /** Читает буфер начиная с курсора (или последние tail символов). */
    read(options: { since?: number | undefined; maxChars?: number | undefined; tail?: number | undefined } = {}): ReadResult {
        const from = options.since === undefined ? this.bufferStart : Math.max(options.since, this.bufferStart);
        const droppedChars =
            options.since !== undefined && options.since < this.bufferStart ? this.bufferStart - options.since : 0;

        let value = this.buffer.slice(Math.max(0, from - this.bufferStart));
        if (options.tail !== undefined && value.length > options.tail) {
            value = value.slice(value.length - options.tail);
        }
        if (options.maxChars !== undefined && value.length > options.maxChars) {
            value = value.slice(value.length - options.maxChars);
        }

        return { text: value, cursor: this.cursor, droppedChars, bufferedChars: this.bufferedChars };
    }

    /** Сырой stdin — для интерактивных программ (ответы на промпты, y/n, пароли). */
    async write(input: string, appendNewline = true): Promise<void> {
        this.assertAlive();
        await this.writeRaw(appendNewline ? `${input}${this.eol}` : input);
        this.lastActivityAt = Date.now();
    }

    async run(command: string, waitMs: number): Promise<RunResult> {
        this.assertAlive();

        if (this.status === "running") {
            throw new Error(
                `Сессия ${this.id} занята командой '${this.lastCommand}'. ` +
                    `Смотри вывод через terminal_read, открой новый терминал (terminal_open) или закрой эту (terminal_close).`
            );
        }

        const token = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
        const startCursor = this.cursor;

        this.token = token;
        this.status = "running";
        this.lastCommand = command;
        this.lastExitCode = null;
        this.commandStartedAt = Date.now();
        this.lastActivityAt = Date.now();

        // Подписываемся ДО записи: быстрая команда может завершиться раньше, чем мы начнём ждать.
        const completed = new Promise<void>(resolve => {
            this.doneWaiters.push(resolve);
        });

        await this.writeRaw(`${command}${this.eol}${markerCommand(this.shell, token)}${this.eol}`);

        /**
         * Ждём событие, а не крутим `while (...) await Bun.sleep(40)`.
         * Старый busy-wait на десятиминутной команде давал 15 000 бесполезных итераций.
         */
        if (waitMs > 0) {
            await Promise.race([completed, Bun.sleep(waitMs)]);
        }

        const elapsedMs = Date.now() - (this.commandStartedAt ?? Date.now());
        const output = this.read({ since: startCursor });

        return {
            completed: this.status !== "running",
            status: this.status,
            exitCode: this.lastExitCode,
            output: output.text,
            cursor: output.cursor,
            elapsedMs,
            cwd: this.cwd
        };
    }

    /** Сбрасывает видимый буфер (например, чтобы выкинуть баннер shell при старте). */
    clear(): void {
        this.bufferStart = this.cursor;
        this.buffer = "";
    }

    async close(force = false): Promise<void> {
        try {
            if (!force && this.status !== "exited") {
                await this.writeRaw(`exit${this.eol}`);
                await Promise.race([this.proc.exited, Bun.sleep(600)]);
            }
        } catch {
            // всё равно убьём ниже
        }

        // Гасим всё дерево: раньше proc.kill() убивал только shell, а dev-серверы,
        // запущенные внутри сессии, оставались висеть и держать порты.
        await terminateProcess(this.proc, { graceMs: force ? 0 : 800 });

        this.status = "exited";
        this.signalDone();
    }

    private signalDone(): void {
        const waiters = this.doneWaiters;
        this.doneWaiters = [];
        for (const resolve of waiters) resolve();
    }

    private assertAlive(): void {
        if (this.status === "exited") {
            throw new Error(
                `Сессия ${this.id} уже завершена (shell exit=${this.shellExitCode}). Открой новую через terminal_open.`
            );
        }
    }

    /** Записи в stdin сериализованы и дожидаются flush: иначе быстрые write подряд перемешиваются. */
    private writeRaw(chunk: string): Promise<void> {
        return this.stdinQueue.run(async () => {
            const stdin = this.proc.stdin as Bun.FileSink;
            stdin.write(chunk);
            await stdin.flush();
        });
    }

    private pump(stream: ReadableStream<Uint8Array>, isStdout: boolean): void {
        const reader = stream.getReader();
        const decoder = new TextDecoder();

        void (async () => {
            try {
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    if (value) this.ingest(decoder.decode(value, { stream: true }), isStdout);
                }
            } catch (error) {
                log.debug("поток сессии закрылся", { id: this.id, error: errorMessage(error) });
            } finally {
                reader.releaseLock();
            }
        })();
    }

    /** Разбирает поток на строки, вырезает маркеры, остальное кладёт в буфер. */
    private ingest(chunk: string, isStdout: boolean): void {
        this.lastActivityAt = Date.now();

        let pending = (isStdout ? this.pendingOut : this.pendingErr) + chunk;

        let newlineIndex = pending.indexOf("\n");
        while (newlineIndex >= 0) {
            const line = pending.slice(0, newlineIndex + 1);
            pending = pending.slice(newlineIndex + 1);
            // Маркер печатает echo/Write-Output — только stdout. В stderr его искать не надо.
            this.append(isStdout ? this.processLine(line) : line);
            newlineIndex = pending.indexOf("\n");
        }

        // Незавершённую строку отдаём сразу (прогресс-бары), кроме возможного начала маркера.
        if (isStdout) {
            const hold = riskySuffixLength(pending);
            if (hold < pending.length && !pending.includes(MARKER_PREFIX)) {
                this.append(pending.slice(0, pending.length - hold));
                pending = pending.slice(pending.length - hold);
            }
        } else if (pending.length > 0) {
            this.append(pending);
            pending = "";
        }

        if (isStdout) this.pendingOut = pending;
        else this.pendingErr = pending;
    }

    private processLine(line: string): string {
        const match = MARKER_RE.exec(line);
        if (!match) return line;

        const [, token, exitCode, cwd] = match;
        if (token === this.token) {
            this.lastExitCode = Number.parseInt(exitCode ?? "0", 10);
            this.status = "idle";
            this.token = null;
            const trimmedCwd = (cwd ?? "").trim();
            if (trimmedCwd.length > 0) this.cwd = trimmedCwd;
            this.signalDone();
        }

        // Строку с маркером не показываем; остальную часть строки — показываем.
        return line.replace(MARKER_RE, "").replace(/^\r?\n/, "");
    }

    private append(value: string): void {
        if (!value) return;
        this.buffer += value;
        if (this.buffer.length > this.maxBufferChars) {
            const drop = this.buffer.length - this.maxBufferChars;
            this.buffer = this.buffer.slice(drop);
            this.bufferStart += drop;
        }
    }
}

class TerminalManager {
    private readonly sessions = new Map<string, TerminalSession>();
    private gcTimer: ReturnType<typeof setInterval> | null = null;

    async open(
        options: { cwd?: string; shell?: ShellKind; name?: string; env?: Record<string, string> } = {}
    ): Promise<SessionInfo> {
        const config = await loadConfig();
        this.gc();
        this.ensureGcTimer();

        const alive = [...this.sessions.values()].filter(session => session.status !== "exited");
        if (alive.length >= config.limits.maxSessions) {
            throw new Error(
                `Достигнут лимит терминалов (${config.limits.maxSessions}). Закрой ненужные через terminal_close.`
            );
        }

        // Монотонный счётчик: sessions.size после закрытия сессий давал повторяющиеся id.
        const id = `t${(++sessionCounter).toString().padStart(2, "0")}-${crypto.randomUUID().slice(0, 4)}`;
        const shell = options.shell ?? defaultShell();

        const session = new TerminalSession({
            id,
            name: options.name ?? id,
            shell,
            cwd: options.cwd ?? getWorkspaceRoot(config),
            maxBufferChars: config.limits.sessionBufferChars,
            env: options.env
        });

        this.sessions.set(id, session);

        const setup = encodingSetupCommand(shell);
        if (setup) {
            await session.write(setup).catch(error => {
                log.warn("не удалось перевести сессию в UTF-8", { id, error: errorMessage(error) });
            });
        }

        // Даём shell выплюнуть баннер/приветствие и чистим буфер.
        await Bun.sleep(250);
        session.clear();

        log.info("терминал открыт", { id, shell, cwd: session.cwd });

        return session.info();
    }

    get(id: string): TerminalSession {
        const session = this.sessions.get(id);
        if (!session) {
            const known = [...this.sessions.keys()];
            throw new Error(
                `Терминал '${id}' не найден. Активные: ${known.length > 0 ? known.join(", ") : "нет"} (terminal_list).`
            );
        }
        return session;
    }

    list(): SessionInfo[] {
        return [...this.sessions.values()].map(session => session.info());
    }

    async close(id: string, force = false): Promise<SessionInfo> {
        const session = this.get(id);
        await session.close(force);
        const info = session.info();
        this.sessions.delete(id);
        log.info("терминал закрыт", { id, force });
        return info;
    }

    async closeAll(): Promise<number> {
        const ids = [...this.sessions.keys()];
        await Promise.all(ids.map(id => this.close(id, true).catch(() => undefined)));
        if (this.gcTimer !== null) {
            clearInterval(this.gcTimer);
            this.gcTimer = null;
        }
        return ids.length;
    }

    /** Убирает завершённые сессии, которые никто не читал больше 30 минут. */
    gc(): void {
        const cutoff = Date.now() - GC_IDLE_MS;
        for (const [id, session] of this.sessions) {
            if (session.status === "exited" && session.lastActivityAt < cutoff) {
                this.sessions.delete(id);
            }
        }
    }

    /** Раньше gc() вызывался только из open(): если больше не открывать терминалов, мёртвые висели вечно. */
    private ensureGcTimer(): void {
        if (this.gcTimer !== null) return;
        this.gcTimer = setInterval(() => this.gc(), GC_INTERVAL_MS);
        this.gcTimer.unref?.();
    }
}

export const terminals = new TerminalManager();
export type { TerminalSession };
