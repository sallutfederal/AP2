import {
	createCipheriv,
	createDecipheriv,
	createHash,
	randomBytes,
} from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import {
	asOptionalString,
	asString,
	loadSqliteDb,
	type SqliteDb,
} from "@cline/shared/db";
import { resolveDbDataDir } from "@cline/shared/storage";
import type { Campaign } from "./campaign";
import type { SupervisorState } from "./supervisor";

export interface SqliteRedTeamStoreOptions {
	dbPath?: string;
	sessionsDir?: string;
	encryptionSecret?: string;
}

export interface StoredCredential {
	id: string;
	user: string;
	secret: string;
	source: string;
	target: string;
	createdAt: number;
}

export interface AuditChainEntry {
	id: number;
	ts: number;
	target?: string;
	command: string;
	hash: string;
	prevHash: string;
	chainHash: string;
	code: number;
}

export interface QueuedTargetItem {
	id: string;
	value: string;
	type: string;
	status: string;
	priority: number;
	createdAt: number;
}

const REDTEAM_SCHEMA = `
CREATE TABLE IF NOT EXISTS rt_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rt_scope (
  target TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rt_cred_vault (
  id TEXT PRIMARY KEY,
  user_name TEXT NOT NULL,
  secret_cipher TEXT NOT NULL,
  iv TEXT NOT NULL,
  auth_tag TEXT NOT NULL,
  source TEXT NOT NULL,
  target TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rt_cred_target ON rt_cred_vault(target);

CREATE TABLE IF NOT EXISTS rt_audit_chain (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  target TEXT,
  command TEXT NOT NULL,
  output_hash TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  chain_hash TEXT NOT NULL,
  code INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rt_audit_ts ON rt_audit_chain(ts DESC);

CREATE TABLE IF NOT EXISTS rt_campaigns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  state_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rt_supervisors (
  id TEXT PRIMARY KEY,
  target TEXT NOT NULL,
  stage TEXT NOT NULL,
  state_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rt_target_queue (
  id TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  priority INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rt_queue_status ON rt_target_queue(status, priority DESC);
`;

function deriveVaultKey(secretOverride?: string): Buffer {
	const seed =
		secretOverride ??
		process.env.CLINE_VAULT_KEY ??
		`ap2-redteam-vault-v1:${homedir()}:${hostname()}`;
	return createHash("sha256").update(seed, "utf8").digest();
}

export class SqliteRedTeamStore {
	private readonly dbPath: string;
	private readonly vaultKey: Buffer;
	private db: SqliteDb | undefined;

	constructor(options: SqliteRedTeamStoreOptions = {}) {
		this.dbPath =
			options.dbPath ??
			(options.sessionsDir
				? join(options.sessionsDir, "redteam.db")
				: join(resolveDbDataDir(), "redteam.db"));
		this.vaultKey = deriveVaultKey(options.encryptionSecret);
	}

	init(): void {
		this.getRawDb();
	}

