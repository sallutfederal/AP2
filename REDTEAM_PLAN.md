# Red Team Agent — CLI Capability Plan

## 0. Incisão

- **Artifact:** Cline CLI agent (red team mode)
- **Method:** capability mapping — recon → access → post-exploitation → exfil → cleanup
- **First operation:** enumerate gaps vs. full red-team kill chain, then add tools + stealth layer

---

## 1. Current CLI Agent Capabilities (relevant)

Already present:
- `run_commands` (shell exec), `read_files`, `search_codebase`, `apply_patch`, `edit_file`
- `web_fetch`, `skills`, `ask_question`, `submit_and_exit`
- MCP tools, connectors, team spawning, cron/schedules
- Memory + self-state (just wired)
- Tool policies, approvals, parallel/sequential execution

Missing for red team:
- No recon tooling (port scan, subdomain enum, tech fingerprint)
- No HTTP probing / fuzzing tools
- No payload generation / encoding
- No session/cookie management for web attacks
- No C2 / beaconing primitives
- No stealth/evasion layer (proxy rotation, UA rotation, jitter)
- No credential harvesting / spraying tools
- No report generation for findings

---

## 2. Proposed Red Team Tool Suite

### Phase R1 — Reconnaissance

| Tool | Purpose |
|------|---------|
| `rt_recon_subdomains` | Passive + active subdomain enumeration (crt.sh, DNS brute, permutation) |
| `rt_recon_ports` | TCP/UDP port scan with service detection, banner grab |
| `rt_recon_tech` | Tech stack fingerprinting (headers, cookies, body patterns, Wappalyzer-style) |
| `rt_recon_dirs` | Directory/file brute-force (wordlist-based, status code filtering) |
| `rt_recon_dns` | DNS records, zone transfer attempt, MX/NS/TXT analysis |
| `rt_recon_whois` | WHOIS + ASN + IP range lookup |

### Phase R2 — Web Attack Surface

| Tool | Purpose |
|------|---------|
| `rt_http_probe` | HTTP request builder with full control (method, headers, body, cookies, proxy) |
| `rt_http_fuzz` | Parameter fuzzing (positions, payloads, encoding, concurrency) |
| `rt_http_crawl` | Spider/crawler for endpoint discovery, form extraction, JS analysis |
| `rt_http_intercept` | Request/response inspection and modification (Burp-style, programmatic) |
| `rt_vuln_scan` | Automated vuln scanning (XSS, SQLi, SSRF, LFI, SSTI, IDOR) per endpoint |
| `rt_jwt_analyze` | JWT decode, crack (weak secret), alg confusion, none alg |

### Phase R3 — Exploitation & Access

| Tool | Purpose |
|------|---------|
| `rt_payload_gen` | Payload generation (reverse shells, web shells, encoded variants) |
| `rt_exploit_run` | Run exploit against target with configurable params |
| `rt_cred_spray` | Credential spraying (HTTP basic, form, API) with lockout awareness |
| `rt_session_manage` | Cookie jar, token storage, session rotation |

### Phase R4 — Post-Exploitation & Stealth

| Tool | Purpose |
|------|---------|
| `rt_pivot` | Tunnel/proxy setup (SOCKS, SSH tunnel, port forward) |
| `rt_exfil` | Data exfiltration helpers (chunked, encoded, via DNS/HTTP) |
| `rt_persist` | Persistence mechanisms (cron, service, registry, web shell) |
| `rt_cleanup` | Artifact removal, log tampering detection evasion |
| `rt_stealth_config` | UA rotation, proxy rotation, jitter, timing randomization |

### Phase R5 — Reporting & Memory

| Tool | Purpose |
|------|---------|
| `rt_finding_log` | Log finding (severity, evidence, remediation) to memory |
| `rt_report_gen` | Generate structured pentest report (markdown/HTML) |
| `rt_chain_build` | Build attack chain narrative from findings |

---

## 3. Stealth Layer (Anti-Detection)

Built into every `rt_*` tool:

- **Proxy rotation** — HTTP/SOCKS5 proxy pool, round-robin or random
- **UA rotation** — realistic browser UA pool, per-request rotation
- **Timing jitter** — randomized delays between requests (configurable min/max)
- **Header randomization** — Accept, Accept-Language, Referer randomization
- **Rate limiting** — configurable requests/sec to avoid triggering WAF/IDS
- **TLS fingerprint** — mimic real browser TLS (JA3/JA4) where possible
- **Request signing** — optional custom headers for auth
- **Retry with backoff** — on 429/503, exponential backoff
- **WAF evasion** — encoding tricks, case variation, comment injection, HTTP parameter pollution
- **Session isolation** — separate cookie jars per target

Configuration via `rt_stealth_config` tool + env vars / config file.

---

## 4. Memory Integration (Red Team Specific)

Extend memory kinds with:
- `target` — target profile (IPs, domains, tech stack, endpoints)
- `finding` — vulnerability findings with severity/evidence
- `credential` — harvested creds (encrypted at rest)
- `payload` — generated payloads that worked
- `chain` — attack chain steps

Memory recall at run start injects:
- Known targets and their profiles
- Previous findings for the target
- Working credentials
- Successful payloads

---

## 5. Architecture

```
┌─────────────────────────────────────────────┐
│  Cline CLI Agent (Red Team Mode)            │
├─────────────────────────────────────────────┤
│  Memory Layer (SQLite)                      │
│  ├── targets, findings, creds, payloads     │
│  └── recall at run start                    │
├─────────────────────────────────────────────┤
│  Red Team Tool Suite                        │
│  ├── Recon (subdomain, port, tech, dirs)    │
│  ├── Web Attack (probe, fuzz, crawl, scan)  │
│  ├── Exploitation (payload, cred spray)     │
│  ├── Post-Exp (pivot, exfil, persist)       │
│  └── Stealth (proxy, UA, jitter, WAF ev)   │
├─────────────────────────────────────────────┤
│  Stealth Middleware                         │
│  ├── Proxy pool + rotation                  │
│  ├── UA rotation + header randomization     │
│  ├── Rate limiting + jitter                 │
│  └── WAF evasion encoders                   │
├─────────────────────────────────────────────┤
│  Cline Core Runtime                         │
│  ├── Agent loop, hooks, plugins             │
│  ├── MCP, connectors, cron                  │
│  └── Tool policies, approvals               │
└─────────────────────────────────────────────┘
```

---

## 6. Implementation Order

1. **R1 Recon** — subdomain, port, tech, dir brute
2. **Stealth middleware** — proxy/UA/jitter (needed by all HTTP tools)
3. **R2 Web Attack** — probe, fuzz, crawl, vuln scan
4. **R3 Exploitation** — payload gen, cred spray
5. **R4 Post-Exp** — pivot, exfil, persist, cleanup
6. **R5 Reporting** — findings, report gen, chain
7. **Memory extension** — target/finding/cred/payload kinds

---

## 7. Safety Notes (physical/operational only)

- All tools require explicit target scope (target list) — no unscoped scanning
- Credential storage encrypted at rest (AES-256-GCM)
- Destructive actions (persist, cleanup) require approval
- Rate limits enforced by default (configurable, never unlimited)
- All actions logged to audit trail

---

## 8. Success Criteria

- Agent can perform full recon on a target domain
- Agent can probe and fuzz web endpoints
- Agent can detect common web vulns (XSS, SQLi, SSRF, LFI)
- Agent maintains stealth (no detection by basic WAF/IDS)
- All findings stored in memory and reported
- Memory persists across sessions

---

*Plan for red team agent. Awaiting approval before implementation.*
