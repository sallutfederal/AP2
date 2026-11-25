import { resolveProviderRequestHeaders } from "@cline/llms";
import type {
	AgentConfig,
	AgentEvent,
	AgentHooks,
	AgentTool,
	BasicLogger,
	ClientContext,
	ExtensionContext,
	ITelemetryService,
	RuntimeConfigExtensionKind,
	SessionPluginIssue,
	ToolApprovalRequest,
	ToolApprovalResult,
	WorkspaceInfo,
} from "@cline/shared";
import {
	buildClineSystemPrompt,
	hasRuntimeConfigExtension,
} from "@cline/shared";
import { version as corePackageVersion } from "../../package.json";
import { CognitiveService } from "../cognitive";
import {
	type AgentPluginPackageDiagnostic,
	loadAgentPluginPackages,
} from "../extensions/agent-plugin";
import type { ConnectorsRequest } from "../extensions/composio/composio-meta-tools";
import { createComposioToolsExtension } from "../extensions/composio/composio-tools-extension";
import {
	resolveAndLoadAgentPlugins,
	resolvePluginSkillDirectoriesFromPaths,
} from "../extensions/plugin/plugin-config-loader";
import type {
	PluginInitializationFailure,
	PluginInitializationWarning,
} from "../extensions/plugin/plugin-load-report";
import { createToolPoliciesWithPreset } from "../extensions/tools/presets";
import { findCodeStubPlaceholder } from "../extensions/tools/helpers";
import type {
	SubAgentEndContext,
	SubAgentStartContext,
	TeamEvent,
} from "../extensions/tools/team";
import { GraphService } from "../graph";
import { SqliteGraphStore } from "../graph/graph-store";
import { ObsidianService } from "../obsidian";
import { ObsidianStore } from "../obsidian/obsidian-store";
import { createCheckpointHooks } from "../hooks/checkpoint-hooks";
import {
	createHookAuditHooks,
	createHookConfigFileExtension,
	mergeAgentHooks,
} from "../hooks/hook-file-hooks";
import { MemoryService, SelfStateService } from "../memory";
import { CommandFilter, SqliteRedTeamStore, StealthMiddleware } from "../redteam";
import { DockerMiddleware } from "../redteam/docker";
import { SqlitePlanStore } from "../redteam/plan-store";
import { SqliteTodoStore } from "../redteam/todo-store";
import type { RuntimeCapabilities } from "../runtime/capabilities";
import { normalizeRuntimeCapabilities } from "../runtime/capabilities";
import type {
	LocalRuntimeStartOptions,
	ResolvedStartSessionInput,
} from "../runtime/host/runtime-host";
import type { RuntimeBuilderInput } from "../runtime/orchestration/session-runtime";
import type { SessionHistoryOriginMetadata } from "../session/history-origin";
import { SessionSource } from "../types/common";
import type { CoreSessionConfig } from "../types/config";
import {
	type ProviderConfig,
	type ProviderSettings,
	toProviderConfig,
} from "../types/provider-settings";
import { resolveWorkspacePath } from "./config";
import {
	filterExtensionToolRegistrations,
	resolveDisabledAgentPluginNames,
} from "./global-settings";
import { hasRuntimeHooks, mergeAgentExtensions } from "./session-data";
import type { ProviderSettingsManager } from "./storage/provider-settings-manager";
import { captureDetachedHookRuntime } from "./telemetry/core-events";
import {
	createClientScopedTelemetryService,
	createScopedTelemetryService,
} from "./telemetry/scoped-telemetry";
import { InMemoryWorkspaceManager } from "./workspace/workspace-manager";
import type { GitWorkspaceState } from "./workspace/workspace-manifest";
import { buildWorkspaceMetadataWithInfo } from "./workspace/workspace-manifest";
import { emitWorkspaceLifecycleTelemetry } from "./workspace/workspace-telemetry";

function formatPluginFailure(failure: PluginInitializationFailure): string {
	const label = failure.pluginName ?? failure.pluginPath;
	return `${label}: ${failure.message}`;
}

function logPluginDiagnostics(
	failures: PluginInitializationFailure[],
	warnings: PluginInitializationWarning[],
	logger: CoreSessionConfig["logger"],
): void {
	if (warnings.length > 0) {
		for (const warning of warnings) {
			logger?.log(warning.message, { severity: "warn" });
		}
	}
	if (failures.length === 0) {
		return;
	}
	const preview = failures.slice(0, 3).map(formatPluginFailure).join("; ");
	const suffix = failures.length > 3 ? `; and ${failures.length - 3} more` : "";
	logger?.log(
		`Some plugins failed to initialize. ${preview}${suffix}. Use --verbose for more details.`,
		{ severity: "warn" },
	);
	for (const failure of failures) {
		logger?.log(
			`Plugin initialization failed (${failure.phase}) for ${failure.pluginPath}`,
			{
				severity: "warn",
				stack: failure.stack,
				pluginPath: failure.pluginPath,
				pluginName: failure.pluginName,
			},
		);
	}
}

function logAgentPluginDiagnostics(
	diagnostics: ReadonlyArray<AgentPluginPackageDiagnostic>,
	logger: BasicLogger | undefined,
): void {
	for (const item of diagnostics) {
		const component = item.componentName ? ` (${item.componentName})` : "";
		logger?.log(
			`[agent-plugins] ${item.pluginName ?? item.pluginPath}${component}: ${item.message}`,
			{ severity: item.level === "warning" ? "warn" : "error" },
		);
	}
}

/**
 * Recover client identity from the Cline request headers baked into the
 * session config. Current Hub clients transport the serializable identity
 * explicitly; these headers preserve attribution for older clients and other
 * transport implementations that only forward the neutral session config.
 */
function resolveClientContextFromHeaders(
	headers: Record<string, string> | undefined,
): ClientContext | undefined {
	const name = headers?.["X-CLIENT-TYPE"]?.trim();
	if (!name) {
		return undefined;
	}
	const version = headers?.["X-CLIENT-VERSION"]?.trim();
	return { name, ...(version ? { version } : {}) };
}

