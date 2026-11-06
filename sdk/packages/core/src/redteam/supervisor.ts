// Supervisor — dual-agent architecture (Supervisor selects tasks from state machine, Executor executes)
// Inspired by CrowdStrike's agentic AI campaigns research

export type AttackStage =
	| "recon"
	| "scan"
	| "exploit"
	| "postex"
	| "report"
	| "done";

export interface SupervisorState {
	taskId: string;
	target: string;
	currentStage: AttackStage;
	stageHistory: {
		stage: AttackStage;
		startedAt: number;
		completedAt?: number;
		result?: string;
	}[];
	findings: { title: string; severity: string; evidence: string }[];
	assets: { type: string; value: string; tested: boolean }[];
	credentials: { user: string; secret: string; source: string }[];
	nextActions: string[];
	maxActions: number;
	actionCount: number;
	createdAt: number;
	updatedAt: number;
}

export interface SupervisorOptions {
	taskId: string;
	target: string;
	maxActions?: number;
}

const STAGE_ORDER: AttackStage[] = [
	"recon",
	"scan",
	"exploit",
	"postex",
	"report",
	"done",
];

const STAGE_ACTIONS: Record<AttackStage, string[]> = {
	recon: ["rt_subfinder", "rt_nmap", "rt_httpx", "rt_whatweb", "rt_wafw00f"],
	scan: [
		"rt_vuln_templates",
		"rt_nuclei",
		"rt_discover_params",
		"rt_discover_api",
		"rt_graphql_probe",
	],
	exploit: ["rt_auto_exploit", "rt_payload_gen", "rt_cred_spray"],
	postex: ["rt_privesc_auto", "rt_cred_dump", "rt_lateral", "rt_persist"],
	report: ["rt_report_gen", "rt_finding_log"],
	done: [],
};

export class Supervisor {
	private state: SupervisorState;

	constructor(options: SupervisorOptions) {
		this.state = {
			taskId: options.taskId,
			target: options.target,
			currentStage: "recon",
			stageHistory: [{ stage: "recon", startedAt: Date.now() }],
			findings: [],
			assets: [],
			credentials: [],
			nextActions: [...STAGE_ACTIONS.recon],
			maxActions: options.maxActions ?? 100,
			actionCount: 0,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};
	}

	getState(): SupervisorState {
		return { ...this.state };
	}

	getCurrentStage(): AttackStage {
		return this.state.currentStage;
	}

	getNextActions(): string[] {
		return [...this.state.nextActions];
	}

	canContinue(): boolean {
		return (
			this.state.actionCount < this.state.maxActions &&
			this.state.currentStage !== "done"
		);
	}

	recordAction(action: string, result: unknown): void {
		this.state.actionCount++;
		this.state.updatedAt = Date.now();

		// Store result as observation
		const resultStr = JSON.stringify(result).slice(0, 500);
		const lastStage =
			this.state.stageHistory[this.state.stageHistory.length - 1];
		if (lastStage) lastStage.result = `${action}: ${resultStr}`;

		// Update assets/findings from result
		this.extractAssets(result);
		this.extractFindings(result);
		this.extractCredentials(result);
	}

	private extractAssets(result: unknown): void {
		if (!result || typeof result !== "object") return;
		const r = result as Record<string, unknown>;
		// Extract from subdomain results
		if (r.subdomains && Array.isArray(r.subdomains)) {
			for (const sub of r.subdomains) {
				this.state.assets.push({
					type: "subdomain",
					value: String(sub),
					tested: false,
				});
			}
		}
		// Extract from nmap results
		if (r.ports && Array.isArray(r.ports)) {
			for (const port of r.ports) {
				this.state.assets.push({
					type: "port",
					value: String(port),
					tested: false,
				});
			}
		}
	}

	private extractFindings(result: unknown): void {
		if (!result || typeof result !== "object") return;
		const r = result as Record<string, unknown>;
		if (r.findings && Array.isArray(r.findings)) {
			for (const f of r.findings) {
				const finding = f as {
					title?: string;
					severity?: string;
					evidence?: string;
				};
				this.state.findings.push({
					title: finding.title ?? "Unknown",
					severity: finding.severity ?? "info",
					evidence: finding.evidence ?? "",
				});
			}
		}
	}

	private extractCredentials(result: unknown): void {
		if (!result || typeof result !== "object") return;
		const r = result as Record<string, unknown>;
		if (r.credentials && Array.isArray(r.credentials)) {
			for (const c of r.credentials) {
				const cred = c as { user?: string; secret?: string; source?: string };
				this.state.credentials.push({
					user: cred.user ?? "unknown",
					secret: cred.secret ?? "",
					source: cred.source ?? "unknown",
				});
			}
		}
	}

	advanceStage(): {
		advanced: boolean;
		newStage: AttackStage;
		actions: string[];
	} {
		const currentIdx = STAGE_ORDER.indexOf(this.state.currentStage);
		if (currentIdx >= STAGE_ORDER.length - 1) {
			return {
				advanced: false,
				newStage: this.state.currentStage,
				actions: [],
			};
		}

		// Mark current stage as completed
		const lastStage =
			this.state.stageHistory[this.state.stageHistory.length - 1];
		if (lastStage) lastStage.completedAt = Date.now();

		// Advance to next stage
		const newStage = STAGE_ORDER[currentIdx + 1];
		this.state.currentStage = newStage;
		this.state.stageHistory.push({ stage: newStage, startedAt: Date.now() });
		this.state.nextActions = [...STAGE_ACTIONS[newStage]];
		this.state.updatedAt = Date.now();

		return { advanced: true, newStage, actions: this.state.nextActions };
	}

	// Determine if current stage is complete based on findings/assets
	isStageComplete(): boolean {
		const stage = this.state.currentStage;
		if (stage === "recon") {
			// Complete if we have assets discovered
			return this.state.assets.length > 0;
		}
		if (stage === "scan") {
			// Complete if we have findings or no vulns found
			return true; // Always proceed after scan
		}
		if (stage === "exploit") {
			// Complete if we have credentials or findings exploited
			return (
				this.state.credentials.length > 0 ||
				this.state.findings.some(
					(f) => f.severity === "critical" || f.severity === "high",
				)
			);
		}
		if (stage === "postex") {
			return true; // Always proceed after postex
		}
		if (stage === "report") {
			return true;
		}
		return false;
	}

	// Auto-advance if stage is complete
	autoAdvance(): {
		advanced: boolean;
		newStage: AttackStage;
		actions: string[];
	} | null {
		if (this.isStageComplete()) {
			return this.advanceStage();
		}
		return null;
	}

	addAsset(asset: { type: string; value: string }): void {
		this.state.assets.push({ ...asset, tested: false });
		this.state.updatedAt = Date.now();
	}

	addFinding(finding: {
		title: string;
		severity: string;
		evidence: string;
	}): void {
		this.state.findings.push(finding);
		this.state.updatedAt = Date.now();
	}

	addCredential(cred: { user: string; secret: string; source: string }): void {
		this.state.credentials.push(cred);
		this.state.updatedAt = Date.now();
	}

	getSummary(): string {
		return `Stage: ${this.state.currentStage} | Assets: ${this.state.assets.length} | Findings: ${this.state.findings.length} | Creds: ${this.state.credentials.length} | Actions: ${this.state.actionCount}/${this.state.maxActions}`;
	}
}
