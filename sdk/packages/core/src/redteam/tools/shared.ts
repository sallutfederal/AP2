import type { AgentTool } from "@cline/shared";
import type { CommandFilter } from "../command-filter";
import type { DockerMiddleware } from "../docker";
import type { SqlitePlanStore } from "../plan-store";
import type { SqliteRedTeamStore } from "../redteam-store";
import type { StealthMiddleware } from "../stealth";
import type { SqliteTodoStore } from "../todo-store";

export interface RedTeamToolContext {
	stealth: StealthMiddleware;
	docker?: DockerMiddleware;
	planStore?: SqlitePlanStore;
	todoStore?: SqliteTodoStore;
	redTeamStore?: SqliteRedTeamStore;
	/** When false (default), the 64 rt_ref_* and 14 rt_re_* tools are consolidated into rt_reference and rt_reverse_engineer to save ~76 tool schemas per LLM request. */
	includeLegacyRefTools?: boolean;
	memoryService?: {
		store: (entry: unknown) => void;
		recall: (query: unknown) => unknown[];
		formatForPrompt: (mems: unknown[], limit: number) => string;
	};
	obsidianService?: {
		autoRemember: (obs: string, ctx?: string) => boolean;
		writeNote: (path: string, content: string) => boolean;
		appendNote: (path: string, content: string) => boolean;
		saveReport?: (
			title: string,
			content: string,
			tags?: string[],
		) => string | null;
	};
	cognitiveService?: {
		recordCommand: (cmd: string, ms: number, success: boolean) => void;
		reflect: (topic: string, insight: string, useful?: boolean) => void;
		getProfile: () => unknown;
	};
	graphService?: {
		addAsset: (a: {
			id: string;
			type: string;
			value: string;
			company?: string;
			parentId?: string;
		}) => unknown;
		markTested?: (id: string, findingCount?: number) => void;
		addNode: (n: {
			id: string;
			type: string;
			title: string;
			status?: string;
			parentId?: string;
			assetId?: string;
		}) => unknown;
		logTrace: (t: {
			intentId?: string;
			stepNumber?: number;
			command?: string;
			output?: string;
			observation?: string;
		}) => unknown;
	};
	commandFilter?: CommandFilter;
}

export interface RedTeamAuditEntry {
	ts: number;
	target?: string;
	command: string;
	hash: string;
	prevHash?: string;
	chainHash?: string;
	code: number;
}

export const rtState = {
	scopeAllowlist: new Set<string>(),
	dryRunMode: false,
	killed: false,
	actionCount: 0,
};

export interface RedTeamRuntimeEnv {
	ctx: RedTeamToolContext;
	tools: AgentTool[];
	scopeAllowlist: Set<string>;
	auditLog: RedTeamAuditEntry[];
	recordAuditEntry: (entry: {
		ts: number;
		target?: string;
		command: string;
		hash: string;
		code: number;
	}) => void;
	syncAssetToGraph: (
		type: string,
		value: string,
		parentId?: string,
		tested?: boolean,
		findingCount?: number,
	) => string;
	syncTargetFactToMemory: (
		key: string,
		value: string,
		tags: string[],
		confidence?: number,
	) => void;
	syncFindingToGraphAndMemory: (
		target: string,
		title: string,
		severity: string,
		evidence: string,
	) => void;
}

export function createRedTeamRuntimeEnv(
	ctx: RedTeamToolContext,
): RedTeamRuntimeEnv {
	const { redTeamStore, memoryService, graphService } = ctx;
	const tools: AgentTool[] = [];
	const scopeAllowlist = rtState.scopeAllowlist;

	if (redTeamStore) {
		try {
			redTeamStore.init();
			for (const t of redTeamStore.getScopeTargets()) {
				scopeAllowlist.add(t);
			}
			rtState.dryRunMode = redTeamStore.isDryRun();
			rtState.killed = redTeamStore.isKilled();
		} catch {
			// ignore hydration errors
		}
	}

	const auditLog: RedTeamAuditEntry[] = [];
	if (redTeamStore) {
		try {
			for (const entry of redTeamStore.listAudit()) {
				auditLog.push(entry);
			}
		} catch {
			// ignore
		}
	}

	const recordAuditEntry = (entry: {
		ts: number;
		target?: string;
		command: string;
		hash: string;
		code: number;
	}): void => {
		if (redTeamStore) {
			try {
				const persisted = redTeamStore.appendAudit({
					ts: entry.ts,
					target: entry.target,
					command: entry.command,
					outputHash: entry.hash,
					code: entry.code,
				});
				auditLog.push(persisted);
				return;
			} catch {
				// fallback to in-memory
			}
		}
		auditLog.push(entry);
	};

	const syncAssetToGraph = (
		type: string,
		value: string,
		parentId?: string,
		tested?: boolean,
		findingCount?: number,
	): string => {
		const id = `${type}:${value.toLowerCase()}`;
		if (!graphService) return id;
		try {
			graphService.addAsset({ id, type, value, parentId });
			if (tested && graphService.markTested) {
				graphService.markTested(id, findingCount ?? 0);
			}
		} catch {
			// ignore graph errors
		}
		return id;
	};

	const syncTargetFactToMemory = (
		key: string,
		value: string,
		tags: string[],
		confidence = 0.95,
	): void => {
		if (!memoryService) return;
		try {
			memoryService.store({
				kind: "target",
				key,
				value,
				confidence,
				tags: ["redteam", ...tags],
			});
		} catch {
			// ignore memory errors
		}
	};

	const syncFindingToGraphAndMemory = (
		target: string,
		title: string,
		severity: string,
		evidence: string,
	): void => {
		const assetId = syncAssetToGraph("target", target, undefined, true, 1);
		if (graphService) {
			try {
				graphService.addNode({
					id: `finding:${target.toLowerCase()}:${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
					type: "finding",
					title: `[${severity.toUpperCase()}] ${title} on ${target}`,
					status: "confirmed",
					assetId,
				});
			} catch {
				// ignore
			}
		}
		if (memoryService) {
			try {
				memoryService.store({
					kind: "finding",
					key: `finding:${target}:${title}`,
					value: `[${severity.toUpperCase()}] ${title} on ${target} — Evidence: ${evidence.slice(0, 400)}`,
					confidence: 0.95,
					tags: ["redteam", "finding", severity.toLowerCase(), target],
				});
			} catch {
				// ignore
			}
		}
	};

	return {
		ctx,
		tools,
		scopeAllowlist,
		auditLog,
		recordAuditEntry,
		syncAssetToGraph,
		syncTargetFactToMemory,
		syncFindingToGraphAndMemory,
	};
}
