import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { SelfState, SelfStateStore } from "@cline/shared";
import { loadSqliteDb, type SqliteDb } from "@cline/shared/db";
import { resolveDbDataDir } from "@cline/shared/storage";

export interface SqliteSelfStateStoreOptions {
	dbPath?: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS self_state (
  agent_id TEXT PRIMARY KEY,
  state_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

export class SqliteSelfStateStore implements SelfStateStore {
	private readonly dbPath: string;
	private db: SqliteDb | undefined;

	constructor(options: SqliteSelfStateStoreOptions = {}) {
		this.dbPath = options.dbPath ?? join(resolveDbDataDir(), "self-state.db");
	}

	private ensureDir(): void {
		const dir = this.dbPath.split(/[/\\]/).slice(0, -1).join("/");
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	}

	getRawDb(): SqliteDb {
		if (this.db) return this.db;
		this.ensureDir();
		const db = loadSqliteDb(this.dbPath);
		db.exec(SCHEMA);
		this.db = db;
		return db;
	}

	load(agentId: string): SelfState | undefined {
		const row = this.getRawDb()
			.prepare("SELECT state_json FROM self_state WHERE agent_id = ?")
			.get(agentId) as { state_json: string } | undefined;
		if (!row) return undefined;
		try {
			return JSON.parse(row.state_json) as SelfState;
		} catch {
			return undefined;
		}
	}

	save(state: SelfState): void {
		this.getRawDb()
			.prepare(
				"INSERT OR REPLACE INTO self_state (agent_id, state_json, updated_at) VALUES (?, ?, ?)",
			)
			.run(state.agentId, JSON.stringify(state), Date.now());
	}

	clear(agentId: string): void {
		this.getRawDb()
			.prepare("DELETE FROM self_state WHERE agent_id = ?")
			.run(agentId);
	}

	close(): void {
		this.db?.close?.();
		this.db = undefined;
	}
}