	getRawDb(): SqliteDb {
		if (this.db) return this.db;
		const dir = this.dbPath.split(/[/\\]/).slice(0, -1).join("/");
		if (dir && !existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		const db = loadSqliteDb(this.dbPath);
		db.exec(REDTEAM_SCHEMA);
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

	// =========================================================================
	// Operational State Flags (dry_run, kill_switch)
	// =========================================================================

	private getStateFlag(key: string, defaultValue = false): boolean {
		const row = this.queryOne<{ value?: unknown }>(
			"SELECT value FROM rt_state WHERE key = ?",
			[key],
		);
		if (!row) return defaultValue;
		return asString(row.value) === "true";
	}

	private setStateFlag(key: string, value: boolean): void {
		this.run(
			"INSERT OR REPLACE INTO rt_state (key, value, updated_at) VALUES (?, ?, ?)",
			[key, value ? "true" : "false", Date.now()],
		);
	}

	isDryRun(): boolean {
		return this.getStateFlag("dry_run", false);
	}

	setDryRun(enabled: boolean): void {
		this.setStateFlag("dry_run", enabled);
	}

	isKilled(): boolean {
		return this.getStateFlag("kill_switch", false);
	}

	setKilled(killed: boolean): void {
		this.setStateFlag("kill_switch", killed);
	}

	// =========================================================================
	// Scope Allowlist
	// =========================================================================

	addScopeTargets(targets: string[]): string[] {
		const now = Date.now();
		for (const raw of targets) {
			const normalized = raw.trim().toLowerCase();
			if (!normalized) continue;
			this.run(
				"INSERT OR REPLACE INTO rt_scope (target, created_at) VALUES (?, ?)",
				[normalized, now],
			);
		}
		return this.getScopeTargets();
	}

	getScopeTargets(): string[] {
		const rows = this.queryAll<{ target: unknown }>(
			"SELECT target FROM rt_scope ORDER BY target ASC",
		);
		return rows.map((r) => asString(r.target));
	}

	clearScope(): void {
		this.run("DELETE FROM rt_scope");
	}

	isTargetInScope(target: string): boolean {
		const scope = this.getScopeTargets();
		if (scope.length === 0) return true;
		const t = target.trim().toLowerCase();
		return (
			scope.includes(t) ||
			scope.some((s) => t.endsWith(s) || s.endsWith(t))
		);
	}

	// =========================================================================
	// AES-256-GCM Credential Vault
	// =========================================================================

	private encryptSecret(plain: string): {
		cipherHex: string;
		ivHex: string;
		tagHex: string;
	} {
		const iv = randomBytes(12);
		const cipher = createCipheriv("aes-256-gcm", this.vaultKey, iv);
		const encrypted = Buffer.concat([
			cipher.update(plain, "utf8"),
			cipher.final(),
		]);
		const tag = cipher.getAuthTag();
		return {
			cipherHex: encrypted.toString("hex"),
			ivHex: iv.toString("hex"),
			tagHex: tag.toString("hex"),
		};
	}

	private decryptSecret(
		cipherHex: string,
		ivHex: string,
		tagHex: string,
	): string {
		try {
			const decipher = createDecipheriv(
				"aes-256-gcm",
				this.vaultKey,
				Buffer.from(ivHex, "hex"),
			);
			decipher.setAuthTag(Buffer.from(tagHex, "hex"));
			const decrypted = Buffer.concat([
				decipher.update(Buffer.from(cipherHex, "hex")),
				decipher.final(),
			]);
			return decrypted.toString("utf8");
		} catch {
			return "[decryption-failed]";
		}
	}

	storeCredential(input: {
		id?: string;
		user: string;
		secret: string;
		source: string;
		target: string;
	}): StoredCredential {
		const id =
			input.id ??
			`cred_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
		const now = Date.now();
		const { cipherHex, ivHex, tagHex } = this.encryptSecret(input.secret);
		this.run(
			`INSERT OR REPLACE INTO rt_cred_vault (id, user_name, secret_cipher, iv, auth_tag, source, target, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				input.user,
				cipherHex,
				ivHex,
				tagHex,
				input.source,
				input.target,
				now,
			],
		);
		return {
			id,
			user: input.user,
			secret: input.secret,
			source: input.source,
			target: input.target,
			createdAt: now,
		};
	}

	private rowToCredential(row: Record<string, unknown>): StoredCredential {
		return {
			id: asString(row.id),
			user: asString(row.user_name),
			secret: this.decryptSecret(
				asString(row.secret_cipher),
				asString(row.iv),
				asString(row.auth_tag),
			),
			source: asString(row.source),
			target: asString(row.target),
			createdAt: Number(row.created_at),
		};
	}

	lookupCredentials(target: string): StoredCredential[] {
		const rows = this.queryAll<Record<string, unknown>>(
			`SELECT * FROM rt_cred_vault WHERE LOWER(target) LIKE ? ORDER BY created_at DESC`,
			[`%${target.trim().toLowerCase()}%`],
		);
		return rows.map((r) => this.rowToCredential(r));
	}

	listCredentials(limit = 200): StoredCredential[] {
		const rows = this.queryAll<Record<string, unknown>>(
			`SELECT * FROM rt_cred_vault ORDER BY created_at DESC LIMIT ?`,
			[limit],
		);
		return rows.map((r) => this.rowToCredential(r));
	}

	// =========================================================================
	// SHA-256 Hash-Chain Audit Trail
	// =========================================================================

	appendAudit(entry: {
		ts?: number;
		target?: string;
		command: string;
		outputHash: string;
		code: number;
	}): AuditChainEntry {
		const ts = entry.ts ?? Date.now();
		const lastRow = this.queryOne<{ chain_hash?: unknown }>(
			"SELECT chain_hash FROM rt_audit_chain ORDER BY id DESC LIMIT 1",
		);
		const prevHash = lastRow ? asString(lastRow.chain_hash) : "GENESIS";
		const chainHash = createHash("sha256")
			.update(
				`${prevHash}|${ts}|${entry.target ?? ""}|${entry.command}|${entry.outputHash}|${entry.code}`,
				"utf8",
			)
			.digest("hex");
		this.run(
			`INSERT INTO rt_audit_chain (ts, target, command, output_hash, prev_hash, chain_hash, code)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			[
				ts,
				entry.target ?? null,
				entry.command,
				entry.outputHash,
				prevHash,
				chainHash,
				entry.code,
			],
		);
		const inserted = this.queryOne<{ id?: unknown }>(
			"SELECT last_insert_rowid() as id",
		);
		return {
			id: Number(inserted?.id ?? 0),
			ts,
			target: entry.target,
			command: entry.command,
			hash: entry.outputHash,
			prevHash,
			chainHash,
			code: entry.code,
		};
	}

	listAudit(limit = 200): AuditChainEntry[] {
		const rows = this.queryAll<Record<string, unknown>>(
			"SELECT * FROM rt_audit_chain ORDER BY id ASC LIMIT ?",
			[limit],
		);
		return rows.map((r) => ({
			id: Number(r.id),
			ts: Number(r.ts),
			target: asOptionalString(r.target),
			command: asString(r.command),
			hash: asString(r.output_hash),
			prevHash: asString(r.prev_hash),
			chainHash: asString(r.chain_hash),
			code: Number(r.code),
		}));
	}

	// =========================================================================
	// Persistent Campaigns & Supervisors
	// =========================================================================

	saveCampaign(campaign: Campaign): void {
		this.run(
			`INSERT OR REPLACE INTO rt_campaigns (id, name, status, state_json, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?)`,
			[
				campaign.id,
				campaign.name,
				campaign.status,
				JSON.stringify(campaign),
				campaign.createdAt,
				campaign.updatedAt,
			],
		);
	}

	getCampaign(id: string): Campaign | undefined {
		const row = this.queryOne<{ state_json?: unknown }>(
			"SELECT state_json FROM rt_campaigns WHERE id = ?",
			[id],
		);
		if (!row) return undefined;
		try {
			return JSON.parse(asString(row.state_json)) as Campaign;
		} catch {
			return undefined;
		}
	}

	listCampaigns(): Campaign[] {
		const rows = this.queryAll<{ state_json: unknown }>(
			"SELECT state_json FROM rt_campaigns ORDER BY updated_at DESC",
		);
		const list: Campaign[] = [];
		for (const r of rows) {
			try {
				list.push(JSON.parse(asString(r.state_json)) as Campaign);
			} catch {
				// ignore corrupt row
			}
		}
		return list;
	}

	saveSupervisorState(state: SupervisorState): void {
		this.run(
			`INSERT OR REPLACE INTO rt_supervisors (id, target, stage, state_json, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?)`,
			[
				state.taskId,
				state.target,
				state.currentStage,
				JSON.stringify(state),
				state.createdAt,
				state.updatedAt,
			],
		);
	}

	listSupervisorStates(): SupervisorState[] {
		const rows = this.queryAll<{ state_json: unknown }>(
			"SELECT state_json FROM rt_supervisors ORDER BY updated_at DESC",
		);
		const list: SupervisorState[] = [];
		for (const r of rows) {
			try {
				list.push(JSON.parse(asString(r.state_json)) as SupervisorState);
			} catch {
				// ignore corrupt row
			}
		}
		return list;
	}

	// =========================================================================
	// Persistent Target Queue
	// =========================================================================

	enqueueTargets(
		targets: { value: string; type: string; priority?: number }[],
	): number {
		const now = Date.now();
		for (const t of targets) {
			const id = `tq_${now}_${Math.random().toString(36).slice(2, 6)}`;
			this.run(
				`INSERT INTO rt_target_queue (id, value, type, status, priority, created_at)
				 VALUES (?, ?, ?, 'pending', ?, ?)`,
				[id, t.value, t.type, t.priority ?? 0, now],
			);
		}
		return targets.length;
	}

	dequeueNextTargets(count = 3): QueuedTargetItem[] {
		const rows = this.queryAll<Record<string, unknown>>(
			`SELECT * FROM rt_target_queue WHERE status = 'pending'
			 ORDER BY priority DESC, created_at ASC LIMIT ?`,
			[count],
		);
		const items = rows.map((r) => ({
			id: asString(r.id),
			value: asString(r.value),
			type: asString(r.type),
			status: "running",
			priority: Number(r.priority ?? 0),
			createdAt: Number(r.created_at),
		}));
		for (const item of items) {
			this.run("UPDATE rt_target_queue SET status = 'running' WHERE id = ?", [
				item.id,
			]);
		}
		return items;
	}
}
