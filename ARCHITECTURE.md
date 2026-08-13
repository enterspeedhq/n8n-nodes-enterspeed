# Architecture

Technical blueprint for `n8n-nodes-enterspeed`. For conventions and rules, see
[AGENTS.md](AGENTS.md). For Claude-specific shortcuts, see [CLAUDE.md](CLAUDE.md).

## System overview

This package ships two n8n node types plus one shared credential type:

- **`Enterspeed`** (`nodes/Enterspeed/Enterspeed.node.ts`) — an action node.
  A single `resource` selector (`entity` / `delivery` / `query` / `route`)
  plus a per-resource `operation` selector drive one dispatch point:
  `actions/router.ts`. `execute()` on the node is a one-line delegation to
  `router.call(this)`; all real logic lives under `actions/<resource>/`.
- **`EnterspeedTrigger`** (`nodes/Enterspeed/EnterspeedTrigger.node.ts`) — a
  push trigger (internal n8n type name `enterspeedTrigger`, display name
  "Enterspeed Webhook Trigger"). Enterspeed POSTs a lightweight notification
  when a *view* is deployed or removed; the node optionally fetches the full
  view from the Delivery API using the payload's URL. Properties live in
  `webhookTrigger/properties.ts`; the auth check, payload assembly, and view
  fetch live in `webhookTrigger/handler.ts`; `webhook()` on the node is a
  one-line delegation to `handleWebhook.call(this)`. Routes and indices do
  **not** emit webhooks — there is no polling equivalent in this package (an
  earlier polling node, which also used the class name `EnterspeedTrigger`,
  was removed; that name was then reused for this webhook trigger. The
  documented "poll a Query index on a schedule" behaviour is expected to be
  built as an n8n **workflow template** — Schedule Trigger + the `Enterspeed`
  node's Query operation + a Code node — rather than a custom node).
- **`EnterspeedApi`** (`credentials/EnterspeedApi.credentials.ts`) — one
  credential type shared by both nodes, holding two API keys and three host
  URLs (see Core Data Models below).

## Directory breakdown

- **`nodes/Enterspeed/actions/router.ts`** — the dispatch table. Reads
  `resource`/`operation` node parameters, looks up the matching operation
  module in a `Record<resource, { operations }>` map, builds an
  `EnterspeedCredentials` object once per execution from the raw credential
  fields, and runs the handler once per input item. Wraps thrown errors as
  `NodeApiError` (or passes through `NodeOperationError`), and honors
  `continueOnFail()` by emitting an `{ error, description }` item instead of
  throwing.
- **`nodes/Enterspeed/actions/<resource>/`** (`entity`, `delivery`, `query`,
  `route`) — one folder per resource:
  - `index.ts` — the resource's `operation` selector plus the concatenated
    `INodeProperties` of every operation in the resource; exports an
    `operations` map consumed by `router.ts`.
  - `shared.ts` — field-builder helpers reused by sibling operations, e.g.
    `query/shared.ts` exports `buildQueryFields` (shared UI fields for
    "Query Items" and "Multi Query Items") and `buildQueryPayload` (turns
    those fields into the Query API request body: `filters`, `sort`,
    `facets`, `search`, `pagination`, `aliases`).
  - `*.operation.ts` — one file per operation, each exporting `properties:
    INodeProperties[]` and `execute(this: IExecuteFunctions, itemIndex:
    number, creds: EnterspeedCredentials): Promise<INodeExecutionData[]>`.
- **`nodes/Enterspeed/webhookTrigger/`** — the trigger's split-out logic.
  Unlike the action node, there's a single entry point (no resource/operation
  dispatch), so the split is just `properties.ts` (the `INodeProperties[]`
  array) and `handler.ts` (`handleWebhook(this: IWebhookFunctions)`, the
  access-key check, PascalCase/lower-case payload normalization, and the
  optional Delivery API fetch). It does not go through `transport.ts` —
  `IWebhookFunctions` isn't an `IExecuteFunctions`, and there's only the one
  call site, so it calls `this.helpers.httpRequest` directly.
- **`nodes/Enterspeed/transport.ts`** — a single-purpose passthrough:
  `enterspeedApiRequest(this: IExecuteFunctions, options: IHttpRequestOptions)`
  just calls `this.helpers.httpRequest(options)`. It injects no base URL and
  no auth header — every caller builds the full request (URL, `X-Api-Key`
  header, body) itself using the `EnterspeedCredentials` passed down from
  `router.ts`.
- **`credentials/EnterspeedApi.credentials.ts`** — the `ICredentialType`
  definition plus a `test` credential-check request against the Routes API
  (`{ingestHost}/routes/v2?first=100`).
- **`tests/`** — mirrors the source tree: one test file per node
  (`Enterspeed.node.test.ts`, `EnterspeedTrigger.node.test.ts`), `mocks.ts`
  (minimal `IExecuteFunctions`/`IWebhookFunctions` stand-ins), and
  `workflow-templates.test.ts` (validates every JSON file under
  `workflows/templates/`, not code).
