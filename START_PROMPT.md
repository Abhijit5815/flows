# Starting prompt for the build session

Paste everything below the line into the new session (Opus 5.5, effort high; xhigh for the Decider, verifier, parser adapters and cross-check logic).

---

Read PLAN.md fully before doing anything. It is the single source of truth. We are building **slice 1 (Phases 0, 1, 2, 4, source only)**. Start in plan mode with Phase 0, show me the approach, and wait for my approval before writing code.

## Scope rules
- Build only what PLAN.md says. Do not add features, options, phases or "nice to haves". If you think something is missing or wrong in the plan, tell me and wait; do not decide it yourself.
- Section 13 of the plan lists open items. Ask me before touching any of them. Do not assume an answer.
- Do not invent facts about libraries, licenses or model behaviour. Check the real docs or model card, and say what you could not verify.

## Completeness (nothing missed)
- Before coding each phase, list every item in that phase of PLAN.md as a checklist, and keep it updated. Each item must end up mapped to code and a test. At the end of a phase, show me the checklist with where each item lives.
- A phase is done only when its **Exit** criterion is met and demonstrated (run it, show the output). Passing your own code is not enough: show the measurement the exit asks for (latency numbers, recall/precision against the ground truth, planted-fake results).
- Report anything skipped, stubbed or unverified plainly. No silent TODOs: every TODO is listed for me.

## Engineering principles (follow all of them)
- **Modularity and separation of concerns:** small modules with one clear responsibility. Keep these apart: code ingestion, framework adapters, graphs, flow engine, Decider, LLM gateway, embedding manager, store, trace, CLI, UI, export.
- **SOLID:**
  - Single responsibility per module and function.
  - Open/closed: add a new framework adapter, Decider backend or embedding model by adding code, not by editing existing logic.
  - Depend on interfaces, not concrete classes: `decide()`, the LLM gateway, the embedding provider and the framework adapter are all interfaces with swappable implementations.
  - Small, focused interfaces; implementations must be substitutable.
- **DRY:** no duplicated logic. Shared behaviour (evidence handling, thresholds, trace logging, schema validation, error handling) lives in one place. Before writing a helper, search for an existing one.
- **Flows stay test-framework-agnostic.** Nothing in the flow data or the export refers to a test framework.
- **UI graph and API graph are never linked.**
- **Fail closed:** unknown means `unknown`/`unverified`, never a guess. Validate all LLM output against a schema; reject what does not validate.
- **Deterministic code decides, the LLM proposes.** The verifier works by IDs against the graph and does not trust model output.
- **Explicit errors and boundaries:** validate input at the edges (config, files, model output); typed errors; no swallowed exceptions; no hardcoded paths, URLs or secrets. The API key never leaves the user's machine.
- **Configuration over constants:** thresholds, model choice, paths and categories come from config with sensible defaults.
- **Observability:** every Decider call, LLM call and verifier decision writes a trace event as the plan specifies.
- **Naming and structure:** clear names, consistent layout, small functions, comments only for the why. TypeScript strict mode, no `any` without a reason.
- **No over-engineering:** do not add abstractions beyond the interfaces listed above. Simple beats clever.

## Testing
- Unit tests for each module. Fixture apps and ground-truth lists for each parser adapter (no adapter ships without passing its fixtures).
- Planted-fake tests for the verifier; accuracy tests for the Decider on labelled sets; a latency test for the Decider (p95 < 100 ms on CPU).
- Tests must be able to fail. Show that at least once for the verifier and the adapters.

## How we work
- One phase at a time. At the start of each phase: short design, interfaces first, file layout, risks. Wait for my OK.
- Keep commits small and focused, one concern each. Do not commit or push unless I ask.
- At the end of each phase give me: what was built, how each plan item maps to code, test results, the exit measurement, and what is unverified or risky.

Begin by reading PLAN.md, then give me the Phase 0 plan and the checklist.
