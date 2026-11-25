import type { ObsidianSearchResult, ObsidianStore } from "./obsidian-store";

export interface ObsidianServiceOptions {
	store: ObsidianStore;
	agentName?: string;
}

export interface ObsidianPersonality {
	nickname: string;
	style: string;
	traits: string[];
	howToTalkToUser: string;
	voiceRules: string[];
	adaptations: string[];
}

export interface ObsidianUserStyle {
	preferredName: string;
	language: string;
	tone: string;
	expressions: string[];
	preferences: string[];
	observations: string[];
}

export interface LearnFromTurnInput {
	userText?: string;
	assistantText?: string;
	toolsUsed?: string[];
	sessionId?: string;
}

export interface CommandReportInput {
	reportPath?: string;
	objective?: string;
	toolName: string;
	commandOrTarget: string;
	outputSummary: string;
	durationMs?: number;
	sessionId?: string;
	tags?: string[];
}

export interface FinalizeReportInput {
	reportPath?: string;
	objective: string;
	conclusion: string;
	toolsUsed?: string[];
	sessionId?: string;
	tags?: string[];
}

const PERSONALITY_PATH = "personality.md";
const USER_STYLE_PATH = "user-style.md";

const DEFAULT_PERSONALITY: ObsidianPersonality = {
	nickname: "AP2",
	style:
		"Parceiro técnico direto, vivo e com personalidade própria em PT-BR — zero fala robótica ou corporativa",
	traits: [
		"direto e sem enrolação",
		"natural e expressivo como alguém próximo",
		"técnico e afiado quando o papo é código ou segurança",
		"lembra do contexto e do jeito do usuário",
		"opinião própria sem parecer assistente genérico",
	],
	howToTalkToUser:
		"Fala em português brasileiro natural, no mesmo ritmo do usuário: descontraído quando a conversa é leve, cirúrgico e técnico na hora da execução. Nunca usa frases engessadas de IA ('Claro! Posso ajudar com isso', 'Como uma IA', ou resumos artificiais no fim de toda resposta).",
	voiceRules: [
		"Nunca comece com templates repetitivos ou saudações genéricas de chatbot.",
		"Espelhe o ritmo e a naturalidade do usuário sem perder a própria identidade.",
		"Quando lembrar de algo real do Obsidian (memória, conhecimento, preferência), traga isso de forma orgânica na conversa.",
		"Use gírias e expressões com moderação natural, sem forçar.",
	],
	adaptations: [],
};

const DEFAULT_USER_STYLE: ObsidianUserStyle = {
	preferredName: "usuário",
	language: "pt-BR",
	tone: "direto, informal, prático e focado em resolver rápido",
	expressions: [],
	preferences: [
		"Prefere personalidade própria e conversa natural em vez de respostas genéricas.",
		"Quer que memórias, conhecimentos e o jeito de conversar fiquem salvos no Obsidian.",
	],
	observations: [],
};

const PT_BR_STYLE_EXPRESSIONS = [
	"mano",
	"cara",
	"vei",
	"véi",
	"parceiro",
	"bora",
	"vlw",
	"valeu",
	"tmj",
	"blz",
	"beleza",
	"suave",
	"firmeza",
	"top",
	"show",
	"massa",
	"daora",
	"dahora",
	"kkk",
	"kkkk",
	"slk",
	"pdp",
	"pfv",
	"pq",
	"vc",
	"tá",
	"ta",
	"né",
	"ne",
	"oxe",
	"eita",
	"caramba",
	"bicho",
	"irmão",
	"chefe",
];

function parseBulletSection(content: string, heading: string): string[] {
	const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const regex = new RegExp(`## ${escaped}\\n([\\s\\S]*?)(?=\\n## |$)`);
	const match = content.match(regex);
	if (!match?.[1]) return [];
	return match[1]
		.split("\n")
		.map((line) => line.replace(/^\s*[-*]\s*/, "").trim())
		.filter((line) => line.length > 0 && !line.startsWith("_"));
}

