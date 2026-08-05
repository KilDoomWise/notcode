import { readFileTool } from "@/tools/fs/readFile";
import { writeFileTool } from "@/tools/fs/writeFile";
import { patchFileTool } from "@/tools/fs/patchFile";
import { listDirTool } from "@/tools/fs/listDir";
import { findFilesTool, searchContentTool } from "@/tools/fs/search";
import { restoreTool, snapshotsTool } from "@/tools/fs/snapshots";
import { watchListTool, watchPollTool, watchStartTool, watchStopTool } from "@/tools/fs/watch";
import { execTool } from "@/tools/terminal/exec";
import {
    terminalCloseTool,
    terminalListTool,
    terminalOpenTool,
    terminalReadTool,
    terminalRunTool,
    terminalWriteTool
} from "@/tools/terminal/session";
import { gitBranchTool, gitCommitTool, gitDiffTool, gitLogTool, gitStatusTool } from "@/tools/git/git";
import {
    auditTool,
    setModeTool,
    statusTool,
    workspaceAddTool,
    workspaceAllowTool,
    workspaceListTool,
    workspaceUseTool
} from "@/tools/meta/notcode";
import type { AnyToolDefinition } from "@/tools/types";

/** Файловые операции. */
export const fsTools: AnyToolDefinition[] = [
    readFileTool,
    writeFileTool,
    patchFileTool,
    listDirTool,
    searchContentTool,
    findFilesTool,
    snapshotsTool,
    restoreTool,
    watchStartTool,
    watchPollTool,
    watchListTool,
    watchStopTool
];

/** Одноразовые команды + изолированные терминал-сессии. */
export const terminalTools: AnyToolDefinition[] = [
    execTool,
    terminalOpenTool,
    terminalRunTool,
    terminalReadTool,
    terminalWriteTool,
    terminalListTool,
    terminalCloseTool
];

/** Структурированные git-операции (без парсинга сырого вывода моделью). */
export const gitTools: AnyToolDefinition[] = [gitStatusTool, gitDiffTool, gitCommitTool, gitLogTool, gitBranchTool];

/** Самонаблюдение и настройки сервера. */
export const metaTools: AnyToolDefinition[] = [
    statusTool,
    auditTool,
    setModeTool,
    workspaceListTool,
    workspaceUseTool,
    workspaceAddTool,
    workspaceAllowTool
];

export const allTools: AnyToolDefinition[] = [...fsTools, ...terminalTools, ...gitTools, ...metaTools];
