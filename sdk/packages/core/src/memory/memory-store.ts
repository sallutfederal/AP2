import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
	Memory,
	MemoryKind,
	MemoryQuery,
	MemoryStore,
} from "@cline/shared";
import {
	asOptionalString,
	asString,
	loadSqliteDb,
	type SqliteDb,
} from "@cline/shared/db";
import { resolveDbDataDir } from "@cline/shared/storage";

export interface SqliteMemoryStoreOptions {
	dbPath?: string;
	sessionsDir?: string;
}

const MEMORY_SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  agent_id TEXT,
  session_id TEXT,
  workspace_root TEXT,
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  summary TEXT,
  confidence REAL NOT NULL DEFAULT 1.0,
  source TEXT NOT NULL DEFAULT 'user',
  tags TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER,
  last_recalled_at INTEGER,
  recall_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(agent_id, session_id, workspace_root);
CREATE INDEX IF NOT EXISTS idx_memories_kind_key ON memories(kind, key);
CREATE INDEX IF NOT EXISTS idx_memories_updated ON memories(updated_at DESC);
`;

function ensureSchema(db: SqliteDb): void {
	db.exec(MEMORY_SCHEMA);
}

function rowToMemory(row: Record<string, unknown>): Memory {
	const tagsRaw = asOptionalString(row.tags);
	let tags: string[] | undefined;
	if (tagsRaw) {
		try {
			const parsed = JSON.parse(tagsRaw);
			if (Array.isArray(parsed)) tags = parsed as string[];
		} catch {
			tags = tagsRaw
				.split(",")
				.map((t) => t.trim())
				.filter(Boolean);
		}
	}
	return {
		id: asString(row.id),
		agentId: asOptionalString(row.agent_id),
		sessionId: asOptionalString(row.session_id),
		workspaceRoot: asOptionalString(row.workspace_root),
		kind: asString(row.kind) as MemoryKind,
		key: asString(row.key),
		value: asString(row.value),
		summary: asOptionalString(row.summary),
		confidence: Number(row.confidence ?? 1),
		source: asString(row.source) as Memory["source"],
		tags,
		createdAt: Number(row.created_at),
		updatedAt: Number(row.updated_at),
		expiresAt: row.expires_at == null ? undefined : Number(row.expires_at),
		lastRecalledAt:
			row.last_recalled_at == null ? undefined : Number(row.last_recalled_at),
		recallCount: Number(row.recall_count ?? 0),
	};
}

export class SqliteMemoryStore implements MemoryStore {
	private readonly dbPath: string;
	private db: SqliteDb | undefined;

	constructor(options: SqliteMemoryStoreOptions = {}) {
		this.dbPath =
			options.dbPath ??
			(options.sessionsDir
				? join(options.sessionsDir, "memory.db")
				: join(resolveDbDataDir(), "memory.db"));
	}

	init(): void {
		this.getRawDb();
	}

	getRawDb(): SqliteDb {
		if (this.db) return this.db;
		if (!existsSync(this.dbPath.split(/[/\\]/).slice(0, -1).join("/"))) {
			mkdirSync(this.dbPath.split(/[/\\]/).slice(0, -1).join("/"), {
				recursive: true,
			});
		}
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

	store(memory: Memory): Memory {
		const now = Date.now();
		const m: Memory = {
			...memory,
			createdAt: memory.createdAt || now,
			updatedAt: now,
			recallCount: memory.recallCount ?? 0,
			confidence: memory.confidence ?? 1,
		};
		this.run(
			`INSERT OR REPLACE INTO memories (
				id, agent_id, session_id, workspace_root, kind, key, value, summary,
				confidence, source, tags, created_at, updated_at, expires_at,
				last_recalled_at, recall_count
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				m.id,
				m.agentId ?? null,
				m.sessionId ?? null,
				m.workspaceRoot ?? null,
				m.kind,
				m.key,
				m.value,
				m.summary ?? null,
				m.confidence,
				m.source,
				m.tags ? JSON.stringify(m.tags) : null,
				m.createdAt,
				m.updatedAt,
				m.expiresAt ?? null,
				m.lastRecalledAt ?? null,
				m.recallCount,
			],
		);
		return m;
	}

	get(id: string): Memory | undefined {
		const row = this.queryOne<Record<string, unknown>>(
			`SELECT * FROM memories WHERE id = ?`,
			[id],
		);
		return row ? rowToMemory(row) : undefined;
	}

	findByKey(scope: {
		agentId?: string;
		sessionId?: string;
		workspaceRoot?: string;
		kind: MemoryKind;
		key: string;
	}): Memory | undefined {
		const rows = this.queryAll<Record<string, unknown>>(
			`SELECT * FROM memories WHERE kind = ? AND key = ?
			 AND (agent_id IS ? OR agent_id = ?)
			 AND (session_id IS ? OR session_id = ?)
			 AND (workspace_root IS ? OR workspace_root = ?)
			 ORDER BY updated_at DESC LIMIT 1`,
			[
				scope.kind,
				scope.key,
				scope.agentId ?? null,
				scope.agentId ?? null,
				scope.sessionId ?? null,
				scope.sessionId ?? null,
				scope.workspaceRoot ?? null,
				scope.workspaceRoot ?? null,
			],
		);
		return rows.length ? rowToMemory(rows[0]) : undefined;
	}

	query(q: MemoryQuery): Memory[] {
		const now = Date.now();
		const where: string[] = [];
		const params: unknown[] = [];
		if (q.agentId !== undefined) {
			where.push("agent_id = ?");
			params.push(q.agentId);
		}
		if (q.sessionId !== undefined) {
			where.push("session_id = ?");
			params.push(q.sessionId);
		}
		if (q.workspaceRoot !== undefined) {
			where.push("workspace_root = ?");
			params.push(q.workspaceRoot);
		}
		if (q.kinds?.length) {
			where.push(`kind IN (${q.kinds.map(() => "?").join(",")})`);
			params.push(...q.kinds);
		}
		if (q.keyPrefix) {
			where.push("key LIKE ?");
			params.push(`${q.keyPrefix}%`);
		}
		if (q.minConfidence !== undefined) {
			where.push("confidence >= ?");
			params.push(q.minConfidence);
		}
		if (!q.includeExpired) {
			where.push("(expires_at IS NULL OR expires_at > ?)");
			params.push(now);
		}
		let sql = "SELECT * FROM memories";
		if (where.length) sql += ` WHERE ${where.join(" AND ")}`;

		const rawQueryText = q.text?.trim();
		if (!rawQueryText) {
			sql += " ORDER BY updated_at DESC";
			if (q.limit) {
				sql += " LIMIT ?";
				params.push(q.limit);
			}
			const rows = this.queryAll<Record<string, unknown>>(sql, params);
			return rows.map(rowToMemory);
		}

		// Tokenized keyword search with relevance scoring so multi-word natural
		// language prompts (e.g. from beforeRun recall) match relevant memories.
		const stopwords = new Set([
			"para",
			"com",
			"uma",
			"como",
			"sobre",
			"que",
			"dos",
			"das",
			"nos",
			"nas",
			"por",
			"mais",
			"the",
			"and",
			"for",
			"with",
			"from",
			"this",
			"that",
		]);
		const tokens = [
			...new Set(
				rawQueryText
					.toLowerCase()
					.split(/[\s,.;:!?/\\|()[\]{}"'`]+/)
					.map((t) => t.trim())
					.filter((t) => t.length >= 3 && !stopwords.has(t)),
			),
		].slice(0, 12);

		const searchTerms = tokens.length > 0 ? tokens : [rawQueryText.toLowerCase()];
		const termClauses = searchTerms.map(
			() => "(LOWER(key) LIKE ? OR LOWER(value) LIKE ? OR LOWER(COALESCE(summary, '')) LIKE ? OR LOWER(COALESCE(tags, '')) LIKE ?)",
		);
		const textFilter = `(${termClauses.join(" OR ")})`;
		sql += where.length ? ` AND ${textFilter}` : ` WHERE ${textFilter}`;
		for (const term of searchTerms) {
			const like = `%${term}%`;
			params.push(like, like, like, like);
		}
		sql += " ORDER BY updated_at DESC LIMIT 200";

		const candidates = this.queryAll<Record<string, unknown>>(sql, params).map(
			rowToMemory,
		);
		const fullLower = rawQueryText.toLowerCase();
		const scored = candidates.map((m) => {
			const keyLower = m.key.toLowerCase();
			const valLower = m.value.toLowerCase();
			const sumLower = (m.summary ?? "").toLowerCase();
			const tagsLower = (m.tags ?? []).join(" ").toLowerCase();
			let score = m.confidence;
			if (keyLower.includes(fullLower) || valLower.includes(fullLower)) {
				score += 8;
			}
			for (const term of searchTerms) {
				if (keyLower.includes(term)) score += 4;
				if (tagsLower.includes(term)) score += 3;
				if (sumLower.includes(term)) score += 2;
				if (valLower.includes(term)) score += 2;
			}
			return { memory: m, score };
		});
		scored.sort(
			(a, b) => b.score - a.score || b.memory.updatedAt - a.memory.updatedAt,
		);
		const limit = q.limit ?? 25;
		return scored.slice(0, limit).map((s) => s.memory);
	}

	delete(id: string): boolean {
		const changes =
			this.run(`DELETE FROM memories WHERE id = ?`, [id]).changes ?? 0;
		return changes > 0;
	}

	clear(scope?: {
		agentId?: string;
		sessionId?: string;
		workspaceRoot?: string;
	}): number {
		const where: string[] = [];
		const params: unknown[] = [];
		if (scope?.agentId) {
			where.push("agent_id = ?");
			params.push(scope.agentId);
		}
		if (scope?.sessionId) {
			where.push("session_id = ?");
			params.push(scope.sessionId);
		}
		if (scope?.workspaceRoot) {
			where.push("workspace_root = ?");
			params.push(scope.workspaceRoot);
		}
		let sql = "DELETE FROM memories";
		if (where.length) sql += ` WHERE ${where.join(" AND ")}`;
		return this.run(sql, params).changes ?? 0;
	}

	count(scope?: {
		agentId?: string;
		sessionId?: string;
		workspaceRoot?: string;
	}): number {
		const where: string[] = [];
		const params: unknown[] = [];
		if (scope?.agentId) {
			where.push("agent_id = ?");
			params.push(scope.agentId);
		}
		if (scope?.sessionId) {
			where.push("session_id = ?");
			params.push(scope.sessionId);
		}
		if (scope?.workspaceRoot) {
			where.push("workspace_root = ?");
			params.push(scope.workspaceRoot);
		}
		let sql = "SELECT COUNT(*) as c FROM memories";
		if (where.length) sql += ` WHERE ${where.join(" AND ")}`;
		const row = this.queryOne<{ c: number }>(sql, params);
		return row?.c ?? 0;
	}
}
