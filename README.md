# Flows

Flows finds the **user (UI) flows and API flows** of a web app from two inputs:

- its **source code** (one or more repos, parsed statically: your code is never run);
- optionally, its **live URL**, which a read-only explorer visits.

You review the flows on a local page, with the code (and screenshots, requests) behind every step, then export them
as JSON for a test tool. Flows itself writes and runs no tests.

The first supported stack is Next.js 14 (App Router) for the web app and Express 4 with TypeScript for the API.

## Install

Flows needs Node.js 24.12 or newer.

```bash
npm install --global ./flows-0.1.0.tgz
```

Then download the models it runs locally (about 430 MB, checked against their checksums). This works offline
afterwards, which matters for coding assistants whose sandbox blocks the network:

```bash
flows setup
```

`flows setup` also says whether it found a browser for the live-app commands (Google Chrome, Microsoft Edge, or
Playwright's Chromium). Only `flows explore`, `flows login` and `flows inspect` need one.

## First flows, with the sample project

The package ships a tiny sample: a Next.js shop and its Express API.

```bash
cp -r "$(npm root --global)/flows/examples/quickstart" quickstart
cd quickstart
flows init
flows repo add web --role web
flows repo add api --role api
flows scan
flows ui
```

`flows scan` parses both repos and builds the flows; `flows ui` opens the review page. To use it on your own app,
run the same commands in its root and register its web and API folders.

## What you can do

| Command | What it does |
|---|---|
| `flows scan` | Parse the repos and build their flows (again after any code change; unchanged files are cached). |
| `flows show flows` | Print the flows, with the evidence for every step. |
| `flows ui` | The review page: approve, reject, edit, categorise and add flows. Your changes are saved in each repo's `.flows/` folder, so they go into version control with the code. |
| `flows export --out flows.json` | Write the reviewed flows (every enabled flow) as JSON for a test tool: each step's request (with the body's fields and rules), its expected result, and its errors (status, which guard or handler sends it, and the message), so negative cases can be written too. |
| `flows explore <url>` | Visit the running app read-only (every write and WebSocket is blocked before it reaches the app) and cross-check what it shows with source. |
| `flows login <url> --as <name>` | Log in once by hand; the session is kept locally for `explore --as <name>`. |
| `flows inspect` | Use the app by hand in a browser window, for what the explorer can't reach. |
| `flows eval` | In a project: the Decider's accuracy, calibration and drift since its last refit. |
| `flows cost` | LLM calls and tokens per run (a cost only with prices in the config). |

`flows help` lists every command.

## Working as a team

Commit the `.flows/` folders. They hold everything people decided: reviews, edits, added flows, learned rules
(`rules.jsonl`, `flows.jsonl` in each repo) and the LLM's flow names and categories (`answers.jsonl` in the project).
So everyone who scans gets the same flows, and only the first scan of a change waits for the LLM.

Each file gets one line per change and is only ever appended to. The `.gitattributes` Flows writes beside them
tells git to keep both sides' lines, so two people reviewing at once never get a merge conflict. When they judge the
same flow, the later judgment wins; when they edit different fields of one flow, both edits stay.

## AI and privacy

Flows decides most things itself, with a small local embedding model. An LLM is used only for flow names,
descriptions and the categories the local model can't decide, and every answer is checked against the code.

- By default the LLM is a local model through [Ollama](https://ollama.com) (`llama3.2:3b`): nothing leaves the
  machine.
- Inside a coding assistant, set `"llm": { "provider": "assistant" }` in `.flows/config.json`: the assistant does
  these jobs (`flows jobs`, `flows answer`) and Flows calls no model at all. `skill/flows/SKILL.md` is the Agent
  Skill that tells the assistant how.
- A hosted model needs your own API key, read only from the environment variable the config names.

The live-app commands keep screenshots, requests and saved sessions in Flows' local cache, never in `.flows/`, and
redact tokens and personal data from what they store.

## Development

```bash
npm install
npm test           # unit, fixture and browser tests
npm run typecheck
npm run build      # dist/: plain JavaScript, the data files and the prebuilt review page
npm pack           # builds, then makes flows-<version>.tgz
```

`PLAN.md` is the design and the record of decisions.
