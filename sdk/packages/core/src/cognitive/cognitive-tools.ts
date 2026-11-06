import type { AgentTool } from "@cline/shared";
import { zodToJsonSchema } from "@cline/shared";
import { z } from "zod";
import type { CognitiveService } from "./cognitive-service";

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

export function createCognitiveTools(service: CognitiveService): AgentTool[] {
	const tools: AgentTool[] = [];

	// cg_profile_get
	tools.push(
		createTool<
			Record<string, never>,
			{ profile: ReturnType<CognitiveService["getProfile"]> }
		>({
			name: "cg_profile_get",
			description:
				"Get the user profile: name, emotions, command counts, wait times.",
			inputSchema: zodToJsonSchema(z.object({})),
			execute: async () => ({ profile: service.getProfile() }),
		}) as AgentTool,
	);

	// cg_profile_update
	const ProfileUpdateSchema = z.object({
		name: z.string().optional(),
		preferredLanguage: z.string().optional(),
		identityNotes: z.string().optional(),
	});
	tools.push(
		createTool<
			{ name?: string; preferredLanguage?: string; identityNotes?: string },
			{ updated: boolean }
		>({
			name: "cg_profile_update",
			description: "Update user profile (name, language, identity notes).",
			inputSchema: zodToJsonSchema(ProfileUpdateSchema),
			execute: async (input) => {
				const v = validateWithZod(ProfileUpdateSchema, input);
				service.updateProfile(v);
				return { updated: true };
			},
		}) as AgentTool,
	);

	// cg_command_log
	const CommandLogSchema = z.object({
		command: z.string().min(1),
		durationMs: z.number().int().nonnegative(),
		success: z.boolean(),
	});
	tools.push(
		createTool<
			{ command: string; durationMs: number; success: boolean },
			{ logged: boolean }
		>({
			name: "cg_command_log",
			description:
				"Log a command execution with duration and success for learning.",
			inputSchema: zodToJsonSchema(CommandLogSchema),
			execute: async (input) => {
				const v = validateWithZod(CommandLogSchema, input);
				service.recordCommand(v.command, v.durationMs, v.success);
				return { logged: true };
			},
		}) as AgentTool,
	);

	// cg_command_stats
	tools.push(
		createTool<
			Record<string, never>,
			{ stats: ReturnType<CognitiveService["getCommandStats"]> }
		>({
			name: "cg_command_stats",
			description:
				"Get command usage statistics (counts, avg time, success/failure).",
			inputSchema: zodToJsonSchema(z.object({})),
			execute: async () => ({ stats: service.getCommandStats() }),
		}) as AgentTool,
	);

	// cg_top_commands
	tools.push(
		createTool<
			Record<string, never>,
			{ top: ReturnType<CognitiveService["getTopCommands"]> }
		>({
			name: "cg_top_commands",
			description: "Get the most used commands.",
			inputSchema: zodToJsonSchema(z.object({})),
			execute: async () => ({ top: service.getTopCommands() }),
		}) as AgentTool,
	);

	// cg_emotion_set
	const EmotionSchema = z.object({
		emotion: z.enum(["engagement", "frustration", "excitement", "confidence"]),
		value: z.number().min(0).max(1),
	});
	tools.push(
		createTool<
			{
				emotion: "engagement" | "frustration" | "excitement" | "confidence";
				value: number;
			},
			{ set: boolean }
		>({
			name: "cg_emotion_set",
			description: "Set an emotional state value (0-1).",
			inputSchema: zodToJsonSchema(EmotionSchema),
			execute: async (input) => {
				const v = validateWithZod(EmotionSchema, input);
				service.updateEmotion(v.emotion, v.value);
				return { set: true };
			},
		}) as AgentTool,
	);

	// cg_memory_link
	const LinkSchema = z.object({
		fromKey: z.string().min(1),
		toKey: z.string().min(1),
		relation: z.string().optional(),
		weight: z.number().optional(),
	});
	tools.push(
		createTool<
			{ fromKey: string; toKey: string; relation?: string; weight?: number },
			{ link: ReturnType<CognitiveService["createLink"]> }
		>({
			name: "cg_memory_link",
			description: "Create a link between two memories (creates memory graph).",
			inputSchema: zodToJsonSchema(LinkSchema),
			execute: async (input) => {
				const v = validateWithZod(LinkSchema, input);
				return {
					link: service.createLink(v.fromKey, v.toKey, v.relation, v.weight),
				};
			},
		}) as AgentTool,
	);

	// cg_memory_links_get
	const LinksGetSchema = z.object({ key: z.string().min(1) });
	tools.push(
		createTool<
			{ key: string },
			{ links: ReturnType<CognitiveService["getLinks"]> }
		>({
			name: "cg_memory_links_get",
			description: "Get all memory links for a key.",
			inputSchema: zodToJsonSchema(LinksGetSchema),
			execute: async (input) => {
				const v = validateWithZod(LinksGetSchema, input);
				return { links: service.getLinks(v.key) };
			},
		}) as AgentTool,
	);

	// cg_context_add
	const CtxAddSchema = z.object({
		role: z.string().min(1),
		content: z.string().min(1),
		importance: z.number().min(0).max(1).optional(),
	});
	tools.push(
		createTool<
			{ role: string; content: string; importance?: number },
			{ added: boolean }
		>({
			name: "cg_context_add",
			description: "Add a context entry (never lose conversation context).",
			inputSchema: zodToJsonSchema(CtxAddSchema),
			execute: async (input) => {
				const v = validateWithZod(CtxAddSchema, input);
				service.addContext(v.role, v.content, v.importance);
				return { added: true };
			},
		}) as AgentTool,
	);

	// cg_context_get
	tools.push(
		createTool<
			Record<string, never>,
			{ context: ReturnType<CognitiveService["getContext"]> }
		>({
			name: "cg_context_get",
			description: "Get recent context entries.",
			inputSchema: zodToJsonSchema(z.object({})),
			execute: async () => ({ context: service.getContext() }),
		}) as AgentTool,
	);

	// cg_predict
	tools.push(
		createTool<
			Record<string, never>,
			{ prediction: ReturnType<CognitiveService["predictNext"]> }
		>({
			name: "cg_predict",
			description: "Predict what the user will ask next based on patterns.",
			inputSchema: zodToJsonSchema(z.object({})),
			execute: async () => ({ prediction: service.predictNext() }),
		}) as AgentTool,
	);

	// cg_predict_request
	tools.push(
		createTool<Record<string, never>, { request: string }>({
			name: "cg_predict_request",
			description: "Predict the user's next request in natural language.",
			inputSchema: zodToJsonSchema(z.object({})),
			execute: async () => ({ request: service.predictNextRequest() }),
		}) as AgentTool,
	);

	// cg_reflect
	const ReflectSchema = z.object({
		topic: z.string().min(1),
		insight: z.string().min(1),
		useful: z.boolean().optional(),
	});
	tools.push(
		createTool<
			{ topic: string; insight: string; useful?: boolean },
			{ reflected: boolean }
		>({
			name: "cg_reflect",
			description: "Reflect on a topic and store an insight (learning).",
			inputSchema: zodToJsonSchema(ReflectSchema),
			execute: async (input) => {
				const v = validateWithZod(ReflectSchema, input);
				service.reflect(v.topic, v.insight, v.useful);
				return { reflected: true };
			},
		}) as AgentTool,
	);

	// cg_reflections_get
	tools.push(
		createTool<
			Record<string, never>,
			{ reflections: ReturnType<CognitiveService["getReflections"]> }
		>({
			name: "cg_reflections_get",
			description: "Get past reflections/insights.",
			inputSchema: zodToJsonSchema(z.object({})),
			execute: async () => ({ reflections: service.getReflections() }),
		}) as AgentTool,
	);

	// cg_think
	const ThinkSchema = z.object({
		items: z.array(z.object({ id: z.string(), content: z.string() })),
	});
	tools.push(
		createTool<
			{ items: { id: string; content: string }[] },
			ReturnType<CognitiveService["think"]>
		>({
			name: "cg_think",
			description: "Human-like thinking: separate useful from useless data.",
			inputSchema: zodToJsonSchema(ThinkSchema),
			execute: async (input) => {
				const v = validateWithZod(ThinkSchema, input);
				return service.think(v.items);
			},
		}) as AgentTool,
	);

	// cg_filter
	const FilterSchema = z.object({
		items: z.array(z.object({ id: z.string(), content: z.string() })),
	});
	tools.push(
		createTool<
			{ items: { id: string; content: string }[] },
			{ useful: string[]; useless: string[] }
		>({
			name: "cg_filter",
			description: "Filter useful vs useless information.",
			inputSchema: zodToJsonSchema(FilterSchema),
			execute: async (input) => {
				const v = validateWithZod(FilterSchema, input);
				return service.filterUseful(v.items);
			},
		}) as AgentTool,
	);

	// cg_predictions_get
	tools.push(
		createTool<
			Record<string, never>,
			{ predictions: ReturnType<CognitiveService["getPredictions"]> }
		>({
			name: "cg_predictions_get",
			description: "Get past predictions.",
			inputSchema: zodToJsonSchema(z.object({})),
			execute: async () => ({ predictions: service.getPredictions() }),
		}) as AgentTool,
	);

	// cg_fulfill_prediction
	const FulfillSchema = z.object({ id: z.string().min(1) });
	tools.push(
		createTool<{ id: string }, { fulfilled: boolean }>({
			name: "cg_fulfill_prediction",
			description: "Mark a prediction as fulfilled (learning).",
			inputSchema: zodToJsonSchema(FulfillSchema),
			execute: async (input) => {
				const v = validateWithZod(FulfillSchema, input);
				service.fulfillPrediction(v.id);
				return { fulfilled: true };
			},
		}) as AgentTool,
	);

	return tools;
}