function renderPersonalityMarkdown(
	agentName: string,
	p: ObsidianPersonality,
): string {
	const voiceLines =
		p.voiceRules.length > 0
			? p.voiceRules.map((r) => `- ${r}`).join("\n")
			: "- Falar de forma natural, direta e autêntica.";
	const adaptationLines =
		p.adaptations.length > 0
			? p.adaptations.map((a) => `- ${a}`).join("\n")
			: "- _Ainda aprendendo nuances com o usuário._";
	return [
		`# ${agentName} Personality`,
		"",
		`Nickname: ${p.nickname}`,
		`Speaking Style: ${p.style}`,
		`Traits: ${p.traits.join(", ")}`,
		`How I Talk To User: ${p.howToTalkToUser}`,
		`Updated: ${new Date().toISOString()}`,
		"",
		"## Voice Rules",
		voiceLines,
		"",
		"## Style Adaptations",
		adaptationLines,
		"",
	].join("\n");
}

function renderUserStyleMarkdown(style: ObsidianUserStyle): string {
	const exprLines =
		style.expressions.length > 0
			? style.expressions.map((e) => `- ${e}`).join("\n")
			: "- _Nenhuma expressão registrada ainda._";
	const prefLines =
		style.preferences.length > 0
			? style.preferences.map((p) => `- ${p}`).join("\n")
			: "- _Nenhuma preferência registrada ainda._";
	const obsLines =
		style.observations.length > 0
			? style.observations.map((o) => `- ${o}`).join("\n")
			: "- _Nenhuma observação de conversa ainda._";
	return [
		"# User Conversation Style",
		"",
		`Preferred Name: ${style.preferredName}`,
		`Language: ${style.language}`,
		`Tone: ${style.tone}`,
		`Updated: ${new Date().toISOString()}`,
		"",
		"## Expressions & Slang",
		exprLines,
		"",
		"## Communication Preferences",
		prefLines,
		"",
		"## Style Observations",
		obsLines,
		"",
	].join("\n");
}

function compactText(text: string, maxLen: number): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	if (oneLine.length <= maxLen) return oneLine;
	return `${oneLine.slice(0, maxLen - 3)}...`;
}

function normalizeForKey(text: string): string {
	return text
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);
}

export class ObsidianService {
	private readonly store: ObsidianStore;
	private readonly agentName: string;

	constructor(options: ObsidianServiceOptions) {
		this.store = options.store;
		this.agentName = options.agentName ?? "AP2";
		this.ensureBaseNotes();
	}

