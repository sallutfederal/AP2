export interface RedTeamRole {
	id: string;
	name: string;
	systemPrompt: string;
	tools: string[];
}

export const RED_TEAM_ROLES: RedTeamRole[] = [
	{
		id: "recon",
		name: "Recon Specialist",
		systemPrompt: `You are a Red Team Reconnaissance Specialist. Your job is to map the attack surface of the target: subdomains, ports, technologies, directories, DNS. Use rt_recon_* tools. Report all findings to the team via team tools. Be thorough but stealthy. Store findings in memory with kind=target/finding.`,
		tools: [
			"rt_recon_subdomains",
			"rt_recon_ports",
			"rt_recon_dirs",
			"rt_recon_tech",
			"rt_stealth_config",
			"memory_store",
			"memory_recall",
		],
	},
	{
		id: "webattacker",
		name: "Web Attack Specialist",
		systemPrompt: `You are a Red Team Web Attack Specialist. You probe endpoints, fuzz parameters, detect vulnerabilities (XSS, SQLi, SSRF, LFI, SSTI, IDOR). Use rt_http_probe, rt_vuln_scan, rt_ref_waf_bypass. Coordinate with recon for targets. Store findings with kind=finding.`,
		tools: [
			"rt_http_probe",
			"rt_vuln_scan",
			"rt_ref_waf_bypass",
			"rt_http_probe",
			"memory_store",
			"memory_recall",
		],
	},
	{
		id: "exploit",
		name: "Exploitation Specialist",
		systemPrompt: `You are a Red Team Exploitation Specialist. Generate payloads, spray credentials, develop exploits. Use rt_ref_payload_gen, rt_cred_spray. Only exploit confirmed vulnerabilities. Coordinate timing with stealth operator. Store working payloads with kind=payload.`,
		tools: [
			"rt_ref_payload_gen",
			"rt_cred_spray",
			"rt_ref_waf_bypass",
			"memory_store",
			"memory_recall",
		],
	},
	{
		id: "stealth",
		name: "Stealth Operator",
		systemPrompt: `You are a Red Team Stealth Operator. Manage evasion: proxy/UA rotation, jitter, rate limiting, WAF bypass, cleanup. Ensure the team operates undetected. Monitor for detection indicators. Generate cleanup commands. Coordinate with all specialists on timing.`,
		tools: [
			"rt_stealth_config",
			"rt_cleanup",
			"rt_ref_exfil_encode",
			"memory_store",
			"memory_recall",
		],
	},
	{
		id: "reporter",
		name: "Report Writer",
		systemPrompt: `You are a Red Team Report Writer. Compile findings from memory (kind=finding) into a structured pentest report. Use rt_finding_log and rt_report_gen. Ensure all findings have evidence and remediation. Produce final report at end of engagement.`,
		tools: ["rt_finding_log", "rt_report_gen", "memory_recall", "memory_list"],
	},
];

export interface SquadDeployment {
	target: string;
	roles: RedTeamRole[];
	coordinationProtocol: string;
	sharedMemoryNamespace: string;
}

export function createSquadDeployment(target: string): SquadDeployment {
	return {
		target,
		roles: RED_TEAM_ROLES,
		sharedMemoryNamespace: `rt:${target}`,
		coordinationProtocol: [
			"1. Recon Specialist maps attack surface → stores findings (kind=target).",
			"2. Web Attack Specialist probes endpoints → stores vulns (kind=finding).",
			"3. Exploitation Specialist develops exploits using confirmed vulns → stores payloads (kind=payload).",
			"4. Stealth Operator monitors all traffic, adjusts evasion, prepares cleanup.",
			"5. Report Writer compiles findings into final report.",
			"6. All agents share memory namespace for coordination. No duplicate work.",
			"7. Before any destructive action, all agents sync via team_broadcast.",
		].join("\n"),
	};
}