function resolveReasoningSettings(
	config: CoreSessionConfig,
	storedReasoning: ProviderSettings["reasoning"],
): ProviderSettings["reasoning"] {
	const hasThinking = typeof config.thinking === "boolean";
	const hasEffort = typeof config.reasoningEffort === "string";
	if (!hasThinking && !hasEffort) return storedReasoning;
	return {
		...(storedReasoning ?? {}),
		...(hasThinking ? { enabled: config.thinking } : {}),
		...(hasEffort ? { effort: config.reasoningEffort } : {}),
	};
}

function hasConfigExtension(
	extensions: ReadonlyArray<RuntimeConfigExtensionKind> | undefined,
	kind: RuntimeConfigExtensionKind,
): boolean {
	return hasRuntimeConfigExtension(extensions, kind);
}

function resolveBootstrapSystemPrompt(
	config: CoreSessionConfig,
	workspaceInfo: WorkspaceInfo,
	workspaceMetadata: string,
): string {
	if (config.systemPrompt?.trim()) {
		return config.systemPrompt;
	}

	return buildClineSystemPrompt({
		ide: "Terminal Shell",
		workspaceRoot: workspaceInfo.rootPath,
		workspaceName: workspaceInfo.hint,
		metadata: workspaceMetadata,
		rules: config.rules,
		mode: config.mode,
		providerId: config.providerId,
		platform: process.platform || "unknown",
	});
}

function buildProviderConfig(
	config: CoreSessionConfig,
	sessionId: string,
	source: ResolvedStartSessionInput["source"],
	providerSettingsManager: ProviderSettingsManager,
	modelCatalogDefaults?: Partial<ProviderSettings["modelCatalog"]>,
	defaultFetch?: typeof fetch,
): ProviderConfig {
	const stored = providerSettingsManager.getProviderSettings(config.providerId);
	const modelCatalog =
		modelCatalogDefaults || stored?.modelCatalog
			? {
					...(modelCatalogDefaults ?? {}),
					...(stored?.modelCatalog ?? {}),
				}
			: undefined;
	const sessionProviderConfig =
		config.providerConfig?.providerId === config.providerId
			? config.providerConfig
			: undefined;
	const resolvedHeaders = resolveProviderRequestHeaders({
		providerId: config.providerId,
		sessionId,
		source,
		defaultSource: SessionSource.CLI,
		client: {
			name: config.extensionContext?.client?.name,
			version: config.extensionContext?.client?.version,
			versionHeaderFallback: config.headers?.["X-CLIENT-VERSION"],
			platform: config.extensionContext?.client?.platform,
			platformVersion: config.extensionContext?.client?.platformVersion,
			isMultiRoot: config.extensionContext?.client?.isMultiRoot,
		},
		coreVersion: corePackageVersion,
		openAiCodex: {
			accountId: sessionProviderConfig?.accountId ?? stored?.auth?.accountId,
			accessToken:
				sessionProviderConfig?.accessToken ??
				config.apiKey ??
				stored?.auth?.accessToken ??
				stored?.apiKey,
			userAgentVersion: process.env.npm_package_version,
		},
		headers: {
			stored: stored?.headers,
			config: config.headers,
			session: sessionProviderConfig?.headers,
		},
	});
	const settings: ProviderSettings = {
		...(stored ?? {}),
		provider: config.providerId,
		model: config.modelId,
		apiKey: config.apiKey ?? stored?.apiKey,
		baseUrl: config.baseUrl ?? stored?.baseUrl,
		headers: undefined,
		reasoning: resolveReasoningSettings(config, stored?.reasoning),
		modelCatalog,
	};
	const providerConfig: ProviderConfig = {
		...toProviderConfig(settings),
		...(sessionProviderConfig ?? {}),
	};
	if (resolvedHeaders) {
		providerConfig.headers = resolvedHeaders;
	}
	if (config.knownModels) {
		providerConfig.knownModels = config.knownModels;
	}
	if (config.extensionContext) {
		providerConfig.extensionContext = config.extensionContext;
	}
	// Thread a host-provided custom fetch through to the AI gateway providers.
	// Precedence: explicit per-session config > stored provider settings > host default.
	const sessionFetch = (config as { fetch?: typeof fetch }).fetch;
	const resolvedFetch = sessionFetch ?? providerConfig.fetch ?? defaultFetch;
	if (resolvedFetch) {
		providerConfig.fetch = resolvedFetch;
	}
	return providerConfig;
}

const NON_REPORTED_TOOLS = new Set([
	"read_files",
	"search_codebase",
	"skills",
	"ask_question",
	"memory_store",
	"memory_recall",
	"memory_forget",
	"memory_list",
	"self_state",
	"goal_push",
	"goal_complete",
	"goal_fail",
	"belief_add",
	"open_question",
	"resolve_question",
	"reflect",
	"introspect",
	"cog_reflect",
	"cog_profile",
	"graph_query",
	"rt_reference",
	"rt_asset_add",
	"rt_asset_list",
	"rt_asset_tested",
	"rt_coverage",
	"rt_explore_add",
	"rt_explore_list",
	"rt_explore_update",
	"rt_anchor",
	"rt_trace_log",
	"rt_trace_search",
	"rt_trace_by_intent",
	"rt_trace_by_task",
	"rt_todo_list",
	"rt_todo_next",
	"rt_todo_add",
	"rt_todo_start",
	"rt_todo_done",
	"rt_todo_block",
	"rt_todo_clear",
	"rt_plan_list",
	"rt_plan_status",
	"rt_plan_next",
	"rt_scope_check",
	"rt_scope_set",
	"rt_dry_run",
	"rt_kill_switch",
	"rt_stealth_config",
	"rt_cred_lookup",
	"rt_cred_vault_list",
	"rt_skill_list",
	"rt_skill_search",
	"rt_skill_load",
	"rt_auto_log",
	"rt_parse_nmap",
	"rt_parse_nuclei",
]);

const SPAWN_STOPWORDS = new Set([
	"para",
	"com",
	"nos",
	"nas",
	"das",
	"dos",
	"que",
	"uma",
	"como",
	"sobre",
	"cada",
	"outras",
	"outros",
	"testar",
	"teste",
	"testes",
	"executar",
	"analise",
	"realizar",
	"identificar",
	"endpoints",
	"endpoint",
	"fornecidos",
	"especificados",
	"api",
	"the",
	"and",
	"for",
	"with",
	"test",
	"tests",
]);

