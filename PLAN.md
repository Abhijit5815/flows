# Flows: Plan (final)

Working name: **Flows**. Status: ready to build, nothing built yet. No time estimates.

## 1. Goal
A tool, independent of any editor, that:
1. **Discovers** the user (UI) flows and API flows of an application from two inputs: its **source code** (one or more repos) and its **live URL**. Each input finds flows on its own; a flow found by both is more likely correct. UI flows and API flows are separate; source-derived API flows come from the backend repo, and nothing links a UI flow to an API flow.
2. Lets users **review, edit, categorise, enable and disable** those flows on a visual canvas, with evidence for why each flow exists.
3. **Exports** the reviewed flows as JSON. Generating tests from them is a separate tool, outside this plan. Flows know nothing about test frameworks.

Optional add-on: an **inspector** the user can turn on to explore the live app by hand and capture additional flows.

The tool never generates or runs tests. It explores the live app only to discover and cross-check flows (read-only, see Phase 3).

## 2. Principles
- **LLM proposes, deterministic code decides.** No flow is "true" because a model said so.
- **Every claim needs evidence** (file:line from source; for observed flows also request/response or screenshot). No evidence means the claim is dropped.
- **Fail closed.** Unknown stays `unverified` and is disabled by default.
- **Provider-agnostic.** Any OpenAI-compatible LLM, Claude through the official Anthropic SDK, or a local model (e.g. Ollama). The user brings their own API key; it stays on their machine.
- **Free, local embeddings.** Open-source embedding model, downloaded on first use, not bundled. Hosted embeddings optional.
- **Local-first for code.** Source never leaves the machine unless the user points to a remote endpoint.
- **Fast decisions without generation.** Routing, intent and guardrails use rules plus an embedding-based classifier (target p95 < 100 ms on CPU), not an LLM.
- **Observable.** Every decision is traceable and replayable.
- **Human feedback is first-class** and persists as project rules.
- **Keep scope small.** Do only what is in this plan.

## 3. Architecture

```
 Repos (e.g. apps/web, apps/api)              Live URL
        |                                          |
  [Code Ingestion]                          [Explorer] read-only automated crawl
  stack detection -> adapters               (+ optional Inspector, manual)
  -> UI graph / API graph                          |
        |                                    observed flows
        +----------------+-------------------------+
                         |
  [Flow Engine]  candidates -> Decider + (LLM if unknown) -> verifier -> reachability
                 -> cross-check source vs observed -> judge
        |
  Flow Store + Provenance trace
        |
  [Flow UI canvas]  <-- feedback --> rules / labels  (rules saved in repo: .flows/)
        |
  [Export]  reviewed flows as JSON --> separate test tool (outside this plan)

```

Components:
- **LLM gateway:** our own small interface with swappable implementations: OpenAI-compatible HTTP (e.g. Ollama) and the official Anthropic SDK for Claude. Roles: `llm` (naming, descriptions, `unknown` cases) and `embedder`; each can be pointed at a different model. The default `llm` is a free local model (Ollama), so nothing leaves the machine; hosted models need the user's own API key. Chat subscriptions (Claude Pro, Copilot, Cursor) can't be used by an outside tool. Recommended hosted option: OpenRouter with GLM 5.3 (`z-ai/glm-5.3`), which is OpenAI-compatible, so it needs config only; users should turn on OpenRouter's privacy setting that blocks providers which collect data (or require zero data retention), because by default it may route to providers that store prompts.
- **Embedding manager:** user picks the model (see 6).
- **Decider:** our own `decide(task_type, input, allowed_labels) -> {label, prob, all_probs, version}` (see 7).
- **Store:** generated flows are per-repo JSON files in the deletable cache, since they can be rebuilt from source. Everything a person adds lives as JSON in the user's repo (`.flows/`): learned rules and review feedback (`rules.jsonl`), human edits and added flows (`flows.jsonl`), so it is reviewed and versioned with the code and git history is its version history. No SQLite. The tool's own storage holds only a deletable cache.
- **Trace:** append-only provenance log for every decision and model call.

