import {
	type AgentTool,
	createTool,
	validateWithZod,
	zodToJsonSchema,
} from "@cline/shared";
import { z } from "zod";
import type { SelfStateService } from "./self-state-service";

const GoalPushSchema = z.object({
	description: z.string().min(1),
	parentId: z.string().optional(),
});

const GoalCompleteSchema = z.object({
	goalId: z.string().min(1),
	evidence: z.string().optional(),
});

const GoalFailSchema = z.object({
	goalId: z.string().min(1),
	reason: z.string().optional(),
});

const BeliefAddSchema = z.object({
	statement: z.string().min(1),
	confidence: z.number().min(0).max(1),
});

const OpenQuestionSchema = z.object({
	question: z.string().min(1),
});

const ResolveQuestionSchema = z.object({
	question: z.string().min(1),
});

const ReflectSchema = z.object({
	reflection: z.string().min(1),
});

const IntrospectSchema = z.object({});

export function createSelfStateTools(
	service: SelfStateService,
	agentId?: string,
): AgentTool[] {
	const tools: AgentTool[] = [];
	const id = agentId;

	tools.push(
		createTool<{ description: string; parentId?: string }, { goalId: string }>({
			name: "goal_push",
			description:
				"Push a new goal (or sub-goal) onto the agent's goal stack for the current task.",
			inputSchema: zodToJsonSchema(GoalPushSchema),
			execute: async (input) => {
				const v = validateWithZod(GoalPushSchema, input);
				const g = service.pushGoal(v.description, v.parentId, id);
				return { goalId: g.id };
			},
		}) as AgentTool,
	);

	tools.push(
		createTool<
			{ goalId: string; evidence?: string },
			{ goalId: string; status: string }
		>({
			name: "goal_complete",
			description: "Mark a goal as completed, optionally with evidence.",
			inputSchema: zodToJsonSchema(GoalCompleteSchema),
			execute: async (input) => {
				const v = validateWithZod(GoalCompleteSchema, input);
				const g = service.completeGoal(v.goalId, v.evidence, id);
				return { goalId: v.goalId, status: g?.status ?? "unknown" };
			},
		}) as AgentTool,
	);

	tools.push(
		createTool<
			{ goalId: string; reason?: string },
			{ goalId: string; status: string }
		>({
			name: "goal_fail",
			description: "Mark a goal as failed with a reason.",
			inputSchema: zodToJsonSchema(GoalFailSchema),
			execute: async (input) => {
				const v = validateWithZod(GoalFailSchema, input);
				const g = service.failGoal(v.goalId, v.reason, id);
				return { goalId: v.goalId, status: g?.status ?? "unknown" };
			},
		}) as AgentTool,
	);

	tools.push(
		createTool<{ statement: string; confidence: number }, { ok: boolean }>({
			name: "belief_add",
			description:
				"Record a belief about the world/task with a confidence (0..1).",
			inputSchema: zodToJsonSchema(BeliefAddSchema),
			execute: async (input) => {
				const v = validateWithZod(BeliefAddSchema, input);
				service.addBelief(v.statement, v.confidence, "reflection", id);
				return { ok: true };
			},
		}) as AgentTool,
	);

	tools.push(
		createTool<{ question: string }, { ok: boolean }>({
			name: "open_question",
			description: "Record an open question the agent cannot yet answer.",
			inputSchema: zodToJsonSchema(OpenQuestionSchema),
			execute: async (input) => {
				const v = validateWithZod(OpenQuestionSchema, input);
				service.addOpenQuestion(v.question, id);
				return { ok: true };
			},
		}) as AgentTool,
	);

	tools.push(
		createTool<{ question: string }, { ok: boolean }>({
			name: "resolve_question",
			description: "Mark an open question as resolved.",
			inputSchema: zodToJsonSchema(ResolveQuestionSchema),
			execute: async (input) => {
				const v = validateWithZod(ResolveQuestionSchema, input);
				service.resolveOpenQuestion(v.question, id);
				return { ok: true };
			},
		}) as AgentTool,
	);

	tools.push(
		createTool<{ reflection: string }, { ok: boolean }>({
			name: "reflect",
			description:
				"Record a self-reflection insight about the current task/approach.",
			inputSchema: zodToJsonSchema(ReflectSchema),
			execute: async (input) => {
				const v = validateWithZod(ReflectSchema, input);
				service.setReflection(v.reflection, id);
				return { ok: true };
			},
		}) as AgentTool,
	);

	tools.push(
		createTool<Record<string, never>, { state: unknown }>({
			name: "introspect",
			description:
				"Introspect the agent's current self-state (goals, beliefs, open questions, confidence, last reflection).",
			inputSchema: zodToJsonSchema(IntrospectSchema),
			execute: async () => {
				const state = service.get(id);
				return { state };
			},
		}) as AgentTool,
	);

	return tools;
}
