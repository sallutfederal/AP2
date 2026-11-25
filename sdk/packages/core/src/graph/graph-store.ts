import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
	asOptionalString,
	asString,
	loadSqliteDb,
	type SqliteDb,
} from "@cline/shared/db";
import { resolveDbDataDir } from "@cline/shared/storage";

export interface SqliteGraphStoreOptions {
	dbPath?: string;
	sessionsDir?: string;
}

const GRAPH_SCHEMA = `
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  value TEXT NOT NULL,
  company TEXT,
  parent_id TEXT,
  tested INTEGER NOT NULL DEFAULT 0,
  tested_at INTEGER,
  finding_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assets_type ON assets(type);
CREATE INDEX IF NOT EXISTS idx_assets_parent ON assets(parent_id);
CREATE INDEX IF NOT EXISTS idx_assets_tested ON assets(tested);

CREATE TABLE IF NOT EXISTS exploration_nodes (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  parent_id TEXT,
  asset_id TEXT,
  result TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_explore_task ON exploration_nodes(task_id);
CREATE INDEX IF NOT EXISTS idx_explore_type ON exploration_nodes(type);
CREATE INDEX IF NOT EXISTS idx_explore_asset ON exploration_nodes(asset_id);

CREATE TABLE IF NOT EXISTS anchors (
  id TEXT PRIMARY KEY,
  exploration_node_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_anchors_node ON anchors(exploration_node_id);
CREATE INDEX IF NOT EXISTS idx_anchors_asset ON anchors(asset_id);

CREATE TABLE IF NOT EXISTS traces (
  id TEXT PRIMARY KEY,
  worker_id TEXT,
  task_id TEXT,
  intent_id TEXT,
  step_number INTEGER NOT NULL DEFAULT 0,
  command TEXT,
  output TEXT,
  observation TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_traces_worker ON traces(worker_id);
CREATE INDEX IF NOT EXISTS idx_traces_task ON traces(task_id);
CREATE INDEX IF NOT EXISTS idx_traces_intent ON traces(intent_id);
`;

function ensureSchema(db: SqliteDb): void {
	db.exec(GRAPH_SCHEMA);
}

export interface Asset {
	id: string;
	type: string;
	value: string;
	company?: string;
	parentId?: string;
	tested: boolean;
	testedAt?: number;
	findingCount: number;
	createdAt: number;
	updatedAt: number;
}

export interface ExplorationNode {
	id: string;
	taskId?: string;
	type: string;
	title: string;
	status: string;
	parentId?: string;
	assetId?: string;
	result?: string;
	createdAt: number;
	updatedAt: number;
}

export interface Anchor {
	id: string;
	explorationNodeId: string;
	assetId: string;
	createdAt: number;
}

export interface Trace {
	id: string;
	workerId?: string;
	taskId?: string;
	intentId?: string;
	stepNumber: number;
	command?: string;
	output?: string;
	observation?: string;
	createdAt: number;
}

export class SqliteGraphStore {
	private readonly dbPath: string;
	private db: SqliteDb | undefined;

	constructor(options: { dbPath?: string; sessionsDir?: string } = {}) {
		this.dbPath =
			options.dbPath ??
			(options.sessionsDir
				? join(options.sessionsDir, "graph.db")
				: join(resolveDbDataDir(), "graph.db"));
	}

	init(): void {
		this.getRawDb();
	}

	getRawDb(): SqliteDb {
		if (this.db) return this.db;
		const dir = this.dbPath.split(/[/\\]/).slice(0, -1).join("/");
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		const db = loadSqliteDb(this.dbPath);
		ensureSchema(db);
		this.db = db;
		return db;
	}

	close(): void {
		this.db?.close?.();
		this.db = undefined;
	}

	private run(sql: string, params: unknown[] = []): { changes?: number } {
		return this.getRawDb()
			.prepare(sql)
			.run(...params);
	}

	private queryOne<T>(sql: string, params: unknown[] = []): T | undefined {
		const row = this.getRawDb()
			.prepare(sql)
			.get(...params);
		return (row as T | null) ?? undefined;
	}

	private queryAll<T>(sql: string, params: unknown[] = []): T[] {
		return this.getRawDb()
			.prepare(sql)
			.all(...params) as T[];
	}