	private ensureBaseNotes(): void {
		this.store.ensureFolders();
		if (this.store.readNote(PERSONALITY_PATH) === null) {
			this.store.writeNote(
				PERSONALITY_PATH,
				renderPersonalityMarkdown(this.agentName, DEFAULT_PERSONALITY),
			);
		}
		if (this.store.readNote(USER_STYLE_PATH) === null) {
			this.store.writeNote(
				USER_STYLE_PATH,
				renderUserStyleMarkdown(DEFAULT_USER_STYLE),
			);
		}
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

	searchNotes(query: string): ObsidianSearchResult[] {
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
		this.store.getDailyNote();
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

	// --- Knowledge notes ---
	saveKnowledge(
		topic: string,
		content: string,
		tags: string[] = [],
	): boolean {
		return this.store.createKnowledgeNote(topic, content, tags);
	}

	getKnowledge(topic: string): string | null {
		return this.store.getKnowledgeNote(topic);
	}

	listKnowledge(): string[] {
		return this.store.listKnowledgeNotes();
	}

	// --- Execution & Completion Reports (knowledge/reports/) ---
	buildReportPath(objectiveOrTitle: string, uniqueSuffix = ""): string {
		const today = new Date().toISOString().split("T")[0];
		const slug = normalizeForKey(objectiveOrTitle) || "execution";
		const suffix = uniqueSuffix ? `-${normalizeForKey(uniqueSuffix)}` : "";
		return `knowledge/reports/${today}-${slug}${suffix}.md`;
	}

	saveReport(
		title: string,
		content: string,
		tags: string[] = [],
	): string | null {
		const path = this.buildReportPath(title);
		const normalizedTags = [...new Set(["report", "knowledge", ...tags])];
		const body = `# ${title}\n\n${content.trim()}\n\nTags: ${normalizedTags.join(", ")}\nUpdated: ${new Date().toISOString()}\n`;
		return this.store.writeNote(path, body) ? path : null;
	}

	recordCommandReport(input: CommandReportInput): string | null {
		const today = new Date().toISOString().split("T")[0];
		const time = new Date().toISOString().split("T")[1].slice(0, 8);
		const path =
			input.reportPath?.trim() ||
			this.buildReportPath(
				input.objective || input.commandOrTarget || input.toolName,
			);
		const existing = this.store.readNote(path);
		if (existing === null) {
			const title = compactText(
				input.objective || input.commandOrTarget || input.toolName,
				90,
			);
			const normalizedTags = [
				...new Set(["report", "knowledge", input.toolName, ...(input.tags ?? [])]),
			];
			const header = [
				`# Relatório: ${title}`,
				"",
				`- **Data:** ${today}`,
				`- **Session:** ${input.sessionId ?? "local"}`,
				`- **Objetivo:** ${compactText(input.objective || input.commandOrTarget, 300)}`,
				"- **Status:** em andamento",
				"",
				`Tags: ${normalizedTags.join(", ")}`,
				"",
				"## Comandos & Execuções Concluídas",
				"",
			].join("\n");
			if (!this.store.writeNote(path, header)) {
				return null;
			}
		}

		const durationStr =
			typeof input.durationMs === "number" ? ` · ${input.durationMs}ms` : "";
		const cleanOutput = input.outputSummary.replace(/```/g, "'''").trim();
		const entry = [
			"",
			`### [${time}] \`${input.toolName}\`${durationStr}`,
			`- **Entrada / Alvo:** ${compactText(input.commandOrTarget, 240)}`,
			"- **Saída:**",
			"```text",
			cleanOutput || "(sem saída textual)",
			"```",
			"",
		].join("\n");

		return this.store.appendNote(path, entry) ? path : null;
	}

	finalizeReport(input: FinalizeReportInput): string | null {
		const today = new Date().toISOString().split("T")[0];
		const time = new Date().toISOString().split("T")[1].slice(0, 8);
		const path =
			input.reportPath?.trim() ||
			this.buildReportPath(
				input.objective,
				input.sessionId ? input.sessionId.slice(-8) : "",
			);
		const existing = this.store.readNote(path);
		const uniqueTools = [...new Set(input.toolsUsed ?? [])];
		const conclusionBlock = [
			"",
			`## Conclusão (${time})`,
			`- **Ferramentas usadas:** ${uniqueTools.join(", ") || "nenhuma"}`,
			`- **Updated:** ${new Date().toISOString()}`,
			"",
			input.conclusion.trim(),
			"",
		].join("\n");

		if (existing === null) {
			const title = compactText(input.objective || "Objetivo Concluído", 90);
			const normalizedTags = [
				...new Set(["report", "knowledge", ...(input.tags ?? [])]),
			];
			const body = [
				`# Relatório: ${title}`,
				"",
				`- **Data:** ${today}`,
				`- **Session:** ${input.sessionId ?? "local"}`,
				`- **Objetivo:** ${compactText(input.objective, 300)}`,
				"- **Status:** concluído",
				"",
				`Tags: ${normalizedTags.join(", ")}`,
				conclusionBlock,
			].join("\n");
			return this.store.writeNote(path, body) ? path : null;
		}

		const updatedExisting = existing.replace(
			"- **Status:** em andamento",
			"- **Status:** concluído",
		);
		if (updatedExisting !== existing) {
			this.store.writeNote(path, updatedExisting);
		}
		return this.store.appendNote(path, conclusionBlock) ? path : null;
	}

	// --- Personality ---
	setPersonality(
		nickname: string,
		style: string,
		traits: string[],
		options?: {
			howToTalkToUser?: string;
			voiceRules?: string[];
			adaptation?: string;
		},
	): boolean {
		const current = this.getPersonality() ?? DEFAULT_PERSONALITY;
		const adaptations = options?.adaptation
			? [...new Set([...current.adaptations, options.adaptation])].slice(-15)
			: current.adaptations;
		const next: ObsidianPersonality = {
			nickname: nickname.trim() || current.nickname,
			style: style.trim() || current.style,
			traits: traits.length > 0 ? traits : current.traits,
			howToTalkToUser:
				options?.howToTalkToUser?.trim() || current.howToTalkToUser,
			voiceRules:
				options?.voiceRules && options.voiceRules.length > 0
					? options.voiceRules
					: current.voiceRules,
			adaptations,
		};
		return this.store.writeNote(
			PERSONALITY_PATH,
			renderPersonalityMarkdown(this.agentName, next),
		);
	}

	getPersonality(): ObsidianPersonality | null {
		const content = this.store.readNote(PERSONALITY_PATH);
		if (!content) return null;
		const nickname =
			content.match(/Nickname: (.+)/)?.[1]?.trim() ?? this.agentName;
		const style =
			content.match(/Speaking Style: (.+)/)?.[1]?.trim() ??
			DEFAULT_PERSONALITY.style;
		const traits = (content.match(/Traits: (.+)/)?.[1] ?? "")
			.split(",")
			.map((t) => t.trim())
			.filter(Boolean);
		const howToTalkToUser =
			content.match(/How I Talk To User: (.+)/)?.[1]?.trim() ??
			DEFAULT_PERSONALITY.howToTalkToUser;
		const voiceRules = parseBulletSection(content, "Voice Rules");
		const adaptations = parseBulletSection(content, "Style Adaptations");
		return {
			nickname,
			style,
			traits: traits.length > 0 ? traits : DEFAULT_PERSONALITY.traits,
			howToTalkToUser,
			voiceRules:
				voiceRules.length > 0 ? voiceRules : DEFAULT_PERSONALITY.voiceRules,
			adaptations,
		};
	}

	// --- User conversation style ---
	getUserStyle(): ObsidianUserStyle {
		const content = this.store.readNote(USER_STYLE_PATH);
		if (!content) return { ...DEFAULT_USER_STYLE };
		const preferredName =
			content.match(/Preferred Name: (.+)/)?.[1]?.trim() ??
			DEFAULT_USER_STYLE.preferredName;
		const language =
			content.match(/Language: (.+)/)?.[1]?.trim() ??
			DEFAULT_USER_STYLE.language;
		const tone =
			content.match(/Tone: (.+)/)?.[1]?.trim() ?? DEFAULT_USER_STYLE.tone;
		const expressions = parseBulletSection(content, "Expressions & Slang");
		const preferences = parseBulletSection(
			content,
			"Communication Preferences",
		);
		const observations = parseBulletSection(content, "Style Observations");
		return {
			preferredName,
			language,
			tone,
			expressions,
			preferences,
			observations,
		};
	}

	updateUserStyle(updates: {
		preferredName?: string;
		language?: string;
		tone?: string;
		expressions?: string[];
		preferences?: string[];
		observation?: string;
	}): ObsidianUserStyle {
		const current = this.getUserStyle();
		const next: ObsidianUserStyle = {
			preferredName:
				updates.preferredName?.trim() || current.preferredName,
			language: updates.language?.trim() || current.language,
			tone: updates.tone?.trim() || current.tone,
			expressions: updates.expressions?.length
				? [
						...new Set([
							...current.expressions,
							...updates.expressions.map((e) => e.trim()).filter(Boolean),
						]),
					].slice(-30)
				: current.expressions,
			preferences: updates.preferences?.length
				? [
						...new Set([
							...current.preferences,
							...updates.preferences.map((p) => p.trim()).filter(Boolean),
						]),
					].slice(-25)
				: current.preferences,
			observations: updates.observation?.trim()
				? [
						...new Set([
							...current.observations,
							updates.observation.trim(),
						]),
					].slice(-25)
				: current.observations,
		};
		this.store.writeNote(USER_STYLE_PATH, renderUserStyleMarkdown(next));
		return next;
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
		return this.appendNote(
			`sessions/${today}.md`,
			`\n## ${time}\n${summary}\n`,
		);
	}

	// --- Prompt injection: load personality, user style, knowledge, memories ---
	buildPromptContext(userMessage?: string, maxChars = 4500): string {
		this.ensureBaseNotes();
		const sections: string[] = [];
		const vaultPath = this.store.getVaultPath();
		sections.push(
			`[OBSIDIAN VAULT LOCATION]\nVault Path: ${vaultPath}\nReports Folder: ${vaultPath}\\knowledge\\reports\nRule: Always save reports inside Obsidian using obs_save_report (or obs_write_note in knowledge/reports/). NEVER save reports outside Obsidian (never in workspace cwd or Downloads).`,
		);

		const personality = this.getPersonality();
		if (personality) {
			const pLines = [
				`[PERSONALITY & SPEAKING VOICE (${this.store.getVaultPath()}\\${PERSONALITY_PATH})]`,
				`Nickname: ${personality.nickname}`,
				`Speaking Style: ${personality.style}`,
				`Traits: ${personality.traits.join(", ")}`,
				`How to talk with user: ${personality.howToTalkToUser}`,
			];
			if (personality.voiceRules.length > 0) {
				pLines.push(`Voice rules: ${personality.voiceRules.join(" | ")}`);
			}
			if (personality.adaptations.length > 0) {
				pLines.push(
					`Recent style adaptations: ${personality.adaptations.slice(-5).join(" | ")}`,
				);
			}
			sections.push(pLines.join("\n"));
		}

		const userStyle = this.getUserStyle();
		const uLines = [
			`[USER CONVERSATION STYLE (${USER_STYLE_PATH})]`,
			`User: ${userStyle.preferredName} | Language: ${userStyle.language} | Tone: ${userStyle.tone}`,
		];
		if (userStyle.expressions.length > 0) {
			uLines.push(
				`Observed expressions/slang: ${userStyle.expressions.slice(-15).join(", ")}`,
			);
		}
		if (userStyle.preferences.length > 0) {
			uLines.push(
				`Communication preferences: ${userStyle.preferences.slice(-8).join(" | ")}`,
			);
		}
		if (userStyle.observations.length > 0) {
			uLines.push(
				`Recent style notes: ${userStyle.observations.slice(-5).join(" | ")}`,
			);
		}
		sections.push(uLines.join("\n"));

		const matchedPaths = new Set<string>();
		if (userMessage?.trim()) {
			const hits = this.store
				.searchNotes(userMessage)
				.filter(
					(h) => h.path !== PERSONALITY_PATH && h.path !== USER_STYLE_PATH,
				)
				.slice(0, 5);
			if (hits.length > 0) {
				const hitLines = ["[OBSIDIAN RELEVANT RECALL]"];
				for (const hit of hits) {
					matchedPaths.add(hit.path);
					hitLines.push(`- ${hit.path}: ${hit.matches.slice(0, 2).join(" / ")}`);
				}
				sections.push(hitLines.join("\n"));
			}
		}

		const allKnowledgePaths = this.store
			.listKnowledgeNotes()
			.filter((p) => !matchedPaths.has(p));
		const reportPaths = allKnowledgePaths
			.filter((p) => p.startsWith("knowledge/reports/"))
			.sort()
			.slice(-4);
		const knowledgePaths = allKnowledgePaths
			.filter((p) => !p.startsWith("knowledge/reports/"))
			.slice(-5);
		if (knowledgePaths.length > 0) {
			const kLines = ["[OBSIDIAN KNOWLEDGE]"];
			for (const path of knowledgePaths) {
				const content = this.store.readNote(path);
				if (!content) continue;
				const summary = compactText(
					content.replace(/^#.*\n/, "").replace(/Updated:.*$/m, ""),
					220,
				);
				kLines.push(`- ${path}: ${summary}`);
			}
			if (kLines.length > 1) sections.push(kLines.join("\n"));
		}
		if (reportPaths.length > 0) {
			const rLines = ["[OBSIDIAN RECENT REPORTS]"];
			for (const path of reportPaths) {
				const content = this.store.readNote(path);
				if (!content) continue;
				const summary = compactText(
					content.replace(/^#.*\n/, "").replace(/Updated:.*$/m, ""),
					220,
				);
				rLines.push(`- ${path}: ${summary}`);
			}
			if (rLines.length > 1) sections.push(rLines.join("\n"));
		}

		const memoryPaths = this.store
			.listMemoryNotes()
			.filter((p) => !matchedPaths.has(p))
			.slice(-6);
		if (memoryPaths.length > 0) {
			const mLines = ["[OBSIDIAN MEMORIES]"];
			for (const path of memoryPaths) {
				const content = this.store.readNote(path);
				if (!content) continue;
				const summary = compactText(
					content
						.replace(/^#.*\n/, "")
						.replace(/Tags:.*$/m, "")
						.replace(/Created:.*$/m, "")
						.replace(/Updated:.*$/m, ""),
					200,
				);
				mLines.push(`- ${path}: ${summary}`);
			}
			if (mLines.length > 1) sections.push(mLines.join("\n"));
		}

		const today = new Date().toISOString().split("T")[0];
		const todaySession = this.store.readNote(`sessions/${today}.md`);
		if (todaySession?.trim()) {
			const tail = todaySession.trim().slice(-600);
			sections.push(`[TODAY SESSION NOTES (sessions/${today}.md)]\n${tail}`);
		}

		let combined = sections.join("\n\n");
		if (combined.length > maxChars) {
			combined = `${combined.slice(0, maxChars - 3)}...`;
		}
		return combined;
	}

	// --- Automatic turn learning: persist style, memories, knowledge & journal ---
	learnFromTurn(input: LearnFromTurnInput): void {
		this.ensureBaseNotes();
		const userText = input.userText?.trim();
		const assistantText = input.assistantText?.trim();
		const toolsUsed = input.toolsUsed ?? [];
		if (!userText && !assistantText) return;

		if (userText) {
			this.learnUserStyleFromText(userText);
			this.captureExplicitFactsAndKnowledge(userText);
		}

		if (userText || assistantText) {
			const parts: string[] = [];
			if (userText) parts.push(`User: ${compactText(userText, 240)}`);
			if (toolsUsed.length > 0) {
				parts.push(`Tools: ${[...new Set(toolsUsed)].join(", ")}`);
			}
			if (assistantText) {
				parts.push(`${this.agentName}: ${compactText(assistantText, 260)}`);
			}
			const summary = parts.join("\n");
			if (summary.length > 0) {
				this.logSession(summary);
			}
		}
	}

	private learnUserStyleFromText(userText: string): void {
		const lower = userText.toLowerCase();
		const detectedExpressions = PT_BR_STYLE_EXPRESSIONS.filter((expr) =>
			new RegExp(`\\b${expr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(
				lower,
			),
		);

		const isPortuguese =
			/[ãõçáéíóúâêôà]|(\b(não|nao|pra|pro|com|isso|aqui|meu|minha|como|vc|você|fala|jeito|quero|troque|coloque)\b)/i.test(
				userText,
			);
		const isDirect = userText.length < 180 && !userText.includes("\n\n");
		const hasLowercaseCasual =
			userText === userText.toLowerCase() && userText.length > 8;

		const newPreferences: string[] = [];
		const styleFeedbackMatch = userText.match(
			/(?:fala|conversa|responde|seja|quero que você|quero que vc)\s+([^.!?\n]{4,120})/i,
		);
		if (styleFeedbackMatch?.[0]) {
			const feedback = compactText(styleFeedbackMatch[0], 140);
			newPreferences.push(feedback);
			this.setPersonality(
				this.getPersonality()?.nickname ?? this.agentName,
				this.getPersonality()?.style ?? DEFAULT_PERSONALITY.style,
				this.getPersonality()?.traits ?? DEFAULT_PERSONALITY.traits,
				{ adaptation: `User asked: "${feedback}"` },
			);
		}

		const nameMatch = userText.match(
			/(?:meu nome é|me chamo|pode me chamar de)\s+([a-zA-ZÀ-ÿ0-9_-]{2,30})/i,
		);

		const styleNotes: string[] = [];
		if (isDirect && hasLowercaseCasual) {
			styleNotes.push("Escreve direto em minúsculas, tom informal e rápido");
		} else if (isDirect) {
			styleNotes.push("Mensagens curtas e objetivas");
		}
		if (detectedExpressions.length > 0) {
			styleNotes.push(
				`Usa expressões como: ${detectedExpressions.slice(0, 5).join(", ")}`,
			);
		}

		this.updateUserStyle({
			...(nameMatch?.[1] ? { preferredName: nameMatch[1] } : {}),
			...(isPortuguese ? { language: "pt-BR" } : {}),
			...(detectedExpressions.length > 0
				? { expressions: detectedExpressions }
				: {}),
			...(newPreferences.length > 0 ? { preferences: newPreferences } : {}),
			...(styleNotes.length > 0
				? {
						observation: `${new Date().toISOString().split("T")[0]}: ${styleNotes.join("; ")}`,
					}
				: {}),
		});
	}

	private captureExplicitFactsAndKnowledge(userText: string): void {
		const isExplicitRemember =
			/\b(lembra|lembre|anota|anote|guarda|guarde|memoriza|memorize|nunca esqueça|nao esquece|sempre|nunca|eu prefiro|eu gosto|meu sistema|meu projeto|eu uso)\b/i.test(
				userText,
			);
		if (!isExplicitRemember || userText.length < 15) return;

		const keySlug = normalizeForKey(userText.slice(0, 60));
		if (!keySlug) return;
		const key = `user_${keySlug}`;
		if (this.recall(key) !== null) return;
		this.remember(key, compactText(userText, 500), ["auto", "user-fact"]);
	}
}
