import type { ZodRawShape } from "zod";
import type { ToolResult } from "@/utils/result";

/** Описание тула MCP в одном месте — чтобы регистрация в mcp.ts была тривиальной. */
export interface ToolDefinition<Shape extends ZodRawShape = ZodRawShape, Args = never> {
    name: string;
    description: string;
    schema: Shape;
    handler: (args: Args) => Promise<ToolResult>;
}

export function defineTool<Shape extends ZodRawShape, Args>(
    definition: ToolDefinition<Shape, Args>
): ToolDefinition<Shape, Args> {
    return definition;
}

/** Гетерогенный список тулов (у каждого своя схема и свои аргументы). */
export type AnyToolDefinition = ToolDefinition<ZodRawShape, any>;
