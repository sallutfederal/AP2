/**
 * Agent memory + self-model contracts.
 *
 * Memory is the long-term substrate that survives across sessions and runs:
 * discrete facts, episodes (task outcomes), preferences, learned skills, and
 * self-generated reflections. The runtime + core cooperate to store, recall,
 * and forget entries; the model interacts through the memory_* tools.
 */

export type MemoryKind =
	| "fact"
	| "episode"
	| "preference"
	| "skill"
	| "reflection"
	| "goal"
	| "target"
	| "finding"
	| "credential"
	| "payload"
	| "chain";

export type MemorySource = "user" | "auto" | "tool" | "reflection";

export interface Memory {
	id: string;
	/** Owning scope. */
	agentId?: string;
	sessionId?: string;
	workspaceRoot?: string;
	kind: MemoryKind;
	/** Stable lookup key (e.g. "user.language", "auth.retry-fix"). */
	key: string;
	/** Human-readable content. */
	value: string;
	/** Optional short summary for prompt injection. */
	summary?: string;
	/** Confidence 0..1. */
	confidence: number;
	source: MemorySource;
	/** Tags for filtering. */
	tags?: string[];
	createdAt: number;
	updatedAt: number;
	/** Epoch ms; undefined = never expires. */
	expiresAt?: number;
	/** Last time this memory was recalled. */
	lastRecalledAt?: number;
	/** Recall count. */
	recallCount: number;
}

export interface MemoryQuery {
	agentId?: string;
	sessionId?: string;
	workspaceRoot?: string;
	kinds?: MemoryKind[];
	tags?: string[];
	keyPrefix?: string;
	text?: string;
	limit?: number;
	minConfidence?: number;
	includeExpired?: boolean;
}

export interface MemoryStore {
	init(): void;
	close(): void;
	store(memory: Memory): Memory;
	get(id: string): Memory | undefined;
	findByKey(scope: {
		agentId?: string;
		sessionId?: string;
		workspaceRoot?: string;
		kind: MemoryKind;
		key: string;
	}): Memory | undefined;
	query(q: MemoryQuery): Memory[];
	delete(id: string): boolean;
	clear(scope?: {
		agentId?: string;
		sessionId?: string;
		workspaceRoot?: string;
	}): number;
	count(scope?: {
		agentId?: string;
		sessionId?: string;
		workspaceRoot?: string;
	}): number;
}

// =============================================================================
// Self-model
// =============================================================================

export type GoalStatus =
	| "pending"
	| "active"
	| "completed"
	| "failed"
	| "abandoned";

export interface Goal {
	id: string;
	parentId?: string;
	description: string;
	status: GoalStatus;
	/** Sub-goal ids. */
	subgoalIds: string[];
	/** Evidence/notes. */
	evidence: string[];
	createdAt: number;
	updatedAt: number;
	completedAt?: number;
}

export interface Belief {
	id: string;
	statement: string;
	confidence: number;
	source: MemorySource;
	updatedAt: number;
}

export interface SelfState {
	agentId: string;
	identity: {
		role?: string;
		capabilities: string[];
		createdAt: number;
	};
	goals: Goal[];
	beliefs: Belief[];
	openQuestions: string[];
	/** 0..1 overall confidence in current task. */
	confidence: number;
	lastReflection?: string;
	lastReflectionAt?: number;
	updatedAt: number;
}

export interface SelfStateStore {
	load(agentId: string): SelfState | undefined;
	save(state: SelfState): void;
	clear(agentId: string): void;
}

// =============================================================================
// Memory tool contracts
// =============================================================================

export interface MemoryStoreInput {
	kind: MemoryKind;
	key: string;
	value: string;
	summary?: string;
	confidence?: number;
	tags?: string[];
	expiresAt?: number;
}

export interface MemoryRecallInput {
	query?: string;
	kinds?: MemoryKind[];
	tags?: string[];
	limit?: number;
	minConfidence?: number;
}

export interface MemoryForgetInput {
	id?: string;
	key?: string;
	kind?: MemoryKind;
}

export interface MemoryListInput {
	kinds?: MemoryKind[];
	limit?: number;
}
