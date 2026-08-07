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

/** Какие shell-опции вообще имеют смысл на этой ОС — используется схемой terminal_open,
 *  чтобы вызывающая модель не пыталась открыть cmd на Linux или bash на Windows без WSL. */
export const AVAILABLE_SHELLS: ShellKind[] =
    process.platform === "win32" ? ["cmd", "powershell"] : ["bash", "sh", "powershell"];

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

/** Команда явно фонит через POSIX `&` в конце — не можем безопасно приклеить `; marker`
 *  на ту же строку (`cmd & ; marker` — синтаксическая ошибка bash/sh). Такие команды
 *  почти не встречаются в этом инструменте (для долгих задач есть waitMs), поэтому для
 *  них сохраняем старое поведение из двух строк вместо склейки ниже. */
const TRAILING_BACKGROUND_RE = /&\s*$/;

/**
 * Раньше run() писал `${command}\n${markerCommand}\n` ДВУМЯ строками одним writeRaw().
 * Это ломается на любой команде, которая сама читает stdin «сырыми» байтами раньше, чем
 * shell перейдёт к следующей строке — например `pause` на Windows: если stdin не консоль
 * (а тут именно пайп), pause не ждёт настоящую консоль, а читает ровно 1 байт напрямую из
 * пайпа. Раз обе строки уже лежат в пайпе одним чанком (writeRaw пишет их за один вызов),
 * pause мгновенно — ещё до любого terminal_write — сжирает первый байт ещё НЕ выполненного
 * маркера, букву "e" из "echo". Shell затем пытается выполнить огрызок "cho ..." как
 * отдельную команду ("'cho' is not recognized..."), а настоящий маркер с токеном никогда
 * не печатается — сессия навсегда виснет в status=running. Это НЕ ограничивается pause:
 * тот же класс бага задевает choice, set /p, запросы пароля sudo/ssh, `python -c
 * "input()"` и любой другой посимвольный/построчный сырой read из stdin.
 * Склейка команды и маркера в ОДНУ физическую строку (через `&`/`;`) чинит это: чтобы
 * распознать оператор-разделитель, shell обязан дочитать всю строку целиком ДО того, как
 * запустит первую подкоманду — то есть к моменту фактического старта `pause` в пайпе уже
 * физически не остаётся хвоста, который можно случайно схватить.
 */
