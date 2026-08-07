import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

/** Папки, которые почти никогда не нужны агенту и убивают производительность обхода. */
export const DEFAULT_IGNORED_DIRS = new Set([
    "node_modules",
    ".git",
    ".hg",
    ".svn",
    "dist",
    "build",
    "out",
    ".next",
    ".nuxt",
    ".turbo",
    ".cache",
    ".parcel-cache",
    "coverage",
    ".venv",
    "venv",
    "__pycache__",
    ".idea",
    ".vscode-test",
    ".bun"
]);

export interface WalkEntry {
    absPath: string;
    relPath: string;
    name: string;
    isDirectory: boolean;
    depth: number;
}

export interface WalkOptions {
    root: string;
    maxDepth?: number | undefined;
    includeHidden?: boolean | undefined;
    includeIgnored?: boolean | undefined;
    maxEntries?: number | undefined;
    /** Общий дедлайн обхода: сетевые диски и гигантские деревья не должны вешать тул навсегда. */
    timeBudgetMs?: number | undefined;
}

export interface WalkResult {
    entries: WalkEntry[];
    truncated: boolean;
    scannedDirs: number;
    /** true, если обход остановлен по времени, а не по количеству. */
    timedOut: boolean;
    /** Каталоги, которые не удалось прочитать (нет прав, битые symlinkи). */
    unreadableDirs: number;
}

const DEFAULT_TIME_BUDGET_MS = 15_000;

/** Обход дерева в ширину с лимитами: глубина, количество, время, игнор-листы. */
export async function collectEntries(options: WalkOptions): Promise<WalkResult> {
    const maxDepth = options.maxDepth ?? 1;
    const maxEntries = options.maxEntries ?? 1000;
    const deadline = Date.now() + (options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS);

    const entries: WalkEntry[] = [];
    const queue: Array<{ dir: string; depth: number }> = [{ dir: options.root, depth: 1 }];

    let head = 0;
    let truncated = false;
    let timedOut = false;
    let scannedDirs = 0;
    let unreadableDirs = 0;

    // Индекс вместо queue.shift(): shift() на десятках тысяч каталогов даёт O(n²).
    while (head < queue.length) {
        if (Date.now() > deadline) {
            timedOut = true;
            break;
        }

        const current = queue[head++];
        if (!current) break;

        let dirEntries;
        try {
            dirEntries = await readdir(current.dir, { withFileTypes: true });
            scannedDirs++;
        } catch {
            unreadableDirs++;
            continue;
        }

        // Стабильный порядок: без него один и тот же запрос даёт разный вывод на разных ФС.
        dirEntries.sort((a, b) => a.name.localeCompare(b.name, "en"));

        for (const dirEntry of dirEntries) {
            const name = dirEntry.name;
            const isDirectory = dirEntry.isDirectory();

            if (!options.includeHidden && name.startsWith(".") && name !== ".env") continue;
            if (isDirectory && !options.includeIgnored && DEFAULT_IGNORED_DIRS.has(name)) continue;

            if (entries.length >= maxEntries) {
                return { entries, truncated: true, scannedDirs, timedOut, unreadableDirs };
            }

            const absPath = join(current.dir, name);

            entries.push({
                absPath,
                relPath: relative(options.root, absPath).split(sep).join("/"),
                name,
                isDirectory,
                depth: current.depth
            });

            if (isDirectory && current.depth < maxDepth) {
                queue.push({ dir: absPath, depth: current.depth + 1 });
            }
        }
    }

    return { entries, truncated, scannedDirs, timedOut, unreadableDirs };
}

/** Простейший glob: * (в пределах сегмента), ** (любая глубина), ? (один символ). */
export function globToRegExp(pattern: string): RegExp {
    let source = "";

    for (let i = 0; i < pattern.length; i++) {
        const char = pattern[i];
        if (char === "*") {
            if (pattern[i + 1] === "*") {
                source += ".*";
                i++;
                if (pattern[i + 1] === "/") i++;
            } else {
                source += "[^/]*";
            }
        } else if (char === "?") {
            source += "[^/]";
        } else if (char !== undefined && ".+^${}()|[]\\".includes(char)) {
            source += `\\${char}`;
        } else {
            source += char;
        }
    }

    return new RegExp(`^${source}$`, process.platform === "win32" ? "i" : "");
}

/**
 * Кэш скомпилированных глобов.
 * Раньше matchesAnyGlob() вызывался в цикле по 20 000 файлов и каждый раз заново строил RegExp
 * на каждый паттерн — десятки тысяч компиляций на один поиск.
 */
const globCache = new Map<string, RegExp>();
const GLOB_CACHE_LIMIT = 500;

function cachedGlob(pattern: string): RegExp {
    const cached = globCache.get(pattern);
    if (cached) return cached;

    const compiled = globToRegExp(pattern.includes("/") ? pattern : `**/${pattern}`);

    if (globCache.size >= GLOB_CACHE_LIMIT) globCache.clear();
    globCache.set(pattern, compiled);

    return compiled;
}

/** Компилирует список глобов один раз — используй в горячих циклах вместе с matchesCompiled(). */
export function compileGlobs(patterns: string[]): RegExp[] {
    return patterns.map(cachedGlob);
}

export function matchesCompiled(relPath: string, compiled: RegExp[]): boolean {
    if (compiled.length === 0) return true;
    return compiled.some(regex => regex.test(relPath) || regex.test(`/${relPath}`));
}

export function matchesAnyGlob(relPath: string, patterns: string[]): boolean {
    return matchesCompiled(relPath, compileGlobs(patterns));
}
