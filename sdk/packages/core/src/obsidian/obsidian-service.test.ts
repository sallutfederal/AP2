import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ObsidianService } from "./obsidian-service";
import { ObsidianStore } from "./obsidian-store";

describe("ObsidianService", () => {
	const tempDirs: string[] = [];

	function createService(): ObsidianService {
		const dir = mkdtempSync(join(tmpdir(), "obsidian-service-test-"));
		tempDirs.push(dir);
		return new ObsidianService({
			store: new ObsidianStore({ vaultPath: dir }),
			agentName: "AP2",
		});
	}

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("seeds personality.md and user-style.md when vault is empty", () => {
		const service = createService();
		const personality = service.getPersonality();
		const userStyle = service.getUserStyle();

		expect(personality).not.toBeNull();
		expect(personality?.nickname).toBe("AP2");
		expect(personality?.traits.length).toBeGreaterThan(0);
		expect(userStyle.language).toBe("pt-BR");
	});

	it("saves and recalls structured knowledge and memories", () => {
		const service = createService();
		expect(
			service.saveKnowledge("nvidia-nim", "Usa endpoint integrate.api.nvidia.com/v1", [
				"llm",
			]),
		).toBe(true);
		expect(service.listKnowledge()).toContain("knowledge/nvidia-nim.md");
		expect(service.getKnowledge("nvidia-nim")).toContain("integrate.api.nvidia.com");

		expect(service.remember("preferencia-idioma", "Sempre responder em PT-BR")).toBe(
			true,
		);
		expect(service.recall("preferencia-idioma")).toContain("Sempre responder em PT-BR");
	});

	it("learns user conversation style, expressions, explicit facts, and session logs from a turn", () => {
		const service = createService();
		service.learnFromTurn({
			userText: "bora mano, lembra que meu sistema usa obsidian pra guardar tudo",
			assistantText: "Fechado, já deixei salvo aqui no Obsidian.",
			toolsUsed: ["obs_remember"],
		});

		const userStyle = service.getUserStyle();
		expect(userStyle.expressions).toEqual(expect.arrayContaining(["bora", "mano"]));
		expect(service.listMemories().length).toBeGreaterThan(0);

		const context = service.buildPromptContext("como funciona o obsidian aqui");
		expect(context).toContain("[PERSONALITY & SPEAKING VOICE");
		expect(context).toContain("[USER CONVERSATION STYLE");
		expect(context).toContain("bora");
		expect(context).toContain("obsidian");
	});

	it("records command reports, finalizes objective conclusions, and surfaces them in prompt context", () => {
		const service = createService();
		const reportPath = service.recordCommandReport({
			objective: "Testar endpoints de autenticação da API",
			toolName: "rt_http_probe",
			commandOrTarget: "https://api.example.com/auth/login",
			outputSummary: "HTTP 200 OK - token validado",
			durationMs: 142,
			sessionId: "sess-1234",
		});

		expect(reportPath).toMatch(/^knowledge\/reports\/\d{4}-\d{2}-\d{2}-/);
		const afterCommand = service.readNote(reportPath as string);
		expect(afterCommand).toContain("rt_http_probe");
		expect(afterCommand).toContain("HTTP 200 OK - token validado");
		expect(afterCommand).toContain("em andamento");

		const finalizedPath = service.finalizeReport({
			reportPath: reportPath ?? undefined,
			objective: "Testar endpoints de autenticação da API",
			conclusion: "Fluxo de login validado sem exposição indevida.",
			toolsUsed: ["rt_http_probe"],
			sessionId: "sess-1234",
		});

		expect(finalizedPath).toBe(reportPath);
		const finalContent = service.readNote(finalizedPath as string);
		expect(finalContent).toContain("concluído");
		expect(finalContent).toContain("Fluxo de login validado sem exposição indevida.");

		const saved = service.saveReport(
			"Pentest API Auth",
			"## Resumo\nNenhuma falha crítica.",
			["api"],
		);
		expect(saved).toMatch(/^knowledge\/reports\/.*pentest-api-auth\.md$/);

		const recallContext = service.buildPromptContext("como foi o teste da api");
		expect(recallContext).toContain("[OBSIDIAN RELEVANT RECALL]");

		const recentContext = service.buildPromptContext("oi");
		expect(recentContext).toContain("[OBSIDIAN RECENT REPORTS]");
	});
});
