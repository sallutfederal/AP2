import { buildClineSystemPrompt } from "@cline/shared";
import type { DelegatedAgentRuntimeConfig } from "./delegated-agent";

const DELEGATED_EXECUTION_DISCIPLINE = `
Execution discipline:
- State what you are doing at most once in a single short sentence at the start. Never repeat or paraphrase the same intent across tool iterations.
- Write 100% complete, production-ready code without shrinking scope, simplifying logic, leaving TODOs/placeholders ("// ..."), or implementing gradually. If a file is huge, continue seamlessly with editor append=true across turns until complete.
- Execute tools directly until the entire delegated objective is finished; do not re-call spawn_agent for the same or overlapping scope.
- Return a concise, concrete, consolidated final output with the verified results.`;

function appendExecutionDiscipline(prompt: string): string {
	const trimmed = prompt.trim();
	if (!trimmed) {
		return DELEGATED_EXECUTION_DISCIPLINE.trim();
	}
	return `${trimmed}\n\n${DELEGATED_EXECUTION_DISCIPLINE.trim()}`;
}

export function buildTeammateSystemPrompt(
	prompt: string,
	config: DelegatedAgentRuntimeConfig,
): string {
	const trimmedPrompt = appendExecutionDiscipline(prompt);
	if (config.providerId.toLowerCase() !== "cline") {
		return trimmedPrompt;
	}

	return buildClineSystemPrompt({
		ide: config.clineIdeName?.trim() || "Terminal",
		workspaceRoot: config.cwd?.trim() || "/",
		providerId: config.providerId,
		rules: `# Team Teammate Role\n${trimmedPrompt}`,
		platform: config.clinePlatform,
		metadata: config.workspaceMetadata,
	});
}

export function buildSubAgentSystemPrompt(
	// The prompt provided when spawning the subagent
	prompt: string,
	config: DelegatedAgentRuntimeConfig,
): string {
	const trimmedPrompt = appendExecutionDiscipline(prompt);
	if (config.providerId.toLowerCase() !== "cline") {
		return trimmedPrompt;
	}

	return buildClineSystemPrompt({
		ide: config.clineIdeName || "Terminal",
		workspaceRoot: config.cwd?.trim() || "/",
		providerId: config.providerId,
		overridePrompt: trimmedPrompt,
		metadata: config.workspaceMetadata,
		platform: config.clinePlatform,
	});
}
