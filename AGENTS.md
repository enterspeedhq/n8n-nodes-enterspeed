# AGENTS.md

Universal instructions for any coding agent (Claude Code, Cursor, Copilot,
Gemini CLI, ...) working in this repository. Tool-specific shortcuts live in
[CLAUDE.md](CLAUDE.md); technical component detail lives in
[ARCHITECTURE.md](ARCHITECTURE.md).

## Overview

`@enterspeed/n8n-nodes-enterspeed` is the n8n community node package for
[Enterspeed](https://www.enterspeed.com), a headless data delivery platform.
It ships two n8n node types plus one shared credential type (the community
node naming convention this package name follows is `@<scope>/n8n-nodes-<name>`):

- **`Enterspeed`** — an action node covering four resources (`entity`,
  `delivery`, `query`, `route`), letting workflows ingest, deliver, and query
  Enterspeed data.
- **`EnterspeedTrigger`** — a push trigger ("Enterspeed Webhook Trigger")
  that reacts to Enterspeed view deploy/remove events, optionally fetching
  the full view from the Delivery API.
- **`EnterspeedApi`** — the one credential type both nodes share (two API
  keys, three overridable host URLs).

See `ARCHITECTURE.md`'s "System overview" for how these fit together.

- Language: TypeScript (`strict` mode)
- Runtime target: n8n community node API (peer dependency `n8n-workflow`)
- Build: `@n8n/node-cli` (`n8n-node build`)
- Tests: Vitest

## Important notes

- Follow the rules in this document, `CLAUDE.md`, and `ARCHITECTURE.md` over
  any example code you find in n8n's own docs (linked under **Additional
  resources** below) if they conflict — those examples are generic
  single-resource tutorials, not this package's entity/delivery/query/route
  resource-and-operation pattern.
