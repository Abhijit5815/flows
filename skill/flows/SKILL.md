---
name: flows
description: Find the user (UI) flows and API flows of this app from its source code with the Flows CLI, let the user review them on a local page, and export them as JSON for a test tool. Use when the user asks for the app's flows, wants to review or edit them, or wants them exported.
---

# Flows

Flows reads the app's repos (static parsing only; it never runs the app's code) and builds flows: one per API
route, and for the web app one per page, form and click that does something. Every step cites the code it came
from, and Flows checks every claim against the code itself. You do the few AI jobs it has (names, descriptions,
categories it can't decide), and Flows checks your answers the same way.

If `flows` isn't on the PATH, run it as `node <flows checkout>/src/cli/main.ts`.

## Set up once

1. In the project root: `flows init`, then register each app folder with its role:
   `flows repo add apps/web --role web` and `flows repo add apps/api --role api`.
2. So that you do the AI jobs instead of a model Flows would call, set this in `.flows/config.json`:
   `"llm": { "provider": "assistant" }`.
3. `flows stack` shows the framework found for each repo. If one is wrong, `flows stack set <path> <framework>`.

## Build and answer

1. `flows scan` parses the repos and builds the flows. At the end it says how many AI jobs wait for you.
2. `flows jobs --json` lists them. Each has `instructions`, `facts` and an `answer_schema`.
3. Answer each job with `flows answer <id> '<json>'`. The JSON must match `answer_schema`.
   - Use only the facts. A name or description that says more than the facts is refused at the next scan, and the
     job comes back with `last_refusal` saying why.
   - For a category, pick one of the ids the instructions list.
4. Run `flows scan` again. Repeat until `flows jobs` shows none, or only jobs you can't answer from the facts.

## Hand over to the user

1. Run `flows ui` and give the user the URL it prints. The page shows every flow with the code behind each step.
   The user marks flows correct or wrong, edits them and adds missing ones. Everything they change is saved in each
   repo's `.flows/` folder, so it goes into version control with the code, and later scans never overwrite it.
2. `flows export --out flows.json` writes the reviewed flows (every enabled flow, with the subflows it uses) for the
   test tool. Flows itself writes and runs no tests.

## Rules

- Don't edit the files in `.flows/` by hand: they hold the user's review. Use the page or `flows review`.
- Flows that delete, pay or send stay disabled until the user marks them correct. Don't mark flows yourself; that
  is the user's review.
- `flows show flows|rejected|unreachable` prints what the last scan found, if the user asks in the terminal.
