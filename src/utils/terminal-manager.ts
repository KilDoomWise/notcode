import { getWorkspaceRoot, loadConfig } from "@/config";

/**
 * Менеджер долгоживущих терминал-сессий.
 *
 * Идея: держим настоящий shell-процесс с открытым stdin. Команды пишем в него построчно,
 * а факт завершения команды детектим по служебному маркеру, который печатает сам shell:
 *   __NOTCODE_DONE_<token>__<exitCode>|<cwd>
 * Маркер вырезается из видимого вывода, а из него же берём exit code и актуальный cwd
 * (то есть `cd` внутри сессии сохраняется между командами — в отличие от одноразового exec).
 */
const MARKER_PREFIX = "__NOTCODE_DONE_";
const MARKER_RE = /__NOTCODE_DONE_([0-9a-zA-Z]+)__(-?\d+)\|?([^\r\n]*)/;

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
    private buffer = "";
    private bufferStart = 0;
    private pending = "";
    private token: string | null = null;
    private commandStartedAt: number | null = null;

    constructor(options: {
        id: string;
        name: string;
        shell: ShellKind;
        cwd: string;
        maxBufferChars: number;
        env?: Record<string, string>;
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

        this.pump(this.proc.stdout as ReadableStream<Uint8Array>);
        this.pump(this.proc.stderr as ReadableStream<Uint8Array>);

        void this.proc.exited.then(code => {
            this.status = "exited";
            this.shellExitCode = typeof code === "number" ? code : null;
            this.lastActivityAt = Date.now();
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
            runningForMs: this.status === "running" && this.commandStartedAt ? Date.now() - this.commandStartedAt : null,
            bufferedChars: this.bufferedChars,
            cursor: this.cursor
        };
    }

    /** Читает буфер начиная с курсора (или последние tail символов). */
    read(options: { since?: number; maxChars?: number; tail?: number } = {}): ReadResult {
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
    write(input: string, appendNewline = true): void {
        this.assertAlive();
        this.writeRaw(appendNewline ? `${input}${this.eol}` : input);
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

        this.writeRaw(`${command}${this.eol}${markerCommand(this.shell, token)}${this.eol}`);

        const deadline = Date.now() + Math.max(0, waitMs);
        while (this.status === "running" && Date.now() < deadline) {
            await Bun.sleep(40);
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
                this.writeRaw(`exit${this.eol}`);
                await Promise.race([this.proc.exited, Bun.sleep(600)]);
            }
        } catch {
            // всё равно убьём ниже
        }

        try {
            this.proc.kill(force ? 9 : 15);
        } catch {
            // процесс уже мёртв
        }

        this.status = "exited";
    }

    private assertAlive(): void {
        if (this.status === "exited") {
            throw new Error(
                `Сессия ${this.id} уже завершена (shell exit=${this.shellExitCode}). Открой новую через terminal_open.`
            );
        }
    }

    private writeRaw(chunk: string): void {
        const stdin = this.proc.stdin as Bun.FileSink;
        stdin.write(chunk);
        void stdin.flush();
    }

    private pump(stream: ReadableStream<Uint8Array>): void {
        const reader = stream.getReader();
        const decoder = new TextDecoder();

        void (async () => {
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    if (value) this.ingest(decoder.decode(value, { stream: true }));
                }
            } catch {
                // стрим закрылся вместе с процессом
            }
        })();
    }

    /** Разбирает поток на строки, вырезает маркеры, остальное кладёт в буфер. */
    private ingest(chunk: string): void {
        this.pending += chunk;
        this.lastActivityAt = Date.now();

        let newlineIndex = this.pending.indexOf("\n");
        while (newlineIndex >= 0) {
            const line = this.pending.slice(0, newlineIndex + 1);
            this.pending = this.pending.slice(newlineIndex + 1);
            this.append(this.processLine(line));
            newlineIndex = this.pending.indexOf("\n");
        }

        // Незавершённую строку отдаём сразу (прогресс-бары), кроме возможного начала маркера.
        const hold = riskySuffixLength(this.pending);
        if (hold < this.pending.length && !this.pending.includes(MARKER_PREFIX)) {
            const emit = this.pending.slice(0, this.pending.length - hold);
            this.pending = this.pending.slice(this.pending.length - hold);
            this.append(emit);
        }
    }

    private processLine(line: string): string {
        const match = MARKER_RE.exec(line);
        if (!match) return line;

        const [, token, exitCode, cwd] = match;
        if (token === this.token) {
            this.lastExitCode = Number.parseInt(exitCode as string, 10);
            this.status = "idle";
            this.token = null;
            const trimmedCwd = (cwd ?? "").trim();
            if (trimmedCwd.length > 0) this.cwd = trimmedCwd;
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

    async open(options: { cwd?: string; shell?: ShellKind; name?: string; env?: Record<string, string> } = {}): Promise<SessionInfo> {
        const config = await loadConfig();
        this.gc();

        const alive = [...this.sessions.values()].filter(session => session.status !== "exited");
        if (alive.length >= config.limits.maxSessions) {
            throw new Error(
                `Достигнут лимит терминалов (${config.limits.maxSessions}). Закрой ненужные через terminal_close.`
            );
        }

        const id = `t${(this.sessions.size + 1).toString().padStart(2, "0")}-${crypto.randomUUID().slice(0, 4)}`;
        const session = new TerminalSession({
            id,
            name: options.name ?? id,
            shell: options.shell ?? defaultShell(),
            cwd: options.cwd ?? getWorkspaceRoot(config),
            maxBufferChars: config.limits.sessionBufferChars,
            env: options.env
        });

        this.sessions.set(id, session);

        // Даём shell выплюнуть баннер/приветствие и чистим буфер.
        await Bun.sleep(250);
        session.clear();

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
        return info;
    }

    async closeAll(): Promise<number> {
        const ids = [...this.sessions.keys()];
        await Promise.all(ids.map(id => this.close(id, true).catch(() => undefined)));
        return ids.length;
    }

    /** Убирает завершённые сессии, которые никто не читал больше 30 минут. */
    gc(): void {
        const cutoff = Date.now() - 30 * 60_000;
        for (const [id, session] of this.sessions) {
            if (session.status === "exited" && session.lastActivityAt < cutoff) {
                this.sessions.delete(id);
            }
        }
    }
}

export const terminals = new TerminalManager();
export type { TerminalSession };