	// --- Assets ---
	addAsset(
		asset: Omit<Asset, "createdAt" | "updatedAt"> & { createdAt?: number },
	): Asset {
		const now = Date.now();
		const a: Asset = {
			...asset,
			createdAt: asset.createdAt ?? now,
			updatedAt: now,
		};
		this.run(
			`INSERT OR REPLACE INTO assets (id, type, value, company, parent_id, tested, tested_at, finding_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				a.id,
				a.type,
				a.value,
				a.company ?? null,
				a.parentId ?? null,
				a.tested ? 1 : 0,
				a.testedAt ?? null,
				a.findingCount,
				a.createdAt,
				a.updatedAt,
			],
		);
		return a;
	}

	getAsset(id: string): Asset | undefined {
		const row = this.queryOne<Record<string, unknown>>(
			`SELECT * FROM assets WHERE id = ?`,
			[id],
		);
		if (!row) return undefined;
		return {
			id: asString(row.id),
			type: asString(row.type),
			value: asString(row.value),
			company: asOptionalString(row.company),
			parentId: asOptionalString(row.parent_id),
			tested: Number(row.tested ?? 0) === 1,
			testedAt: row.tested_at == null ? undefined : Number(row.tested_at),
			findingCount: Number(row.finding_count ?? 0),
			createdAt: Number(row.created_at),
			updatedAt: Number(row.updated_at),
		};
	}

	listAssets(type?: string, tested?: boolean): Asset[] {
		let sql = `SELECT * FROM assets WHERE 1=1`;
		const params: unknown[] = [];
		if (type) {
			sql += ` AND type = ?`;
			params.push(type);
		}
		if (tested !== undefined) {
			sql += ` AND tested = ?`;
			params.push(tested ? 1 : 0);
		}
		sql += ` ORDER BY created_at DESC`;
		const rows = this.queryAll<Record<string, unknown>>(sql, params);
		return rows.map((r) => ({
			id: asString(r.id),
			type: asString(r.type),
			value: asString(r.value),
			company: asOptionalString(r.company),
			parentId: asOptionalString(r.parent_id),
			tested: Number(r.tested ?? 0) === 1,
			testedAt: r.tested_at == null ? undefined : Number(r.tested_at),
			findingCount: Number(r.finding_count ?? 0),
			createdAt: Number(r.created_at),
			updatedAt: Number(r.updated_at),
		}));
	}

	markTested(id: string, findingCount = 0): void {
		this.run(
			`UPDATE assets SET tested = 1, tested_at = ?, finding_count = ?, updated_at = ? WHERE id = ?`,
			[Date.now(), findingCount, Date.now(), id],
		);
	}

	getCoverage(): {
		total: number;
		tested: number;
		untested: number;
		findings: number;
		byType: Record<string, { total: number; tested: number }>;
	} {
		const all = this.listAssets();
		const byType: Record<string, { total: number; tested: number }> = {};
		for (const a of all) {
			if (!byType[a.type]) byType[a.type] = { total: 0, tested: 0 };
			byType[a.type].total++;
			if (a.tested) byType[a.type].tested++;
		}
		return {
			total: all.length,
			tested: all.filter((a) => a.tested).length,
			untested: all.filter((a) => !a.tested).length,
			findings: all.reduce((sum, a) => sum + a.findingCount, 0),
			byType,
		};
	}

	// --- Exploration nodes ---
	addNode(
		node: Omit<ExplorationNode, "createdAt" | "updatedAt"> & {
			createdAt?: number;
		},
	): ExplorationNode {
		const now = Date.now();
		const n: ExplorationNode = {
			...node,
			createdAt: node.createdAt ?? now,
			updatedAt: now,
		};
		this.run(
			`INSERT OR REPLACE INTO exploration_nodes (id, task_id, type, title, status, parent_id, asset_id, result, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				n.id,
				n.taskId ?? null,
				n.type,
				n.title,
				n.status,
				n.parentId ?? null,
				n.assetId ?? null,
				n.result ?? null,
				n.createdAt,
				n.updatedAt,
			],
		);
		return n;
	}

	getNode(id: string): ExplorationNode | undefined {
		const row = this.queryOne<Record<string, unknown>>(
			`SELECT * FROM exploration_nodes WHERE id = ?`,
			[id],
		);
		if (!row) return undefined;
		return {
			id: asString(row.id),
			taskId: asOptionalString(row.task_id),
			type: asString(row.type),
			title: asString(row.title),
			status: asString(row.status),
			parentId: asOptionalString(row.parent_id),
			assetId: asOptionalString(row.asset_id),
			result: asOptionalString(row.result),
			createdAt: Number(row.created_at),
			updatedAt: Number(row.updated_at),
		};
	}

	listNodes(taskId?: string, type?: string): ExplorationNode[] {
		let sql = `SELECT * FROM exploration_nodes WHERE 1=1`;
		const params: unknown[] = [];
		if (taskId) {
			sql += ` AND task_id = ?`;
			params.push(taskId);
		}
		if (type) {
			sql += ` AND type = ?`;
			params.push(type);
		}
		sql += ` ORDER BY created_at DESC`;
		const rows = this.queryAll<Record<string, unknown>>(sql, params);
		return rows.map((r) => ({
			id: asString(r.id),
			taskId: asOptionalString(r.task_id),
			type: asString(r.type),
			title: asString(r.title),
			status: asString(r.status),
			parentId: asOptionalString(r.parent_id),
			assetId: asOptionalString(r.asset_id),
			result: asOptionalString(r.result),
			createdAt: Number(r.created_at),
			updatedAt: Number(r.updated_at),
		}));
	}

