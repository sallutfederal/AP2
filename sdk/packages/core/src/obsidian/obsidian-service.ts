import type { ObsidianStore } from "./obsidian-store";

export interface ObsidianServiceOptions {
	store: ObsidianStore;
	agentName?: string;
}

export class ObsidianService {
	private readonly store: ObsidianStore;
	private readonly agentName: string;

	constructor(options: ObsidianServiceOptions) {
		this.store = options.store;
		this.agentName = options.agentName ?? "AP2";
	}

	getVaultPath(): string {
		return this.store.getVaultPath();
	}

	// --- Note operations ---
	listNotes(folder?: string): string[] {
		return this.store.listNotes(folder);
	}

	readNote(path: string): string | null {
		return this.store.readNote(path);
	}

	writeNote(path: string, content: string): boolean {
		return this.store.writeNote(path, content);
	}

	appendNote(path: string, content: string): boolean {
		return this.store.appendNote(path, content);
	}

	searchNotes(query: string) {
		return this.store.searchNotes(query);
	}

	deleteNote(path: string): boolean {
		return this.store.deleteNote(path);
	}

	// --- Daily journal ---
	getDailyNote(): string {
		return this.store.getDailyNote();
	}

	addToDaily(content: string): boolean {
		const today = new Date().toISOString().split("T")[0];
		return this.store.appendNote(`daily/${today}.md`, content);
	}

	// --- Memory notes ---
	remember(key: string, value: string, tags: string[] = []): boolean {
		return this.store.createMemoryNote(key, value, tags);
	}

	recall(key: string): string | null {
		return this.store.getMemoryNote(key);
	}

	listMemories(): string[] {
		return this.store.listMemoryNotes();
	}

	// --- Personality ---
	setPersonality(nickname: string, style: string, traits: string[]): boolean {
		const content = `# ${this.agentName} Personality\n\nNickname: ${nickname}\nSpeaking Style: ${style}\nTraits: ${traits.join(", ")}\nUpdated: ${new Date().toISOString()}\n`;
		return this.store.writeNote("personality.md", content);
	}

	getPersonality(): { nickname: string; style: string; traits: string[] } | null {
		const content = this.store.readNote("personality.md");
		if (!content) return null;
		const nickname = content.match(/Nickname: (.+)/)?.[1] ?? this.agentName;
		const style = content.match(/Speaking Style: (.+)/)?.[1] ?? "direct";
		const traits = (content.match(/Traits: (.+)/)?.[1] ?? "").split(",").map((t) => t.trim()).filter(Boolean);
		return { nickname, style, traits };
	}

	// --- Auto-memory: store observations automatically ---
	autoRemember(observation: string, context?: string): boolean {
		const key = `obs_${Date.now()}`;
		const tags = ["auto", "observation"];
		if (context) tags.push(context);
		return this.remember(key, observation, tags);
	}

	// --- Session log ---
	logSession(summary: string): boolean {
		const today = new Date().toISOString().split("T")[0];
		const time = new Date().toISOString().split("T")[1].slice(0, 8);
		return this.appendNote(`sessions/${today}.md`, `\n## ${time}\n${summary}\n`);
	}
}