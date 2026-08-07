import type { ZodRawShape } from "zod";
import type { ToolResult } from "@/utils/result";

/**
 * Подсказки клиенту о характере тула (часть спецификации MCP).
 *
 * Без них агент видит fs_read_file и terminal_exec как равнозначно опасные,
 * а клиент не может ни отсортировать список, ни спросить подтверждение только на разрушающих.
 */
export interface ToolAnnotations {
    /** Короткое человеческое имя для UI. */
    title?: string;
    /** Тул ничего не меняет. */
    readOnlyHint?: boolean;
    /** Тул может необратимо удалить/испортить данные. */
    destructiveHint?: boolean;
    /** Повторный вызов с теми же аргументами ничего не меняет дополнительно. */
    idempotentHint?: boolean;
    /** Тул работает с внешним миром (сеть, чужие сервисы). */
    openWorldHint?: boolean;
}

/** Описание тула MCP в одном месте — чтобы регистрация в mcp.ts была тривиальной. */
export interface ToolDefinition<Shape extends ZodRawShape = ZodRawShape, Args = never> {
    name: string;
    description: string;
    schema: Shape;
    annotations?: ToolAnnotations;
    handler: (args: Args) => Promise<ToolResult>;
}

export function defineTool<Shape extends ZodRawShape, Args>(
    definition: ToolDefinition<Shape, Args>
): ToolDefinition<Shape, Args> {
    return definition;
}

/** Гетерогенный список тулов (у каждого своя схема и свои аргументы). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolDefinition = ToolDefinition<ZodRawShape, any>;