	updateNode(id: string, updates: Partial<ExplorationNode>): void {
		const node = this.getNode(id);
		if (!node) return;
		const merged = { ...node, ...updates, updatedAt: Date.now() };
		this.run(
			`UPDATE exploration_nodes SET task_id=?, type=?, title=?, status=?, parent_id=?, asset_id=?, result=?, updated_at=? WHERE id=?`,
			[
				merged.taskId ?? null,
				merged.type,
				merged.title,
				merged.status,
				merged.parentId ?? null,
				merged.assetId ?? null,
				merged.result ?? null,
				merged.updatedAt,
				id,
			],
		);
	}

	// --- Anchors ---
	addAnchor(explorationNodeId: string, assetId: string): Anchor {
		const id = `anchor_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
		const now = Date.now();
		this.run(
			`INSERT INTO anchors (id, exploration_node_id, asset_id, created_at) VALUES (?, ?, ?, ?)`,
			[id, explorationNodeId, assetId, now],
		);
		return { id, explorationNodeId, assetId, createdAt: now };
	}

	getAnchorsForAsset(assetId: string): Anchor[] {
		const rows = this.queryAll<Record<string, unknown>>(
			`SELECT * FROM anchors WHERE asset_id = ?`,
			[assetId],
		);
		return rows.map((r) => ({
			id: asString(r.id),
			explorationNodeId: asString(r.exploration_node_id),
			assetId: asString(r.asset_id),
			createdAt: Number(r.created_at),
		}));
	}

	getAnchorsForNode(nodeId: string): Anchor[] {
		const rows = this.queryAll<Record<string, unknown>>(
			`SELECT * FROM anchors WHERE exploration_node_id = ?`,
			[nodeId],
		);
		return rows.map((r) => ({
			id: asString(r.id),
			explorationNodeId: asString(r.exploration_node_id),
			assetId: asString(r.asset_id),
			createdAt: Number(r.created_at),
		}));
	}

	// --- Traces (trace sharing) ---
	addTrace(
		trace: Omit<Trace, "id" | "createdAt"> & {
			id?: string;
			createdAt?: number;
		},
	): Trace {
		const id =
			trace.id ??
			`trace_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
		const now = trace.createdAt ?? Date.now();
		const t: Trace = {
			id,
			workerId: trace.workerId,
			taskId: trace.taskId,
			intentId: trace.intentId,
			stepNumber: trace.stepNumber,
			command: trace.command,
			output: trace.output,
			observation: trace.observation,
			createdAt: now,
		};
		this.run(
			`INSERT INTO traces (id, worker_id, task_id, intent_id, step_number, command, output, observation, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				t.id,
				t.workerId ?? null,
				t.taskId ?? null,
				t.intentId ?? null,
				t.stepNumber,
				t.command ?? null,
				t.output ?? null,
				t.observation ?? null,
				t.createdAt,
			],
		);
		return t;
	}

	searchTraces(query: string, excludeWorkerId?: string, limit = 20): Trace[] {
		const rows = this.queryAll<Record<string, unknown>>(
			`SELECT * FROM traces WHERE (command LIKE ? OR output LIKE ? OR observation LIKE ?) ${excludeWorkerId ? "AND worker_id != ?" : ""} ORDER BY created_at DESC LIMIT ?`,
			excludeWorkerId
				? [`%${query}%`, `%${query}%`, `%${query}%`, excludeWorkerId, limit]
				: [`%${query}%`, `%${query}%`, `%${query}%`, limit],
		);
		return rows.map((r) => ({
			id: asString(r.id),
			workerId: asOptionalString(r.worker_id),
			taskId: asOptionalString(r.task_id),
			intentId: asOptionalString(r.intent_id),
			stepNumber: Number(r.step_number ?? 0),
			command: asOptionalString(r.command),
			output: asOptionalString(r.output),
			observation: asOptionalString(r.observation),
			createdAt: Number(r.created_at),
		}));
	}

	getTracesByIntent(intentId: string): Trace[] {
		const rows = this.queryAll<Record<string, unknown>>(
			`SELECT * FROM traces WHERE intent_id = ? ORDER BY step_number ASC`,
			[intentId],
		);
		return rows.map((r) => ({
			id: asString(r.id),
			workerId: asOptionalString(r.worker_id),
			taskId: asOptionalString(r.task_id),
			intentId: asOptionalString(r.intent_id),
			stepNumber: Number(r.step_number ?? 0),
			command: asOptionalString(r.command),
			output: asOptionalString(r.output),
			observation: asOptionalString(r.observation),
			createdAt: Number(r.created_at),
		}));
	}

	getTracesByTask(taskId: string, limit = 50): Trace[] {
		const rows = this.queryAll<Record<string, unknown>>(
			`SELECT * FROM traces WHERE task_id = ? ORDER BY created_at DESC LIMIT ?`,
			[taskId, limit],
		);
		return rows.map((r) => ({
			id: asString(r.id),
			workerId: asOptionalString(r.worker_id),
			taskId: asOptionalString(r.task_id),
			intentId: asOptionalString(r.intent_id),
			stepNumber: Number(r.step_number ?? 0),
			command: asOptionalString(r.command),
			output: asOptionalString(r.output),
			observation: asOptionalString(r.observation),
			createdAt: Number(r.created_at),
		}));
	}
}
