import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { asString, loadSqliteDb, type SqliteDb } from "@cline/shared/db";
import { resolveDbDataDir } from "@cline/shared/storage";

export interface SqliteTodoStoreOptions {
	dbPath?: string;
	sessionsDir?: string;
}

const TODO_SCHEMA = `
CREATE TABLE IF NOT EXISTS todo_items (
  id TEXT PRIMARY KEY,
  target TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  order_index INTEGER NOT NULL DEFAULT 0,
  prereq_id TEXT,
  required_fact TEXT,
  intent_id TEXT,
  result TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_todo_target ON todo_items(target);
CREATE INDEX IF NOT EXISTS idx_todo_status ON todo_items(status);
`;

function ensureSchema(db: SqliteDb): void {
	db.exec(TODO_SCHEMA);
}

export type TodoStatus = "pending" | "in_progress" | "done" | "blocked";

export interface TodoItem {
	id: string;
	target: string;
	title: string;
	status: TodoStatus;
	orderIndex: number;
	prereqId: string | null;
	requiredFact: string | null;
	intentId: string | null;
	result: string | null;
	createdAt: number;
	updatedAt: number;
}

export interface NewTodoItem {
	target: string;
	title: string;
	prereqId?: string | null;
	requiredFact?: string | null;
	orderIndex?: number;
}

export class SqliteTodoStore {
	private readonly dbPath: string;
	private db: SqliteDb | undefined;

	constructor(options: SqliteTodoStoreOptions = {}) {
		this.dbPath =
			options.dbPath ??
			(options.sessionsDir
				? join(options.sessionsDir, "todos.db")
				: join(resolveDbDataDir(), "todos.db"));
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

	private rowToItem(row: Record<string, unknown>): TodoItem {
		return {
			id: asString(row.id),
			target: asString(row.target),
			title: asString(row.title),
			status: asString(row.status) as TodoStatus,
			orderIndex: Number(row.order_index ?? 0),
			prereqId: row.prereq_id == null ? null : asString(row.prereq_id),
			requiredFact:
				row.required_fact == null ? null : asString(row.required_fact),
			intentId: row.intent_id == null ? null : asString(row.intent_id),
			result: row.result == null ? null : asString(row.result),
			createdAt: Number(row.created_at),
			updatedAt: Number(row.updated_at),
		};
	}

	add(item: NewTodoItem): string {
		const id = `todo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const now = Date.now();
		this.run(
			`INSERT INTO todo_items (id, target, title, status, order_index, prereq_id, required_fact, intent_id, result, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?, ?, NULL, NULL, ?, ?)`,
			[
				id,
				item.target,
				item.title,
				item.orderIndex ?? 0,
				item.prereqId ?? null,
				item.requiredFact ?? null,
				now,
				now,
			],
		);
		return id;
	}

	list(target: string): TodoItem[] {
		const rows = this.queryAll<Record<string, unknown>>(
			`SELECT * FROM todo_items WHERE target = ? ORDER BY order_index ASC, created_at ASC`,
			[target],
		);
		return rows.map((r) => this.rowToItem(r));
	}

	get(id: string): TodoItem | undefined {
		const row = this.queryOne<Record<string, unknown>>(
			`SELECT * FROM todo_items WHERE id = ?`,
			[id],
		);
		return row ? this.rowToItem(row) : undefined;
	}

	// Returns the first pending item whose prerequisite is done and whose
	// required fact exists (if specified). factExists is supplied by the caller
	// (typically backed by the graph store).
	nextReady(
		target: string,
		factExists: (fact: string) => boolean = () => true,
	): TodoItem | undefined {
		const items = this.list(target);
		const byId = new Map(items.map((i) => [i.id, i]));
		for (const item of items) {
			if (item.status !== "pending") continue;
			if (item.prereqId) {
				const prereq = byId.get(item.prereqId);
				if (!prereq || prereq.status !== "done") continue;
			}
			if (item.requiredFact && !factExists(item.requiredFact)) continue;
			return item;
		}
		return undefined;
	}

	markInProgress(id: string, intentId?: string): void {
		const now = Date.now();
		this.run(
			`UPDATE todo_items SET status = 'in_progress', intent_id = COALESCE(?, intent_id), updated_at = ? WHERE id = ?`,
			[intentId ?? null, now, id],
		);
	}

	markDone(id: string, result?: string): void {
		const now = Date.now();
		this.run(
			`UPDATE todo_items SET status = 'done', result = COALESCE(?, result), updated_at = ? WHERE id = ?`,
			[result ?? null, now, id],
		);
	}

	markBlocked(id: string, reason: string): void {
		const now = Date.now();
		this.run(
			`UPDATE todo_items SET status = 'blocked', result = ?, updated_at = ? WHERE id = ?`,
			[reason, now, id],
		);
	}

	clear(target: string): number {
		return (
			this.run(`DELETE FROM todo_items WHERE target = ?`, [target]).changes ?? 0
		);
	}
}