## 4. Data model (sketch)
- `Project`, `Repo(role: web|api)` (a monorepo can register `apps/web` and `apps/api` as two roles), `Environment(url)` for the live app
- `GraphNode` / `GraphEdge` for the UI graph and the API graph, each with `evidence` (file:line). No edges between the two graphs.
- `Flow { id, name, category, kind: ui|api, origin: source|observed|both, status, confidence, enabled, priority, tags, version }`
- `Step { flow_id, order, kind: ui|api|subflow, claim, check, evidence[], enabled, subflow_ref? }`. A `subflow` step points to another flow (e.g. Login), so common flows are defined once and reused. A flow used by many others is `shared`. References must not form cycles; nesting depth capped at 3 (configurable). `check` is the expected result taken from source (page/element after a UI action, status and response fields for an API call); empty if source is silent.
- `Evidence { type: code|network|dom|screenshot, ref }` (network/dom/screenshot only for observed flows)
- `Category { id, name, color, editable }` (user-defined; defaults provided)
- `Feedback { flow_id/step_id, verdict, comment }`, `Rule { scope, pattern|exclusion }`
- `TraceEvent { decision_type, inputs_ref, probs, threshold, model_version, llm_call?, tokens }`

Flow `status`: `confirmed` (found in source and observed on the live app) | `verified` (all claims have source evidence and the flow is reachable, not observed) | `observed-only` (seen on the live app, no matching source) | `unreachable` | `unverified` | `rejected`. Confidence rises from `verified` or `observed-only` to `confirmed`.

## 5. Phases (build in usable slices; each slice is tested on the open-source sample apps; the user's app is used only once the tool is complete)
Slice 1 = Phases 0, 1, 2, 4 (source only). Slice 2 = Phase 5. Slice 3 = Phase 3 (live URL discovery and cross-check). Phase 7 later. There is no Phase 6: test generation is a separate tool, outside this plan.

### Phase 0: Spikes
- Latency spike: embed + match under 100 ms p95 on CPU with 2-3 candidate small embedding models.
- Define flow JSON schema v0 and category defaults.
- Hand-write the ground-truth list of routes/pages/endpoints for 2-3 open-source sample apps on the same frameworks. The user's app gets its ground truth only once the tool is complete and the user provides its dev repo and live URL.
- **Exit:** latency numbers recorded; schema and ground truth signed off.

### Phase 1: Core platform
- Project/config model, repo registration with roles.
- LLM gateway; test against one hosted and one local model.
- Embedding manager: model catalogue, download/cache with checksum, remote option, versioned index, re-index on change.
- Decider v1 (see 7), trace logging.
- Trace store and a minimal viewer (CLI or JSON).
- **Exit:** `decide()` meets the latency target; model swap works end to end; every call is traced.

