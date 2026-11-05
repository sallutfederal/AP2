import {
	type AgentTool,
	createTool,
	validateWithZod,
	zodToJsonSchema,
} from "@cline/shared";
import { z } from "zod";
import type { MemoryService } from "./memory-service";

const MemoryStoreInputSchema = z.object({
	kind: z.enum([
"fact",
"episode",
"preference",
"skill",
"reflection",
"goal",
"target",
"finding",
"credential",
"payload",
"chain",
]),
	key: z.string().min(1),
	value: z.string().min(1),
	summary: z.string().optional(),
	confidence: z.number().min(0).max(1).optional(),
	tags: z.array(z.string()).optional(),
});

const MemoryRecallInputSchema = z.object({
	query: z.string().optional(),
	kinds: z
		.array(
			z.enum(["fact", "episode", "preference", "skill", "reflection", "goal", "target", "finding", "credential", "payload", "chain"]),
		)
		.optional(),
	tags: z.array(z.string()).optional(),
	limit: z.number().int().positive().max(50).optional(),
	minConfidence: z.number().min(0).max(1).optional(),
});

const MemoryForgetInputSchema = z.object({
	id: z.string().optional(),
	key: z.string().optional(),
	kind: z
		.enum(["fact", "episode", "preference", "skill", "reflection", "goal"])
		.optional(),
});

const MemoryListInputSchema = z.object({
	kinds: z
		.array(
			z.enum(["fact", "episode", "preference", "skill", "reflection", "goal", "target", "finding", "credential", "payload", "chain"]),
		)
		.optional(),
	limit: z.number().int().positive().max(100).optional(),
});

export type MemoryStoreToolInput = z.infer<typeof MemoryStoreInputSchema>;
export type MemoryRecallToolInput = z.infer<typeof MemoryRecallInputSchema>;
export type MemoryForgetToolInput = z.infer<typeof MemoryForgetInputSchema>;
export type MemoryListToolInput = z.infer<typeof MemoryListInputSchema>;

export function createMemoryTools(service: MemoryService): AgentTool[] {
	const tools: AgentTool[] = [];

	tools.push(
		createTool<MemoryStoreToolInput, { id: string; key: string; kind: string }>(
			{
				name: "memory_store",
				description:
					"Store a long-term memory (fact, episode, preference, skill, reflection, or goal). Use to remember important facts, user preferences, lessons learned, or task outcomes across sessions.",
				inputSchema: zodToJsonSchema(MemoryStoreInputSchema),
				execute: async (input) => {
					const v = validateWithZod(MemoryStoreInputSchema, input);
					const m = service.store({
						kind: v.kind,
						key: v.key,
						value: v.value,
						summary: v.summary,
						confidence: v.confidence,
						tags: v.tags,
					});
					return { id: m.id, key: m.key, kind: m.kind };
				},
			},
		) as AgentTool,
	);

	tools.push(
		createTool<
			MemoryRecallToolInput,
			{
				memories: {
					id: string;
					kind: string;
					key: string;
					value: string;
					confidence: number;
				}[];
			}
		>({
			name: "memory_recall",
			description:
				"Recall long-term memories relevant to a query. Returns matching facts/episodes/preferences/skills/reflections/goals.",
			inputSchema: zodToJsonSchema(MemoryRecallInputSchema),
			execute: async (input) => {
				const v = validateWithZod(MemoryRecallInputSchema, input);
				const mems = service.recall({
					query: v.query,
					kinds: v.kinds,
					tags: v.tags,
					limit: v.limit,
					minConfidence: v.minConfidence,
				});
				return {
					memories: mems.map(
						(m: {
							id: string;
							kind: string;
							key: string;
							value: string;
							confidence: number;
						}) => ({
							id: m.id,
							kind: m.kind,
							key: m.key,
							value: m.value,
							confidence: m.confidence,
						}),
					),
				};
			},
		}) as AgentTool,
	);

	tools.push(
		createTool<MemoryForgetToolInput, { removed: number }>({
			name: "memory_forget",
			description: "Forget (delete) memories by id, key, or kind.",
			inputSchema: zodToJsonSchema(MemoryForgetInputSchema),
			execute: async (input) => {
				const v = validateWithZod(MemoryForgetInputSchema, input);
				const removed = service.forget({
					id: v.id,
					key: v.key,
					kind: v.kind,
				});
				return { removed };
			},
		}) as AgentTool,
	);

	tools.push(
		createTool<
			MemoryListToolInput,
			{
				memories: { id: string; kind: string; key: string; value: string }[];
				count: number;
			}
		>({
			name: "memory_list",
			description:
				"List stored long-term memories, optionally filtered by kind.",
			inputSchema: zodToJsonSchema(MemoryListInputSchema),
			execute: async (input) => {
				const v = validateWithZod(MemoryListInputSchema, input);
				const mems = service.list({ kinds: v.kinds, limit: v.limit });
				return {
					memories: mems.map(
						(m: {
							id: string;
							kind: string;
							key: string;
							value: string;
							confidence: number;
						}) => ({
							id: m.id,
							kind: m.kind,
							key: m.key,
							value: m.value,
						}),
					),
					count: mems.length,
				};
			},
		}) as AgentTool,
	);

	return tools;
}
