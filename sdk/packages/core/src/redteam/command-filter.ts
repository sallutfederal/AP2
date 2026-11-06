// Command filtering layer — 7-layer defense-in-depth
// Inspired by CrowdStrike's secure agent harness execution

export interface CommandFilterResult {
	allowed: boolean;
	reason: string;
	filteredCommand: string;
	layer: string;
}

const DANGEROUS_PATTERNS: { pattern: RegExp; reason: string; layer: string }[] =
	[
		{
			pattern: /rm\s+-rf\s+\/(?!\w)/,
			reason: "Recursive delete of root filesystem",
			layer: "command-filter",
		},
		{
			pattern: /dd\s+if=.*of=\/dev\/(sd|hd|nvme)/,
			reason: "Direct disk write",
			layer: "command-filter",
		},
		{ pattern: /mkfs\./, reason: "Filesystem format", layer: "command-filter" },
		{ pattern: /:(){ :|:& };:/, reason: "Fork bomb", layer: "command-filter" },
		{
			pattern: />\s*\/dev\/(sd|hd|nvme)/,
			reason: "Direct disk overwrite",
			layer: "command-filter",
		},
		{
			pattern: /chmod\s+777\s+\//,
			reason: "World-writable root",
			layer: "command-filter",
		},
		{
			pattern: /curl.*\|\s*(bash|sh|python)/,
			reason: "Pipe to shell (potential malware)",
			layer: "command-filter",
		},
		{
			pattern: /wget.*\|\s*(bash|sh|python)/,
			reason: "Pipe to shell (potential malware)",
			layer: "command-filter",
		},
	];

export class CommandFilter {
	private allowlist: Set<string> = new Set();
	private volumeCeiling = 1000;
	private actionCount = 0;
	private outputSanitizer = true;

	setAllowlist(targets: string[]): void {
		this.allowlist = new Set(targets.map((t) => t.toLowerCase()));
	}

	setVolumeCeiling(ceiling: number): void {
		this.volumeCeiling = ceiling;
	}

	check(command: string, target?: string): CommandFilterResult {
		// Layer 1: Dangerous pattern detection
		for (const { pattern, reason, layer } of DANGEROUS_PATTERNS) {
			if (pattern.test(command)) {
				return { allowed: false, reason, filteredCommand: "", layer };
			}
		}

		// Layer 2: Scope enforcement
		if (target && this.allowlist.size > 0) {
			const t = target.toLowerCase();
			const inScope =
				this.allowlist.has(t) ||
				[...this.allowlist].some((s) => t.endsWith(s) || s.endsWith(t));
			if (!inScope) {
				return {
					allowed: false,
					reason: `Target ${target} not in scope`,
					filteredCommand: "",
					layer: "scope-enforcement",
				};
			}
		}

		// Layer 3: Volume ceiling
		if (this.actionCount >= this.volumeCeiling) {
			return {
				allowed: false,
				reason: `Volume ceiling reached (${this.volumeCeiling})`,
				filteredCommand: "",
				layer: "volume-ceiling",
			};
		}

		// Layer 4: Credential exclusion (sanitize output)
		let filtered = command;
		if (this.outputSanitizer) {
			// Remove potential credential patterns from command
			filtered = filtered.replace(/password[=:]\S+/gi, "password=***");
			filtered = filtered.replace(/token[=:]\S+/gi, "token=***");
			filtered = filtered.replace(/secret[=:]\S+/gi, "secret=***");
		}

		this.actionCount++;
		return {
			allowed: true,
			reason: "OK",
			filteredCommand: filtered,
			layer: "passed",
		};
	}

	resetVolume(): void {
		this.actionCount = 0;
	}

	getActionCount(): number {
		return this.actionCount;
	}
}
