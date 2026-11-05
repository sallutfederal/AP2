# Agent Enhancement Plan — "Invasion Agent" Upgrade

## 0. Incisão

- **Artifact:** Cline SDK agent runtime (`@cline/agents` + `@cline/core` + `@cline/shared`)
- **Method:** systematic gap-mapping across runtime loop, session persistence, memory, tools/hooks/plugins, context compaction
- **First operation:** audit current capabilities → identify missing cognitive layers → propose phased plan

---

## 1. Current State Map

### 1.1 Runtime layer (`@cline/agents`)

- `AgentRuntime` — stateless loop: turn → model → tool calls → tool results → repeat.
- Hooks: `beforeRun`, `afterRun`, `beforeModel`, `afterModel`, `beforeTool`, `afterTool`, `onEvent`.
- Plugins: register tools/hooks at init.
- Compaction: `prepareTurn` seam (owned by core).
- Recovery: max-tokens recovery, provider-error retry, context-overflow recovery, interrupted turn continuation.
- State: in-memory `messages`, `usage`, `pendingToolCalls`, abort controller.
- **No persistent memory across sessions. No self-model. No goal stack.**

### 1.2 Session layer (`@cline/core`)

- `ConversationStore` — in-memory message list, conversation id, session-started gate.
- `PersistenceService` — persists messages artifact, compaction artifact.
- `SessionService` — lifecycle, restore, fork, history listing.
- `ToolResultCache` — session-owned oversized result cache with URI recovery.
- Checkpoints, fork metadata, team persistence.

### 1.3 Memory-related primitives already present

- Context compaction (`${sessionId}.compaction.json`) — working-context summary, not episodic memory.
- Tool result cache — short-lived (5 iterations), LRU, 16 MiB cap.
- `initialMessages` seed — can rehydrate from external storage.
- `restore(messages)` — re-seed runtime from persisted transcript.
- **No vector store, no long-term facts, no user preference memory, no cross-session recall.**

### 1.4 Tools / extensibility

- Tool registry with policies, timeouts, retryable, execution mode.
- Plugin sandbox (worker/subprocess).
- MCP integration, connectors, cron, schedules.
- Hooks system for lifecycle interception.
- **No built-in memory tool (store/recall facts). No planning tool. No self-reflection tool.**

### 1.5 Observability / self-awareness

- Telemetry events (run-started, turn-started, tool-*, run-finished).
- Snapshot API.
- **No self-state model (goals, beliefs, open questions, confidence). No introspection endpoint.**

---

## 2. Gaps Identified (what makes the agent "weak")

| # | Gap | Impact |
|---|-----|--------|
| G1 | No persistent memory across sessions | Agent forgets everything between runs |
| G2 | No self-model / identity state | Cannot reason about its own capabilities/limits |
| G3 | No goal stack / task decomposition | Single flat loop, no sub-goal tracking |
| G4 | No episodic memory (what worked/failed) | Repeats mistakes |
| G5 | No user preference / profile memory | Re-asks same questions |
| G6 | No reflection step between turns | Blind execution, no self-correction |
| G7 | Compaction is lossy summarization only | Loses actionable facts |
| G8 | No memory tool exposed to model | Model cannot deliberately remember/recall |
| G9 | No cross-session recall API | Hosts cannot query "what did agent learn" |
| G10 | No confidence / uncertainty tracking | Overconfident outputs |
| G11 | No mistake-limit / circuit breaker beyond maxIterations | Runaway loops possible |
| G12 | No persistent identity (agentId resets per run) | No continuity |

---

## 3. Proposed Enhancements

### Phase A — Persistent Chat Memory (foundation)

**A1. Memory store abstraction**
- New package module `@cline/core/src/memory/` with `MemoryStore` interface.
- Backends: SQLite (default, like hub), in-memory (tests), pluggable.
- Schema: `memories(id, sessionId?, agentId?, kind, key, value, embedding?, createdAt, updatedAt, expiresAt, source)`.

**A2. Memory kinds**
- `fact` — discrete facts ("user prefers TypeScript")
- `episode` — task outcomes ("fixed auth bug by adding retry")
- `preference` — user prefs
- `skill` — learned procedures
- `reflection` — self-generated insights

**A3. Memory tool for the model**
- Tools: `memory_store`, `memory_recall`, `memory_forget`, `memory_list`.
- Wired into default tool catalog when memory enabled.
- Policy: read always allowed, write gated by approval (configurable).

**A4. Auto-memory (implicit)**
- After each run, extract candidate facts from transcript via a small model call (optional, gated by setting).
- Store with `source: "auto"` and confidence score.
- Dedup by key (upsert).

**A5. Cross-session recall at run start**
- `beforeRun` hook injects top-K relevant memories into system context (semantic search if embeddings available, else keyword/recency).
- Configurable: `memory.recallOnRunStart`, `memory.recallTopK`.

