import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { asString, loadSqliteDb, type SqliteDb } from "@cline/shared/db";
import { resolveDbDataDir } from "@cline/shared/storage";

export interface SqlitePlanStoreOptions {
	dbPath?: string;
	sessionsDir?: string;
}

const PLAN_SCHEMA = `
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  goal TEXT NOT NULL,
  target TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'full',
  status TEXT NOT NULL DEFAULT 'active',
  steps TEXT NOT NULL,
  current_index INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plans_status ON plans(status);
CREATE INDEX IF NOT EXISTS idx_plans_target ON plans(target);
`;

function ensureSchema(db: SqliteDb): void {
	db.exec(PLAN_SCHEMA);
}

export interface PersistedPlan {
	id: string;
	goal: string;
	target: string;
	mode: string;
	status: string;
	steps: string; // JSON
	currentIndex: number;
	createdAt: number;
	updatedAt: number;
}

export class SqlitePlanStore {
	private readonly dbPath: string;
	private db: SqliteDb | undefined;

	constructor(options: SqlitePlanStoreOptions = {}) {
		this.dbPath =
			options.dbPath ??
			(options.sessionsDir
				? join(options.sessionsDir, "plans.db")
				: join(resolveDbDataDir(), "plans.db"));
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

	save(plan: PersistedPlan): void {
		this.run(
			`INSERT OR REPLACE INTO plans (id, goal, target, mode, status, steps, current_index, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				plan.id,
				plan.goal,
				plan.target,
				plan.mode,
				plan.status,
				plan.steps,
				plan.currentIndex,
				plan.createdAt,
				plan.updatedAt,
			],
		);
	}

	get(id: string): PersistedPlan | undefined {
		const row = this.queryOne<Record<string, unknown>>(
			`SELECT * FROM plans WHERE id = ?`,
			[id],
		);
		if (!row) return undefined;
		return {
			id: asString(row.id),
			goal: asString(row.goal),
			target: asString(row.target),
			mode: asString(row.mode),
			status: asString(row.status),
			steps: asString(row.steps),
			currentIndex: Number(row.current_index ?? 0),
			createdAt: Number(row.created_at),
			updatedAt: Number(row.updated_at),
		};
	}

	list(): PersistedPlan[] {
		const rows = this.queryAll<Record<string, unknown>>(
			`SELECT * FROM plans ORDER BY updated_at DESC`,
		);
		return rows.map((r) => ({
			id: asString(r.id),
			goal: asString(r.goal),
			target: asString(r.target),
			mode: asString(r.mode),
			status: asString(r.status),
			steps: asString(r.steps),
			currentIndex: Number(r.current_index ?? 0),
			createdAt: Number(r.created_at),
			updatedAt: Number(r.updated_at),
		}));
	}

	delete(id: string): boolean {
		const changes =
			this.run(`DELETE FROM plans WHERE id = ?`, [id]).changes ?? 0;
		return changes > 0;
	}
}
