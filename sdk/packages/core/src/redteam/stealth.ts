import { randomInt } from "node:crypto";

export interface StealthConfig {
	/** Proxy pool (http/https/socks5 URLs). */
	proxies: string[];
	/** Current proxy index (round-robin). */
	proxyIndex: number;
	/** User-Agent pool. */
	userAgents: string[];
	/** Min/max delay between requests (ms). */
	jitterMinMs: number;
	jitterMaxMs: number;
	/** Max requests per second (0 = unlimited). */
	rateLimitRps: number;
	/** Enable WAF evasion encodings. */
	wafEvasion: boolean;
	/** Enable header randomization. */
	headerRandomization: boolean;
}

const DEFAULT_USER_AGENTS = [
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
];

export class StealthMiddleware {
	private config: StealthConfig;
	private requestCount = 0;
	private windowStart = Date.now();

	constructor(config?: Partial<StealthConfig>) {
		this.config = {
			proxies: config?.proxies ?? [],
			proxyIndex: 0,
			userAgents: config?.userAgents ?? [...DEFAULT_USER_AGENTS],
			jitterMinMs: config?.jitterMinMs ?? 200,
			jitterMaxMs: config?.jitterMaxMs ?? 1200,
			rateLimitRps: config?.rateLimitRps ?? 5,
			wafEvasion: config?.wafEvasion ?? true,
			headerRandomization: config?.headerRandomization ?? true,
		};
	}

	getConfig(): StealthConfig {
		return { ...this.config };
	}

	updateConfig(patch: Partial<StealthConfig>): void {
		Object.assign(this.config, patch);
	}

	/** Pick next proxy (round-robin). */
	nextProxy(): string | undefined {
		if (this.config.proxies.length === 0) return undefined;
		const p =
			this.config.proxies[this.config.proxyIndex % this.config.proxies.length];
		this.config.proxyIndex += 1;
		return p;
	}

	/** Pick random UA. */
	randomUA(): string {
		const pool = this.config.userAgents;
		return pool[randomInt(0, pool.length)];
	}

	/** Jitter delay. */
	async jitter(): Promise<void> {
		const ms =
			this.config.jitterMinMs +
			randomInt(
				0,
				Math.max(1, this.config.jitterMaxMs - this.config.jitterMinMs),
			);
		await new Promise((r) => setTimeout(r, ms));
	}

	/** Rate limit enforcement. */
	async rateLimit(): Promise<void> {
		if (this.config.rateLimitRps <= 0) return;
		const now = Date.now();
		if (now - this.windowStart >= 1000) {
			this.windowStart = now;
			this.requestCount = 0;
		}
		this.requestCount += 1;
		if (this.requestCount > this.config.rateLimitRps) {
			const wait = 1000 - (now - this.windowStart);
			if (wait > 0) await new Promise((r) => setTimeout(r, wait));
			this.windowStart = Date.now();
			this.requestCount = 1;
		}
	}

	/** Build stealth headers. */
	buildHeaders(extra?: Record<string, string>): Record<string, string> {
		const headers: Record<string, string> = {
			"User-Agent": this.randomUA(),
			Accept:
				"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
			"Accept-Language": this.config.headerRandomization
				? `en-US,en;q=${(0.7 + Math.random() * 0.3).toFixed(2)}`
				: "en-US,en;q=0.9",
			"Accept-Encoding": "gzip, deflate, br",
			Connection: "keep-alive",
			"Upgrade-Insecure-Requests": "1",
			...extra,
		};
		if (this.config.headerRandomization) {
			// randomize accept order occasionally
			if (Math.random() < 0.3) {
				headers["Sec-Fetch-Dest"] = "document";
				headers["Sec-Fetch-Mode"] = "navigate";
				headers["Sec-Fetch-Site"] = "none";
				headers["Sec-Fetch-User"] = "?1";
			}
		}
		return headers;
	}

	/** WAF evasion: encode payload. */
	evadeWaf(payload: string): string {
		if (!this.config.wafEvasion) return payload;
		// Random case variation on SQL keywords
		const keywords = [
			"SELECT",
			"UNION",
			"FROM",
			"WHERE",
			"OR",
			"AND",
			"INSERT",
			"UPDATE",
			"DELETE",
		];
		let out = payload;
		for (const kw of keywords) {
			const re = new RegExp(kw, "gi");
			out = out.replace(re, (m) =>
				m
					.split("")
					.map((c) => (Math.random() > 0.5 ? c.toUpperCase() : c.toLowerCase()))
					.join(""),
			);
		}
		return out;
	}

	/** Full pre-request pipeline. */
	async preRequest(): Promise<{
		proxy?: string;
		headers: Record<string, string>;
	}> {
		await this.rateLimit();
		await this.jitter();
		return { proxy: this.nextProxy(), headers: this.buildHeaders() };
	}
}
