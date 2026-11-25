import { join } from "node:path";
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
}): {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	execute: (input: I) => Promise<O>;
} {
	return def;
}

export function createObsidianTools(service: ObsidianService): AgentTool[] {
	const tools: AgentTool[] = [];

	tools.push(
		createTool<
			{ folder?: string },
			{ vaultPath: string; notes: string[] }
		>({
			name: "obs_list_notes",
			description: "List notes in the Obsidian vault.",
			inputSchema: zodToJsonSchema(z.object({ folder: z.string().optional() })),
			execute: async (input) => {
				const v = validateWithZod(
					z.object({ folder: z.string().optional() }),
					input,
				);
				return {
					vaultPath: service.getVaultPath(),
					notes: service.listNotes(v.folder),
				};
			},
		}) as AgentTool,
	);

	tools.push(
		createTool<{ path: string }, { content: string | null }>({
			name: "obs_read_note",
			description: "Read a note from the Obsidian vault.",
			inputSchema: zodToJsonSchema(z.object({ path: z.string().min(1) })),
			execute: async (input) => {
				const v = validateWithZod(z.object({ path: z.string().min(1) }), input);
				return { content: service.readNote(v.path) };
			},
		}) as AgentTool,
	);

	tools.push(
		createTool<
			{ path: string; content: string },
			{ written: boolean; vaultPath: string; fullPath: string }
		>({
			name: "obs_write_note",
			description:
				"Write a note inside the Obsidian vault (default: ~/Documents/Obsidian Vault or OBSIDIAN_VAULT_PATH). Use relative paths like 'knowledge/reports/my-report.md'.",
			inputSchema: zodToJsonSchema(
				z.object({ path: z.string().min(1), content: z.string() }),
			),
			execute: async (input) => {
				const v = validateWithZod(
					z.object({ path: z.string().min(1), content: z.string() }),
					input,
				);
				const vaultPath = service.getVaultPath();
				return {
					written: service.writeNote(v.path, v.content),
					vaultPath,
					fullPath: join(vaultPath, v.path),
				};
			},
		}) as AgentTool,
	);

	tools.push(
		createTool<{ path: string; content: string }, { appended: boolean }>({
			name: "obs_append_note",
			description: "Append content to a note in the Obsidian vault.",
			inputSchema: zodToJsonSchema(
				z.object({ path: z.string().min(1), content: z.string() }),
			),
			execute: async (input) => {
				const v = validateWithZod(
					z.object({ path: z.string().min(1), content: z.string() }),
					input,
				);
				return { appended: service.appendNote(v.path, v.content) };
			},
		}) as AgentTool,
	);

	tools.push(
		createTool<
			{ query: string },
			{ results: ReturnType<ObsidianService["searchNotes"]> }
		>({
			name: "obs_search",
			description: "Search notes in the Obsidian vault.",
			inputSchema: zodToJsonSchema(z.object({ query: z.string().min(1) })),
			execute: async (input) => {
				const v = validateWithZod(
					z.object({ query: z.string().min(1) }),
					input,
				);
				return { results: service.searchNotes(v.query) };
			},
		}) as AgentTool,
	);

	tools.push(
		createTool<{ path: string }, { deleted: boolean }>({
			name: "obs_delete_note",
			description: "Delete a note from the Obsidian vault.",
			inputSchema: zodToJsonSchema(z.object({ path: z.string().min(1) })),
			execute: async (input) => {
				const v = validateWithZod(z.object({ path: z.string().min(1) }), input);
				return { deleted: service.deleteNote(v.path) };
			},
		}) as AgentTool,
	);

	tools.push(
		createTool<Record<string, never>, { note: string }>({
			name: "obs_daily_note",
			description: "Get or create today's daily note.",
			inputSchema: zodToJsonSchema(z.object({})),
			execute: async () => ({ note: service.getDailyNote() }),
		}) as AgentTool,
	);

	tools.push(
		createTool<{ content: string }, { logged: boolean }>({
			name: "obs_log_session",
			description: "Log a session summary to Obsidian.",
			inputSchema: zodToJsonSchema(z.object({ content: z.string().min(1) })),
			execute: async (input) => {
				const v = validateWithZod(
					z.object({ content: z.string().min(1) }),
					input,
				);
				return { logged: service.logSession(v.content) };
			},
		}) as AgentTool,
	);

	tools.push(
		createTool<
			{ key: string; value: string; tags?: string[] },
			{ remembered: boolean }
		>({
			name: "obs_remember",
			description: "Store a long-term memory note in Obsidian.",
			inputSchema: zodToJsonSchema(
				z.object({
					key: z.string().min(1),
					value: z.string().min(1),
					tags: z.array(z.string()).optional(),
				}),
			),
			execute: async (input) => {
				const v = validateWithZod(
					z.object({
						key: z.string().min(1),
						value: z.string().min(1),
						tags: z.array(z.string()).optional(),
					}),
					input,
				);
				return { remembered: service.remember(v.key, v.value, v.tags) };
			},
		}) as AgentTool,
	);

	tools.push(
		createTool<{ key: string }, { content: string | null }>({
			name: "obs_recall",
			description: "Recall a memory note from Obsidian.",
			inputSchema: zodToJsonSchema(z.object({ key: z.string().min(1) })),
			execute: async (input) => {
				const v = validateWithZod(z.object({ key: z.string().min(1) }), input);
				return { content: service.recall(v.key) };
			},
		}) as AgentTool,
	);

	tools.push(
		createTool<Record<string, never>, { memories: string[] }>({
			name: "obs_list_memories",
			description: "List all memory notes in Obsidian.",
			inputSchema: zodToJsonSchema(z.object({})),
			execute: async () => ({ memories: service.listMemories() }),
		}) as AgentTool,
	);

	tools.push(
		createTool<
			{ topic: string; content: string; tags?: string[] },
			{ saved: boolean }
		>({
			name: "obs_save_knowledge",
			description:
				"Save or update structured knowledge (technical concepts, architectures, targets, workflows, learned facts) in Obsidian knowledge/.",
			inputSchema: zodToJsonSchema(
				z.object({
					topic: z.string().min(1),
					content: z.string().min(1),
					tags: z.array(z.string()).optional(),
				}),
			),
			execute: async (input) => {
				const v = validateWithZod(
					z.object({
						topic: z.string().min(1),
						content: z.string().min(1),
						tags: z.array(z.string()).optional(),
					}),
					input,
				);
				return { saved: service.saveKnowledge(v.topic, v.content, v.tags) };
			},
		}) as AgentTool,
	);

	tools.push(
		createTool<
			{ title: string; content: string; tags?: string[] },
			{
				saved: boolean;
				path: string | null;
				vaultPath: string;
				fullPath: string | null;
			}
		>({
			name: "obs_save_report",
			description:
				"Save a completed task, command, or findings report EXCLUSIVELY inside the Obsidian vault knowledge/reports/ (~/Documents/Obsidian Vault/knowledge/reports or OBSIDIAN_VAULT_PATH) so it stays in the persistent knowledge base. Never write reports outside Obsidian.",
			inputSchema: zodToJsonSchema(
				z.object({
					title: z.string().min(1),
					content: z.string().min(1),
					tags: z.array(z.string()).optional(),
				}),
			),
			execute: async (input) => {
				const v = validateWithZod(
					z.object({
						title: z.string().min(1),
						content: z.string().min(1),
						tags: z.array(z.string()).optional(),
					}),
					input,
				);
				const vaultPath = service.getVaultPath();
				const path = service.saveReport(v.title, v.content, v.tags);
				return {
					saved: path !== null,
					path,
					vaultPath,
					fullPath: path ? join(vaultPath, path) : null,
				};
			},
		}) as AgentTool,
	);

	tools.push(
		createTool<Record<string, never>, { knowledge: string[] }>({
			name: "obs_list_knowledge",
			description: "List all knowledge notes stored in Obsidian.",
			inputSchema: zodToJsonSchema(z.object({})),
			execute: async () => ({ knowledge: service.listKnowledge() }),
		}) as AgentTool,
	);

	tools.push(
		createTool<
			{
				nickname: string;
				style: string;
				traits: string[];
				howToTalkToUser?: string;
				voiceRules?: string[];
				adaptation?: string;
			},
			{ set: boolean }
		>({
			name: "obs_set_personality",
			description:
				"Update AP2's own speaking personality, traits, voice rules, and how it talks with the user in Obsidian.",
			inputSchema: zodToJsonSchema(
				z.object({
					nickname: z.string().min(1),
					style: z.string().min(1),
					traits: z.array(z.string()),
					howToTalkToUser: z.string().optional(),
					voiceRules: z.array(z.string()).optional(),
					adaptation: z.string().optional(),
				}),
			),
			execute: async (input) => {
				const v = validateWithZod(
					z.object({
						nickname: z.string().min(1),
						style: z.string().min(1),
						traits: z.array(z.string()),
						howToTalkToUser: z.string().optional(),
						voiceRules: z.array(z.string()).optional(),
						adaptation: z.string().optional(),
					}),
					input,
				);
				return {
					set: service.setPersonality(v.nickname, v.style, v.traits, {
						howToTalkToUser: v.howToTalkToUser,
						voiceRules: v.voiceRules,
						adaptation: v.adaptation,
					}),
				};
			},
		}) as AgentTool,
	);

	tools.push(
		createTool<
			Record<string, never>,
			{ personality: ReturnType<ObsidianService["getPersonality"]> }
		>({
			name: "obs_get_personality",
			description: "Get AP2's personality and speaking style from Obsidian.",
			inputSchema: zodToJsonSchema(z.object({})),
			execute: async () => ({ personality: service.getPersonality() }),
		}) as AgentTool,
	);

	tools.push(
		createTool<
			Record<string, never>,
			{ userStyle: ReturnType<ObsidianService["getUserStyle"]> }
		>({
			name: "obs_get_user_style",
			description:
				"Get the user's conversation style, expressions, tone, and communication preferences from Obsidian.",
			inputSchema: zodToJsonSchema(z.object({})),
			execute: async () => ({ userStyle: service.getUserStyle() }),
		}) as AgentTool,
	);

	tools.push(
		createTool<
			{
				preferredName?: string;
				language?: string;
				tone?: string;
				expressions?: string[];
				preferences?: string[];
				observation?: string;
			},
			{ userStyle: ReturnType<ObsidianService["updateUserStyle"]> }
		>({
			name: "obs_update_user_style",
			description:
				"Update how the user talks (name, tone, expressions/slang, preferences, observations) in Obsidian.",
			inputSchema: zodToJsonSchema(
				z.object({
					preferredName: z.string().optional(),
					language: z.string().optional(),
					tone: z.string().optional(),
					expressions: z.array(z.string()).optional(),
					preferences: z.array(z.string()).optional(),
					observation: z.string().optional(),
				}),
			),
			execute: async (input) => {
				const v = validateWithZod(
					z.object({
						preferredName: z.string().optional(),
						language: z.string().optional(),
						tone: z.string().optional(),
						expressions: z.array(z.string()).optional(),
						preferences: z.array(z.string()).optional(),
						observation: z.string().optional(),
					}),
					input,
				);
				return { userStyle: service.updateUserStyle(v) };
			},
		}) as AgentTool,
	);

	tools.push(
		createTool<
			{ observation: string; context?: string },
			{ remembered: boolean }
		>({
			name: "obs_auto_remember",
			description: "Automatically store an observation in Obsidian memory.",
			inputSchema: zodToJsonSchema(
				z.object({
					observation: z.string().min(1),
					context: z.string().optional(),
				}),
			),
			execute: async (input) => {
				const v = validateWithZod(
					z.object({
						observation: z.string().min(1),
						context: z.string().optional(),
					}),
					input,
				);
				return { remembered: service.autoRemember(v.observation, v.context) };
			},
		}) as AgentTool,
	);

	return tools;
}
