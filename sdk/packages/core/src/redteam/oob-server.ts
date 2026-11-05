import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";

export interface OobCallback {
	id: string;
	type: "http" | "dns";
	receivedAt: number;
	sourceIp?: string;
	data: string;
}

export interface OobServer {
	start(port?: number): Promise<{ port: number; url: string; token: string }>;
	stop(): void;
	getCallbacks(): OobCallback[];
	clear(): void;
}

export function createOobServer(): OobServer {
	const callbacks: OobCallback[] = [];
	let server: Server | null = null;
	let token = "";

	return {
		async start(port = 0) {
			token = randomBytes(16).toString("hex");
			return new Promise((resolve, reject) => {
				server = createServer((req, res) => {
					const id = randomBytes(8).toString("hex");
					let body = "";
					req.on("data", (c) => {
						body += c.toString();
					});
					req.on("end", () => {
						callbacks.push({
							id,
							type: "http",
							receivedAt: Date.now(),
							sourceIp: req.socket.remoteAddress,
							data: `${req.method} ${req.url}\n${JSON.stringify(req.headers)}\n${body}`,
						});
						res.writeHead(200, { "Content-Type": "text/plain" });
						res.end("OK");
					});
				});
				server.listen(port, "0.0.0.0", () => {
					const addr = server?.address();
					const p = typeof addr === "object" && addr ? addr.port : port;
					resolve({ port: p, url: `http://0.0.0.0:${p}`, token });
				});
				server.on("error", reject);
			});
		},
		stop() {
			server?.close();
			server = null;
		},
		getCallbacks() {
			return [...callbacks];
		},
		clear() {
			callbacks.length = 0;
		},
	};
}
