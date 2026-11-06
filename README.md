# AP2 — Autonomous Red Team Agent

AP2 is an autonomous red team / offensive security agent built on the Cline SDK. It combines 157 red-team tools, a dual-graph coverage tracker, cognitive memory, an autonomous planner, Docker/Kali integration, and a strong identity lock for any LLM.

## Features

- **157 Red Team Tools** — recon, vuln scan, exploitation, post-exploitation, evasion, C2, persistence, reporting
- **Docker/Kali Integration** — runs real tools (nmap, nuclei, sqlmap, etc.) inside a Kali container
- **Autonomous Planner** — HTN-style planning with auto-execution, branching, and retry
- **Memory & Cognition** — SQLite-backed long-term memory, self-state, emotional tracking, predictions
- **Dual-Graph** — asset graph + exploration graph for coverage tracking and trace sharing
- **897 Security Skills** — from claude-red and anthropic-cybersecurity-skills
- **Strong Identity Lock** — AP2 red-team operator persona that overrides model defaults
- **Scope/Dry-Run/Kill-Switch** — safety controls for authorized testing only
- **Audit Trail** — SHA-256 hash chain for chain of custody

## Requirements

- Node.js 18+ or Bun
- Docker Desktop (for Kali container tools)
- A LLM provider API key (OpenAI, Anthropic, or custom)

## Quick Start

```bash
# Clone
git clone https://github.com/sallutfederal/AP2.git
cd AP2

# Install dependencies
bun install

# Run
bun run dev
```

## Docker/Kali Setup

```bash
# Inside the CLI, run:
rt_docker_setup
rt_docker_enable enabled=true
```

This pulls the Kali image and installs nmap, nuclei, sqlmap, ffuf, gobuster, nikto, masscan, hydra, wafw00f, whatweb.

## Usage

```
# Recon
rt_plan_auto goal="recon example.com" target="example.com" mode="recon"

# Full attack
rt_plan_auto goal="full assessment example.com" target="example.com" mode="full"

# Individual tools
rt_nmap target="example.com"
rt_nuclei target="example.com"
rt_subfinder domain="example.com"
rt_vuln_templates url="https://example.com"

# Target discovery
rt_target_discover criteria="e-commerce"
rt_dork_search dork="site:*.com inurl:login"
```

## Configuration

- Provider settings: `~/.cline/data/settings/providers.json`
- Memory DB: `~/.cline/data/cognitive.db`
- Plan DB: `~/.cline/data/plans.db`
- Graph DB: `~/.cline/data/graph.db`
- Skills: `~/.agents/skills/` and `~/.cline/skills/`

## License

MIT
