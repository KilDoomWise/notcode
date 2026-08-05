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
    maxDepth?: number;
    includeHidden?: boolean;
    includeIgnored?: boolean;
    maxEntries?: number;
}

export interface WalkResult {
    entries: WalkEntry[];
    truncated: boolean;
    scannedDirs: number;
}

/** Обход дерева в ширину с лимитами: глубина, количество, игнор-листы. */
export async function collectEntries(options: WalkOptions): Promise<WalkResult> {
    const maxDepth = options.maxDepth ?? 1;
    const maxEntries = options.maxEntries ?? 1000;
    const entries: WalkEntry[] = [];
    const queue: Array<{ dir: string; depth: number }> = [{ dir: options.root, depth: 1 }];

    let truncated = false;
    let scannedDirs = 0;

    while (queue.length > 0) {
        const current = queue.shift()!;
        let dirEntries;
        try {
            dirEntries = await readdir(current.dir, { withFileTypes: true });
            scannedDirs++;
        } catch {
            continue;
        }

        for (const dirEntry of dirEntries) {
            const name = dirEntry.name;
            const isDirectory = dirEntry.isDirectory();

            if (!options.includeHidden && name.startsWith(".") && name !== ".env") continue;
            if (isDirectory && !options.includeIgnored && DEFAULT_IGNORED_DIRS.has(name)) continue;

            const absPath = join(current.dir, name);
            if (entries.length >= maxEntries) {
                truncated = true;
                return { entries, truncated, scannedDirs };
            }

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

    return { entries, truncated, scannedDirs };
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
        } else if (".+^${}()|[]\\".includes(char as string)) {
            source += `\\${char}`;
        } else {
            source += char;
        }
    }
    return new RegExp(`^${source}$`, process.platform === "win32" ? "i" : "");
}

export function matchesAnyGlob(relPath: string, patterns: string[]): boolean {
    if (patterns.length === 0) return true;
    return patterns.some(pattern => {
        const regex = globToRegExp(pattern.includes("/") ? pattern : `**/${pattern}`);
        return regex.test(relPath) || regex.test(`/${relPath}`);
    });
}
