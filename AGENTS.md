# AGENTS.md — n8n-nodes-enterspeed

Operating guide for AI coding agents (Claude Code, Cursor, Copilot, Gemini CLI, …) working in this
repository. This is the canonical agent context; Claude Code reads it via the `@AGENTS.md` import in
[`CLAUDE.md`](CLAUDE.md), which adds only Claude-specific shortcuts. How the package is built is in
[`ARCHITECTURE.md`](ARCHITECTURE.md); what each operation does for a user is in
[`README.md`](README.md).

## What this repo is

`@enterspeed/n8n-nodes-enterspeed`, the n8n community node package for Enterspeed (the
`@<scope>/n8n-nodes-<name>` naming convention). TypeScript in `strict` mode, built with
`@n8n/node-cli` (`n8n-node build`), tested with Vitest, peer-dependent only on `n8n-workflow`.

| Path | Role |
|---|---|
| `nodes/Enterspeed/Enterspeed.node.ts` | **Enterspeed Core** action node — resources `entity`, `delivery`, `query`, `route`. Released. |
| `nodes/Enterspeed/EnterspeedTrigger.node.ts` | **Enterspeed Core Webhook Trigger** — reacts to view deploy/remove webhooks, optionally fetching the full view. Released. |
| `credentials/EnterspeedApi.credentials.ts` | **Enterspeed Core API** — two keys, three overridable hosts; shared by both Core nodes. |
| `nodes/EnterspeedContextGraph/EnterspeedContextGraph.node.ts` | **Enterspeed Context Graph** action node — Entity › Push / Push Many, Shape › Get / Get Many, Index › Get / Query, Representation › Get, Schema › Get. Several read fields are filled from the manifest's schema while editing (`actions/schema/msd.ts`). Unreleased (epic sc-13858). |
| `credentials/EnterspeedContextGraphApi.credentials.ts` | **Enterspeed Context Graph API** — ingest URL + Ingest API Key, delivery URL + Delivery API Key, manifest version. Never shared with Core. |
| `workflows/templates/` | Example workflows, including the Tonevik demo (`Context-Graph-Tonevik-Demo.json`) |
| `docs/context-graph-demo/GUIDE.md` | The step-by-step guide that goes with the Tonevik template |
| `scripts/` | `setup.mjs` (credentials + template import into Docker n8n), `execute-workflow.mjs` (run one by name) |
| `tests/` | One test file per node, `EnterspeedContextGraph.msd.test.ts`, `mocks.ts`, `workflow-templates.test.ts` |

The Context Graph's behaviour is defined in the **semantic-graph** repository: wire contracts in
`contracts/spec/` (with vectors in `contracts/vectors/`) and decisions in `contracts/docs/adr/`.
This repo implements a client of those contracts; it doesn't own them.

## Ubiquitous language

**Core and the Context Graph are two products with two vocabularies. Don't mix them.**

| Context Graph | Means | Not |
|---|---|---|
| **record** | One source system record as the node sends it: its own fields plus `$id`, `$type`, `$source`, `$action`, `$modifiedAt` (*Ingest NDJSON*) | "entity" for output |
| **`$id`** | The source system's own record key, e.g. `pim-cat-dd34d4` | the domain `id` field |
| **shape** | A view the schema declares over graphed data, read by **shape key** `{shapeName}:{segKey}:{value}:…` | a Core "view" |
| **index** / **document** | What Index › Query searches and Index › Get reads by its `$id` | a Core "index alias" |
| **representation** | What delivery composes from **slots** (shapes, queries) and serves for a **route** | a "page" (routes are API resources, sdk/ADR-003) |
| **manifest** | The published schema every Delivery route is scoped to; its **MSD** is delivery's materialised schema document | a Core "environment" |

"Entity" is ingest-side vocabulary: the node pushes records that become **source entities**; what
comes back out is shapes, documents and representations. Core's views, origin IDs and index aliases
belong to the Core node only.

## The rule that matters: n8n is only the integration

The Context Graph node moves data; it doesn't model it.

- **Records go in as they are.** Never reshape, rename, trim or convert a record's fields. `$id` is
  the source system's key, never derived from the domain `id`. Reshaping belongs in the workflow (a
  Code or Edit Fields node) where the user can see it.