- **`workflows/templates/*.json`** — example workflows, each a JSON array
  containing one exported n8n workflow object. Validated for shape and for
  never containing a real credential ID (see AGENTS.md). Imported into a
  local Docker n8n via `scripts/setup.mjs`, run via `scripts/execute-workflow.mjs`.
- **`scripts/{setup.mjs,execute-workflow.mjs}`** — Docker-based end-to-end
  tooling: create the credential + import all templates in one step; then
  trigger a named workflow by REST call and poll its execution to
  completion. Neither is wired into `package.json` scripts — run with `node
  scripts/<file>.mjs` directly.
- **`dist/`** — build output (`n8n-node build`, then `gulp
  copy-credential-icons`), gitignored, never hand-edited. `package.json`'s
  `n8n.nodes`/`n8n.credentials` arrays point here, so every node/credential
  file must actually compile to something at that exact path.

## Core data models & state

`EnterspeedCredentials` (`nodes/Enterspeed/actions/types.ts`):

```ts
interface EnterspeedCredentials {
  envKey: string;
  sourceKey: string;
  ingestHost: string;
  deliveryHost: string;
  queryHost: string;
}
```

This is built exactly once per node execution, in `router.ts`, from the raw
credential fields the customer entered (`environmentApiKey`, `sourceApiKey`,
and the three host overrides, each falling back to its public default if
blank). Operation modules never read `this.getCredentials(...)` themselves —
they receive this already-normalized object as a parameter.

There is **no fixed schema for API request/response payloads** anywhere in
this codebase. Every Enterspeed API call/response is typed as opaque
`IDataObject` / `IDataObject[]`. This is intentional: index and entity shapes
are defined per Enterspeed customer/schema, not by this package, so nothing
here should assume a fixed set of fields (an "id" field, a "data" wrapper,
etc.) beyond what the user configures at the node level (e.g. an index alias
or, in the polling-workflow pattern, a configurable marker/ID field name).

## Dependencies & constraints

- **Peer dependency**: `n8n-workflow` (`*`) — the n8n SDK types and runtime
  helpers (`IExecuteFunctions`, `IHttpRequestOptions`, `NodeApiError`, etc.).
- **TypeScript**: `strict: true`, `noUnusedLocals: true`, target `es2019`,
  compiles `credentials/**` and `nodes/**` only (`tsconfig.json`).
- **Linting**: `npm run lint` runs `n8n-node lint`, which lints against
  `eslint.config.mjs` — `@n8n/node-cli`'s bundled flat config
  (`@n8n/eslint-plugin-community-nodes` recommended rules +
  `eslint-plugin-n8n-nodes-base`'s `nodes`/`credentials`/`community`
  rulesets), plus one local override excluding `tests/**` from the
  cloud-compatibility import/global restrictions (test tooling legitimately
  uses `fs`/`path`/`__dirname`; it never ships — see `package.json`
  `"files"`). This is the same rule set n8n's own
  `@n8n/scan-community-package` verification scanner runs, so a clean local
  `npm run lint` is a strong (though not perfect — see the note on
  `usableAsTool` below) signal the package will pass verification.
- **Build**: `n8n-node build` compiles to `dist/` and copies node icons into
  `dist/nodes`, then `gulp copy-credential-icons` (`gulpfile.js`) copies the
  same SVG into `dist/credentials/` — `n8n-node build` doesn't know the
  `EnterspeedApi` credential reuses the node's icon, so this one extra step
  fills that gap. `npm run dev` runs the same gulp step before `n8n-node
  dev` for the same reason.
- **Known lint inconsistency**: `n8n-node lint`'s bundled preset flags
  `EnterspeedTrigger` for not setting `usableAsTool: true` unconditionally,
  but that's not fixable — the type (`true | UsableAsToolDescription |
  undefined`) has no `false`, and n8n's actual verification scanner
  explicitly forbids `true` on trigger nodes (agents can't invoke a trigger
  as a tool). Omitting the property is correct; this one warning is a false
  positive in the CLI's own preset, not a real gap.
- **Three Enterspeed API hosts**, each with a public default the customer can
  override per environment: Ingest (`api.enterspeed.com`), Delivery
  (`delivery.enterspeed.com`), Query (`query.enterspeed.com`).
- **CI** (`.github/workflows/ci.yml`, documented in `DevelopReadme.md`): on
  every push/PR to `main`, runs `npm run lint`, `npm test`, `npm run build`
  in that order. Release is tag-triggered (`v*`) and publishes to npm.
- **Local end-to-end testing** requires Docker (`docker-compose.yml` mounts
  `./dist` into n8n's custom-extensions folder) — nodes loaded this way
  register as `CUSTOM.enterspeed`, whereas `npm link` registers them as
  `n8n-nodes-enterspeed.enterspeed`. Workflow templates are authored against
  the Docker path and will show "unknown node" if built via `npm link`.