- New nodes, credentials, or operations must match the existing patterns in
  `nodes/Enterspeed/actions/<resource>/` and `credentials/` (see "Key
  guidelines" below) — don't introduce a different shape modeled on a
  generic scaffold.
- This codebase intentionally has **no fixed schema** for Enterspeed
  request/response payloads (`ARCHITECTURE.md`, "Core data models & state").
  Index and entity shapes are defined per Enterspeed customer/schema, so
  don't assume an `"id"` field, a `"data"` wrapper, or any other fixed key
  exists in an entity/query response — everything is opaque `IDataObject`.

## Project structure

Two folders drive what n8n actually loads: `nodes/` (one subfolder per node)
and `credentials/` (one file per credential type). `package.json`'s `n8n`
field points at the *compiled* output of both:

```json
"n8n": {
  "n8nNodesApiVersion": 1,
  "credentials": ["dist/credentials/EnterspeedApi.credentials.js"],
  "nodes": [
    "dist/nodes/Enterspeed/Enterspeed.node.js",
    "dist/nodes/Enterspeed/EnterspeedTrigger.node.js"
  ]
}
```

Adding, removing, or renaming a node/credential file means updating this
`n8n.nodes`/`n8n.credentials` array to match — n8n resolves these paths
literally against `dist/`, so a stale entry loads nothing (or throws) at
runtime. The full layout beyond those two top-level folders:

```
nodes/Enterspeed/
  Enterspeed.node.ts              action node — delegates to actions/router.ts
  EnterspeedTrigger.node.ts       push trigger — delegates to webhookTrigger/handler.ts
  transport.ts                    thin httpRequest wrapper, no auth/base-url injection
  actions/
    router.ts                     resource/operation dispatch + credential mapping
    types.ts                      EnterspeedCredentials shape
    entity/ delivery/ query/ route/
      index.ts                    operation selector + properties for this resource
      shared.ts                   field builders reused across the resource's operations
      *.operation.ts              one file per operation (properties + execute())
  webhookTrigger/
    properties.ts                 Actions / Fetch Full View / Access Key parameters
    handler.ts                    webhook() logic: auth check, payload build, view fetch
credentials/
  EnterspeedApi.credentials.ts    the enterspeedApi credential type
  enterspeed.svg                  copy of the node's icon (see ARCHITECTURE.md)
tests/
  Enterspeed.node.test.ts
  EnterspeedTrigger.node.test.ts
  mocks.ts                        minimal IExecuteFunctions/IWebhookFunctions stand-ins
  workflow-templates.test.ts      validates every JSON file under workflows/templates/
workflows/templates/*.json        example workflows (see "Example workflows" below)
scripts/
  setup.mjs                       creates credential + imports all templates into local Docker n8n
  execute-workflow.mjs            triggers a named workflow, polls its execution
dist/                             build output — gitignored, never hand-edited
```

## Key guidelines

- Use the `n8n-node` CLI (`npm run build`/`dev`/`lint`) wherever possible
  instead of reaching for `tsc`/`eslint` directly — see `CLAUDE.md` for the
  full command list.
- Always address lint and typecheck errors/warnings rather than suppressing
  them, unless there's a specific, documented reason not to (see
  `ARCHITECTURE.md`'s "Known lint inconsistency" note for the one existing
  exception and why it's justified).
- Use proper types wherever possible — this repo compiles with
  `strict: true` and `noUnusedLocals: true`; don't reach for `any` or `as`
  casts to route around a type error.
- **Never commit a real Enterspeed credential ID.** Every credential
  reference inside `workflows/templates/*.json` must use the literal
  placeholder `__ENTERSPEED_CREDENTIAL_ID__` — enforced by
  `tests/workflow-templates.test.ts`, which also scans for any stray
  16-character alphanumeric string in a credential `"id"` field.
- **Workflow templates must use node type `CUSTOM.enterspeed`**, the type
  n8n assigns when loading via Docker's `N8N_CUSTOM_EXTENSIONS`. Templates
  built against an `npm link`-loaded instance register as
  `@enterspeed/n8n-nodes-enterspeed.enterspeed` instead and will show "unknown node" for
  anyone importing them — always author/export templates from the Docker
  setup (see `CONTRIBUTING.md`).
- **Never hand-edit `dist/`.** It's regenerated by `npm run build`
  (`n8n-node build` — see `ARCHITECTURE.md`) and is gitignored.
- **New operations belong under `actions/<resource>/`** as their own
  `*.operation.ts` file, wired into that resource's `index.ts`. Don't inline
  new logic into `router.ts` or the node classes themselves.
- **Every node parameter needs a `description`** — enforced by
  `@n8n/eslint-plugin-community-nodes` + `eslint-plugin-n8n-nodes-base`
  (`eslint.config.mjs`); `npm run lint` will fail otherwise.
- **No customer personal data or credentials in chat/tooling context** —
  this repo is governed by Enterspeed's ISO 27001 / GDPR data-handling
  policy regardless of which agent is operating on it.

## Workflow and PR rules

- Branch from `main`: `feat/<short-description>`, `fix/<short-description>`,
  `chore/<short-description>`.
- Keep commits focused — one logical change per commit.
- Run `npm run lint` and `npm test` before pushing.
- Fill in the PR template; state which operations were tested and against
  which n8n version.
- **Adding a new operation**: add its value to the resource's `operation`
  options array → add gated input fields (`displayOptions.show.operation`)
  → handle it in that resource's `execute()` → add at least one unit test in
  `tests/` → update `README.md` under **Operations**.
- **Versioning** (semver): patch = bug fix or doc update; minor = new
  operation or node, backwards-compatible; major = breaking credential or
  API shape change.

## Example workflows

`workflows/templates/` holds example n8n workflows, each an exported JSON
array with the credential placeholder substituted in-memory (never on disk)
by `scripts/setup.mjs`. To add one: build/test it in a local Docker n8n
instance, export it, strip `id`/`versionId`/`shared`/`creatorId`/
`projectId`/`workflowId` and any real credential ID, replace the credential
ID with `__ENTERSPEED_CREDENTIAL_ID__`, then commit it under
`workflows/templates/`.

## Context-specific docs

This repo doesn't split per-topic guidance into a `.agents/` folder; it's
concentrated in the three root docs instead. Read the relevant one(s) before
working in an area:

| Working on...                          | Read first                                     |
|-----------------------------------------|-------------------------------------------------|
| Any file under `nodes/` or `credentials/` | `ARCHITECTURE.md` (Directory breakdown + Core data models) |
| Adding a new operation or resource      | "Key guidelines" above + `ARCHITECTURE.md`'s router/operation-module description |
| Build, lint, test, or icon-copy issues   | `CLAUDE.md` (Commands) + `ARCHITECTURE.md` (Dependencies & constraints) |
| Workflow templates under `workflows/templates/` | "Example workflows" above + `tests/workflow-templates.test.ts` |
| Versioning / release / CI               | "Workflow and PR rules" above + `ARCHITECTURE.md` (CI section) |
| Starting a new task or planning         | `CLAUDE.md` (Claude tool preferences) |

## Additional resources

n8n's official docs for building community nodes, for anything not covered
above (treat this repo's own docs as authoritative where they disagree —
see "Important notes"):

- https://docs.n8n.io/integrations/community-nodes/build-community-nodes/
- https://docs.n8n.io/integrations/creating-nodes/overview/
- https://docs.n8n.io/integrations/creating-nodes/build/reference/
- https://docs.n8n.io/integrations/creating-nodes/build/reference/ux-guidelines/
