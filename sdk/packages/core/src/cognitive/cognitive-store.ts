import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
	asOptionalString,
	asString,
	loadSqliteDb,
	type SqliteDb,
} from "@cline/shared/db";
import { resolveDbDataDir } from "@cline/shared/storage";

export interface SqliteCognitiveStoreOptions {
	dbPath?: string;
	sessionsDir?: string;
}

const COGNITIVE_SCHEMA = `
CREATE TABLE IF NOT EXISTS user_profile (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL DEFAULT 'Zyon',
  preferred_language TEXT NOT NULL DEFAULT 'pt',
  engagement_level REAL NOT NULL DEFAULT 0.5,
  frustration_level REAL NOT NULL DEFAULT 0.0,
  excitement_level REAL NOT NULL DEFAULT 0.5,
  confidence_level REAL NOT NULL DEFAULT 0.5,
  total_commands INTEGER NOT NULL DEFAULT 0,
  total_wait_ms INTEGER NOT NULL DEFAULT 0,
  avg_wait_ms REAL NOT NULL DEFAULT 0,
  last_interaction_at INTEGER,
  identity_notes TEXT
);
INSERT OR IGNORE INTO user_profile (id, name) VALUES (1, 'Zyon');

CREATE TABLE IF NOT EXISTS command_stats (
  command TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  total_ms INTEGER NOT NULL DEFAULT 0,
  avg_ms REAL NOT NULL DEFAULT 0,
  last_used_at INTEGER,
  success_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS memory_links (
  id TEXT PRIMARY KEY,
  from_key TEXT NOT NULL,
  to_key TEXT NOT NULL,
  relation TEXT NOT NULL DEFAULT 'related',
  weight REAL NOT NULL DEFAULT 1.0,
  created_at INTEGER NOT NULL,
  last_traversed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_memlinks_from ON memory_links(from_key);
CREATE INDEX IF NOT EXISTS idx_memlinks_to ON memory_links(to_key);

CREATE TABLE IF NOT EXISTS context_entries (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  importance REAL NOT NULL DEFAULT 0.5,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ctx_session ON context_entries(session_id);

CREATE TABLE IF NOT EXISTS predictions (
  id TEXT PRIMARY KEY,
  predicted_request TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.5,
  based_on TEXT,
  created_at INTEGER NOT NULL,
  fulfilled INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS reflections (
  id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  insight TEXT NOT NULL,
  useful INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
`;

function ensureSchema(db: SqliteDb): void {
	db.exec(COGNITIVE_SCHEMA);
}

export interface UserProfile {
	name: string;
	preferredLanguage: string;
	engagementLevel: number;
	frustrationLevel: number;
	excitementLevel: number;
	confidenceLevel: number;
	totalCommands: number;
	totalWaitMs: number;
	avgWaitMs: number;
	lastInteractionAt?: number;
	identityNotes?: string;
}

export interface CommandStat {
	command: string;
	count: number;
	totalMs: number;
	avgMs: number;
	lastUsedAt?: number;
	successCount: number;
	failureCount: number;
}

export interface MemoryLink {
	id: string;
	fromKey: string;
	toKey: string;
	relation: string;
	weight: number;
	createdAt: number;
	lastTraversedAt?: number;
}

export interface ContextEntry {
	id: string;
	sessionId?: string;
	role: string;
	content: string;
	importance: number;
	createdAt: number;
}

export interface Prediction {
	id: string;
	predictedRequest: string;
	confidence: number;
	basedOn?: string;
	createdAt: number;
	fulfilled: boolean;
}

export interface Reflection {
	id: string;
	topic: string;
	insight: string;
	useful: boolean;
	createdAt: number;
}

export class SqliteCognitiveStore {
	private readonly dbPath: string;
	private db: SqliteDb | undefined;

