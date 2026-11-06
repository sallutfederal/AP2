import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ObsidianStoreOptions {
	vaultPath?: string;
}

export class ObsidianStore {
	private readonly vaultPath: string;

	constructor(options: ObsidianStoreOptions = {}) {
		this.vaultPath = options.vaultPath ?? "C:\\Users\\usuario\\Documents\\Obsidian Vault";
		if (!existsSync(this.vaultPath)) {
			try { mkdirSync(this.vaultPath, { recursive: true }); } catch { /* ignore */ }
		}
	}

	getVaultPath(): string {
		return this.vaultPath;
	}

	listNotes(folder?: string): string[] {
		const dir = folder ? join(this.vaultPath, folder) : this.vaultPath;
		if (!existsSync(dir)) return [];
		const notes: string[] = [];
		const walk = (d: string, prefix: string) => {
			try {
				const entries = readdirSync(d, { withFileTypes: true });
				for (const e of entries) {
					if (e.name.startsWith(".")) continue;
					if (e.isDirectory()) {
						walk(join(d, e.name), prefix ? `${prefix}/${e.name}` : e.name);
					} else if (e.name.endsWith(".md")) {
						notes.push(prefix ? `${prefix}/${e.name}` : e.name);
					}
				}
			} catch { /* ignore */ }
		};
		walk(dir, folder ?? "");
		return notes;
	}

	readNote(path: string): string | null {
		const fullPath = join(this.vaultPath, path);
		if (!existsSync(fullPath)) return null;
		try {
			return readFileSync(fullPath, "utf8");
		} catch {
			return null;
		}
	}

	writeNote(path: string, content: string): boolean {
		const fullPath = join(this.vaultPath, path);
		const dir = fullPath.split(/[/\\]/).slice(0, -1).join("/");
		if (!existsSync(dir)) {
			try { mkdirSync(dir, { recursive: true }); } catch { return false; }
		}
		try {
			writeFileSync(fullPath, content, "utf8");
			return true;
		} catch {
			return false;
		}
	}

	appendNote(path: string, content: string): boolean {
		const existing = this.readNote(path) ?? "";
		return this.writeNote(path, existing + "\n" + content);
	}

	searchNotes(query: string): { path: string; matches: string[] }[] {
		const results: { path: string; matches: string[] }[] = [];
		const notes = this.listNotes();
		const q = query.toLowerCase();
		for (const note of notes) {
			const content = this.readNote(note);
			if (!content) continue;
			const lines = content.split("\n");
			const matches: string[] = [];
			for (const line of lines) {
				if (line.toLowerCase().includes(q)) {
					matches.push(line.trim().slice(0, 200));
				}
			}
			if (matches.length > 0) {
				results.push({ path: note, matches: matches.slice(0, 5) });
			}
		}
		return results;
	}

	deleteNote(path: string): boolean {
		const fullPath = join(this.vaultPath, path);
		if (!existsSync(fullPath)) return false;
		try {
			const { unlinkSync } = require("node:fs");
			unlinkSync(fullPath);
			return true;
		} catch {
			return false;
		}
	}

	getDailyNote(): string {
		const today = new Date().toISOString().split("T")[0];
		const path = `daily/${today}.md`;
		const existing = this.readNote(path);
		if (existing) return existing;
		const template = `# ${today}\n\n## Notes\n\n## Tasks\n\n## Observations\n\n`;
		this.writeNote(path, template);
		return template;
	}

	createMemoryNote(key: string, value: string, tags: string[] = []): boolean {
		const path = `memory/${key}.md`;
		const content = `# ${key}\n\n${value}\n\nTags: ${tags.join(", ")}\nCreated: ${new Date().toISOString()}\n`;
		return this.writeNote(path, content);
	}

	getMemoryNote(key: string): string | null {
		return this.readNote(`memory/${key}.md`);
	}

	listMemoryNotes(): string[] {
		return this.listNotes("memory");
	}
}