function extractSpawnUrls(text: string): Set<string> {
	const matches = text.match(/https?:\/\/[^\s"'<>)\]]+|\/api\/[a-zA-Z0-9_./-]+/gi);
	return new Set((matches ?? []).map((m) => m.toLowerCase().replace(/[,.;:]+$/, "")));
}

function tokenizeSpawnTask(text: string): Set<string> {
	const cleaned = text
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/https?:\/\/[^\s"'<>)\]]+/g, " ");
	const tokens = cleaned
		.split(/[^a-z0-9]+/)
		.filter((t) => t.length >= 3 && !SPAWN_STOPWORDS.has(t));
	return new Set(tokens);
}

function isDuplicateSpawnTask(
	previous: { tokens: Set<string>; urls: Set<string> },
	nextTokens: Set<string>,
	nextUrls: Set<string>,
): boolean {
	if (nextUrls.size > 0) {
		for (const url of nextUrls) {
			if (!previous.urls.has(url)) {
				return false;
			}
		}
	}
	if (previous.tokens.size === 0 || nextTokens.size === 0) {
		return previous.urls.size > 0 && nextUrls.size > 0;
	}
	let intersection = 0;
	for (const token of nextTokens) {
		if (previous.tokens.has(token)) {
			intersection += 1;
		}
	}
	const union = previous.tokens.size + nextTokens.size - intersection;
	return union > 0 && intersection / union >= 0.65;
}

function isOperationalToolSuccess(
	toolName: string,
	isError: boolean | undefined,
	output: unknown,
): boolean {
	if (isError) return false;
	if (
		NON_REPORTED_TOOLS.has(toolName) ||
		toolName.startsWith("obs_") ||
		toolName.startsWith("memory_") ||
		toolName.startsWith("cg_") ||
		toolName.startsWith("goal_") ||
		toolName.startsWith("rt_ref_")
	) {
		return false;
	}
	if (toolName === "run_commands" && Array.isArray(output)) {
		return output.some(
			(item) =>
				item &&
				typeof item === "object" &&
				(item as { success?: unknown }).success === true,
		);
	}
	if (output && typeof output === "object" && !Array.isArray(output)) {
		const record = output as Record<string, unknown>;
		if (typeof record.code === "number" && record.code !== 0) {
			return false;
		}
		if (record.success === false) {
			return false;
		}
		if (record.stdout === "[dry-run]" || record.stdout === "killed") {
			return false;
		}
	}
	return true;
}

function extractToolCommandTarget(
	toolName: string,
	input: unknown,
	output: unknown,
): string {
	if (toolName === "run_commands" && Array.isArray(output)) {
		const queries = output
			.filter(
				(item): item is { query?: string; success?: boolean } =>
					Boolean(item) &&
					typeof item === "object" &&
					(item as { success?: boolean }).success === true,
			)
			.map((item) => item.query?.trim())
			.filter((q): q is string => Boolean(q));
		if (queries.length > 0) {
			return queries.join(" ; ").slice(0, 240);
		}
	}
	if (input && typeof input === "object" && !Array.isArray(input)) {
		const rec = input as Record<string, unknown>;
		for (const key of [
			"url",
			"target",
			"domain",
			"host",
			"command",
			"path",
			"task",
			"query",
			"title",
		]) {
			const val = rec[key];
			if (typeof val === "string" && val.trim()) {
				return val.trim().slice(0, 240);
			}
		}
		try {
			return JSON.stringify(rec).slice(0, 240);
		} catch {
			return toolName;
		}
	}
	if (typeof input === "string" && input.trim()) {
		return input.trim().slice(0, 240);
	}
	return toolName;
}

function formatToolOutputForReport(toolName: string, output: unknown): string {
	if (toolName === "run_commands" && Array.isArray(output)) {
		const lines: string[] = [];
		for (const item of output) {
			if (!item || typeof item !== "object") continue;
			const rec = item as {
				query?: string;
				result?: unknown;
				success?: boolean;
			};
			if (rec.success !== true) continue;
			const cmdText = rec.query ? `$ ${rec.query}` : "$ command";
			const resText =
				typeof rec.result === "string"
					? rec.result.trim()
					: JSON.stringify(rec.result ?? "");
			lines.push(`${cmdText}\n${resText.slice(0, 800)}`);
		}
		return lines.join("\n\n").slice(0, 1600);
	}
	if (
		toolName === "spawn_agent" &&
		output &&
		typeof output === "object" &&
		"text" in output &&
		typeof (output as { text?: unknown }).text === "string"
	) {
		return (output as { text: string }).text.trim().slice(0, 1600);
	}
	if (typeof output === "string") {
		return output.trim().slice(0, 1600);
	}
	try {
		return JSON.stringify(output, null, 2).slice(0, 1600);
	} catch {
		return String(output ?? "").slice(0, 1600);
	}
}

function assistantHadNarrationInLatestTurn(
	messages: ReadonlyArray<{
		role: string;
		content: ReadonlyArray<{ type: string }>;
	}>,
): boolean {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (!msg) continue;
		if (msg.role === "user") return false;
		if (msg.role !== "assistant") continue;
		const text = msg.content
			.filter(
				(part): part is { type: "text"; text: string } =>
					part.type === "text" &&
					"text" in part &&
					typeof (part as { text?: unknown }).text === "string",
			)
			.map((part) => part.text)
			.join(" ")
			.trim();
		return text.length >= 15;
	}
	return false;
}

export interface PrepareLocalRuntimeBootstrapOptions {
	input: ResolvedStartSessionInput;
	localRuntime?: LocalRuntimeStartOptions;
	sessionId: string;
	/**
	 * How the session was initiated (user, automation, import, ...). Stamped
	 * on every telemetry event the session emits so errors can be filtered by
	 * provenance, e.g. transcripts imported from another agent.
	 */
	sessionOrigin?: SessionHistoryOriginMetadata;
	providerSettingsManager: ProviderSettingsManager;
	defaultTelemetry?: ITelemetryService;
	defaultLogger?: BasicLogger;
	defaultCapabilities?: RuntimeCapabilities;
	defaultToolPolicies?: AgentConfig["toolPolicies"];
	/**
	 * Host-level default `fetch` threaded into `ProviderConfig.fetch` so the
	 * AI gateway providers can use a custom HTTP implementation.
	 */
	defaultFetch?: typeof fetch;
	connectorsRequest?: ConnectorsRequest;
	onPluginEvent: (event: { name: string; payload?: unknown }) => void;
	/** A plugin this session uses became degraded or failed after start. */
	onPluginIssue?: (issue: SessionPluginIssue) => void;
	onTeamEvent: (event: TeamEvent) => void;
	createSubAgentLifecycleCallbacks?: (config: CoreSessionConfig) => {
		onSubAgentEvent?: (event: AgentEvent) => void;
		onSubAgentStart?: (context: SubAgentStartContext) => void | Promise<void>;
		onSubAgentEnd?: (context: SubAgentEndContext) => void | Promise<void>;
	};
	createSpawnTool: () => AgentTool;
	readSessionMetadata: () => Promise<Record<string, unknown> | undefined>;
	writeSessionMetadata: (
		metadata: Record<string, unknown>,
	) => Promise<void> | void;
}

export interface LocalRuntimeBootstrap {
	effectiveInput: ResolvedStartSessionInput;
	config: CoreSessionConfig;
	providerConfig: ProviderConfig;
	workspaceMetadata: string;
	/** Structured git + path metadata generated alongside workspaceMetadata. */
	workspaceInfo: WorkspaceInfo;
	gitState: GitWorkspaceState;
	extensions: AgentConfig["extensions"];
	hooks: AgentHooks | undefined;
	toolPolicies: AgentConfig["toolPolicies"];
	requestToolApproval?: (
		request: ToolApprovalRequest,
	) => Promise<ToolApprovalResult> | ToolApprovalResult;
	pluginSandboxShutdown?: () => Promise<void>;
	/** Plugins the session asked for but does not have (failed or disabled). */
	pluginIssues: SessionPluginIssue[];
	pluginCommandError?: string;
	runtimeBuilderInput: RuntimeBuilderInput;
}

export async function prepareLocalRuntimeBootstrap(
	options: PrepareLocalRuntimeBootstrapOptions,
): Promise<LocalRuntimeBootstrap> {
	const {
		input,
		sessionId,
		sessionOrigin,
		providerSettingsManager,
		defaultTelemetry,
		defaultLogger,
		defaultCapabilities,
		defaultToolPolicies,
		defaultFetch,
		connectorsRequest,
		onPluginEvent,
		onPluginIssue,
		onTeamEvent,
		createSubAgentLifecycleCallbacks,
		createSpawnTool,
		localRuntime,
		readSessionMetadata,
		writeSessionMetadata,
	} = options;
	const workspacePath = resolveWorkspacePath(input.config);
	const {
		modelCatalogDefaults,
		userInstructionService,
		configExtensions,
		onTeamRestored,
		...localConfigFields
	} = localRuntime ?? {};
	const localConfig =
		Object.keys(localConfigFields).length > 0
			? (localConfigFields as Partial<CoreSessionConfig>)
			: undefined;

	// Generate workspace + git metadata once, early, so it can be forwarded to
	// hooks and extensions. The serialized string goes into CoreSessionConfig
	// as workspaceMetadata; the structured object is kept as workspaceInfo.
	const {
		workspaceInfo,
		workspaceMetadata,
		gitState,
		durationMs,
		vcsType,
		initError,
	} = await buildWorkspaceMetadataWithInfo(workspacePath);
	const configuredExtensionContext = localConfig?.extensionContext;
	const headerClientContext = configuredExtensionContext?.client
		? undefined
		: resolveClientContextFromHeaders(input.config.headers);
	const clientContext =
		configuredExtensionContext?.client ?? headerClientContext;
	const configuredTelemetry =
		configuredExtensionContext?.telemetry ?? localConfig?.telemetry;
	// Hub-backed sessions execute inside a shared daemon and therefore inherit
	// its process telemetry service. Scope that singleton to the serialized
	// client identity without mutating it; local clients already carry their
	// own telemetry instance and keep using it directly.
	const clientTelemetry =
		configuredTelemetry ??
		(defaultTelemetry && clientContext
			? createClientScopedTelemetryService(defaultTelemetry, {
					client: clientContext,
					source: input.source,
					user: configuredExtensionContext?.user,
				})
			: defaultTelemetry);
	const telemetry =
		clientTelemetry && sessionOrigin
			? createScopedTelemetryService(clientTelemetry, {
					session_origin: sessionOrigin.mode,
					session_origin_trigger: sessionOrigin.trigger,
				})
			: clientTelemetry;
	const extensionContext: ExtensionContext = {
		...(configuredExtensionContext ?? {}),
		...(headerClientContext ? { client: headerClientContext } : {}),
		workspace: {
			...workspaceInfo,
			...(configuredExtensionContext?.workspace ?? {}),
		},
		session: {
			...(configuredExtensionContext?.session ?? {}),
			sessionId,
		},
		logger:
			configuredExtensionContext?.logger ??
			localConfig?.logger ??
			defaultLogger,
		telemetry,
	};
	emitWorkspaceLifecycleTelemetry({
		telemetry: extensionContext.telemetry,
		rootPath: workspaceInfo.rootPath,
		dedupeScope: extensionContext.client?.name ?? input.source,
		workspaceInfo,
		rootCount: 1,
		vcsType,
		durationMs,
		initError,
		featureFlagEnabled: true,
	});

	// Hosts with their own hook execution layer (the VS Code extension's
	// hooks adapter) exclude "hooks" so file hooks run exactly once.
	const fileHookExtension = hasConfigExtension(configExtensions, "hooks")
		? createHookConfigFileExtension({
				cwd: input.config.cwd,
				workspacePath,
				rootSessionId: sessionId,
				logger: localConfig?.logger,
				workspaceInfo,
				// Detached hooks are never awaited, so their runtime is
				// invisible today. Measuring it is what tells us whether
				// run-start hooks could safely become blocking.
				onHookRuntime: (event) =>
					captureDetachedHookRuntime(extensionContext.telemetry, event),
			})
		: undefined;
	const auditHooks = hasRuntimeHooks(localConfig?.hooks)
		? undefined
		: createHookAuditHooks({
				rootSessionId: sessionId,
				workspacePath,
				workspaceInfo,
			});
	const baseHooks = mergeAgentHooks([localConfig?.hooks, auditHooks]);

	let pluginCommandError: string | undefined;
	let loadedPlugins:
		| Awaited<ReturnType<typeof resolveAndLoadAgentPlugins>>
		| undefined;
	const pluginIssues: SessionPluginIssue[] = [];
	if (hasConfigExtension(configExtensions, "plugins")) {
		try {
			loadedPlugins = await resolveAndLoadAgentPlugins({
				pluginPaths: localConfig?.pluginPaths,
				workspacePath,
				cwd: input.config.cwd,
				onEvent: onPluginEvent,
				providerId: input.config.providerId,
				modelId: input.config.modelId,
				workspaceInfo,
				session: extensionContext.session,
				client: extensionContext.client,
				user: extensionContext.user,
				logger: extensionContext.logger,
				telemetry: extensionContext.telemetry,
				automation: extensionContext.automation,
				policy: input.plugins,
				hookErrorMode: input.config.hookErrorMode,
				onIssue: onPluginIssue,
			});
			pluginIssues.push(...(loadedPlugins.issues ?? []));
			pluginCommandError = loadedPlugins.failures.length
				? loadedPlugins.failures.map((f) => f.message).join("; ")
				: undefined;
			logPluginDiagnostics(
				loadedPlugins.failures,
				loadedPlugins.warnings,
				localConfig?.logger ?? extensionContext.logger,
			);
		} catch (error) {
			// The registry reports per-plugin failures itself; reaching this
			// means discovery as a whole broke. Surface it like a plugin issue
			// so the client can show it instead of silently dropping plugins.
			const message = error instanceof Error ? error.message : String(error);
			(localConfig?.logger ?? extensionContext.logger)?.log(
				`Plugin loading failed; the session has no plugins: ${message}`,
				{ severity: "error", sessionId },
			);
			pluginCommandError = message;
			pluginIssues.push({
				name: "plugins",
				pluginPath: workspacePath,
				state: "failed",
				reason: "error",
				lastError: {
					phase: "discover",
					message,
					stack: error instanceof Error ? error.stack : undefined,
					pluginPath: workspacePath,
					timestamp: Date.now(),
					sessionId,
				},
			});
		}
	}

	let loadedAgentPluginPackages:
		| Awaited<ReturnType<typeof loadAgentPluginPackages>>
		| undefined;
	if (hasConfigExtension(configExtensions, "plugins")) {
		try {
			loadedAgentPluginPackages = await loadAgentPluginPackages({
				pluginPaths: input.config.agentPluginPaths,
				cwd: input.config.cwd,
				disabledPluginNames: [...resolveDisabledAgentPluginNames()],
			});
			logAgentPluginDiagnostics(
				loadedAgentPluginPackages.diagnostics,
				extensionContext.logger,
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			extensionContext.logger?.log(
				`[agent-plugins] Package discovery failed; continuing without Agent Plugins: ${message}`,
				{ severity: "error" },
			);
		}
	}

	// Composio registers only search/connect/execute meta tools in-process,
	// independently of persisted desktop connections. Compiled hosts cannot
	// spawn the drop-in plugin sandbox.
	const composioToolsExtension = await createComposioToolsExtension({
		request: connectorsRequest,
		logger: localConfig?.logger,
	});
	const builtInExtensionList = [
		...(fileHookExtension ? [fileHookExtension] : []),
		...(composioToolsExtension ? [composioToolsExtension] : []),
	];
	const builtInExtensions =
		builtInExtensionList.length > 0 ? builtInExtensionList : undefined;
	const extensions = mergeAgentExtensions(
		builtInExtensions,
		mergeAgentExtensions(
			localConfig?.extensions,
			filterExtensionToolRegistrations(loadedPlugins?.extensions),
		),
	);
	const pluginSkillDirectories = hasConfigExtension(configExtensions, "plugins")
		? resolvePluginSkillDirectoriesFromPaths(loadedPlugins?.pluginPaths ?? [])
		: undefined;
	const memoryAgentId = "ap2";
	const memoryWorkspaceRoot =
		workspaceInfo?.rootPath ?? input.config.workspaceRoot;
	const memoryService = new MemoryService({
		defaultAgentId: memoryAgentId,
		defaultWorkspaceRoot: memoryWorkspaceRoot,
	});
	const selfStateService = new SelfStateService({
		defaultAgentId: memoryAgentId,
		defaultCapabilities: [
			"reconnaissance",
			"vulnerability_discovery",
			"exploitation",
			"post_exploitation",
			"evasion",
			"persistence",
			"credential_access",
			"lateral_movement",
			"privilege_escalation",
			"osint",
			"reporting",
			"tool_execution",
			"memory_management",
			"planning",
			"docker_operations",
		],
	});
	const cognitiveService = new CognitiveService({
		agentId: memoryAgentId,
		sessionId,
		workspaceRoot: memoryWorkspaceRoot,
	});
	const stealthMiddleware = new StealthMiddleware();
	const dockerMiddleware = new DockerMiddleware();
	const planStore = new SqlitePlanStore();
	const todoStore = new SqliteTodoStore();
	const redTeamStore = new SqliteRedTeamStore();
	const commandFilter = new CommandFilter();
	try {
		redTeamStore.init();
		commandFilter.setAllowlist(redTeamStore.getScopeTargets());
	} catch {
		// ignore store init errors
	}
	const graphStore = new SqliteGraphStore();
	const graphService = new GraphService({
		store: graphStore,
		taskId: sessionId,
		workerId: sessionId,
	});
	const obsidianStore = new ObsidianStore();
	const obsidianService = new ObsidianService({ store: obsidianStore, agentName: "AP2" });

	// Identity persistence in memory
	const identityMemoryKey = "ap2.identity.lock";
	const identityStored =
		memoryService.recall({ kinds: ["skill"], limit: 1 }).length > 0;
	if (!identityStored) {
		try {
			memoryService.store({
				kind: "skill",
				key: identityMemoryKey,
				value:
					"I am AP2, a red-team operator and technical partner with my own direct, natural voice in Brazilian Portuguese. I persist memories, knowledge, and conversation style in Obsidian.",
				confidence: 1.0,
				tags: ["identity", "ap2", "redteam", "obsidian"],
			});
		} catch {
			// ignore
		}
	}

	let turnCount = 0;
	interface RunGuardState {
		userGoal: string;
		reportPath?: string;
		successfulCount: number;
		spawnCalls: Array<{
			task: string;
			tokens: Set<string>;
			urls: Set<string>;
		}>;
		skippedSpawnCallIds: Set<string>;
		lastNudgedIteration: number;
	}
	const runGuards = new Map<string, RunGuardState>();
	const getRunGuard = (runId?: string, agentId?: string): RunGuardState => {
		const key = runId || agentId || "default";
		let guard = runGuards.get(key);
		if (!guard) {
			if (runGuards.size >= 100) {
				const oldestKey = runGuards.keys().next().value;
				if (oldestKey !== undefined) runGuards.delete(oldestKey);
			}
			guard = {
				userGoal: "",
				successfulCount: 0,
				spawnCalls: [],
				skippedSpawnCallIds: new Set<string>(),
				lastNudgedIteration: 0,
			};
			runGuards.set(key, guard);
		}
		return guard;
	};
	const extractLatestUserMessage = (
		messages: ReadonlyArray<{
			role: string;
			content: ReadonlyArray<{ type: string }>;
			metadata?: Record<string, unknown>;
		}>,
	): string => {
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (!msg || msg.role !== "user" || msg.metadata?.displayRole === "system") {
				continue;
			}
			const text = msg.content
				.filter(
					(part): part is { type: "text"; text: string } =>
						part.type === "text" &&
						"text" in part &&
						typeof (part as { text?: unknown }).text === "string",
				)
				.map((part) => part.text)
				.join("\n")
				.trim();
			if (text && !text.startsWith("<hook_context")) {
				return text;
			}
		}
		return "";
	};

	const memoryRecallHook: AgentHooks["beforeRun"] = async (ctx) => {
		turnCount++;
		try {
			const latestUserText = extractLatestUserMessage(ctx.snapshot.messages);
			const guard = getRunGuard(ctx.snapshot.runId, ctx.snapshot.agentId);
			if (latestUserText && !guard.userGoal) {
				guard.userGoal = latestUserText;
			}
			const obsidianContext = obsidianService.buildPromptContext(latestUserText);
			const memories = memoryService.recall({
				query: latestUserText || undefined,
				limit: 25,
			});
			const recentMemories =
				memories.length > 0
					? memories
					: memoryService.recall({ limit: 25 });
			const selfState = selfStateService.get(memoryAgentId);
			const profile = cognitiveService.getProfile();
			const predictions = cognitiveService.getPredictions(5);
			const reflections = cognitiveService.getReflections(10);
			const context = cognitiveService.getContext(20);
			const parts: string[] = [];
			if (obsidianContext) parts.push(obsidianContext);
			const memText = memoryService.formatForPrompt(recentMemories, 3000);
			if (memText) parts.push(memText);
			const stateText = selfStateService.formatForPrompt(selfState, 1500);
			if (stateText) parts.push(stateText);
			const cogParts: string[] = [];
			cogParts.push(
				`User: ${profile.name} | Engagement: ${profile.engagementLevel.toFixed(2)} | Commands: ${profile.totalCommands} | Avg wait: ${profile.avgWaitMs.toFixed(0)}ms`,
			);
			if (predictions.length > 0) {
				cogParts.push(
					`Predictions: ${predictions.map((p) => p.predictedRequest).join(", ")}`,
				);
			}
			if (reflections.length > 0) {
				cogParts.push(
					`Reflections: ${reflections
						.slice(0, 3)
						.map((r) => r.insight)
						.join("; ")}`,
				);
			}
			if (context.length > 0) {
				cogParts.push(
					`Recent context: ${context
						.slice(0, 5)
						.map((c) => c.content.slice(0, 100))
						.join(" | ")}`,
				);
			}
			if (cogParts.length > 0)
				parts.push(`[Cognitive]\n${cogParts.join("\n")}`);
			if (turnCount % 4 === 0 || turnCount === 1) {
				const personality = obsidianService.getPersonality();
				const userStyle = obsidianService.getUserStyle();
				const voiceLine = personality
					? `Você é ${personality.nickname}. Estilo: ${personality.style}. Traços: ${personality.traits.join(", ")}. Como falar com ${userStyle.preferredName}: ${personality.howToTalkToUser}`
					: `Você é AP2, direto, autêntico e sem fala robótica de chatbot.`;
				parts.push(
					`[IDENTITY & VOICE REMINDER] ${voiceLine} Use sua própria personalidade de fala (nunca respostas genéricas de assistente) e salve novos conhecimentos/memórias/estilo no Obsidian (obs_save_knowledge, obs_remember, obs_update_user_style, obs_set_personality) sempre que aprender algo relevante.`,
				);
			}
			if (
				latestUserText &&
				/\b(cria|crie|criar|faz|faça|fazer|implement|gera|gere|gerar|desenvolv|constr|build|create|write|generate|c[oó]digo|sistema|projeto|arquitetura|linhas|m[oó]dulos|app|api)\b/i.test(
					latestUserText,
				)
			) {
				parts.push(
					"[FULL-CODE DIRECTIVE] PROIBIDO repartir, simplificar, abreviar ou implementar gradualmente. Gere TODOS os módulos e arquivos 100% completos, reais e prontos para produção (ZERO TODOs, ZERO '// ...', ZERO esqueletos). Use múltiplas chamadas editor/apply_patch por turno, use editor com append=true para arquivos individuais enormes e continue entre turnos automaticamente até 100% do código existir completo em disco.",
				);
			}
			if (parts.length === 0) return undefined;
			return { appendContext: parts.join("\n\n") };
		} catch {
			return undefined;
		}
	};

	const beforeToolHook: AgentHooks["beforeTool"] = async (ctx) => {
		if (ctx.toolCall.toolName === "run_commands") {
			const inputRecord =
				ctx.input && typeof ctx.input === "object"
					? (ctx.input as Record<string, unknown>)
					: undefined;
			const commands = Array.isArray(inputRecord?.commands)
				? inputRecord.commands.filter((c): c is string => typeof c === "string")
				: typeof inputRecord?.command === "string"
					? [inputRecord.command]
					: [];
			for (const cmd of commands) {
				const check = commandFilter.check(cmd);
				if (!check.allowed) {
					return {
						skip: true,
						reason: `Command blocked by security filter (${check.layer}): ${check.reason}`,
					};
				}
			}
		}
		if (ctx.toolCall.toolName === "editor") {
			const inputRecord =
				ctx.input && typeof ctx.input === "object"
					? (ctx.input as Record<string, unknown>)
					: undefined;
			const targetPath =
				typeof inputRecord?.path === "string" ? inputRecord.path.trim() : "";
			const vaultRoot = obsidianService.getVaultPath().toLowerCase();
			if (
				targetPath &&
				/(?:^|[\\/])(?:report|relatorio)[-_a-z0-9]*\.md$/i.test(targetPath) &&
				!targetPath.toLowerCase().startsWith(vaultRoot)
			) {
				return {
					skip: true,
					reason: `Reports must NEVER be created outside the Obsidian vault (${obsidianService.getVaultPath()}). Use obs_save_report (saves to knowledge/reports/) or obs_write_note instead.`,
				};
			}
		}
		if (ctx.toolCall.toolName !== "spawn_agent") {
			return undefined;
		}
		try {
			const inputRecord =
				ctx.input && typeof ctx.input === "object"
					? (ctx.input as Record<string, unknown>)
					: undefined;
			const taskText =
				typeof inputRecord?.task === "string" ? inputRecord.task.trim() : "";
			if (!taskText) {
				return undefined;
			}
			const guard = getRunGuard(ctx.snapshot.runId, ctx.snapshot.agentId);
			const nextTokens = tokenizeSpawnTask(taskText);
			const nextUrls = extractSpawnUrls(taskText);
			const isDup = guard.spawnCalls.some((prev) =>
				isDuplicateSpawnTask(prev, nextTokens, nextUrls),
			);
			if (isDup) {
				guard.skippedSpawnCallIds.add(ctx.toolCall.toolCallId);
				return {
					skip: true,
					reason:
						"Duplicate spawn_agent blocked: you already delegated this same/overlapping scope in this run. Use the subagent result already returned, run any remaining distinct checks directly with your tools, or conclude the objective now without repeating announcements.",
				};
			}
			guard.spawnCalls.push({
				task: taskText,
				tokens: nextTokens,
				urls: nextUrls,
			});
		} catch {
			// ignore guard errors
		}
		return undefined;
	};

	const afterModelHook: AgentHooks["afterModel"] = async () => {
		return undefined;
	};

	const afterToolHook: AgentHooks["afterTool"] = async (ctx) => {
		try {
			cognitiveService.recordCommand(
				ctx.toolCall.toolName,
				ctx.durationMs,
				!ctx.result.isError,
			);
		} catch {
			// ignore
		}

		const guard = getRunGuard(ctx.snapshot.runId, ctx.snapshot.agentId);
		if (!guard.userGoal) {
			guard.userGoal = extractLatestUserMessage(ctx.snapshot.messages);
		}

		try {
			if (
				isOperationalToolSuccess(
					ctx.toolCall.toolName,
					ctx.result.isError,
					ctx.result.output,
				)
			) {
				const commandOrTarget = extractToolCommandTarget(
					ctx.toolCall.toolName,
					ctx.input,
					ctx.result.output,
				);
				const outputSummary = formatToolOutputForReport(
					ctx.toolCall.toolName,
					ctx.result.output,
				);
				const savedPath = obsidianService.recordCommandReport({
					reportPath: guard.reportPath,
					objective: guard.userGoal || commandOrTarget,
					toolName: ctx.toolCall.toolName,
					commandOrTarget,
					outputSummary,
					durationMs: ctx.durationMs,
					sessionId,
				});
				if (savedPath) {
					guard.reportPath = savedPath;
				}
				guard.successfulCount += 1;
				try {
					graphService.logTrace({
						stepNumber: ctx.snapshot.iteration,
						command: `${ctx.toolCall.toolName}: ${commandOrTarget}`,
						output: outputSummary.slice(0, 1000),
						observation: "operational_tool_success",
					});
				} catch {
					// ignore graph trace errors
				}
			}
		} catch {
			// ignore reporting failures
		}

		if (ctx.toolCall.toolName === "spawn_agent") {
			if (guard.skippedSpawnCallIds.delete(ctx.toolCall.toolCallId)) {
				return undefined;
			}
			if (ctx.result.isError) {
				const inputRecord =
					ctx.input && typeof ctx.input === "object"
						? (ctx.input as Record<string, unknown>)
						: undefined;
				const taskText =
					typeof inputRecord?.task === "string" ? inputRecord.task.trim() : "";
				const idx = guard.spawnCalls.findIndex((s) => s.task === taskText);
				if (idx !== -1) {
					guard.spawnCalls.splice(idx, 1);
				}
				return undefined;
			}
			guard.lastNudgedIteration = ctx.snapshot.iteration;
			return {
				appendContext:
					"[EXECUTION DISCIPLINE] spawn_agent finished. Do NOT repeat the task announcement or call spawn_agent again for the same/overlapping objective. Work from the returned result directly, execute only distinct remaining steps with minimal narration, or conclude now.",
			};
		}

		if (
			!ctx.result.isError &&
			(ctx.toolCall.toolName === "editor" ||
				ctx.toolCall.toolName === "apply_patch")
		) {
			const inputRecord =
				ctx.input && typeof ctx.input === "object"
					? (ctx.input as Record<string, unknown>)
					: undefined;
			const writtenCode =
				ctx.toolCall.toolName === "editor" &&
				typeof inputRecord?.new_text === "string"
					? inputRecord.new_text
					: ctx.toolCall.toolName === "apply_patch" &&
							typeof inputRecord?.input === "string"
						? inputRecord.input
						: "";
			const stubLabel = findCodeStubPlaceholder(writtenCode);
			if (stubLabel) {
				guard.lastNudgedIteration = ctx.snapshot.iteration;
				return {
					appendContext: `[CODE COMPLETENESS GUARD] Você inseriu ${stubLabel} em ${ctx.toolCall.toolName}. Substitua imediatamente esse trecho incompleto pela implementação 100% real, completa e funcional sem resumir nem simplificar código.`,
				};
			}
		}

		if (
			assistantHadNarrationInLatestTurn(ctx.snapshot.messages) &&
			guard.lastNudgedIteration !== ctx.snapshot.iteration
		) {
			guard.lastNudgedIteration = ctx.snapshot.iteration;
			return {
				appendContext:
					"[EXECUTION DISCIPLINE] You already announced what you are doing. Do NOT repeat or paraphrase that announcement ('Vou testar...', 'Vou executar...', etc.). Call the next tool directly without repetitive text, or deliver the final conclusion once complete.",
			};
		}

		return undefined;
	};

	const afterRunHook: AgentHooks["afterRun"] = async (ctx) => {
		const runKey = ctx.result.runId || ctx.snapshot.agentId || "default";
		const guard = runGuards.get(runKey);
		try {
			const messages = ctx.result.messages;
			const lastUserText = extractLatestUserMessage(messages);
			const toolsUsed: string[] = [];
			for (const msg of messages) {
				if (msg.role !== "assistant") continue;
				for (const part of msg.content) {
					if (part.type === "tool-call") {
						toolsUsed.push(part.toolName);
					}
				}
			}
			const assistantText = ctx.result.outputText?.trim() || undefined;
			obsidianService.learnFromTurn({
				userText: lastUserText || undefined,
				assistantText,
				toolsUsed,
				sessionId,
			});
			const shouldFinalizeReport =
				ctx.result.status === "completed" &&
				((guard?.successfulCount ?? 0) > 0 ||
					(toolsUsed.length > 0 && (assistantText?.length ?? 0) >= 80));
			if (shouldFinalizeReport) {
				obsidianService.finalizeReport({
					reportPath: guard?.reportPath,
					objective:
						guard?.userGoal || lastUserText || "Objetivo Concluído",
					conclusion: assistantText || "Objetivo concluído com sucesso.",
					toolsUsed,
					sessionId,
				});
			}
			if (lastUserText) {
				cognitiveService.addContext("user", lastUserText.slice(0, 1000), 0.7);
			}
			if (assistantText) {
				cognitiveService.addContext(
					"assistant",
					assistantText.slice(0, 1000),
					0.6,
				);
			}
		} catch {
			// ignore
		} finally {
			runGuards.delete(runKey);
		}
	};

	const baseHooksWithMemory = mergeAgentHooks([
		baseHooks,
		{
			beforeRun: memoryRecallHook,
			beforeTool: beforeToolHook,
			afterModel: afterModelHook,
			afterTool: afterToolHook,
			afterRun: afterRunHook,
		},
	]);

	const baseConfig: CoreSessionConfig = {
		...input.config,
		...(localConfig ?? {}),
		sessionId,
		hooks: baseHooksWithMemory,
		extensions,
		extensionContext,
		telemetry: extensionContext.telemetry,
		logger: extensionContext.logger,
		memoryService,
		selfStateService,
		stealthMiddleware,
		cognitiveService,
		dockerMiddleware,
		planStore,
		todoStore,
		redTeamStore,
		commandFilter,
		graphService,
		obsidianService,
		toolPolicies: createToolPoliciesWithPreset("yolo"),
	};
	const providerConfig = buildProviderConfig(
		baseConfig,
		sessionId,
		input.source,
		providerSettingsManager,
		modelCatalogDefaults,
		defaultFetch,
	);
	const hooks = mergeAgentHooks([
		baseConfig.hooks,
		baseConfig.checkpoint?.enabled === true
			? createCheckpointHooks({
					cwd: baseConfig.cwd,
					sessionId,
					logger: baseConfig.logger,
					createCheckpoint: baseConfig.checkpoint?.createCheckpoint,
					telemetry: baseConfig.telemetry,
					readSessionMetadata,
					writeSessionMetadata,
				})
			: undefined,
	]);
	const config: CoreSessionConfig = {
		...baseConfig,
		providerConfig,
		workspaceMetadata,
		systemPrompt: resolveBootstrapSystemPrompt(
			baseConfig,
			workspaceInfo,
			workspaceMetadata,
		),
		hooks,
	};
	const toolPolicies =
		input.toolPolicies ?? baseConfig.toolPolicies ?? defaultToolPolicies;
	const capabilities = normalizeRuntimeCapabilities(
		defaultCapabilities,
		input.capabilities,
	);
	const requestToolApproval = capabilities?.requestToolApproval;
	const effectiveToolExecutors = capabilities?.toolExecutors;
	const subAgentLifecycleCallbacks = createSubAgentLifecycleCallbacks?.(config);
	const workspaceManager = new InMemoryWorkspaceManager({
		currentWorkspacePath: workspaceInfo.rootPath,
		workspaces: {
			[workspaceInfo.rootPath]: workspaceInfo,
		},
	});

	return {
		effectiveInput: input,
		config,
		providerConfig,
		workspaceMetadata,
		workspaceInfo,
		gitState,
		extensions,
		hooks,
		toolPolicies,
		requestToolApproval,
		pluginSandboxShutdown: loadedPlugins?.shutdown,
		pluginIssues,
		pluginCommandError,
		runtimeBuilderInput: {
			config,
			hooks,
			extensions,
			onTeamEvent,
			createSpawnTool,
			onTeamRestored: onTeamRestored,
			onSubAgentEvent: subAgentLifecycleCallbacks?.onSubAgentEvent,
			onSubAgentStart: subAgentLifecycleCallbacks?.onSubAgentStart,
			onSubAgentEnd: subAgentLifecycleCallbacks?.onSubAgentEnd,
			userInstructionService: userInstructionService,
			pluginSkillDirectories,
			agentPluginSkills: loadedAgentPluginPackages?.skills,
			agentPluginMcpServers: loadedAgentPluginPackages?.mcpServers,
			configExtensions: configExtensions,
			toolExecutors: effectiveToolExecutors,
			toolPolicies,
			workspaceManager,
			logger: config.logger,
			telemetry: config.telemetry,
			requestToolApproval,
		},
	};
}