	constructor(options: SqliteCognitiveStoreOptions = {}) {
		this.dbPath =
			options.dbPath ??
			(options.sessionsDir
				? join(options.sessionsDir, "cognitive.db")
				: join(resolveDbDataDir(), "cognitive.db"));
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

	// --- User profile ---
	getProfile(): UserProfile {
		const row = this.queryOne<Record<string, unknown>>(
			`SELECT * FROM user_profile WHERE id = 1`,
		);
		return {
			name: asString(row?.name ?? "Zyon"),
			preferredLanguage: asString(row?.preferred_language ?? "pt"),
			engagementLevel: Number(row?.engagement_level ?? 0.5),
			frustrationLevel: Number(row?.frustration_level ?? 0),
			excitementLevel: Number(row?.excitement_level ?? 0.5),
			confidenceLevel: Number(row?.confidence_level ?? 0.5),
			totalCommands: Number(row?.total_commands ?? 0),
			totalWaitMs: Number(row?.total_wait_ms ?? 0),
			avgWaitMs: Number(row?.avg_wait_ms ?? 0),
			lastInteractionAt:
				row?.last_interaction_at == null
					? undefined
					: Number(row.last_interaction_at),
			identityNotes: asOptionalString(row?.identity_notes),
		};
	}

	updateProfile(updates: Partial<UserProfile>): UserProfile {
		const current = this.getProfile();
		const merged = { ...current, ...updates };
		this.run(
			`UPDATE user_profile SET name=?, preferred_language=?, engagement_level=?, frustration_level=?, excitement_level=?, confidence_level=?, total_commands=?, total_wait_ms=?, avg_wait_ms=?, last_interaction_at=?, identity_notes=? WHERE id=1`,
			[
				merged.name,
				merged.preferredLanguage,
				merged.engagementLevel,
				merged.frustrationLevel,
				merged.excitementLevel,
				merged.confidenceLevel,
				merged.totalCommands,
				merged.totalWaitMs,
				merged.avgWaitMs,
				merged.lastInteractionAt ?? null,
				merged.identityNotes ?? null,
			],
		);
		return merged;
	}

	recordCommand(command: string, durationMs: number, success: boolean): void {
		const now = Date.now();
		const existing = this.queryOne<Record<string, unknown>>(
			`SELECT * FROM command_stats WHERE command = ?`,
			[command],
		);
		if (existing) {
			const count = Number(existing.count ?? 0) + 1;
			const totalMs = Number(existing.total_ms ?? 0) + durationMs;
			this.run(
				`UPDATE command_stats SET count=?, total_ms=?, avg_ms=?, last_used_at=?, success_count=?, failure_count=? WHERE command=?`,
				[
					count,
					totalMs,
					totalMs / count,
					now,
					Number(existing.success_count ?? 0) + (success ? 1 : 0),
					Number(existing.failure_count ?? 0) + (success ? 0 : 1),
					command,
				],
			);
		} else {
			this.run(
				`INSERT INTO command_stats (command, count, total_ms, avg_ms, last_used_at, success_count, failure_count) VALUES (?, ?, ?, ?, ?, ?, ?)`,
				[
					command,
					1,
					durationMs,
					durationMs,
					now,
					success ? 1 : 0,
					success ? 0 : 1,
				],
			);
		}
		const profile = this.getProfile();
		const newTotal = profile.totalCommands + 1;
		const newWait = profile.totalWaitMs + durationMs;
		this.updateProfile({
			totalCommands: newTotal,
			totalWaitMs: newWait,
			avgWaitMs: newWait / newTotal,
			lastInteractionAt: now,
		});
	}

	getCommandStats(limit = 20): CommandStat[] {
		const rows = this.queryAll<Record<string, unknown>>(
			`SELECT * FROM command_stats ORDER BY count DESC LIMIT ?`,
			[limit],
		);
		return rows.map((r) => ({
			command: asString(r.command),
			count: Number(r.count ?? 0),
			totalMs: Number(r.total_ms ?? 0),
			avgMs: Number(r.avg_ms ?? 0),
			lastUsedAt: r.last_used_at == null ? undefined : Number(r.last_used_at),
			successCount: Number(r.success_count ?? 0),
			failureCount: Number(r.failure_count ?? 0),
		}));
	}

	getTopCommands(limit = 5): CommandStat[] {
		return this.getCommandStats(limit);
	}

	// --- Memory links ---
	createLink(
		fromKey: string,
		toKey: string,
		relation = "related",
		weight = 1.0,
	): MemoryLink {
		const id = `link_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
		const now = Date.now();
		this.run(
			`INSERT INTO memory_links (id, from_key, to_key, relation, weight, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
			[id, fromKey, toKey, relation, weight, now],
		);
		return { id, fromKey, toKey, relation, weight, createdAt: now };
	}

	getLinks(key: string): MemoryLink[] {
		const rows = this.queryAll<Record<string, unknown>>(
			`SELECT * FROM memory_links WHERE from_key = ? OR to_key = ?`,
			[key, key],
		);
		return rows.map((r) => ({
			id: asString(r.id),
			fromKey: asString(r.from_key),
			toKey: asString(r.to_key),
			relation: asString(r.relation),
			weight: Number(r.weight ?? 1),
			createdAt: Number(r.created_at),
			lastTraversedAt:
				r.last_traversed_at == null ? undefined : Number(r.last_traversed_at),
		}));
	}

	traverseLink(id: string): void {
		this.run(`UPDATE memory_links SET last_traversed_at = ? WHERE id = ?`, [
			Date.now(),
			id,
		]);
	}

	// --- Context entries ---
	addContext(
		sessionId: string | undefined,
		role: string,
		content: string,
		importance = 0.5,
	): void {
		const id = `ctx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
		this.run(
			`INSERT INTO context_entries (id, session_id, role, content, importance, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
			[id, sessionId ?? null, role, content, importance, Date.now()],
		);
	}

	getContext(sessionId: string | undefined, limit = 50): ContextEntry[] {
		const rows = this.queryAll<Record<string, unknown>>(
			sessionId
				? `SELECT * FROM context_entries WHERE session_id = ? ORDER BY created_at DESC LIMIT ?`
				: `SELECT * FROM context_entries ORDER BY created_at DESC LIMIT ?`,
			sessionId ? [sessionId, limit] : [limit],
		);
		return rows.map((r) => ({
			id: asString(r.id),
			sessionId: asOptionalString(r.session_id),
			role: asString(r.role),
			content: asString(r.content),
			importance: Number(r.importance ?? 0.5),
			createdAt: Number(r.created_at),
		}));
	}

	// --- Predictions ---
	addPrediction(
		predictedRequest: string,
		confidence: number,
		basedOn?: string,
	): Prediction {
		const id = `pred_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
		const now = Date.now();
		this.run(
			`INSERT INTO predictions (id, predicted_request, confidence, based_on, created_at) VALUES (?, ?, ?, ?, ?)`,
			[id, predictedRequest, confidence, basedOn ?? null, now],
		);
		return {
			id,
			predictedRequest,
			confidence,
			basedOn,
			createdAt: now,
			fulfilled: false,
		};
	}

	getPredictions(limit = 10): Prediction[] {
		const rows = this.queryAll<Record<string, unknown>>(
			`SELECT * FROM predictions ORDER BY created_at DESC LIMIT ?`,
			[limit],
		);
		return rows.map((r) => ({
			id: asString(r.id),
			predictedRequest: asString(r.predicted_request),
			confidence: Number(r.confidence ?? 0.5),
			basedOn: asOptionalString(r.based_on),
			createdAt: Number(r.created_at),
			fulfilled: Number(r.fulfilled ?? 0) === 1,
		}));
	}

	fulfillPrediction(id: string): void {
		this.run(`UPDATE predictions SET fulfilled = 1 WHERE id = ?`, [id]);
	}

	// --- Reflections ---
	addReflection(topic: string, insight: string, useful = true): Reflection {
		const id = `refl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
		const now = Date.now();
		this.run(
			`INSERT INTO reflections (id, topic, insight, useful, created_at) VALUES (?, ?, ?, ?, ?)`,
			[id, topic, insight, useful ? 1 : 0, now],
		);
		return { id, topic, insight, useful, createdAt: now };
	}

	getReflections(limit = 20): Reflection[] {
		const rows = this.queryAll<Record<string, unknown>>(
			`SELECT * FROM reflections ORDER BY created_at DESC LIMIT ?`,
			[limit],
		);
		return rows.map((r) => ({
			id: asString(r.id),
			topic: asString(r.topic),
			insight: asString(r.insight),
			useful: Number(r.useful ?? 1) === 1,
			createdAt: Number(r.created_at),
		}));
	}

	// --- Emotional state helpers ---
	updateEmotion(
		emotion: "engagement" | "frustration" | "excitement" | "confidence",
		value: number,
	): void {
		const clamped = Math.max(0, Math.min(1, value));
		const profile = this.getProfile();
		const updates: Partial<UserProfile> = {};
		switch (emotion) {
			case "engagement":
				updates.engagementLevel = clamped;
				break;
			case "frustration":
				updates.frustrationLevel = clamped;
				break;
			case "excitement":
				updates.excitementLevel = clamped;
				break;
			case "confidence":
				updates.confidenceLevel = clamped;
				break;
		}
		this.updateProfile(updates);
		// also store in identity notes for cross-session
		const notes = profile.identityNotes ?? "";
		if (!notes.includes(`emotion:${emotion}`)) {
			this.updateProfile({
				identityNotes: `${notes}\nemotion:${emotion}=${clamped}`.trim(),
			});
		}
	}

	// --- Prediction based on command patterns ---
	predictNext(topCommands: string[]): Prediction {
		// Simple heuristic: if user often runs recon then scan, predict next likely step
		const patterns: Record<string, string> = {
			rt_nmap: "rt_nuclei",
			rt_subfinder: "rt_httpx",
			rt_httpx: "rt_whatweb",
			rt_vuln_scan: "rt_auto_exploit",
			rt_auto_exploit: "rt_ref_privesc_auto",
			rt_privesc_auto: "rt_cred_dump",
			rt_cred_dump: "rt_lateral",
		};
		let predicted = "rt_recon";
		let confidence = 0.3;
		let basedOn = "default";
		for (const cmd of topCommands) {
			if (patterns[cmd]) {
				predicted = patterns[cmd];
				confidence = 0.7;
				basedOn = cmd;
				break;
			}
		}
		return this.addPrediction(predicted, confidence, basedOn);
	}

	// --- Attention filter (useful vs useless) ---
	filterUseful(items: { id: string; content: string }[]): {
		useful: string[];
		useless: string[];
	} {
		const useful: string[] = [];
		const useless: string[] = [];
		const noisePatterns = [
			/^$/,
			/^\s*$/,
			/error: command not found/i,
			/permission denied/i,
		];
		for (const item of items) {
			if (noisePatterns.some((p) => p.test(item.content))) {
				useless.push(item.id);
			} else {
				useful.push(item.id);
			}
		}
		return { useful, useless };
	}

	// --- Reflection / learning ---
	reflect(topic: string, insight: string, useful = true): Reflection {
		return this.addReflection(topic, insight, useful);
	}
}
