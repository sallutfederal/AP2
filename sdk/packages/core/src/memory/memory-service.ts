import type {
	Memory,
	MemoryForgetInput,
	MemoryListInput,
	MemoryQuery,
	MemoryRecallInput,
	MemorySource,
	MemoryStore,
	MemoryStoreInput,
} from "@cline/shared";
import { nanoid } from "nanoid";
import { SqliteMemoryStore } from "./memory-store";

export interface MemoryServiceOptions {
	store?: MemoryStore;
	dbPath?: string;
	defaultAgentId?: string;
	defaultWorkspaceRoot?: string;
}

export class MemoryService {
	private readonly memoryStore: MemoryStore;
	private defaultAgentId?: string;
	private defaultWorkspaceRoot?: string;

	constructor(options: MemoryServiceOptions = {}) {
		this.memoryStore =
			options.store ?? new SqliteMemoryStore({ dbPath: options.dbPath });
		this.defaultAgentId = options.defaultAgentId;
		this.defaultWorkspaceRoot = options.defaultWorkspaceRoot;
		this.memoryStore.init();
	}

	getStore(): MemoryStore {
		return this.memoryStore;
	}

	setScope(scope: { agentId?: string; workspaceRoot?: string }): void {
		if (scope.agentId !== undefined) this.defaultAgentId = scope.agentId;
		if (scope.workspaceRoot !== undefined)
			this.defaultWorkspaceRoot = scope.workspaceRoot;
	}

	store(
		input: MemoryStoreInput,
		scope?: {
			agentId?: string;
			sessionId?: string;
			workspaceRoot?: string;
		},
	): Memory {
		const agentId = scope?.agentId ?? this.defaultAgentId;
		const workspaceRoot = scope?.workspaceRoot ?? this.defaultWorkspaceRoot;
		// upsert by key+kind+scope
		const existing = this.memoryStore.findByKey({
			agentId,
			sessionId: scope?.sessionId,
			workspaceRoot,
			kind: input.kind,
			key: input.key,
		});
		const now = Date.now();
		const memory: Memory = {
			id: existing?.id ?? `mem_${nanoid(10)}`,
			agentId,
			sessionId: scope?.sessionId,
			workspaceRoot,
			kind: input.kind,
			key: input.key,
			value: input.value,
			summary: input.summary,
			confidence: input.confidence ?? existing?.confidence ?? 1,
			source: (input as { source?: MemorySource }).source ?? "user",
			tags: input.tags,
			createdAt: existing?.createdAt ?? now,
			updatedAt: now,
			expiresAt: input.expiresAt,
			recallCount: existing?.recallCount ?? 0,
		};
		return this.memoryStore.store(memory);
	}

	recall(
		input: MemoryRecallInput,
		scope?: {
			agentId?: string;
			sessionId?: string;
			workspaceRoot?: string;
		},
	): Memory[] {
		const agentId = scope?.agentId ?? this.defaultAgentId;
		const workspaceRoot = scope?.workspaceRoot ?? this.defaultWorkspaceRoot;
		const q: MemoryQuery = {
			agentId,
			workspaceRoot,
			kinds: input.kinds,
			tags: input.tags,
			text: input.query,
			limit: input.limit ?? 10,
			minConfidence: input.minConfidence,
		};
		const results = this.memoryStore.query(q);
		// bump recall counts
		for (const m of results) {
			m.recallCount += 1;
			m.lastRecalledAt = Date.now();
			this.memoryStore.store(m);
		}
		return results;
	}

	forget(
		input: MemoryForgetInput,
		scope?: {
			agentId?: string;
			sessionId?: string;
			workspaceRoot?: string;
		},
	): number {
		if (input.id) {
			return this.memoryStore.delete(input.id) ? 1 : 0;
		}
		const agentId = scope?.agentId ?? this.defaultAgentId;
		const workspaceRoot = scope?.workspaceRoot ?? this.defaultWorkspaceRoot;
		// find by key+kind
		const found = this.memoryStore.query({
			agentId,
			workspaceRoot,
			kinds: input.kind ? [input.kind] : undefined,
			keyPrefix: input.key,
			limit: 1000,
		});
		let n = 0;
		for (const m of found) {
			if (input.key && m.key !== input.key) continue;
			if (input.kind && m.kind !== input.kind) continue;
			if (this.memoryStore.delete(m.id)) n += 1;
		}
		return n;
	}

	list(
		input: MemoryListInput,
		scope?: {
			agentId?: string;
			sessionId?: string;
			workspaceRoot?: string;
		},
	): Memory[] {
		const agentId = scope?.agentId ?? this.defaultAgentId;
		const workspaceRoot = scope?.workspaceRoot ?? this.defaultWorkspaceRoot;
		return this.memoryStore.query({
			agentId,
			workspaceRoot,
			kinds: input.kinds,
			limit: input.limit ?? 50,
		});
	}

	formatForPrompt(memories: Memory[], maxChars = 4000): string {
		if (!memories.length) return "";
		const lines: string[] = ["## Relevant memories"];
		let used = 0;
		for (const m of memories) {
			const text = m.summary ?? m.value;
			const line = `- [${m.kind}] ${m.key}: ${text}`;
			if (used + line.length > maxChars) break;
			lines.push(line);
			used += line.length;
		}
		return lines.join("\n");
	}

	close(): void {
		this.memoryStore.close();
	}
}