function buildCommandLine(shell: ShellKind, command: string, token: string, eol: string): string {
    const marker = markerCommand(shell, token);

    if (shell !== "cmd" && TRAILING_BACKGROUND_RE.test(command)) {
        return `${command}${eol}${marker}${eol}`;
    }

    switch (shell) {
        case "cmd":
            // `&` — выполнить маркер безусловно, независимо от ERRORLEVEL команды.
            return `${command} & ${marker}${eol}`;
        case "powershell":
        case "bash":
        case "sh":
            // `;` — тоже безусловное продолжение (сессии открываются без `set -e`/`-Stop`).
            return `${command}; ${marker}${eol}`;
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

/**
 * Убивает процесс вместе с детьми.
 * proc.kill() гасит только сам shell, а запущенные из него bun/vite/node остаются висеть
 * в памяти и держать порты. На Windows дерево сносит taskkill /T /F, на POSIX — kill по группе процессов.
 */
/** Список прямых детей pid через pgrep -P (есть и на Linux, и на macOS из коробки). */
async function listChildPids(pid: number): Promise<number[]> {
    try {
        const lister = Bun.spawn({
            cmd: ["pgrep", "-P", String(pid)],
            stdin: "ignore",
            stdout: "pipe",
            stderr: "ignore"
        });
        const text = await new Response(lister.stdout).text();
        await lister.exited;
        return text
            .split(/\s+/)
            .map(part => Number.parseInt(part, 10))
            .filter(value => Number.isInteger(value) && value > 0);
    } catch {
        return [];
    }
}

/**
 * Обходит дерево потомков вручную через pgrep -P.
 * process.kill(-pid, sig) бьёт по группе процессов, но это работает только если shell — лидер
 * своей группы; Bun.spawn не выставляет detached/setsid, так что группа обычно совпадает
 * с группой самого notcode-сервера, и process.kill(-pid) либо не находит цели, либо в худшем
 * случае может задеть не тот процесс. Явный обход дерева через pgrep не зависит от group id.
 */
async function collectDescendantPids(rootPid: number): Promise<number[]> {
    const seen = new Set<number>();
    let frontier = [rootPid];
    while (frontier.length > 0) {
        const next: number[] = [];
        for (const pid of frontier) {
            for (const child of await listChildPids(pid)) {
                if (!seen.has(child)) {
                    seen.add(child);
                    next.push(child);
                }
            }
        }
        frontier = next;
    }
    return [...seen];
}

async function killTree(proc: Bun.Subprocess, force: boolean): Promise<void> {
    const pid = proc.pid;

    if (typeof pid === "number" && pid > 0) {
        if (process.platform === "win32") {
            try {
                const killer = Bun.spawn({
                    cmd: ["taskkill", "/PID", String(pid), "/T", "/F"],
                    stdin: "ignore",
                    stdout: "ignore",
                    stderr: "ignore"
                });
                await Promise.race([killer.exited, Bun.sleep(3_000)]);
            } catch {
                // taskkill недоступен — остаётся обычный kill ниже
            }
        } else {
            const signal = force ? "SIGKILL" : "SIGTERM";

            // Явный обход дерева — основной путь, не зависит от того, лидер ли shell своей группы.
            const descendants = await collectDescendantPids(pid);
            for (const child of descendants) {
                try {
                    process.kill(child, signal);
                } catch {
                    // потомок уже завершился
                }
            }

            // group-kill — дополнительная попытка на случай, если группа всё же существует.
            try {
                process.kill(-pid, signal);
            } catch {
                // группы нет — уже добили потомков выше через pgrep
            }
        }
    }

    try {
        proc.kill(force ? 9 : 15);
    } catch {
        // процесс уже мёртв
    }
}

/** Монотонный счётчик: раньше id считался от sessions.size и повторялся после закрытия сессий. */
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

        this.writeRaw(buildCommandLine(this.shell, command, token, this.eol));

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

        await killTree(this.proc, force);

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
    private gcTimer: ReturnType<typeof setInterval> | null = null;

    async open(options: { cwd?: string; shell?: ShellKind; name?: string; env?: Record<string, string> } = {}): Promise<SessionInfo> {
        const config = await loadConfig();
        await this.gc();

        const alive = [...this.sessions.values()].filter(session => session.status !== "exited");
        if (alive.length >= config.limits.maxSessions) {
            throw new Error(
                `Достигнут лимит терминалов (${config.limits.maxSessions}). Закрой ненужные через terminal_close.`
            );
        }

        const id = `t${(++sessionCounter).toString().padStart(2, "0")}-${crypto.randomUUID().slice(0, 4)}`;
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

    /**
     * Убирает завершённые сессии и закрывает живые, но простаивающие.
     * Раньше GC вызывался только внутри open(): если новых терминалов не открывали,
     * shell-процессы и их буферы жили до перезапуска сервера.
     */
    async gc(): Promise<{ removed: number; closed: number }> {
        const config = await loadConfig();
        const now = Date.now();
        const exitedCutoff = now - 30 * 60_000;
        const idleCutoff = now - config.limits.sessionIdleMs;

        let removed = 0;
        let closed = 0;

        for (const [id, session] of this.sessions) {
            if (session.status === "exited") {
                if (session.lastActivityAt < exitedCutoff) {
                    this.sessions.delete(id);
                    removed++;
                }
                continue;
            }

            // running не трогаем: там может идти долгая сборка.
            if (session.status === "idle" && session.lastActivityAt < idleCutoff) {
                await session.close(true).catch(() => undefined);
                this.sessions.delete(id);
                closed++;
                removed++;
            }
        }

        return { removed, closed };
    }

    /** Фоновое обслуживание — без него уборка зависит от того, откроют ли новый терминал. */
    startGc(intervalMs: number): void {
        if (this.gcTimer) return;
        this.gcTimer = setInterval(() => void this.gc().catch(() => undefined), Math.max(30_000, intervalMs));
        this.gcTimer.unref?.();
    }

    stopGc(): void {
        if (!this.gcTimer) return;
        clearInterval(this.gcTimer);
        this.gcTimer = null;
    }
}

export const terminals = new TerminalManager();
export type { TerminalSession };