- **Answers come out as they are.** Every read outputs the service's body unchanged.
- **Every behaviour names its contract.** Each field, default, limit, retry and error follows a
  sentence in a semantic-graph spec or ADR (the table in ARCHITECTURE.md §3.1). IMPORTANT: if no
  spec or ADR defines a behaviour, don't fill the gap from Enterspeed Core or another system; raise
  it as a gap and ask.
- **No fixed payload schema.** Every Enterspeed request and response, Core or Context Graph, is an
  opaque `IDataObject`. Don't assume an `id` field, a `data` wrapper or any other key
  (ARCHITECTURE.md §8.1).
- **Demo data is Tonevik's, copied verbatim** from the SDK dev-server's example.
- **The template never depends on tools outside n8n.** Postman and local harnesses are for testing
  only.

## Build & test

```bash
npm run build        # n8n-node build → dist/ (also copies **/*.{png,svg})
npm run lint         # n8n-node lint: eslint.config.mjs, the rules n8n's verification scanner runs
npm test             # vitest run
npm run dev          # n8n-node dev
```

Use the `n8n-node` CLI, not `tsc`/`eslint` directly. Run `npm run lint` and `npm test` before
pushing; CI runs lint, test and build on every push and PR to `main` only, so a stacked PR gets no
CI run and must be checked locally.

**End to end** (manual, Docker): `docker compose up -d`, then `node scripts/setup.mjs` (creates both
credentials and imports every template) and `node scripts/execute-workflow.mjs` (runs the workflow
named in `N8N_WORKFLOW_NAME`). Unit tests don't prove n8n's run behaviour: the mocks throw plain
errors, not n8n's wrapped `NodeApiError`, so anything that depends on real error wrapping, item
pairing or expression evaluation is proven in Docker n8n.

**The Context Graph locally** runs against the SDK dev-server (semantic-graph-sdk,
`packages/dev-server`). Start Tonevik stage 1 with its own empty data folder. The dev-server differs
from deployed Delivery in places (no index point read, a different `/schema/msd` document, no cursor
paging, keys not enforced); README "Against the local dev-server" lists them.

## Conventions

- **Code style:** tabs, single quotes. Type-only imports use `import type { … } from 'n8n-workflow'`,
  kept separate from value imports.
- **One operation, one file.** `actions/<resource>/<op>.operation.ts` exports `properties:
  INodeProperties[]` and `execute()`, wired in the resource's `index.ts`. IMPORTANT: never inline
  logic in `router.ts` or a node class. Field builders and payload assembly shared by a resource's
  operations live in its `shared.ts`.
- **Match the existing patterns** in `nodes/*/actions/<resource>/` and `credentials/`, not n8n's
  generic single-resource tutorials. This repo's docs win where n8n's docs disagree.
- **Names:** node and credential classes are PascalCase and match their file's base name
  (`EnterspeedTrigger` in `EnterspeedTrigger.node.ts`).
- **Types:** `strict: true`, `noUnusedLocals: true`. Don't reach for `any` or an `as` cast to route
  around a type error.
- **Every node parameter has a `description`**; lint fails otherwise.
- **Fix lint and type errors; don't suppress them.** The exceptions are documented where they are
  suppressed: `usableAsTool` on the trigger (ARCHITECTURE.md §8.7) and the `$id` wording in Push's
  and Push Many's descriptions (`node-param-description-miscased-id`).
- **Never hand-edit `dist/`.** It is build output and gitignored.
- **Branches:** `feature|fix|chore/sc-XXXX/description`, from `main` or, for a stacked PR, from the
  previous story's branch.
- **Commits:** one logical change each; a sentence-case summary naming the story, e.g.
  `Add Index › Get to the Context Graph node (sc-14301)`, and a body saying what changed and which
  contract or ADR it follows.
- **Versioning (semver):** patch = bug fix or doc update; minor = new operation or node,
  backwards-compatible; major = a breaking change to a **released** credential or output shape.
  Unreleased work (everything under `[Unreleased]` in `CHANGELOG.md`) can change freely.

## Adding an operation

