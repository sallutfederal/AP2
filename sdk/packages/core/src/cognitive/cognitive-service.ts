import { SqliteCognitiveStore } from "./cognitive-store";

export interface CognitiveServiceOptions {
	store?: SqliteCognitiveStore;
	agentId?: string;
	sessionId?: string;
	workspaceRoot?: string;
}

export class CognitiveService {
	private readonly store: SqliteCognitiveStore;
	private readonly sessionId?: string;

	constructor(options: CognitiveServiceOptions) {
		this.store = options.store ?? new SqliteCognitiveStore();
		this.sessionId = options.sessionId;
		this.store.init();
	}

	getProfile() {
		return this.store.getProfile();
	}

	updateProfile(updates: Parameters<SqliteCognitiveStore["updateProfile"]>[0]) {
		return this.store.updateProfile(updates);
	}

	recordCommand(command: string, durationMs: number, success: boolean) {
		this.store.recordCommand(command, durationMs, success);
	}

	getCommandStats(limit?: number) {
		return this.store.getCommandStats(limit);
	}

	getTopCommands(limit?: number) {
		return this.store.getTopCommands(limit);
	}

	createLink(
		fromKey: string,
		toKey: string,
		relation?: string,
		weight?: number,
	) {
		return this.store.createLink(fromKey, toKey, relation, weight);
	}

	getLinks(key: string) {
		return this.store.getLinks(key);
	}

	traverseLink(id: string) {
		this.store.traverseLink(id);
	}

	addContext(role: string, content: string, importance?: number) {
		this.store.addContext(this.sessionId, role, content, importance);
	}

	getContext(limit?: number) {
		return this.store.getContext(this.sessionId, limit);
	}

	addPrediction(
		predictedRequest: string,
		confidence: number,
		basedOn?: string,
	) {
		return this.store.addPrediction(predictedRequest, confidence, basedOn);
	}

	getPredictions(limit?: number) {
		return this.store.getPredictions(limit);
	}

	fulfillPrediction(id: string) {
		this.store.fulfillPrediction(id);
	}

	addReflection(topic: string, insight: string, useful?: boolean) {
		return this.store.addReflection(topic, insight, useful);
	}

	getReflections(limit?: number) {
		return this.store.getReflections(limit);
	}

	updateEmotion(
		emotion: "engagement" | "frustration" | "excitement" | "confidence",
		value: number,
	) {
		this.store.updateEmotion(emotion, value);
	}

	predictNext() {
		const top = this.store.getTopCommands(5).map((c) => c.command);
		return this.store.predictNext(top);
	}

	filterUseful(items: { id: string; content: string }[]) {
		return this.store.filterUseful(items);
	}

	reflect(topic: string, insight: string, useful?: boolean) {
		return this.store.addReflection(topic, insight, useful);
	}

	// --- Predictive: what will user ask next? ---
	predictNextRequest(): string {
		const top = this.store.getTopCommands(3);
		if (top.length === 0) return "rt_recon";
		const lastCmd = top[0].command;
		const patterns: Record<string, string> = {
			rt_nmap: "run nuclei scan on discovered hosts",
			rt_subfinder: "probe HTTP services",
			rt_httpx: "fingerprint technologies",
			rt_vuln_scan: "exploit discovered vulnerabilities",
			rt_auto_exploit: "escalate privileges",
			rt_privesc_auto: "dump credentials",
			rt_cred_dump: "move laterally",
			rt_lateral: "establish persistence",
		};
		return patterns[lastCmd] ?? "continue reconnaissance";
	}

	// --- Human-like thinking: separate useful from useless ---
	think(items: { id: string; content: string }[]): {
		useful: string[];
		useless: string[];
		insight: string;
	} {
		const filtered = this.store.filterUseful(items);
		const insight =
			filtered.useful.length > filtered.useless.length
				? "Most data is useful. Proceed with analysis."
				: "Most data is noise. Filter before proceeding.";
		return { ...filtered, insight };
	}
}