### Phase 2: Code ingestion and graphs
Slice 1 stack: Next.js 14 App Router on the frontend, Express 4 + TypeScript on the backend (section 14).
- **Stack detection** from `package.json`, lockfiles and config; shown to the user, correctable.
- **One adapter per framework**, mostly declarative pattern rules on tree-sitter / ast-grep, each shipped with a fixture app and an expected route list.
- **Resolution:** the TypeScript compiler API (ts-morph) resolves constants, imports and types (e.g. route prefixes).
- Extract: routes, handlers, auth guards, request schemas (Zod), response shapes, DB models touched (API graph); pages, components, forms, actions, guards, and the API call each action makes recorded as a step with method and path (UI graph). The API call is not linked to a backend route.
- Static parsing only; no project code is executed.
- **Safety nets:** a coverage report per run (files parsed, skipped, unrecognised patterns), and a "possibly missed" list from pattern search plus embedding search for code that looks like handlers or actions but was not extracted. Nothing in that list becomes a flow automatically.
- **Learning from feedback:** "you missed this" (user points at file:line) proposes a pattern rule, confirmed by the user and saved in `.flows/`. "Not a flow" saves an exclusion rule. Detected frameworks, base paths, entry points and shared guards are cached; re-analysis only touches changed files (content hash).
- **Unknown framework:** the LLM may draft an adapter rule from examples the user marks; it is accepted only if it reproduces those examples.
- **Exit:** on the sample apps (on the user's app once the tool is complete), extracted routes/pages/endpoints are compared with the ground truth; recall and precision recorded.

### Phase 3: Live URL discovery (explorer, then inspector add-on)
Source shows what the code can do; the live app shows **what the user actually sees**: conditional rendering, feature flags, role-based screens, and what is really reachable from the UI. Using both raises the odds that a flow is correct.
- **Explorer (automated, read-only):** a Playwright/CDP agent starts at the URL and follows visible navigation, links and non-destructive forms. For each page it records what is rendered (visible text, buttons, fields, navigation) with a screenshot, plus the network calls the page made. The Decider picks the next action from a fixed action set; the LLM is only for ambiguous forms. Anything the Decider rates destructive (delete, pay, send) is never clicked; neither is anything it rates `unknown`, or `safe` with low confidence (threshold in config): when unsure, the explorer treats the action as destructive. Candidate flows are tagged `origin: observed`.
- **Cross-check with source:** an observed flow is matched to a source flow (UI: route and visible elements; API: method and path, with observed URLs like `/orders/123` matched to source route patterns like `/orders/:id`, inside the API side only). A match merges them as `origin: both` with status `confirmed`. Source flows never observed stay `verified`; observed flows with no source match are `observed-only` and shown for review.
- **Login:** the user logs in themselves (session state kept locally) or points to credentials in env; the tool invents none.
- **Inspector add-on (optional, off by default):** the user turns it on and uses the app by hand to capture flows the explorer cannot reach (multi-step data entry, role-specific paths). It feeds the same store and goes through the same cross-check, review and feedback. Hovering an element shows what the graph knows and lets the user correct it.
- **Gaps are tagged and prompted, not hidden:** a source flow the explorer never saw is tagged `not observed`; a role found in source guards (e.g. admin) that no run has covered is listed as `role not explored`. Each tag has a **"Walk this in the inspector"** action: the inspector opens at the URL in guided mode, shows the flow's steps, and the user performs them; each step is ticked when the observed action matches, and the result is cross-checked like any observed flow. The user can also run it freely for anything the tags do not cover.
- Decider filters noise (analytics, polling, assets). Tokens and personal data in captured traffic are redacted.
- Runs after slice 1 works on source alone, since the cross-check needs source flows to compare against.
- **Exit:** on a running sample app (which one, and where it runs, decided at the start of slice 3), the explorer finds the main flows seen by a human user, and the cross-check reports matches, source-only and observed-only flows.

### Phase 4: Flow engine
Decision order, stopping at the first that is sure: (1) plain rules, (2) embedding-based Decider, (3) entailment check for "does this evidence support this claim", (4) LLM only for `unknown` cases plus naming and descriptions.
- Candidate generation by graph traversal from real entry points (no LLM).
- **Verifier:** each step's claims are checked against the graph by ID. Uncited steps are dropped.
- **Static reachability:** a flow needs a path from a real entry point (router, nav, public endpoint) to its steps; unreachable code is flagged.
- **Judge:** status and confidence from claims proven, evidence types, reachability, agreement between source and observed flows (once the live URL is used), and past feedback. Thresholds configurable.
- Shared steps (e.g. Login) are proposed as subflows; the user reviews them like any flow.
- **Decision log and rejected-candidate list** with reasons.
- Destructive-looking flows (delete, pay, send) are always shown for review regardless of confidence.
- **Decider data from real texts:** rebuild the `destructive-risk` examples and labelled set from the sample apps' real UI and API texts, and re-measure against the 90% gate. Phase 1 baseline (bge-small, hand-written held-out set): `destructive-risk` 82% accuracy on the items it decides, 85% coverage, 2 of 20 destructive items called safe; `flow-category` 94% at 57% coverage.
- **Exit:** zero fabricated routes/steps pass the verifier (planted-fake tests); flow precision measured by manual review.

### Phase 5: Flow UI
- Canvas (React Flow): nodes are steps, lanes are categories.
- Enable/disable at category, flow and step level; bulk actions; filters (category, status, repo, UI/API).
- Badges: status, confidence, UI/API, steps with no check, steps with no stable selector, `not observed`, `role not explored`, with the "Walk this in the inspector" action.
- Side panel: evidence (code snippet; request/response and screenshot for observed flows), "why this flow" trace with the Decider's probabilities, rejected candidates.
- Category editor (create, rename, merge, recolour).
- Subflow editor: create (from scratch or by extracting selected steps), edit, swap or remove. Editing a shared subflow updates all flows that use it, after listing them; a "make a copy for this flow" button duplicates it for one flow. Disabling a shared flow warns about dependents. Human edits are never overwritten by regeneration.
- Add flow: describe in text (the system searches the code and either proposes a flow or explains what it could not find), draw nodes, or promote a "discovered but not a flow" item.
- Feedback controls: correct, wrong, edit steps, missing step, never suggest again, comment.
- Version history.
- Export the reviewed flows as JSON (the flow schema) for a separate test tool.
- **Delivery:** Flows ships as a TypeScript library with a CLI and an Agent Skill (SKILL.md) that tells the user's coding assistant how to run the CLI; the review canvas is a local web page the CLI opens. Inside an assistant, the assistant does the AI jobs (naming, descriptions, `unknown` cases) on the user's own plan, and Flows validates every answer by schema and by graph ID. Without an assistant (direct CLI use, unattended runs), Flows uses its own model: local by default, an API key optional. An MCP server (with MCP Apps for review inside the chat) comes later, only if users need Flows in chat apps without a command line.
- **Exit:** a reviewer can approve or reject a flow from its evidence alone (usability pass with 2-3 QA users).

### Phase 7: Learning loop, evals, packaging (later)
- Feedback becomes labelled examples and rules; Decider re-fit and re-calibration per project.
- Eval harness: labelled sets per decision type, precision/recall, calibration checks, and a drift monitor of Decider vs human overrides (kept, 2026-10-21).
- Staleness: on code change, flag flows that lost evidence.
- Token and cost report per run.
- Packaging: TypeScript library (with a build step to JavaScript, since Node won't run `.ts` files from installed packages) + CLI + local app + Agent Skill; a setup command that downloads the embedding model ahead of time (some assistants block the network inside their sandbox); README; sample project.
- **Exit:** install-to-first-flow works on a fresh machine.

## 6. Embedding model selection
- Catalogue of open-source local models showing size, license (read from the model card, not assumed), and measured latency on the user's machine (benchmark button).
- Default list contains only MIT / Apache-2.0 models; others allowed but labelled. Candidates: bge-small (MIT, proposed default), BGE-M3 (MIT); Qwen3-Embedding only after its license is confirmed.
- No model weights are bundled; they are downloaded on first use from the original source, with checksum and progress.
- Remote embeddings via any OpenAI-compatible endpoint as an option.
- Switching models marks the index stale and re-indexes; calibrations tied to the old model are re-fitted.
- The same model serves code search and the Decider. A separate small entailment (BERT-class) model is used for the grounding check: cross-encoder/nli-deberta-v3-xsmall (see 13).

## 7. Decider (own implementation)
Decisions covered: route class (user-facing / internal), flow category, event noise vs relevant, duplicate flow, destructive-action risk, claim-vs-evidence grounding (entailment model), whether the LLM needs to be called.
1. Plain rules first (e.g. `/admin`, `delete*`).
2. Prototype classifier on embeddings: per-label example set, similarity scoring, calibration (temperature/Platt) on labelled data.
3. Reject option: below threshold or small margin gives `unknown`; the item goes to the LLM, then to the user.
4. Upgrade to a logistic head on frozen embeddings as examples accumulate.
5. Same interface allows other backends (Jev or similar) later; nothing depends on them.
6. Thresholds are per decision type and conservative at first; probabilities are shown in the UI.
7. Everything is logged to the trace.

## 8. Cross-cutting
- **Observability:** provenance trace, LLM audit (prompt, context slice, output, tokens), re-run diffs.
- **Testing the tool itself:** planted-fake tests for the verifier, ground-truth comparisons for the adapters, a latency test (p95 < 100 ms for the Decider), accuracy tests of the Decider on labelled sets.
- **Privacy:** local-first; the API key stays on the user's machine; captured traffic is redacted.
- **Token efficiency:** static analysis first, graph slices only, content-hash caching.

## 9. Risks (all resolved)
| Risk | Resolution |
|---|---|
| UI-to-API linking unreliable | UI and API flows are separate, each from source. No linking. |
| Overconfident classifier | `unknown` instead of guessing, visible probabilities, learning from corrections, destructive-looking flows always reviewed, accuracy tested on labelled sets. |
| Scope too large | Slices 1-3, one stack; inspector and extras later. |
| Model licenses | No bundled weights; permissive licenses by default; license shown in the picker; model cards checked before listing. |
| Destructive flows | The tool generates and runs no tests. The explorer is read-only and never clicks anything the Decider rates destructive; destructive-looking flows are flagged for review. |
| Explorer login and coverage | The user logs in; the explorer only sees what that account can reach and cannot find everything. Gaps are tagged (`not observed`, `role not explored`) and the user is prompted to walk them in the inspector (guided mode) or run it freely. Both kinds of flow are shown with their status. |
| Parser misses flows | Coverage report, "possibly missed" list, ground-truth tests, rules learned from feedback. Not eliminated. |

## 10. Scope
First release: Next.js 14 (App Router) frontend and Express 4 + TypeScript backend, JSON export of reviewed flows, web only, local single-user. **Not in v1:** other frameworks, mobile and desktop apps, Socket.IO/real-time flows, performance testing, visual regression, test generation and execution (a separate tool).

## 11. Success metrics
- Parser recall and precision against the ground truth.
- Fabricated steps passing the verifier: 0 on the planted-fake suite.
- Flow precision after manual review.
- Decider p95 latency < 100 ms; Decider accuracy on labelled sets.
- Share of decisions needing an LLM call (lower is better); tokens per analysed repo.
- Time from install to first flow.

## 12. Decisions
1. TypeScript end to end; Python sidecar for models only if needed.
2. Reviewed flows are exported as JSON; a separate tool, outside this plan, generates tests from them.
3. The tool never generates or runs tests. The live URL is a second discovery input: a read-only explorer (and the optional inspector add-on) finds flows as the user actually sees them and cross-checks them with source. It can point at any environment.
4. Test apps during the build: 2-3 open-source samples on the same frameworks. The user's own monorepo is used only once the tool is complete (the user provides its dev repo and live URL).
5. Team: the user plus Claude. No time estimates.
6. Local single-user mode first.
7. Build our own Decider; the embedding model is free, open-source, local and user-selectable; the LLM is user-supplied (API key or local).
8. UI flows and API flows are separate and never linked to each other. Both inputs (source and live URL) feed each.
9. Parsing is static only in v1. Learned rules live in the user's repo (`.flows/`).
10. Flows are test-framework-agnostic.
11. Subflows are reusable and user-editable; nesting depth cap of 3 (confirmed 2026-10-20).

## 13. Open items
- Embedding model, decided for now (2026-10-19): bge-small-en-v1.5 at fp32, from BAAI's own repo (MIT on the model card). It is the only candidate that met p95 < 100 ms at all three input sizes measured (spikes/latency/RESULTS.md); BGE-M3 and Qwen3-Embedding are not used for now.
- Parser tools, decided 2026-10-19: ast-grep (`@ast-grep/napi`, MIT) for declarative pattern rules and ts-morph (MIT; bundles its own TypeScript 6.0.2, so the project's TypeScript 7 doesn't affect it) for resolving constants, imports and prefixes. The tree-sitter TypeScript grammar is not used directly (its npm package was last released in 2024 and needs an older tree-sitter). Spike: spikes/parsers/RESULTS.md.
- Entailment model, decided 2026-10-20: cross-encoder/nli-deberta-v3-xsmall at fp32, from the publisher's own repo (Apache-2.0 on the model card; trained on SNLI and MultiNLI only). Measured: p95 7.3 ms per claim on CPU.
- Subflow nesting cap, confirmed 2026-10-20: 3, in config.
- Flow store, decided 2026-10-20: generated flows are per-repo JSON files in the cache. At the start of Phase 5 (same day): no SQLite; human edits, added flows and feedback live as JSON in the repo's `.flows/`, and git history is the version history.
- Phase 5, decided 2026-10-20: the canvas is React Flow (`@xyflow/react`, MIT). The exit's usability pass with 2-3 QA users happens once Flows runs on the user's app; until then Claude checks the exit itself on the test apps. Badges that need the live app (no stable selector, not observed, role not explored, "Walk this in the inspector") come with Phase 3.
- Phase 3, decided 2026-10-20 with the approved design:
  - **Browser:** the explorer drives an installed browser through `playwright-core` (Apache-2.0) and downloads none. It tries the configured browser, then Chrome, then Edge, then Playwright's own Chromium, so it runs on Mac, Windows and Linux.
  - **Read-only, at the network:** every request other than GET, HEAD or OPTIONS is aborted and recorded, WebSockets never connect, and service workers are blocked. The one exception is the login submit with env credentials: only the request whose body carries the password gets through.
  - **Inspector:** it blocks nothing, because the person drives.
  - **Storage:** observed runs live in the deletable cache. People's decisions and the inspector's corrections (`match` rules) live in `.flows/`.
  - **Matching:** a UI flow matches by its page and visible elements. Its calls are evidence when they were seen; they don't decide, because a Next.js server component makes some calls out of the browser's sight. An API flow matches by method and the most specific route pattern, and only an answer other than 404, 405 or 501 confirms it.
  - **Explorer gate:** it rates a control as the source flows it matches, by the engine's own texts, and uses the live text only when nothing matches. The Decider data is Phase 4's, unchanged, plus a new `event-noise` task.
  - **Exit:** chessu ran on the user's Mac (pnpm through npx, PostgreSQL 15 from Homebrew, its data in the cache). Claude wrote the answer key, `ground-truth/live/chessu.json`, from a browser walk before any explorer run.
- Phase 7, decided 2026-10-21 with the approved design:
  - **Drift monitor:** kept. `flows eval` reports, per decision type, how often people overrode the current Decider version; below 10 overrides it says "too few to tell", above `decider.drift_warn` (default 0.2) it warns.
  - **Learning:** only unambiguous feedback teaches the Decider: a person's category is a `flow-category` example, a flow marked correct and left enabled is a `destructive-risk` `safe` example; wrong and never teach nothing. The labelled (held-out) sets stay the built-in ones.
  - **Cost:** tokens per run from the trace; money only from `llm.price_per_mtok` in config, never invented prices.
  - **Shipping:** a tarball from `npm pack`, not published (`private: true`). `npm run build` emits JavaScript to `dist/` with the review page pre-bundled; `flows setup` downloads the models ahead of time.
  - **Exit:** run on this Mac (macOS arm64, Node 25.3) in an empty home, npm cache and global prefix: install 12 s, `flows setup` 28 s (about 430 MB), scan of `examples/quickstart` 62 s with Ollama and under 2 s with the LLM unreachable, 22 flows exported either way. Windows and Linux are unverified.
- Team use through git, decided 2026-10-26:
  - **Same flows for everyone:** the LLM's flow names, descriptions and categories are kept in the project's `.flows/answers.jsonl` by prompt alone, whatever model answered, so a team that commits it gets identical flows and each answer is paid for once. Live form values and rule drafts carry page and code details and stay in the local cache.
  - **No merge conflicts:** `rules.jsonl`, `flows.jsonl` and `answers.jsonl` take one JSON record per line, only appended, and Flows writes `.flows/.gitattributes` with `*.jsonl merge=union` so git keeps both sides' lines. Rules are ordered by their full timestamp (the latest verdict wins); edits are stored as patches and folded oldest first (a field only one person set survives, the later one wins a field both set). The older `rules.json` and `flows.json` are still read, under the new lines.
  - **Open:** `answers.jsonl` keeps answers for prompts the code no longer produces; the drift counts in `flows eval` are per machine.
- Hosted LLM check (left open when Phase 1 closed, 2026-10-19): the hosted path of the LLM gateway (Claude through the Anthropic SDK, or any OpenAI-compatible provider) is tested only against a fake server. A real call still needs a user's own API key; Phase 1 closed with the local model (Ollama `llama3.2:3b`) verified live.

## 14. First supported stack (slice 1)
The user's app (used once the tool is complete) is a monorepo: `apps/web` (frontend role) and `apps/api` (backend role); sample apps are picked on the same stack.
- Frontend adapter: Next.js 14 App Router (file-based routes, route groups, dynamic segments, layouts, server actions, forms), React 18, TypeScript, Zod.
- Backend adapter: Express 4 + TypeScript (router mounting and prefixes, middleware chain, custom JWT auth middleware, Zod request schemas, the `{success, data, error, timestamp}` response envelope). Prisma models read for data context.
- Out of slice 1: Socket.IO real-time flows, Redis, pgvector specifics.
- Hard spots: detecting custom JWT auth middleware (expect one user correction saved as a rule), and Express prefix/loop route mounting (needs constant resolution).
