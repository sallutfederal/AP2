import type { AgentTool } from "@cline/shared";
import { zodToJsonSchema } from "@cline/shared";
import { z } from "zod";
import type { GraphService } from "./graph-service";

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

export function createGraphTools(service: GraphService): AgentTool[] {
	const tools: AgentTool[] = [];

	// rt_asset_add
	const AssetAddSchema = z.object({
		id: z.string().min(1),
		type: z.string().min(1),
		value: z.string().min(1),
		company: z.string().optional(),
		parentId: z.string().optional(),
	});
	tools.push(
		createTool<
			{
				id: string;
				type: string;
				value: string;
				company?: string;
				parentId?: string;
			},
			{ asset: ReturnType<GraphService["addAsset"]> }
		>({
			name: "rt_asset_add",
			description:
				"Add an asset to the asset graph (domain, subdomain, ip, service, endpoint).",
			inputSchema: zodToJsonSchema(AssetAddSchema),
			execute: async (input) => {
				const v = validateWithZod(AssetAddSchema, input);
				return { asset: service.addAsset(v) };
			},
		}) as AgentTool,
	);

	// rt_asset_list
	const AssetListSchema = z.object({
		type: z.string().optional(),
		tested: z.boolean().optional(),
	});
	tools.push(
		createTool<
			{ type?: string; tested?: boolean },
			{ assets: ReturnType<GraphService["listAssets"]> }
		>({
			name: "rt_asset_list",
			description:
				"List assets in the asset graph, optionally filtered by type or tested status.",
			inputSchema: zodToJsonSchema(AssetListSchema),
			execute: async (input) => {
				const v = validateWithZod(AssetListSchema, input);
				return { assets: service.listAssets(v.type, v.tested) };
			},
		}) as AgentTool,
	);

	// rt_asset_tested
	const AssetTestedSchema = z.object({
		id: z.string().min(1),
		findingCount: z.number().int().optional(),
	});
	tools.push(
		createTool<{ id: string; findingCount?: number }, { marked: boolean }>({
			name: "rt_asset_tested",
			description: "Mark an asset as tested (with optional finding count).",
			inputSchema: zodToJsonSchema(AssetTestedSchema),
			execute: async (input) => {
				const v = validateWithZod(AssetTestedSchema, input);
				service.markTested(v.id, v.findingCount);
				return { marked: true };
			},
		}) as AgentTool,
	);

	// rt_coverage
	tools.push(
		createTool<
			Record<string, never>,
			{ coverage: ReturnType<GraphService["getCoverage"]> }
		>({
			name: "rt_coverage",
			description:
				"Get test coverage: total/tested/untested assets, findings, by type.",
			inputSchema: zodToJsonSchema(z.object({})),
			execute: async () => ({ coverage: service.getCoverage() }),
		}) as AgentTool,
	);

	// rt_explore_add
	const ExploreAddSchema = z.object({
		id: z.string().min(1),
		type: z.string().min(1),
		title: z.string().min(1),
		status: z.string().optional(),
		parentId: z.string().optional(),
		assetId: z.string().optional(),
	});
	tools.push(
		createTool<
			{
				id: string;
				type: string;
				title: string;
				status?: string;
				parentId?: string;
				assetId?: string;
			},
			{ node: ReturnType<GraphService["addNode"]> }
		>({
			name: "rt_explore_add",
			description:
				"Add an exploration node (goal/intent/fact/finding/hint) to the exploration graph.",
			inputSchema: zodToJsonSchema(ExploreAddSchema),
			execute: async (input) => {
				const v = validateWithZod(ExploreAddSchema, input);
				return { node: service.addNode(v) };
			},
		}) as AgentTool,
	);

	// rt_explore_list
	const ExploreListSchema = z.object({ type: z.string().optional() });
	tools.push(
		createTool<
			{ type?: string },
			{ nodes: ReturnType<GraphService["listNodes"]> }
		>({
			name: "rt_explore_list",
			description: "List exploration nodes, optionally filtered by type.",
			inputSchema: zodToJsonSchema(ExploreListSchema),
			execute: async (input) => {
				const v = validateWithZod(ExploreListSchema, input);
				return { nodes: service.listNodes(v.type) };
			},
		}) as AgentTool,
	);

	// rt_explore_update
	const ExploreUpdateSchema = z.object({
		id: z.string().min(1),
		status: z.string().optional(),
		result: z.string().optional(),
		title: z.string().optional(),
	});
	tools.push(
		createTool<
			{ id: string; status?: string; result?: string; title?: string },
			{ updated: boolean }
		>({
			name: "rt_explore_update",
			description: "Update an exploration node status/result.",
			inputSchema: zodToJsonSchema(ExploreUpdateSchema),
			execute: async (input) => {
				const v = validateWithZod(ExploreUpdateSchema, input);
				service.updateNode(v.id, {
					status: v.status,
					result: v.result,
					title: v.title,
				});
				return { updated: true };
			},
		}) as AgentTool,
	);

	// rt_anchor
	const AnchorSchema = z.object({
		explorationNodeId: z.string().min(1),
		assetId: z.string().min(1),
	});
	tools.push(
		createTool<
			{ explorationNodeId: string; assetId: string },
			{ anchored: boolean }
		>({
			name: "rt_anchor",
			description:
				"Anchor an exploration node to an asset (link exploration to asset graph).",
			inputSchema: zodToJsonSchema(AnchorSchema),
			execute: async (input) => {
				const v = validateWithZod(AnchorSchema, input);
				service.anchor(v.explorationNodeId, v.assetId);
				return { anchored: true };
			},
		}) as AgentTool,
	);

	// rt_trace_log
	const TraceLogSchema = z.object({
		intentId: z.string().optional(),
		stepNumber: z.number().int().optional(),
		command: z.string().optional(),
		output: z.string().optional(),
		observation: z.string().optional(),
	});
	tools.push(
		createTool<
			{
				intentId?: string;
				stepNumber?: number;
				command?: string;
				output?: string;
				observation?: string;
			},
			{ trace: ReturnType<GraphService["logTrace"]> }
		>({
			name: "rt_trace_log",
			description:
				"Log an execution trace (command + output + observation) for trace sharing between workers.",
			inputSchema: zodToJsonSchema(TraceLogSchema),
			execute: async (input) => {
				const v = validateWithZod(TraceLogSchema, input);
				return { trace: service.logTrace(v) };
			},
		}) as AgentTool,
	);

	// rt_trace_search
	const TraceSearchSchema = z.object({
		query: z.string().min(1),
		excludeSelf: z.boolean().optional(),
	});
	tools.push(
		createTool<
			{ query: string; excludeSelf?: boolean },
			{ traces: ReturnType<GraphService["searchTraces"]> }
		>({
			name: "rt_trace_search",
			description:
				"Search execution traces by keyword (trace sharing: reuse other workers' observations).",
			inputSchema: zodToJsonSchema(TraceSearchSchema),
			execute: async (input) => {
				const v = validateWithZod(TraceSearchSchema, input);
				return { traces: service.searchTraces(v.query, v.excludeSelf ?? true) };
			},
		}) as AgentTool,
	);

	// rt_trace_by_intent
	const TraceByIntentSchema = z.object({ intentId: z.string().min(1) });
	tools.push(
		createTool<
			{ intentId: string },
			{ traces: ReturnType<GraphService["getTracesByIntent"]> }
		>({
			name: "rt_trace_by_intent",
			description: "Get all traces for a specific intent.",
			inputSchema: zodToJsonSchema(TraceByIntentSchema),
			execute: async (input) => {
				const v = validateWithZod(TraceByIntentSchema, input);
				return { traces: service.getTracesByIntent(v.intentId) };
			},
		}) as AgentTool,
	);

	// rt_trace_by_task
	tools.push(
		createTool<
			Record<string, never>,
			{ traces: ReturnType<GraphService["getTracesByTask"]> }
		>({
			name: "rt_trace_by_task",
			description: "Get all traces for the current task.",
			inputSchema: zodToJsonSchema(z.object({})),
			execute: async () => ({ traces: service.getTracesByTask() }),
		}) as AgentTool,
	);

	return tools;
}
