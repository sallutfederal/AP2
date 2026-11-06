import { z } from "zod";
import { zodToJsonSchema } from "@cline/shared";
import type { AgentTool } from "@cline/shared";
import type { ObsidianService } from "./obsidian-service";

function validateWithZod<T>(schema: z.ZodType<T>, input: unknown): T {
	return schema.parse(input);
}

function createTool<I, O>(def: {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	execute: (input: I) => Promise<O>;
}): { name: string; description: string; inputSchema: Record<string, unknown>; execute: (input: I) => Promise<O> } {
	return def;
}

export function createObsidianTools(service: ObsidianService): AgentTool[] {
	const tools: AgentTool[] = [];

	tools.push(createTool<Record<string, never>, { vaultPath: string; notes: string[] }>({
		name: "obs_list_notes",
		description: "List notes in the Obsidian vault.",
		inputSchema: zodToJsonSchema(z.object({ folder: z.string().optional() })),
		execute: async (input) => {
			const v = validateWithZod(z.object({ folder: z.string().optional() }), input);
			return { vaultPath: service.getVaultPath(), notes: service.listNotes(v.folder) };
		},
	}) as AgentTool);

	tools.push(createTool<{ path: string }, { content: string | null }>({
		name: "obs_read_note",
		description: "Read a note from the Obsidian vault.",
		inputSchema: zodToJsonSchema(z.object({ path: z.string().min(1) })),
		execute: async (input) => {
			const v = validateWithZod(z.object({ path: z.string().min(1) }), input);
			return { content: service.readNote(v.path) };
		},
	}) as AgentTool);

	tools.push(createTool<{ path: string; content: string }, { written: boolean }>({
		name: "obs_write_note",
		description: "Write a note to the Obsidian vault.",
		inputSchema: zodToJsonSchema(z.object({ path: z.string().min(1), content: z.string() })),
		execute: async (input) => {
			const v = validateWithZod(z.object({ path: z.string().min(1), content: z.string() }), input);
			return { written: service.writeNote(v.path, v.content) };
		},
	}) as AgentTool);

	tools.push(createTool<{ path: string; content: string }, { appended: boolean }>({
		name: "obs_append_note",
		description: "Append content to a note in the Obsidian vault.",
		inputSchema: zodToJsonSchema(z.object({ path: z.string().min(1), content: z.string() })),
		execute: async (input) => {
			const v = validateWithZod(z.object({ path: z.string().min(1), content: z.string() }), input);
			return { appended: service.appendNote(v.path, v.content) };
		},
	}) as AgentTool);

	tools.push(createTool<{ query: string }, { results: ReturnType<ObsidianService["searchNotes"]> }>({
		name: "obs_search",
		description: "Search notes in the Obsidian vault.",
		inputSchema: zodToJsonSchema(z.object({ query: z.string().min(1) })),
		execute: async (input) => {
			const v = validateWithZod(z.object({ query: z.string().min(1) }), input);
			return { results: service.searchNotes(v.query) };
		},
	}) as AgentTool);

	tools.push(createTool<{ path: string }, { deleted: boolean }>({
		name: "obs_delete_note",
		description: "Delete a note from the Obsidian vault.",
		inputSchema: zodToJsonSchema(z.object({ path: z.string().min(1) })),
		execute: async (input) => {
			const v = validateWithZod(z.object({ path: z.string().min(1) }), input);
			return { deleted: service.deleteNote(v.path) };
		},
	}) as AgentTool);

	tools.push(createTool<Record<string, never>, { note: string }>({
		name: "obs_daily_note",
		description: "Get or create today's daily note.",
		inputSchema: zodToJsonSchema(z.object({})),
		execute: async () => ({ note: service.getDailyNote() }),
	}) as AgentTool);

	tools.push(createTool<{ content: string }, { logged: boolean }>({
		name: "obs_log_session",
		description: "Log a session summary to Obsidian.",
		inputSchema: zodToJsonSchema(z.object({ content: z.string().min(1) })),
		execute: async (input) => {
			const v = validateWithZod(z.object({ content: z.string().min(1) }), input);
			return { logged: service.logSession(v.content) };
		},
	}) as AgentTool);

	tools.push(createTool<{ key: string; value: string; tags: z.ZodArray<z.ZodString> }, { remembered: boolean }>({
		name: "obs_remember",
		description: "Store a memory note in Obsidian.",
		inputSchema: zodToJsonSchema(z.object({ key: z.string().min(1), value: z.string().min(1), tags: z.array(z.string()).optional() })),
		execute: async (input) => {
			const v = validateWithZod(z.object({ key: z.string().min(1), value: z.string().min(1), tags: z.array(z.string()).optional() }), input);
			return { remembered: service.remember(v.key, v.value, v.tags) };
		},
	}) as AgentTool);

	tools.push(createTool<{ key: string }, { content: string | null }>({
		name: "obs_recall",
		description: "Recall a memory note from Obsidian.",
		inputSchema: zodToJsonSchema(z.object({ key: z.string().min(1) })),
		execute: async (input) => {
			const v = validateWithZod(z.object({ key: z.string().min(1) }), input);
			return { content: service.recall(v.key) };
		},
	}) as AgentTool);

	tools.push(createTool<Record<string, never>, { memories: string[] }>({
		name: "obs_list_memories",
		description: "List all memory notes in Obsidian.",
		inputSchema: zodToJsonSchema(z.object({})),
		execute: async () => ({ memories: service.listMemories() }),
	}) as AgentTool);

	tools.push(createTool<{ nickname: string; style: string; traits: z.ZodArray<z.ZodString> }, { set: boolean }>({
		name: "obs_set_personality",
		description: "Set AP2's personality (nickname, speaking style, traits) in Obsidian.",
		inputSchema: zodToJsonSchema(z.object({ nickname: z.string().min(1), style: z.string().min(1), traits: z.array(z.string()) })),
		execute: async (input) => {
			const v = validateWithZod(z.object({ nickname: z.string().min(1), style: z.string().min(1), traits: z.array(z.string()) }), input);
			return { set: service.setPersonality(v.nickname, v.style, v.traits) };
		},
	}) as AgentTool);

	tools.push(createTool<Record<string, never>, { personality: ReturnType<ObsidianService["getPersonality"]> }>({
		name: "obs_get_personality",
		description: "Get AP2's personality from Obsidian.",
		inputSchema: zodToJsonSchema(z.object({})),
		execute: async () => ({ personality: service.getPersonality() }),
	}) as AgentTool);

	tools.push(createTool<{ observation: string; context: z.ZodString }, { remembered: boolean }>({
		name: "obs_auto_remember",
		description: "Automatically store an observation in Obsidian memory.",
		inputSchema: zodToJsonSchema(z.object({ observation: z.string().min(1), context: z.string().optional() })),
		execute: async (input) => {
			const v = validateWithZod(z.object({ observation: z.string().min(1), context: z.string().optional() }), input);
			return { remembered: service.autoRemember(v.observation, v.context) };
		},
	}) as AgentTool);

	return tools;
}