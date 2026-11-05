// Multi-target campaign management

export interface CampaignTarget {
	id: string;
	value: string;
	type: string;
	status: "pending" | "running" | "completed" | "failed";
	findings: { title: string; severity: string }[];
	assets: { type: string; value: string; tested: boolean }[];
	startedAt?: number;
	completedAt?: number;
}

export interface Campaign {
	id: string;
	name: string;
	targets: CampaignTarget[];
	status: "active" | "paused" | "completed";
	createdAt: number;
	updatedAt: number;
	maxParallel: number;
}

export class CampaignManager {
	private campaigns = new Map<string, Campaign>();

	createCampaign(
		name: string,
		targets: { value: string; type: string }[],
		maxParallel = 3,
	): Campaign {
		const id = `campaign_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
		const campaign: Campaign = {
			id,
			name,
			targets: targets.map((t, i) => ({
				id: `target_${i}`,
				value: t.value,
				type: t.type,
				status: "pending",
				findings: [],
				assets: [],
			})),
			status: "active",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			maxParallel,
		};
		this.campaigns.set(id, campaign);
		return campaign;
	}

	getCampaign(id: string): Campaign | undefined {
		return this.campaigns.get(id);
	}

	listCampaigns(): Campaign[] {
		return [...this.campaigns.values()];
	}

	getNextTargets(campaignId: string, count?: number): CampaignTarget[] {
		const campaign = this.campaigns.get(campaignId);
		if (!campaign) return [];
		const n = count ?? campaign.maxParallel;
		return campaign.targets.filter((t) => t.status === "pending").slice(0, n);
	}

	markTargetRunning(campaignId: string, targetId: string): void {
		const campaign = this.campaigns.get(campaignId);
		if (!campaign) return;
		const target = campaign.targets.find((t) => t.id === targetId);
		if (target) {
			target.status = "running";
			target.startedAt = Date.now();
			campaign.updatedAt = Date.now();
		}
	}

	markTargetCompleted(
		campaignId: string,
		targetId: string,
		findings: { title: string; severity: string }[],
		assets: { type: string; value: string; tested: boolean }[],
	): void {
		const campaign = this.campaigns.get(campaignId);
		if (!campaign) return;
		const target = campaign.targets.find((t) => t.id === targetId);
		if (target) {
			target.status = "completed";
			target.findings = findings;
			target.assets = assets;
			target.completedAt = Date.now();
			campaign.updatedAt = Date.now();
		}
		// Check if all targets completed
		if (
			campaign.targets.every(
				(t) => t.status === "completed" || t.status === "failed",
			)
		) {
			campaign.status = "completed";
		}
	}

	markTargetFailed(campaignId: string, targetId: string): void {
		const campaign = this.campaigns.get(campaignId);
		if (!campaign) return;
		const target = campaign.targets.find((t) => t.id === targetId);
		if (target) {
			target.status = "failed";
			target.completedAt = Date.now();
			campaign.updatedAt = Date.now();
		}
	}

	getConsolidatedFindings(
		campaignId: string,
	): { title: string; severity: string; targets: string[] }[] {
		const campaign = this.campaigns.get(campaignId);
		if (!campaign) return [];
		const findingMap = new Map<
			string,
			{ title: string; severity: string; targets: string[] }
		>();
		for (const target of campaign.targets) {
			for (const f of target.findings) {
				const key = `${f.title}:${f.severity}`;
				if (!findingMap.has(key)) {
					findingMap.set(key, {
						title: f.title,
						severity: f.severity,
						targets: [],
					});
				}
				const entry = findingMap.get(key);
				if (entry) entry.targets.push(target.value);
			}
		}
		return [...findingMap.values()];
	}

	getCoverage(campaignId: string): {
		total: number;
		completed: number;
		failed: number;
		pending: number;
		running: number;
		findings: number;
	} {
		const campaign = this.campaigns.get(campaignId);
		if (!campaign)
			return {
				total: 0,
				completed: 0,
				failed: 0,
				pending: 0,
				running: 0,
				findings: 0,
			};
		return {
			total: campaign.targets.length,
			completed: campaign.targets.filter((t) => t.status === "completed")
				.length,
			failed: campaign.targets.filter((t) => t.status === "failed").length,
			pending: campaign.targets.filter((t) => t.status === "pending").length,
			running: campaign.targets.filter((t) => t.status === "running").length,
			findings: campaign.targets.reduce((sum, t) => sum + t.findings.length, 0),
		};
	}
}