1. Add its value to the resource's `operation` options in `index.ts`.
2. Add its fields in a new `*.operation.ts`, each gated with `displayOptions.show`.
3. Implement `execute()` there and register it in the resource's `operations` map.
4. Add unit tests in `tests/`.
5. Document it in `README.md` under its node, add a `CHANGELOG.md` entry, and update
   `ARCHITECTURE.md` (for the Context Graph: its row in §3.1 and its own subsection).
6. For a Context Graph operation, name the spec or ADR behind each behaviour in the PR description
   (a table: behaviour | contract or ADR | why).

A new node or credential file also needs its compiled path in `package.json`'s `n8n.nodes` /
`n8n.credentials`.

## Workflow templates

`workflows/templates/*.json` holds exported workflows, each a JSON array with one workflow.

- IMPORTANT: **node types are `CUSTOM.enterspeed` / `CUSTOM.enterspeedContextGraph`**, the types n8n
  assigns when loading from Docker's custom extensions. A template exported from an `npm link`
  instance (`@enterspeed/n8n-nodes-enterspeed.enterspeed`) shows "unknown node" for everyone else.
  Author and export templates from the Docker setup.
- IMPORTANT: **never commit a real credential ID.** Use the placeholders
  `__ENTERSPEED_CREDENTIAL_ID__` (Core) and `__ENTERSPEED_CONTEXT_GRAPH_CREDENTIAL_ID__` (Context
  Graph); `setup.mjs` substitutes them in memory, never on disk.
- **To add one:** build and test it in Docker n8n, export it, strip `id`, `versionId`, `shared`,
  `creatorId`, `projectId`, `workflowId` and any real credential ID, put in the placeholder, then
  commit it.
- **The Tonevik template and `GUIDE.md` change together**, one step per PR.

`tests/workflow-templates.test.ts` enforces the node types and placeholders, and scans for any
16-character credential ID.

## Load-bearing facts

Things that break silently, at runtime or in someone else's workflow, when changed:

- **`package.json` `n8n` paths** point at compiled files in `dist/`, resolved literally. A stale
  entry loads nothing.
- **Icons:** `icon: 'file:…'` resolves relative to the compiled file that declares it, so each node
  folder and `credentials/` keep their own copy of the SVG. Keep the copies identical.
- **Internal names are saved in users' workflows.** `enterspeed`, `enterspeedTrigger`,
  `enterspeedApi`, `enterspeedContextGraph`, `enterspeedContextGraphApi`, every parameter `name` and
  every option `value`. Change a display name freely; changing one of these breaks saved workflows.
- **Saved schema-driven values have a format.** Filter and sort fields are saved as
  `{valueClass}:{field}` and representation context fields as `path:…`, `query:…` or `header:…`
  (ARCHITECTURE.md §4.2). Runs read these back without the schema, so changing the format breaks
  saved workflows.
- **`new NodeApiError(node, existingNodeApiError, …)` returns the existing error unchanged** and
  drops your message. Build it from a plain object; read status and body with `httpFailure`.

## Data handling

This repo is governed by Enterspeed's ISO 27001 and GDPR data-handling policy, whichever agent
works on it. IMPORTANT: no credentials, API keys or customer personal data in chat, tooling context,
tests or templates. Use the placeholders above, and keys from environment variables or 1Password.

## Where the deeper docs are

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — how the nodes are built, the Context Graph's contracts per
  operation, schema-driven fields and their state, decisions and trade-offs.
- [`README.md`](README.md) — user-facing: install, credentials, every operation.
- [`CLAUDE.md`](CLAUDE.md) — Claude Code commands and tool preferences.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — the Docker setup and authoring templates.
- [`docs/context-graph-demo/GUIDE.md`](docs/context-graph-demo/GUIDE.md) — the Tonevik demo.
- semantic-graph `contracts/spec/` and `contracts/docs/adr/` — the Context Graph's contracts and
  decisions.
- n8n's docs, for anything not covered here:
  [building community nodes](https://docs.n8n.io/integrations/community-nodes/build-community-nodes/),
  [creating nodes](https://docs.n8n.io/integrations/creating-nodes/overview/),
  [reference](https://docs.n8n.io/integrations/creating-nodes/build/reference/),
  [UX guidelines](https://docs.n8n.io/integrations/creating-nodes/build/reference/ux-guidelines/).
