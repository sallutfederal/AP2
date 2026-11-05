import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(execCb);

export interface DockerMiddlewareOptions {
	containerName?: string;
	image?: string;
}

export class DockerMiddleware {
	private containerName: string;
	private image: string;
	private enabled = false;
	private dockerCmd = "docker";
	private dockerResolved = false;

	constructor(options: DockerMiddlewareOptions = {}) {
		this.containerName = options.containerName ?? "kali-redteam";
		this.image = options.image ?? "kalilinux/kali-rolling";
	}

	private async resolveDockerCmd(): Promise<void> {
		if (this.dockerResolved) return;
		try {
			await execAsync("docker --version", { timeout: 5000 });
			this.dockerCmd = "docker";
		} catch {
			try {
				await execAsync("wsl -d Ubuntu -e docker --version", {
					timeout: 10000,
				});
				this.dockerCmd = "wsl -d Ubuntu -e docker";
			} catch {
				this.dockerCmd = "docker";
			}
		}
		this.dockerResolved = true;
	}

	get container(): string {
		return this.containerName;
	}

	isEnabled(): boolean {
		return this.enabled;
	}

	private async runDocker(
		cmd: string,
		timeoutMs = 300000,
	): Promise<{ stdout: string; stderr: string; code: number }> {
		await this.resolveDockerCmd();
		const fullCmd = `${this.dockerCmd} ${cmd}`;
		try {
			const { stdout, stderr } = await execAsync(fullCmd, {
				timeout: timeoutMs,
				maxBuffer: 10 * 1024 * 1024,
			});
			return {
				stdout: stdout.slice(0, 100000),
				stderr: stderr.slice(0, 100000),
				code: 0,
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
			};
		}
	}

	async enable(): Promise<boolean> {
		try {
			const r = await this.runDocker(
				`inspect -f {{.State.Running}} ${this.containerName}`,
			);
			if (r.stdout.trim() === "true") {
				this.enabled = true;
				return true;
			}
			await this.runDocker(`start ${this.containerName}`);
			const r2 = await this.runDocker(
				`inspect -f {{.State.Running}} ${this.containerName}`,
			);
			this.enabled = r2.stdout.trim() === "true";
			return this.enabled;
		} catch {
			this.enabled = false;
			return false;
		}
	}

	async disable(): Promise<void> {
		this.enabled = false;
	}

	async status(): Promise<{
		running: boolean;
		container: string;
		image: string;
		tools: string[];
	}> {
		const r = await this.runDocker(
			`inspect -f {{.State.Running}} ${this.containerName}`,
		);
		const running = r.stdout.trim() === "true";
		this.enabled = running;
		const tools = running ? await this.listTools() : [];
		return { running, container: this.containerName, image: this.image, tools };
	}

	async setup(): Promise<{ success: boolean; message: string }> {
		try {
			const pull = await this.runDocker(`pull ${this.image}`, 300000);
			if (pull.code !== 0)
				return { success: false, message: `pull failed: ${pull.stderr}` };
			try {
				const inspect = await this.runDocker(`inspect ${this.containerName}`);
				if (inspect.code !== 0) throw new Error("not found");
				const state = await this.runDocker(
					`inspect -f {{.State.Running}} ${this.containerName}`,
				);
				if (state.stdout.trim() !== "true") {
					const start = await this.runDocker(`start ${this.containerName}`);
					if (start.code !== 0) {
						await this.runDocker(`rm -f ${this.containerName}`);
						const run = await this.runDocker(
							"run -d --name " +
								this.containerName +
								" " +
								this.image +
								" sleep 1000000",
							60000,
						);
						if (run.code !== 0)
							return { success: false, message: `run failed: ${run.stderr}` };
					}
				}
			} catch {
				const run = await this.runDocker(
					"run -d --name " +
						this.containerName +
						" " +
						this.image +
						" sleep 1000000",
					60000,
				);
				if (run.code !== 0)
					return { success: false, message: `run failed: ${run.stderr}` };
			}
			await this.runDocker(
				`exec ${this.containerName} dpkg --configure -a`,
				300000,
			);
			const update = await this.runDocker(
				`exec ${this.containerName} apt-get update`,
				120000,
			);
			if (update.code !== 0)
				return {
					success: false,
					message: `apt update failed: ${update.stderr}`,
				};
			const install = await this.runDocker(
				"exec " +
					this.containerName +
					" apt-get install -y nmap nuclei sqlmap ffuf gobuster nikto whatweb wafw00f masscan hydra",
				600000,
			);
			if (install.code !== 0)
				return { success: false, message: `install failed: ${install.stderr}` };
			this.enabled = true;
			return {
				success: true,
				message: "Kali container ready with red team tools",
			};
		} catch (e: unknown) {
			const err = e as { message?: string };
			return { success: false, message: err.message ?? "Setup failed" };
		}
	}

	async listTools(): Promise<string[]> {
		if (!this.enabled) return [];
		try {
			const r = await this.runDocker(
				"exec " +
					this.containerName +
					" bash -c \"ls /usr/bin | grep -iE 'nmap|nuclei|sqlmap|ffuf|gobuster|nikto|masscan|hydra|impacket|nxc|certipy|subfinder|httpx|whatweb|wafw00f'\"",
			);
			return r.stdout.trim().split(/\r?\n/).filter(Boolean);
		} catch {
			return [];
		}
	}

	wrapCommand(cmd: string): string {
		if (!this.enabled) return cmd;
		return `${this.dockerCmd} exec ${this.containerName} bash -c ${JSON.stringify(cmd)}`;
	}

	async execInContainer(
		cmd: string,
		timeoutMs = 300000,
	): Promise<{ stdout: string; stderr: string; code: number }> {
		if (!this.enabled) {
			const ok = await this.enable();
			if (!ok)
				return {
					stdout: "",
					stderr: "Docker container not available",
					code: -1,
				};
		}
		const r = await this.runDocker(
			`exec ${this.containerName} bash -c ${JSON.stringify(cmd)}`,
			timeoutMs,
		);
		return r;
	}
}
