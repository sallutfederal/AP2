import type { SqliteGraphStore } from "./graph-store";

export interface GraphServiceOptions {
	store: SqliteGraphStore;
	taskId?: string;
	workerId?: string;
}

export class GraphService {
	private readonly store: SqliteGraphStore;
	private readonly taskId?: string;
	private readonly workerId?: string;

	constructor(options: GraphServiceOptions) {
		this.store = options.store;
		this.taskId = options.taskId;
		this.workerId = options.workerId;
	}

	// --- Assets ---
	addAsset(asset: {
		id: string;
		type: string;
		value: string;
		company?: string;
		parentId?: string;
	}) {
		return this.store.addAsset({ ...asset, tested: false, findingCount: 0 });
	}

	listAssets(type?: string, tested?: boolean) {
		return this.store.listAssets(type, tested);
	}

	markTested(id: string, findingCount?: number) {
		this.store.markTested(id, findingCount);
	}

	getCoverage() {
		return this.store.getCoverage();
	}

	// --- Exploration nodes ---
	addNode(node: {
		id: string;
		type: string;
		title: string;
		status?: string;
		parentId?: string;
		assetId?: string;
	}) {
		return this.store.addNode({
			...node,
			taskId: this.taskId,
			status: node.status ?? "pending",
		});
	}

	listNodes(type?: string) {
		return this.store.listNodes(this.taskId, type);
	}

	updateNode(
		id: string,
		updates: { status?: string; result?: string; title?: string },
	) {
		this.store.updateNode(id, updates);
	}

	// --- Anchors ---
	anchor(explorationNodeId: string, assetId: string) {
		return this.store.addAnchor(explorationNodeId, assetId);
	}

	// --- Traces ---
	logTrace(trace: {
		intentId?: string;
		stepNumber?: number;
		command?: string;
		output?: string;
		observation?: string;
	}) {
		return this.store.addTrace({
			...trace,
			workerId: this.workerId,
			taskId: this.taskId,
			stepNumber: trace.stepNumber ?? 0,
		});
	}

	searchTraces(query: string, excludeSelf = true) {
		return this.store.searchTraces(
			query,
			excludeSelf ? this.workerId : undefined,
		);
	}

	getTracesByIntent(intentId: string) {
		return this.store.getTracesByIntent(intentId);
	}

	getTracesByTask(limit?: number) {
		return this.taskId ? this.store.getTracesByTask(this.taskId, limit) : [];
	}
}
