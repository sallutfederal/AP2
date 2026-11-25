import type { AgentTool } from "@cline/shared";
import { registerAdvancedReTools } from "./tools/advanced-re-tools";
import { registerAutonomousOpsTools } from "./tools/autonomous-ops-tools";
import { registerExecKaliTools } from "./tools/exec-kali-tools";
import { registerPlannerCampaignTools } from "./tools/planner-campaign-tools";
import { registerReconExploitTools } from "./tools/recon-exploit-tools";
import {
	createRedTeamRuntimeEnv,
	type RedTeamToolContext,
} from "./tools/shared";

export type { RedTeamToolContext } from "./tools/shared";

export function createRedTeamTools(ctx: RedTeamToolContext): AgentTool[] {
	const env = createRedTeamRuntimeEnv(ctx);

	registerReconExploitTools(env);
	registerExecKaliTools(env);
	registerAdvancedReTools(env);
	registerPlannerCampaignTools(env);
	registerAutonomousOpsTools(env);

	if (ctx.includeLegacyRefTools === true) {
		return env.tools;
	}

	// Keep active HTTP discovery tools exposed directly, while consolidating the
	// 58 static rt_ref_* and 14 rt_re_* schemas into rt_reference & rt_reverse_engineer.
	const ACTIVE_REF_TOOLS = new Set([
		"rt_ref_waf_fingerprint",
		"rt_ref_discover_params",
		"rt_ref_discover_api",
		"rt_ref_graphql_probe",
		"rt_ref_exploit_verify",
		"rt_ref_retest",
	]);
	return env.tools.filter((tool) => {
		if (tool.name.startsWith("rt_re_")) {
			return false;
		}
		if (tool.name.startsWith("rt_ref_") && !ACTIVE_REF_TOOLS.has(tool.name)) {
			return false;
		}
		return true;
	});
}
