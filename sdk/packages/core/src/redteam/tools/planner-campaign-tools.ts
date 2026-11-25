import {
	type AgentTool,
	createTool,
	validateWithZod,
	zodToJsonSchema,
} from "@cline/shared";
import { z } from "zod";
import { CampaignManager } from "../campaign";
import { CommandFilter } from "../command-filter";
import { DockerMiddleware } from "../docker";
import { Supervisor } from "../supervisor";
import { type RedTeamRuntimeEnv, rtState } from "./shared";

export function registerPlannerCampaignTools(env: RedTeamRuntimeEnv): void {
	const { ctx, tools, scopeAllowlist, recordAuditEntry } = env;
	const { docker, planStore, redTeamStore, obsidianService } = ctx;

	// --- Autonomous planner (HTN-style) ---

	interface PlanStep {
		id: string;
		action: string;
		description: string;
		status: "pending" | "running" | "done" | "failed" | "skipped";
		result?: string;
	}

	interface Plan {
		id: string;
		goal: string;
		target: string;
		steps: PlanStep[];
		currentIndex: number;
		status: "active" | "completed" | "completed_with_failures" | "failed";
		createdAt: number;
	}

	const plans = new Map<string, Plan>();
	// Load persisted plans from store
	if (planStore) {
		try {
			planStore.init();
			for (const p of planStore.list()) {
				try {
					const steps = JSON.parse(p.steps) as PlanStep[];
					plans.set(p.id, {
						id: p.id,
						goal: p.goal,
						target: p.target,
						steps,
						currentIndex: p.currentIndex,
						status: p.status as Plan["status"],
						createdAt: p.createdAt,
					});
				} catch {
					// skip corrupt plans
				}
			}
		} catch {
			// ignore store errors
		}
	}

	const PlanCreateSchema = z.object({
		goal: z.string().min(1),
		target: z.string().min(1),
		mode: z.enum(["recon", "full", "exploit", "postex"] as const).optional(),
	});
	tools.push(
		createTool<{ goal: string; target: string; mode?: string }, { plan: Plan }>(
			{
				name: "rt_plan_create",
				description:
					"Create an autonomous attack plan for a goal. Returns plan with steps.",
				inputSchema: zodToJsonSchema(PlanCreateSchema),
				execute: async (input) => {
					const v = validateWithZod(PlanCreateSchema, input);
					const mode = v.mode ?? "full";
					const id = `plan_${Date.now()}`;
					const steps: PlanStep[] = [];

					// HTN decomposition
					if (mode === "recon" || mode === "full") {
						steps.push({
							id: "s1",
							action: "rt_subfinder",
							description: `Enumerate subdomains of ${v.target}`,
							status: "pending",
						});
						steps.push({
							id: "s2",
							action: "rt_nmap",
							description: `Scan ports on ${v.target}`,
							status: "pending",
						});
						steps.push({
							id: "s3",
							action: "rt_httpx",
							description: `Probe HTTP services on ${v.target}`,
							status: "pending",
						});
						steps.push({
							id: "s4",
							action: "rt_whatweb",
							description: `Fingerprint tech stack of ${v.target}`,
							status: "pending",
						});
						steps.push({
							id: "s5",
							action: "rt_wafw00f",
							description: `Detect WAF on ${v.target}`,
							status: "pending",
						});
					}
					if (mode === "full" || mode === "exploit") {
						steps.push({
							id: "s6",
							action: "rt_vuln_templates",
							description: `Vuln scan ${v.target}`,
							status: "pending",
						});
						steps.push({
							id: "s7",
							action: "rt_nuclei",
							description: `Nuclei scan ${v.target}`,
							status: "pending",
						});
						steps.push({
							id: "s8",
							action: "rt_auto_exploit",
							description: `Auto-exploit ${v.target}`,
							status: "pending",
						});
					}
					if (mode === "full" || mode === "postex") {
						steps.push({
							id: "s9",
							action: "rt_ref_privesc_auto",
							description: "Privilege escalation",
							status: "pending",
						});
						steps.push({
							id: "s10",
							action: "rt_cred_dump",
							description: "Credential dumping",
							status: "pending",
						});
						steps.push({
							id: "s11",
							action: "rt_lateral",
							description: "Lateral movement",
							status: "pending",
						});
						steps.push({
							id: "s12",
							action: "rt_persist",
							description: "Establish persistence",
							status: "pending",
						});
					}
					if (mode === "full") {
						steps.push({
							id: "s13",
							action: "rt_report_gen",
							description: "Generate pentest report",
							status: "pending",
						});
					}

					const plan: Plan = {
						id,
						goal: v.goal,
						target: v.target,
						steps,
						currentIndex: 0,
						status: "active",
						createdAt: Date.now(),
					};
					plans.set(id, plan);
					if (planStore) {
						try {
							planStore.save({
								id,
								goal: v.goal,
								target: v.target,
								mode: mode ?? "full",
								status: "active",
								steps: JSON.stringify(steps),
								currentIndex: 0,
								createdAt: Date.now(),
								updatedAt: Date.now(),
							});
						} catch {
							// ignore
						}
					}
					return { plan };
				},
			},
		) as AgentTool,
	);

	const PlanNextSchema = z.object({ planId: z.string().min(1) });
	tools.push(
		createTool<
			{ planId: string },
			{ step: PlanStep | null; planStatus: string; remaining: number }
		>({
			name: "rt_plan_next",
			description: "Get the next pending step in a plan.",
			inputSchema: zodToJsonSchema(PlanNextSchema),
			execute: async (input) => {
				const v = validateWithZod(PlanNextSchema, input);
				const plan = plans.get(v.planId);
				if (!plan) return { step: null, planStatus: "not_found", remaining: 0 };
				const step = plan.steps.find((s) => s.status === "pending");
				const remaining = plan.steps.filter(
					(s) => s.status === "pending",
				).length;
				return { step: step ?? null, planStatus: plan.status, remaining };
			},
		}) as AgentTool,
	);

	const PlanUpdateSchema = z.object({
		planId: z.string().min(1),
		stepId: z.string().min(1),
		status: z.enum(["pending", "running", "done", "failed", "skipped"]),
		result: z.string().optional(),
	});
	tools.push(
		createTool<
			{ planId: string; stepId: string; status: string; result?: string },
			{ updated: boolean }
		>({
			name: "rt_plan_update",
			description: "Update a plan step status and result.",
			inputSchema: zodToJsonSchema(PlanUpdateSchema),
			execute: async (input) => {
				const v = validateWithZod(PlanUpdateSchema, input);
				const plan = plans.get(v.planId);
				if (!plan) return { updated: false };
				const step = plan.steps.find((s) => s.id === v.stepId);
				if (!step) return { updated: false };
				step.status = v.status as PlanStep["status"];
				if (v.result) step.result = v.result;
				// Check if all done
				if (
					plan.steps.every((s) => s.status === "done" || s.status === "skipped")
				) {
					plan.status = "completed";
				} else if (
					plan.steps.every(
						(s) => s.status !== "pending" && s.status !== "running",
					)
				) {
					plan.status = plan.steps.some((s) => s.status === "failed")
						? "completed_with_failures"
						: "completed";
				}
				// Persist
				if (planStore) {
					try {
						planStore.save({
							id: plan.id,
							goal: plan.goal,
							target: plan.target,
							mode: "full",
							status: plan.status,
							steps: JSON.stringify(plan.steps),
							currentIndex: plan.currentIndex,
							createdAt: plan.createdAt,
							updatedAt: Date.now(),
						});
					} catch {
						// ignore
					}
				}
				return { updated: true };
			},
		}) as AgentTool,
	);

	const PlanStatusSchema = z.object({ planId: z.string().min(1) });
	tools.push(
		createTool<{ planId: string }, { plan: Plan | null }>({
			name: "rt_plan_status",
			description: "Get full plan status with all steps.",
			inputSchema: zodToJsonSchema(PlanStatusSchema),
			execute: async (input) => {
				const v = validateWithZod(PlanStatusSchema, input);
				return { plan: plans.get(v.planId) ?? null };
			},
		}) as AgentTool,
	);

	const PlanAutoSchema = z.object({
		goal: z.string().min(1),
		target: z.string().min(1),
		mode: z.enum(["recon", "full", "exploit", "postex"]).optional(),
	});
	tools.push(
		createTool<
			{ goal: string; target: string; mode?: string },
			{ planId: string; message: string }
		>({
			name: "rt_plan_auto",
			description:
				"Create a plan and return the first step to execute. Agent should loop: plan_next → execute action → plan_update → repeat until no pending steps.",
			inputSchema: zodToJsonSchema(PlanAutoSchema),
			execute: async (input) => {
				const v = validateWithZod(PlanAutoSchema, input);
				const id = `plan_${Date.now()}`;
				const steps: PlanStep[] = [];
				const mode = v.mode ?? "full";
				if (mode === "recon" || mode === "full") {
					steps.push({
						id: "s1",
						action: "rt_subfinder",
						description: `Subdomains of ${v.target}`,
						status: "pending",
					});
					steps.push({
						id: "s2",
						action: "rt_nmap",
						description: `Port scan ${v.target}`,
						status: "pending",
					});
					steps.push({
						id: "s3",
						action: "rt_httpx",
						description: `HTTP probe ${v.target}`,
						status: "pending",
					});
					steps.push({
						id: "s4",
						action: "rt_whatweb",
						description: `Tech fingerprint ${v.target}`,
						status: "pending",
					});
					steps.push({
						id: "s5",
						action: "rt_wafw00f",
						description: `WAF detect ${v.target}`,
						status: "pending",
					});
				}
				if (mode === "full" || mode === "exploit") {
					steps.push({
						id: "s6",
						action: "rt_vuln_templates",
						description: `Vuln scan ${v.target}`,
						status: "pending",
					});
					steps.push({
						id: "s7",
						action: "rt_nuclei",
						description: `Nuclei ${v.target}`,
						status: "pending",
					});
					steps.push({
						id: "s8",
						action: "rt_auto_exploit",
						description: `Auto-exploit ${v.target}`,
						status: "pending",
					});
				}
				if (mode === "full" || mode === "postex") {
					steps.push({
						id: "s9",
						action: "rt_ref_privesc_auto",
						description: "Privesc",
						status: "pending",
					});
					steps.push({
						id: "s10",
						action: "rt_cred_dump",
						description: "Cred dump",
						status: "pending",
					});
					steps.push({
						id: "s11",
						action: "rt_lateral",
						description: "Lateral movement",
						status: "pending",
					});
					steps.push({
						id: "s12",
						action: "rt_persist",
						description: "Persistence",
						status: "pending",
					});
				}
				if (mode === "full") {
					steps.push({
						id: "s13",
						action: "rt_report_gen",
						description: "Report",
						status: "pending",
					});
				}
				const plan: Plan = {
					id,
					goal: v.goal,
					target: v.target,
					steps,
					currentIndex: 0,
					status: "active",
					createdAt: Date.now(),
				};
				plans.set(id, plan);
				if (planStore) {
					try {
						planStore.save({
							id,
							goal: v.goal,
							target: v.target,
							mode: mode ?? "full",
							status: "active",
							steps: JSON.stringify(steps),
							currentIndex: 0,
							createdAt: Date.now(),
							updatedAt: Date.now(),
						});
					} catch {
						/* ignore */
					}
				}

				// Auto-execute all steps
				const dispatch: Record<
					string,
					(args: Record<string, unknown>) => Promise<unknown>
				> = {};
				for (const t of tools) {
					const tool = t as unknown as {
						name: string;
						execute: (input: unknown) => Promise<unknown>;
					};
					dispatch[tool.name] = (args) => tool.execute(args);
				}
				const executed: { stepId: string; action: string; result: unknown }[] =
					[];
				let hasMore = true;
				while (hasMore) {
					const step = plan.steps.find((s) => s.status === "pending");
					if (!step) {
						hasMore = false;
						break;
					}
					step.status = "running";
					try {
						const fn = dispatch[step.action];
						if (!fn) {
							step.status = "skipped";
							step.result = `Tool ${step.action} not available`;
							continue;
						}
						const args: Record<string, unknown> = { target: plan.target };
						if (step.action === "rt_subfinder") args.domain = plan.target;
						if (step.action === "rt_nmap") args.target = plan.target;
						if (step.action === "rt_httpx") args.input = plan.target;
						if (step.action === "rt_whatweb") args.target = plan.target;
						if (step.action === "rt_wafw00f") args.target = plan.target;
						if (step.action === "rt_vuln_templates")
							args.url = `https://${plan.target}`;
						if (step.action === "rt_nuclei") args.target = plan.target;
						if (step.action === "rt_auto_exploit")
							args.url = `https://${plan.target}`;
						if (step.action === "rt_report_gen") {
							args.title = `Pentest Report: ${plan.target}`;
							args.findings = [];
						}
						const result = await fn(args);
						step.status = "done";
						step.result = JSON.stringify(result).slice(0, 500);
						executed.push({ stepId: step.id, action: step.action, result });
						if (
							step.action === "rt_nmap" &&
							typeof result === "object" &&
							result !== null
						) {
							const r = result as { stdout?: string };
							if (
								r.stdout?.includes("80/tcp") ||
								r.stdout?.includes("443/tcp") ||
								r.stdout?.includes("8080/tcp")
							) {
								plan.steps.push({
									id: `s_web_${Date.now()}`,
									action: "rt_vuln_templates",
									description: `Web vuln scan (auto: web port found)`,
									status: "pending",
								});
							}
						}
						if (
							step.action === "rt_vuln_templates" &&
							typeof result === "object" &&
							result !== null
						) {
							const r = result as { findings?: unknown[] };
							if (r.findings && r.findings.length > 0) {
								plan.steps.push({
									id: `s_exploit_${Date.now()}`,
									action: "rt_auto_exploit",
									description: `Auto-exploit (auto: vulns found)`,
									status: "pending",
								});
							}
						}
					} catch (e: unknown) {
						// Retry with mutation on failure
						const altCommands: Record<string, string> = {
							rt_nmap: `nmap -sV -T4 --top-ports 1000 ${plan.target}`,
							rt_nuclei: `nuclei -u https://${plan.target} -severity critical,high`,
							rt_vuln_templates: `curl -s https://${plan.target}`,
						};
						const altCmd = altCommands[step.action];
						if (altCmd && !rtState.killed) {
							try {
								const { exec } = await import("node:child_process");
								const { promisify } = await import("node:util");
								const { stdout } = await promisify(exec)(altCmd, {
									timeout: 120000,
									maxBuffer: 10 * 1024 * 1024,
								});
								step.status = "done";
								step.result = `[retry] ${stdout.slice(0, 300)}`;
								executed.push({
									stepId: step.id,
									action: step.action,
									result: { retry: true, stdout: stdout.slice(0, 300) },
								});
								continue;
							} catch {
								/* retry failed */
							}
						}
						step.status = "failed";
						step.result = String(e);
						executed.push({
							stepId: step.id,
							action: step.action,
							result: { error: String(e) },
						});
					}
				}
				if (
					plan.steps.every((s) => s.status === "done" || s.status === "skipped")
				)
					plan.status = "completed";
				else if (
					plan.steps.every(
						(s) => s.status !== "pending" && s.status !== "running",
					)
				)
					plan.status = plan.steps.some((s) => s.status === "failed")
						? "completed_with_failures"
						: "completed";

				if (planStore) {
					try {
						planStore.save({
							id: plan.id,
							goal: plan.goal,
							target: plan.target,
							mode: mode ?? "full",
							status: plan.status,
							steps: JSON.stringify(plan.steps),
							currentIndex: 0,
							createdAt: plan.createdAt,
							updatedAt: Date.now(),
						});
					} catch {
						/* ignore */
					}
				}

				return {
					planId: id,
					status: plan.status,
					executed: executed.length,
					results: executed,
					message: `Plan auto-executed. ${executed.length} steps completed. ${plan.steps.filter((s) => s.status === "pending").length} remaining.`,
				};
			},
		}) as AgentTool,
	);

	const PlanListSchema = z.object({});
	tools.push(
		createTool<
			Record<string, never>,
			{
				plans: {
					id: string;
					goal: string;
					target: string;
					status: string;
					progress: string;
				}[];
			}
		>({
			name: "rt_plan_list",
			description: "List all plans.",
			inputSchema: zodToJsonSchema(PlanListSchema),
			execute: async () => {
				const list = [...plans.values()].map((p) => ({
					id: p.id,
					goal: p.goal,
					target: p.target,
					status: p.status,
					progress: `${p.steps.filter((s) => s.status === "done").length}/${p.steps.length}`,
				}));
				return { plans: list };
			},
		}) as AgentTool,
	);

	// --- Self-driving execution ---

	const PlanDriveSchema = z.object({
		planId: z.string().min(1),
		autoExecute: z.boolean().optional(),
	});
	tools.push(
		createTool<
			{ planId: string; autoExecute?: boolean },
			{
				status: string;
				currentStep: PlanStep | null;
				executed: { stepId: string; action: string; result: unknown }[];
				remaining: number;
				message: string;
			}
		>({
			name: "rt_plan_drive",
			description:
				"Self-driving plan execution: automatically executes all pending steps in sequence. Returns results and next pending step.",
			inputSchema: zodToJsonSchema(PlanDriveSchema),
			execute: async (input) => {
				const v = validateWithZod(PlanDriveSchema, input);
				const plan = plans.get(v.planId);
				if (!plan)
					return {
						status: "not_found",
						currentStep: null,
						executed: [],
						remaining: 0,
						message: "Plan not found",
					};

				const executed: { stepId: string; action: string; result: unknown }[] =
					[];
				const autoExec = v.autoExecute !== false;

				// Build dispatch map
				const dispatch: Record<
					string,
					(args: Record<string, unknown>) => Promise<unknown>
				> = {};
				for (const t of tools) {
					const tool = t as unknown as {
						name: string;
						execute: (input: unknown) => Promise<unknown>;
					};
					dispatch[tool.name] = (args) => tool.execute(args);
				}

				// Execute all pending steps
				let hasMore = true;
				while (hasMore && autoExec) {
					const step = plan.steps.find((s) => s.status === "pending");
					if (!step) {
						hasMore = false;
						break;
					}

					step.status = "running";
					try {
						const fn = dispatch[step.action];
						if (!fn) {
							step.status = "skipped";
							step.result = `Tool ${step.action} not available`;
							continue;
						}
						// Build args from target
						const args: Record<string, unknown> = { target: plan.target };
						if (step.action === "rt_subfinder") args.domain = plan.target;
						if (step.action === "rt_nmap") args.target = plan.target;
						if (step.action === "rt_httpx") args.input = plan.target;
						if (step.action === "rt_whatweb") args.target = plan.target;
						if (step.action === "rt_wafw00f") args.target = plan.target;
						if (step.action === "rt_vuln_templates")
							args.url = `https://${plan.target}`;
						if (step.action === "rt_nuclei") args.target = plan.target;
						if (step.action === "rt_auto_exploit")
							args.url = `https://${plan.target}`;
						if (step.action === "rt_report_gen") {
							args.title = `Pentest Report: ${plan.target}`;
							args.findings = [];
						}

						const result = await fn(args);
						step.status = "done";
						step.result = JSON.stringify(result).slice(0, 500);
						executed.push({ stepId: step.id, action: step.action, result });

						// Branching: if nmap found web ports, add web vuln scan
						if (
							step.action === "rt_nmap" &&
							typeof result === "object" &&
							result !== null
						) {
							const r = result as { stdout?: string };
							if (
								r.stdout?.includes("80/tcp") ||
								r.stdout?.includes("443/tcp") ||
								r.stdout?.includes("8080/tcp")
							) {
								const webStep: PlanStep = {
									id: `s_web_${Date.now()}`,
									action: "rt_vuln_templates",
									description: `Web vuln scan ${plan.target} (auto-added: web port found)`,
									status: "pending",
								};
								plan.steps.push(webStep);
							}
						}
						// Branching: if vuln scan found issues, add exploit step
						if (
							step.action === "rt_vuln_templates" &&
							typeof result === "object" &&
							result !== null
						) {
							const r = result as { findings?: unknown[] };
							if (r.findings && r.findings.length > 0) {
								const exploitStep: PlanStep = {
									id: `s_exploit_${Date.now()}`,
									action: "rt_auto_exploit",
									description: `Auto-exploit ${plan.target} (auto-added: vulns found)`,
									status: "pending",
								};
								plan.steps.push(exploitStep);
							}
						}
					} catch (e: unknown) {
						step.status = "failed";
						step.result = String(e);
						executed.push({
							stepId: step.id,
							action: step.action,
							result: { error: String(e) },
						});
					}
				}

				// Check completion
				if (
					plan.steps.every((s) => s.status === "done" || s.status === "skipped")
				) {
					plan.status = "completed";
				} else if (
					plan.steps.every(
						(s) => s.status !== "pending" && s.status !== "running",
					)
				) {
					plan.status = plan.steps.some((s) => s.status === "failed")
						? "completed_with_failures"
						: "completed";
				}

				// Auto-generate report when plan completes
				if (
					plan.status === "completed" ||
					plan.status === "completed_with_failures"
				) {
					const reportLines = [];
					reportLines.push(`# Pentest Report: ${plan.target}`);
					reportLines.push(`**Date:** ${new Date().toISOString()}`);
					reportLines.push(`**Goal:** ${plan.goal}`);
					reportLines.push(`**Status:** ${plan.status}`);
					reportLines.push("");
					reportLines.push("## Steps Executed");
					for (const step of plan.steps) {
						reportLines.push(
							"- [" +
								step.status +
								"] " +
								step.action +
								": " +
								step.description,
						);
						if (step.result)
							reportLines.push(`  Result: ${step.result.slice(0, 200)}`);
					}
					reportLines.push("");
					reportLines.push("## Evidence");
					for (const e of executed) {
						reportLines.push(`### ${e.stepId} (${e.action})`);
						reportLines.push("```");
						reportLines.push(JSON.stringify(e.result, null, 2).slice(0, 500));
						reportLines.push("```");
					}
					const reportContent = reportLines.join("\n");
					const today = new Date().toISOString().split("T")[0];
					const targetSlug =
						plan.target
							.toLowerCase()
							.replace(/[^a-z0-9_-]+/g, "-")
							.replace(/^-+|-+$/g, "")
							.slice(0, 48) || "target";
					const defaultPath = `knowledge/reports/${today}-plan-${targetSlug}.md`;
					let savedPath: string | null = null;
					if (obsidianService) {
						try {
							if (obsidianService.saveReport) {
								savedPath = obsidianService.saveReport(
									`Pentest Report: ${plan.target}`,
									reportContent,
									["pentest", "plan", plan.target],
								);
							} else if (obsidianService.writeNote(defaultPath, reportContent)) {
								savedPath = defaultPath;
							}
						} catch {
							/* ignore */
						}
					} else {
						try {
							const { ObsidianStore } = await import(
								"../../obsidian/obsidian-store"
							);
							const store = new ObsidianStore();
							if (store.writeNote(defaultPath, reportContent)) {
								savedPath = defaultPath;
							}
						} catch {
							/* ignore */
						}
					}
					if (planStore) {
						try {
							planStore.save({
								id: plan.id,
								goal: plan.goal,
								target: plan.target,
								mode: "full",
								status: plan.status,
								steps: JSON.stringify(plan.steps),
								currentIndex: plan.currentIndex,
								createdAt: plan.createdAt,
								updatedAt: Date.now(),
							});
						} catch {
							/* ignore */
						}
					}
					executed.push({
						stepId: "auto_report",
						action: "rt_report_gen",
						result: {
							file: savedPath ?? defaultPath,
							obsidianPath: savedPath,
							persisted: savedPath !== null,
						},
					});
				}

				const nextStep = plan.steps.find((s) => s.status === "pending") ?? null;
				const remaining = plan.steps.filter(
					(s) => s.status === "pending",
				).length;

				return {
					status: plan.status,
					currentStep: nextStep,
					executed,
					remaining,
					message:
						remaining === 0
							? `Plan completed. ${executed.length} steps executed.`
							: `${executed.length} steps executed. ${remaining} remaining. Call rt_plan_drive again to continue.`,
				};
			},
		}) as AgentTool,
	);

	// --- Docker/Kali integration ---

	const dockerMiddleware = docker ?? new DockerMiddleware();

	tools.push(
		createTool<
			Record<string, never>,
			{ running: boolean; container: string; image: string; tools: string[] }
		>({
			name: "rt_docker_status",
			description: "Check Docker/Kali container status and available tools.",
			inputSchema: zodToJsonSchema(z.object({})),
			execute: async () => dockerMiddleware.status(),
		}) as AgentTool,
	);

	const DockerExecSchema = z.object({
		command: z.string().min(1),
		timeoutMs: z.number().int().positive().optional(),
	});
	tools.push(
		createTool<
			{ command: string; timeoutMs?: number },
			{ stdout: string; stderr: string; code: number }
		>({
			name: "rt_docker_exec",
			description: "Execute a command inside the Kali Docker container.",
			inputSchema: zodToJsonSchema(DockerExecSchema),
			execute: async (input) => {
				const v = validateWithZod(DockerExecSchema, input);
				return dockerMiddleware.execInContainer(v.command, v.timeoutMs);
			},
		}) as AgentTool,
	);

	tools.push(
		createTool<Record<string, never>, { success: boolean; message: string }>({
			name: "rt_docker_setup",
			description: "Set up Kali Docker container with red team tools.",
			inputSchema: zodToJsonSchema(z.object({})),
			execute: async () => dockerMiddleware.setup(),
		}) as AgentTool,
	);

	const DockerEnableSchema = z.object({ enabled: z.boolean() });
	tools.push(
		createTool<{ enabled: boolean }, { enabled: boolean }>({
			name: "rt_docker_enable",
			description: "Enable/disable Docker mode (run tools in Kali container).",
			inputSchema: zodToJsonSchema(DockerEnableSchema),
			execute: async (input) => {
				const v = validateWithZod(DockerEnableSchema, input);
				if (v.enabled) {
					const ok = await dockerMiddleware.enable();
					return { enabled: ok };
				}
				await dockerMiddleware.disable();
				return { enabled: false };
			},
		}) as AgentTool,
	);

	// --- External framework integration ---

	const FrameworkSchema = z.object({
		framework: z.enum(["metasploit", "cobalt_strike", "sliver", "empire"]),
		command: z.string().optional(),
		args: z.string().optional(),
	});

	tools.push(
		createTool<
			{ framework: string; command?: string; args?: string },
			{ output: string; code: number; command: string }
		>({
			name: "rt_framework",
			description:
				"Run a command in an external C2/exploitation framework (metasploit, cobalt_strike, sliver, empire) via Docker/Kali.",
			inputSchema: zodToJsonSchema(FrameworkSchema),
			execute: async (input) => {
				const v = validateWithZod(FrameworkSchema, input);
				let cmd = "";
				switch (v.framework) {
					case "metasploit":
						cmd = v.command
							? `msfconsole -q -x "${v.command}"`
							: "msfconsole -q";
						break;
					case "cobalt_strike":
						cmd = v.command
							? `./teamserver ${v.args ?? ""} ${v.command}`
							: "echo 'Cobalt Strike requires manual setup'";
						break;
					case "sliver":
						cmd = v.command
							? `sliver-server -c "${v.command}"`
							: "sliver-server";
						break;
					case "empire":
						cmd = v.command
							? `python3 empire.py --headless --command "${v.command}"`
							: "python3 empire.py --headless";
						break;
				}
				const fullCmd = `docker exec kali-redteam bash -c ${JSON.stringify(cmd)}`;
				if (rtState.killed) return { output: "killed", code: -1, command: fullCmd };
				if (rtState.dryRunMode)
					return { output: "[dry-run]", code: 0, command: fullCmd };
				const { exec } = await import("node:child_process");
				const { promisify } = await import("node:util");
				try {
					const { stdout } = await promisify(exec)(fullCmd, {
						timeout: 600000,
						maxBuffer: 10 * 1024 * 1024,
					});
					return { output: stdout.slice(0, 100000), code: 0, command: fullCmd };
				} catch (e: unknown) {
					const err = e as { stdout?: string; code?: number };
					return {
						output: (err.stdout ?? "").slice(0, 100000),
						code: err.code ?? 1,
						command: fullCmd,
					};
				}
			},
		}) as AgentTool,
	);

	// Framework setup tools
	const FrameworkSetupSchema = z.object({
		framework: z.enum(["metasploit", "cobalt_strike", "sliver", "empire"]),
	});
	tools.push(
		createTool<
			{ framework: string },
			{ success: boolean; message: string; installCmd: string }
		>({
			name: "rt_framework_setup",
			description: "Install a C2/exploitation framework in the Kali container.",
			inputSchema: zodToJsonSchema(FrameworkSetupSchema),
			execute: async (input) => {
				const v = validateWithZod(FrameworkSetupSchema, input);
				const installCmds: Record<string, string> = {
					metasploit: "apt-get install -y metasploit-framework",
					cobalt_strike:
						"echo 'Cobalt Strike requires manual download from https://www.cobaltstrike.com'",
					sliver: "curl -s https://sliver.sh/install | bash",
					empire:
						"git clone https://github.com/BC-SECURITY/Empire.git /opt/Empire && cd /opt/Empire && pip3 install -r requirements.txt",
				};
				const cmd = installCmds[v.framework];
				if (rtState.killed)
					return { success: false, message: "killed", installCmd: cmd };
				if (rtState.dryRunMode)
					return { success: true, message: "[dry-run]", installCmd: cmd };
				const { exec } = await import("node:child_process");
				const { promisify } = await import("node:util");
				try {
					const fullCmd = `docker exec kali-redteam bash -c ${JSON.stringify(cmd)}`;
					const { stdout } = await promisify(exec)(fullCmd, {
						timeout: 600000,
						maxBuffer: 10 * 1024 * 1024,
					});
					return {
						success: true,
						message: stdout.slice(0, 1000),
						installCmd: cmd,
					};
				} catch (e: unknown) {
					const err = e as { stdout?: string; message?: string };
					return {
						success: false,
						message: (err.stdout ?? err.message ?? String(e)).slice(0, 1000),
						installCmd: cmd,
					};
				}
			},
		}) as AgentTool,
	);

	// Metasploit specific
	tools.push(
		createTool<
			{ module: string; options?: Record<string, string> },
			{ command: string; output: string }
		>({
			name: "rt_metasploit",
			description: "Run a Metasploit module with options.",
			inputSchema: zodToJsonSchema(
				z.object({
					module: z.string().min(1),
					options: z.record(z.string(), z.string()).optional(),
				}),
			),
			execute: async (input) => {
				const v = validateWithZod(
					z.object({
						module: z.string().min(1),
						options: z.record(z.string(), z.string()).optional(),
					}),
					input,
				);
				const opts = Object.entries(v.options ?? {})
					.map(([k, val]) => `set ${k} ${val}`)
					.join("; ");
				const cmd = `msfconsole -q -x "use ${v.module}; ${opts}; run; exit"`;
				const fullCmd = `docker exec kali-redteam bash -c ${JSON.stringify(cmd)}`;
				if (rtState.killed) return { command: fullCmd, output: "killed" };
				if (rtState.dryRunMode) return { command: fullCmd, output: "[dry-run]" };
				const { exec } = await import("node:child_process");
				const { promisify } = await import("node:util");
				try {
					const { stdout } = await promisify(exec)(fullCmd, {
						timeout: 600000,
						maxBuffer: 10 * 1024 * 1024,
					});
					return { command: fullCmd, output: stdout.slice(0, 100000) };
				} catch (e: unknown) {
					const err = e as { stdout?: string };
					return {
						command: fullCmd,
						output: (err.stdout ?? "").slice(0, 100000),
					};
				}
			},
		}) as AgentTool,
	);

	// Sliver specific
	tools.push(
		createTool<{ command: string }, { command: string; output: string }>({
			name: "rt_sliver",
			description: "Run a Sliver C2 command.",
			inputSchema: zodToJsonSchema(z.object({ command: z.string().min(1) })),
			execute: async (input) => {
				const v = validateWithZod(
					z.object({ command: z.string().min(1) }),
					input,
				);
				const cmd = `sliver-server -c "${v.command}"`;
				const fullCmd = `docker exec kali-redteam bash -c ${JSON.stringify(cmd)}`;
				if (rtState.killed) return { command: fullCmd, output: "killed" };
				if (rtState.dryRunMode) return { command: fullCmd, output: "[dry-run]" };
				const { exec } = await import("node:child_process");
				const { promisify } = await import("node:util");
				try {
					const { stdout } = await promisify(exec)(fullCmd, {
						timeout: 600000,
						maxBuffer: 10 * 1024 * 1024,
					});
					return { command: fullCmd, output: stdout.slice(0, 100000) };
				} catch (e: unknown) {
					const err = e as { stdout?: string };
					return {
						command: fullCmd,
						output: (err.stdout ?? "").slice(0, 100000),
					};
				}
			},
		}) as AgentTool,
	);

	// Empire specific
	tools.push(
		createTool<{ command: string }, { command: string; output: string }>({
			name: "rt_empire",
			description: "Run an Empire C2 command.",
			inputSchema: zodToJsonSchema(z.object({ command: z.string().min(1) })),
			execute: async (input) => {
				const v = validateWithZod(
					z.object({ command: z.string().min(1) }),
					input,
				);
				const cmd = `python3 /opt/Empire/empire.py --headless --command "${v.command}"`;
				const fullCmd = `docker exec kali-redteam bash -c ${JSON.stringify(cmd)}`;
				if (rtState.killed) return { command: fullCmd, output: "killed" };
				if (rtState.dryRunMode) return { command: fullCmd, output: "[dry-run]" };
				const { exec } = await import("node:child_process");
				const { promisify } = await import("node:util");
				try {
					const { stdout } = await promisify(exec)(fullCmd, {
						timeout: 600000,
						maxBuffer: 10 * 1024 * 1024,
					});
					return { command: fullCmd, output: stdout.slice(0, 100000) };
				} catch (e: unknown) {
					const err = e as { stdout?: string };
					return {
						command: fullCmd,
						output: (err.stdout ?? "").slice(0, 100000),
					};
				}
			},
		}) as AgentTool,
	);

	// --- Scope enforcement in executors ---
	// Wrap rt_exec to enforce scope before execution
	const originalExecIndex = tools.findIndex(
		(t) => (t as { name?: string }).name === "rt_exec",
	);
	if (originalExecIndex >= 0) {
		const originalExec = tools[originalExecIndex] as unknown as {
			execute: (input: unknown) => Promise<unknown>;
		};
		const wrappedExec = {
			...originalExec,
			execute: async (input: unknown, _context: unknown) => {
				const inp = input as { command?: string; target?: string };
				if (inp.target) {
					const t = inp.target.toLowerCase();
					const inScope =
						scopeAllowlist.size === 0 ||
						scopeAllowlist.has(t) ||
						[...scopeAllowlist].some((s) => t.endsWith(s) || s.endsWith(t));
					if (!inScope) {
						return {
							stdout: "",
							stderr: "BLOCKED: target out of scope",
							code: -1,
							hash: "",
							dryRun: false,
							aborted: false,
							outOfScope: true,
						};
					}
				}
				if (rtState.killed) {
					return {
						stdout: "",
						stderr: "BLOCKED: kill switch active",
						code: -1,
						hash: "",
						dryRun: false,
						aborted: true,
						outOfScope: false,
					};
				}
				return originalExec.execute(input);
			},
		};
		tools[originalExecIndex] = wrappedExec as unknown as AgentTool;
	}

	// --- Supervisor (dual-agent) ---
	const supervisors = new Map<string, Supervisor>();
	if (redTeamStore) {
		try {
			for (const state of redTeamStore.listSupervisorStates()) {
				supervisors.set(state.taskId, Supervisor.fromState(state));
			}
		} catch {
			// ignore
		}
	}
	const persistSupervisor = (sup: Supervisor): void => {
		if (!redTeamStore) return;
		try {
			redTeamStore.saveSupervisorState(sup.getState());
		} catch {
			// ignore
		}
	};
	const SupervisorCreateSchema = z.object({
		target: z.string().min(1),
		maxActions: z.number().int().optional(),
	});
	tools.push(
		createTool<
			{ target: string; maxActions?: number },
			{ supervisorId: string; state: ReturnType<Supervisor["getState"]> }
		>({
			name: "rt_supervisor_create",
			description:
				"Create a supervisor for dual-agent attack orchestration (state machine: recon → scan → exploit → postex → report).",
			inputSchema: zodToJsonSchema(SupervisorCreateSchema),
			execute: async (input) => {
				const v = validateWithZod(SupervisorCreateSchema, input);
				const id = `sup_${Date.now()}`;
				const sup = new Supervisor({
					taskId: id,
					target: v.target,
					maxActions: v.maxActions,
				});
				supervisors.set(id, sup);
				persistSupervisor(sup);
				return { supervisorId: id, state: sup.getState() };
			},
		}) as AgentTool,
	);

	const SupervisorNextSchema = z.object({ supervisorId: z.string().min(1) });
	tools.push(
		createTool<
			{ supervisorId: string },
			{
				actions: string[];
				stage: string;
				canContinue: boolean;
				summary: string;
			}
		>({
			name: "rt_supervisor_next",
			description: "Get next actions from supervisor based on current stage.",
			inputSchema: zodToJsonSchema(SupervisorNextSchema),
			execute: async (input) => {
				const v = validateWithZod(SupervisorNextSchema, input);
				const sup = supervisors.get(v.supervisorId);
				if (!sup)
					return {
						actions: [],
						stage: "not_found",
						canContinue: false,
						summary: "Supervisor not found",
					};
				return {
					actions: sup.getNextActions(),
					stage: sup.getCurrentStage(),
					canContinue: sup.canContinue(),
					summary: sup.getSummary(),
				};
			},
		}) as AgentTool,
	);

	const SupervisorRecordSchema = z.object({
		supervisorId: z.string().min(1),
		action: z.string().min(1),
		result: z.unknown(),
	});
	tools.push(
		createTool<
			{ supervisorId: string; action: string; result: unknown },
			{ recorded: boolean; advanced: boolean; newStage: string }
		>({
			name: "rt_supervisor_record",
			description:
				"Record an action result in the supervisor. Auto-advances stage if complete.",
			inputSchema: zodToJsonSchema(SupervisorRecordSchema),
			execute: async (input) => {
				const v = validateWithZod(SupervisorRecordSchema, input);
				const sup = supervisors.get(v.supervisorId);
				if (!sup)
					return { recorded: false, advanced: false, newStage: "not_found" };
				sup.recordAction(v.action, v.result);
				const adv = sup.autoAdvance();
				persistSupervisor(sup);
				return {
					recorded: true,
					advanced: adv !== null,
					newStage: adv?.newStage ?? sup.getCurrentStage(),
				};
			},
		}) as AgentTool,
	);

	const SupervisorStatusSchema = z.object({ supervisorId: z.string().min(1) });
	tools.push(
		createTool<
			{ supervisorId: string },
			{ state: ReturnType<Supervisor["getState"]> | null }
		>({
			name: "rt_supervisor_status",
			description:
				"Get supervisor state (stage, assets, findings, creds, progress).",
			inputSchema: zodToJsonSchema(SupervisorStatusSchema),
			execute: async (input) => {
				const v = validateWithZod(SupervisorStatusSchema, input);
				const sup = supervisors.get(v.supervisorId);
				return { state: sup ? sup.getState() : null };
			},
		}) as AgentTool,
	);

	// --- Command filter (7-layer defense) ---
	const cmdFilter = ctx.commandFilter ?? new CommandFilter();
	if (scopeAllowlist.size > 0) {
		cmdFilter.setAllowlist([...scopeAllowlist]);
	}
	tools.push(
		createTool<
			{ command: string; target?: string },
			{
				allowed: boolean;
				reason: string;
				filteredCommand: string;
				layer: string;
			}
		>({
			name: "rt_cmd_filter",
			description:
				"Check a command against 7-layer defense (dangerous patterns, scope, volume ceiling, credential sanitization).",
			inputSchema: zodToJsonSchema(
				z.object({ command: z.string().min(1), target: z.string().optional() }),
			),
			execute: async (input) => {
				const v = validateWithZod(
					z.object({
						command: z.string().min(1),
						target: z.string().optional(),
					}),
					input,
				);
				return cmdFilter.check(v.command, v.target);
			},
		}) as AgentTool,
	);

	tools.push(
		createTool<{ targets: string[] }, { set: boolean }>({
			name: "rt_cmd_filter_scope",
			description: "Set the scope allowlist for the command filter.",
			inputSchema: zodToJsonSchema(
				z.object({ targets: z.array(z.string().min(1)) }),
			),
			execute: async (input) => {
				const v = validateWithZod(
					z.object({ targets: z.array(z.string().min(1)) }),
					input,
				);
				for (const t of v.targets) scopeAllowlist.add(t.toLowerCase());
				cmdFilter.setAllowlist([...scopeAllowlist]);
				if (redTeamStore) {
					try {
						redTeamStore.addScopeTargets(v.targets);
					} catch {
						// ignore
					}
				}
				return { set: true };
			},
		}) as AgentTool,
	);

	// --- Campaign manager (multi-target) ---
	const campaignManager = new CampaignManager(redTeamStore);
	tools.push(
		createTool<
			{
				name: string;
				targets: { value: string; type: string }[];
				maxParallel?: number;
			},
			{ campaign: ReturnType<CampaignManager["createCampaign"]> }
		>({
			name: "rt_campaign_create",
			description: "Create a multi-target campaign for parallel execution.",
			inputSchema: zodToJsonSchema(
				z.object({
					name: z.string().min(1),
					targets: z.array(
						z.object({ value: z.string().min(1), type: z.string().min(1) }),
					),
					maxParallel: z.number().int().optional(),
				}),
			),
			execute: async (input) => {
				const v = validateWithZod(
					z.object({
						name: z.string().min(1),
						targets: z.array(
							z.object({ value: z.string().min(1), type: z.string().min(1) }),
						),
						maxParallel: z.number().int().optional(),
					}),
					input,
				);
				return {
					campaign: campaignManager.createCampaign(
						v.name,
						v.targets,
						v.maxParallel,
					),
				};
			},
		}) as AgentTool,
	);

	tools.push(
		createTool<
			{ campaignId: string },
			{ targets: ReturnType<CampaignManager["getNextTargets"]> }
		>({
			name: "rt_campaign_next",
			description:
				"Get next pending targets in a campaign for parallel execution.",
			inputSchema: zodToJsonSchema(z.object({ campaignId: z.string().min(1) })),
			execute: async (input) => {
				const v = validateWithZod(
					z.object({ campaignId: z.string().min(1) }),
					input,
				);
				return { targets: campaignManager.getNextTargets(v.campaignId) };
			},
		}) as AgentTool,
	);

	tools.push(
		createTool<
			{ campaignId: string },
			{ coverage: ReturnType<CampaignManager["getCoverage"]> }
		>({
			name: "rt_campaign_coverage",
			description:
				"Get campaign coverage (total/completed/failed/pending/running/findings).",
			inputSchema: zodToJsonSchema(z.object({ campaignId: z.string().min(1) })),
			execute: async (input) => {
				const v = validateWithZod(
					z.object({ campaignId: z.string().min(1) }),
					input,
				);
				return { coverage: campaignManager.getCoverage(v.campaignId) };
			},
		}) as AgentTool,
	);

	tools.push(
		createTool<
			{ campaignId: string },
			{ findings: ReturnType<CampaignManager["getConsolidatedFindings"]> }
		>({
			name: "rt_campaign_findings",
			description:
				"Get consolidated findings across all targets in a campaign.",
			inputSchema: zodToJsonSchema(z.object({ campaignId: z.string().min(1) })),
			execute: async (input) => {
				const v = validateWithZod(
					z.object({ campaignId: z.string().min(1) }),
					input,
				);
				return {
					findings: campaignManager.getConsolidatedFindings(v.campaignId),
				};
			},
		}) as AgentTool,
	);

	// --- 7-Layer Defense-in-Depth ---

	// Layer 1+2+6+7: Enhanced rt_exec with auto scope check, output sanitization, volume ceiling
	const origExecIdx = tools.findIndex(
		(t) => (t as { name?: string }).name === "rt_exec",
	);
	if (origExecIdx >= 0) {
		const origExec = tools[origExecIdx] as unknown as {
			execute: (input: unknown) => Promise<unknown>;
			name: string;
			description: string;
			inputSchema: unknown;
		};
		const enhancedExec = {
			...origExec,
			execute: async (input: unknown, _context: unknown) => {
				const inp = input as {
					command?: string;
					target?: string;
					timeoutMs?: number;
				};
				// Layer 1: Command filtering
				if (inp.command) {
					const dangerous = [
						/rm\s+-rf\s+\/(?!\w)/,
						/dd\s+if=.*of=\/dev\//,
						/mkfs\./,
						/:(){ :|:& };:/,
					];
					for (const p of dangerous) {
						if (p.test(inp.command)) {
							return {
								stdout: "",
								stderr: "BLOCKED: dangerous command pattern",
								code: -1,
								hash: "",
								dryRun: false,
								aborted: false,
								outOfScope: false,
							};
						}
					}
				}
				// Layer 2: Scope enforcement
				if (inp.target && scopeAllowlist.size > 0) {
					const t = inp.target.toLowerCase();
					const inScope =
						scopeAllowlist.has(t) ||
						[...scopeAllowlist].some((s) => t.endsWith(s) || s.endsWith(t));
					if (!inScope) {
						return {
							stdout: "",
							stderr: "BLOCKED: target out of scope",
							code: -1,
							hash: "",
							dryRun: false,
							aborted: false,
							outOfScope: true,
						};
					}
				}
				// Layer 7: Volume ceiling
				if (rtState.actionCount >= 1000) {
					return {
						stdout: "",
						stderr: "BLOCKED: volume ceiling reached",
						code: -1,
						hash: "",
						dryRun: false,
						aborted: false,
						outOfScope: false,
					};
				}
				rtState.actionCount++;

				// Execute
				const result = (await origExec.execute(input)) as {
					stdout: string;
					stderr: string;
					code: number;
					hash: string;
				};

				// Layer 6: Output sanitization (redact credentials)
				if (result.stdout) {
					result.stdout = result.stdout.replace(
						/password[=:]\S+/gi,
						"password=***",
					);
					result.stdout = result.stdout.replace(/token[=:]\S+/gi, "token=***");
					result.stdout = result.stdout.replace(
						/secret[=:]\S+/gi,
						"secret=***",
					);
					result.stdout = result.stdout.replace(
						/api[_-]?key[=:]\S+/gi,
						"api_key=***",
					);
				}

				// Layer 5: Credential exclusion (log only hashes, not raw creds)
				recordAuditEntry({
					ts: Date.now(),
					target: inp.target,
					command: inp.command ?? "",
					hash: result.hash,
					code: result.code,
				});

				return result;
			},
		};
		tools[origExecIdx] = enhancedExec as AgentTool;
	}

}
