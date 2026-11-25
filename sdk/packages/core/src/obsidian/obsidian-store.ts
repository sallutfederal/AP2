import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface ObsidianStoreOptions {
	vaultPath?: string;
}

export interface ObsidianSearchResult {
	path: string;
	matches: string[];
	score: number;
}

function resolveDefaultObsidianVaultPath(): string {
	const envPath = process.env.OBSIDIAN_VAULT_PATH?.trim();
	if (envPath) return envPath;
	const homeVault = join(homedir(), "Documents", "Obsidian Vault");
	if (existsSync(homeVault)) {
		return homeVault;
	}
	return homeVault;
}

function slugifyNoteName(name: string): string {
	const cleaned = name
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return cleaned || `note-${Date.now()}`;
}

export class ObsidianStore {
	private readonly vaultPath: string;

	constructor(options: ObsidianStoreOptions = {}) {
		this.vaultPath =
			options.vaultPath?.trim() || resolveDefaultObsidianVaultPath();
		this.ensureFolders();
	}

	ensureFolders(): void {
		for (const folder of [
			"",
			"memory",
			"knowledge",
			"knowledge/reports",
			"daily",
			"sessions",
		]) {
			const dir = folder ? join(this.vaultPath, folder) : this.vaultPath;
			if (!existsSync(dir)) {
				try {
					mkdirSync(dir, { recursive: true });
				} catch {
					/* ignore */
				}
			}
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
			} catch {
				/* ignore */
			}
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
		const dir = dirname(fullPath);
		if (!existsSync(dir)) {
			try {
				mkdirSync(dir, { recursive: true });
			} catch {
				return false;
			}
		}
		try {
			writeFileSync(fullPath, content, "utf8");
			return true;
		} catch {
			return false;
		}
	}

	appendNote(path: string, content: string): boolean {
		const existing = this.readNote(path);
		const nextContent = existing
			? `${existing.replace(/\s+$/, "")}\n${content.replace(/^\n+/, "")}`
			: content.replace(/^\n+/, "");
		return this.writeNote(path, nextContent);
	}

	searchNotes(query: string): ObsidianSearchResult[] {
		const results: ObsidianSearchResult[] = [];
		const notes = this.listNotes();
		const q = query.trim().toLowerCase();
		if (!q) return results;

		const tokens = [
			...new Set(
				q
					.split(/[\s,.;:!?/\\|()[\]{}"'`]+/)
					.map((t) => t.trim())
					.filter((t) => t.length >= 3),
			),
		];
		const searchTerms = tokens.length > 0 ? tokens : [q];

		for (const note of notes) {
			const content = this.readNote(note);
			if (!content) continue;
			const lowerPath = note.toLowerCase();
			const lines = content.split("\n");
			const matches: string[] = [];
			let score = 0;

			if (lowerPath.includes(q)) {
				score += 5;
			}
			for (const term of searchTerms) {
				if (lowerPath.includes(term)) {
					score += 2;
				}
			}

			for (const line of lines) {
				const lowerLine = line.toLowerCase();
				if (lowerLine.includes(q)) {
					score += 4;
					matches.push(line.trim().slice(0, 200));
					continue;
				}
				const termHits = searchTerms.filter((t) => lowerLine.includes(t)).length;
				if (termHits > 0) {
					score += termHits;
					matches.push(line.trim().slice(0, 200));
				}
			}

			if (score > 0 && matches.length > 0) {
				results.push({
					path: note,
					matches: matches.slice(0, 5),
					score,
				});
			}
		}

		results.sort((a, b) => b.score - a.score);
		return results;
	}

	deleteNote(path: string): boolean {
		const fullPath = join(this.vaultPath, path);
		if (!existsSync(fullPath)) return false;
		try {
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
		const safeKey = slugifyNoteName(key);
		const path = `memory/${safeKey}.md`;
		const content = `# ${key}\n\n${value}\n\nTags: ${tags.join(", ")}\nUpdated: ${new Date().toISOString()}\n`;
		return this.writeNote(path, content);
	}

	getMemoryNote(key: string): string | null {
		const direct = this.readNote(`memory/${key}.md`);
		if (direct !== null) return direct;
		return this.readNote(`memory/${slugifyNoteName(key)}.md`);
	}

	listMemoryNotes(): string[] {
		return this.listNotes("memory");
	}

	createKnowledgeNote(
		topic: string,
		content: string,
		tags: string[] = [],
	): boolean {
		const slug = slugifyNoteName(topic);
		const path = `knowledge/${slug}.md`;
		const normalizedTags = [...new Set(["knowledge", ...tags])];
		const body = `# ${topic}\n\n${content.trim()}\n\nTags: ${normalizedTags.join(", ")}\nUpdated: ${new Date().toISOString()}\n`;
		return this.writeNote(path, body);
	}

	getKnowledgeNote(topic: string): string | null {
		const direct = this.readNote(`knowledge/${topic}.md`);
		if (direct !== null) return direct;
		return this.readNote(`knowledge/${slugifyNoteName(topic)}.md`);
	}

	listKnowledgeNotes(): string[] {
		return this.listNotes("knowledge");
	}
}
