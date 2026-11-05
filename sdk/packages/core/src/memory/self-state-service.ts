import type { Belief, Goal, SelfState, SelfStateStore } from "@cline/shared";
import { nanoid } from "nanoid";
import { SqliteSelfStateStore } from "./self-state-store";

export interface SelfStateServiceOptions {
	store?: SelfStateStore;
	defaultAgentId?: string;
	defaultCapabilities?: string[];
	defaultRole?: string;
}

export class SelfStateService {
	private readonly store: SelfStateStore;
	private defaultAgentId: string;
	private defaultCapabilities: string[];
	private defaultRole?: string;

	constructor(options: SelfStateServiceOptions = {}) {
		this.store = options.store ?? new SqliteSelfStateStore();
		this.defaultAgentId = options.defaultAgentId ?? "agent";
		this.defaultCapabilities = options.defaultCapabilities ?? [];
		this.defaultRole = options.defaultRole;
	}

	get(agentId?: string): SelfState {
		const id = agentId ?? this.defaultAgentId;
		const existing = this.store.load(id);
		if (existing) return existing;
		const now = Date.now();
		const state: SelfState = {
			agentId: id,
			identity: {
				role: this.defaultRole,
				capabilities: this.defaultCapabilities,
				createdAt: now,
			},
			goals: [],
			beliefs: [],
			openQuestions: [],
			confidence: 0.5,
			updatedAt: now,
		};
		this.store.save(state);
		return state;
	}

	save(state: SelfState): void {
		state.updatedAt = Date.now();
		this.store.save(state);
	}

	pushGoal(description: string, parentId?: string, agentId?: string): Goal {
		const state = this.get(agentId);
		const now = Date.now();
		const goal: Goal = {
			id: `goal_${nanoid(8)}`,
			parentId,
			description,
			status: "active",
			subgoalIds: [],
			evidence: [],
			createdAt: now,
			updatedAt: now,
		};
		state.goals.push(goal);
		if (parentId) {
			const parent = state.goals.find((g) => g.id === parentId);
			if (parent) parent.subgoalIds.push(goal.id);
		}
		this.save(state);
		return goal;
	}

	completeGoal(
		goalId: string,
		evidence?: string,
		agentId?: string,
	): Goal | undefined {
		const state = this.get(agentId);
		const goal = state.goals.find((g) => g.id === goalId);
		if (!goal) return undefined;
		goal.status = "completed";
		goal.completedAt = Date.now();
		goal.updatedAt = Date.now();
		if (evidence) goal.evidence.push(evidence);
		this.save(state);
		return goal;
	}

	failGoal(
		goalId: string,
		reason?: string,
		agentId?: string,
	): Goal | undefined {
		const state = this.get(agentId);
		const goal = state.goals.find((g) => g.id === goalId);
		if (!goal) return undefined;
		goal.status = "failed";
		goal.updatedAt = Date.now();
		if (reason) goal.evidence.push(`failed: ${reason}`);
		this.save(state);
		return goal;
	}

	addBelief(
		statement: string,
		confidence: number,
		source: Belief["source"],
		agentId?: string,
	): Belief {
		const state = this.get(agentId);
		const belief: Belief = {
			id: `belief_${nanoid(8)}`,
			statement,
			confidence,
			source,
			updatedAt: Date.now(),
		};
		state.beliefs.push(belief);
		this.save(state);
		return belief;
	}

	setConfidence(value: number, agentId?: string): void {
		const state = this.get(agentId);
		state.confidence = Math.max(0, Math.min(1, value));
		this.save(state);
	}

	setReflection(text: string, agentId?: string): void {
		const state = this.get(agentId);
		state.lastReflection = text;
		state.lastReflectionAt = Date.now();
		this.save(state);
	}

	addOpenQuestion(q: string, agentId?: string): void {
		const state = this.get(agentId);
		if (!state.openQuestions.includes(q)) state.openQuestions.push(q);
		this.save(state);
	}

	resolveOpenQuestion(q: string, agentId?: string): void {
		const state = this.get(agentId);
		state.openQuestions = state.openQuestions.filter((x) => x !== q);
		this.save(state);
	}

	formatForPrompt(state: SelfState, maxChars = 2000): string {
		const lines: string[] = ["## Self-state"];
		lines.push(`Role: ${state.identity.role ?? "agent"}`);
		lines.push(
			`Capabilities: ${state.identity.capabilities.join(", ") || "none"}`,
		);
		lines.push(`Confidence: ${state.confidence.toFixed(2)}`);
		const activeGoals = state.goals.filter(
			(g) => g.status === "active" || g.status === "pending",
		);
		if (activeGoals.length) {
			lines.push("Active goals:");
			for (const g of activeGoals) lines.push(`  - ${g.id}: ${g.description}`);
		}
		if (state.openQuestions.length) {
			lines.push("Open questions:");
			for (const q of state.openQuestions) lines.push(`  - ${q}`);
		}
		if (state.lastReflection) {
			lines.push(`Last reflection: ${state.lastReflection.slice(0, 500)}`);
		}
		let out = lines.join("\n");
		if (out.length > maxChars) out = out.slice(0, maxChars);
		return out;
	}

	close(): void {
		// store close if supported
		const s = this.store as { close?: () => void };
		s.close?.();
	}
}