### Phase B — Self-Awareness / Self-Model

**B1. Agent identity persistence**
- Persist `agentId` + `agentProfile` (role, capabilities, model, created) to store.
- Reuse across sessions (configurable identity continuity).

**B2. Self-state object**
- `SelfState { goals: Goal[], beliefs: Belief[], openQuestions: string[], confidence: number, lastReflection }`.
- Persisted per session, injected into system prompt as "self-context".

**B3. Goal stack**
- `Goal { id, parent, description, status, subgoals, evidence }`.
- Tools: `goal_push`, `goal_complete`, `goal_status`.
- Agent can decompose tasks into sub-goals.

**B4. Reflection step**
- After N turns or on tool failure, inject a "reflect" prompt: summarize what worked, what failed, what to try next.
- Store reflection as `memory kind=reflection`.
- Configurable cadence.

**B5. Capability self-knowledge**
- System prompt includes a "what I can do" section generated from registered tools + plugins.
- Updated when tool set changes.

### Phase C — Stronger Execution

**C1. Planning tool**
- `plan_create` — produce a structured plan (steps, dependencies, risks) before execution.
- Plan stored, referenced in self-state.

**C2. Self-correction on failure**
- On tool error, trigger a reflection mini-turn (not just retry).
- Track error patterns in episodic memory.

**C3. Circuit breaker**
- Replace flat `maxIterations` with: max iterations, max consecutive failures, max cost, max time.
- Graceful degradation message instead of hard throw.

**C4. Better compaction**
- Compaction should extract facts into memory before summarizing.
- Preserve actionable items (TODOs, decisions) in a structured sidecar.

**C5. Multi-modal memory (embeddings)**
- Optional embedding provider for semantic recall.
- Fallback to keyword if unavailable.

### Phase D — Observability & Control

**D1. Introspection API**
- `agent.introspect()` → self-state, memory summary, goal stack, recent episodes.
- Exposed via hub command `agent.introspect`.

**D2. Memory management UI/CLI**
- CLI commands: `cline memory list/add/remove/export`.
- Settings toggle for auto-memory.

**D3. Audit trail**
- All memory writes logged with source + confidence.
- Exportable for review.

---

## 4. Implementation Order (suggested)

1. **Phase A1–A3** (memory store + tools) — foundation, unblocks rest.
2. **Phase B1–B2** (identity + self-state) — depends on A.
3. **Phase A4–A5** (auto-memory + recall) — depends on A1.
4. **Phase B3–B5** (goals + reflection + capability knowledge).
5. **Phase C1–C4** (planning + correction + circuit breaker + compaction).
6. **Phase D** (observability + CLI + audit).

---

## 5. Files / Touch Points

- `sdk/packages/shared/src/agent.ts` — add memory/self-state types, new tool contracts.
- `sdk/packages/agents/src/agent-runtime.ts` — inject memory hooks, self-state, reflection cadence, circuit breaker.
- `sdk/packages/core/src/memory/` — NEW: MemoryStore, backends, service.
- `sdk/packages/core/src/session/services/` — integrate memory recall into session start.
- `sdk/packages/core/src/runtime/tools/` — add memory_* + goal_* + plan_* tools.
- `sdk/packages/core/src/extensions/config/` — memory settings watcher.
- `apps/cli/src/commands/` — memory CLI commands.
- `sdk/packages/core/src/hub/server/` — introspect hub command.

---

## 6. Risks & Mitigations

- **Context bloat from memory injection** → cap recall to top-K, budget tokens, truncate.
- **Auto-memory noise / false facts** → confidence scoring, user review, forget tool.
- **Embedding provider dependency** → optional, keyword fallback.
- **Performance (SQLite per session)** → reuse hub DB, single connection, WAL.
- **Privacy** → memory scoped to session/agent, export/delete commands, opt-in auto-memory.

---

## 7. Open Questions for Zyon

1. Should memory be **global** (across all sessions) or **per-workspace**? (Recommend: per-workspace default, global opt-in.)
2. Auto-memory: **on by default** or opt-in? (Recommend: opt-in initially.)
3. Embeddings: which provider? (Recommend: reuse configured LLM provider if it supports embeddings, else skip.)
4. Self-reflection cadence: every N turns or only on failure? (Recommend: on failure + every 5 turns.)
5. Goal stack: should goals persist across sessions? (Recommend: yes, as memory kind=goal.)

---

## 8. Success Criteria

- Agent recalls facts from previous sessions (verified by test).
- Agent tracks and completes sub-goals (verified by introspect).
- Agent self-corrects after tool failure (verified by episode memory).
- No regression in existing tests (`bun test`).
- Memory bounded (no unbounded growth).
- All new code passes biome + typecheck.

---

*Plan generated. Awaiting approval before implementation.*
