# n8n Nodes Architecture

**Date:** November 12, 2026
**Status:** Enterspeed Core nodes released; Enterspeed Context Graph node in development (epic sc-13858)
**Context:** `@enterspeed/n8n-nodes-enterspeed`, the n8n community node package for Enterspeed Core and the Enterspeed Context Graph

**See also:**

- [AGENTS.md](AGENTS.md): conventions, rules and the PR workflow
- [CLAUDE.md](CLAUDE.md): commands and Claude-specific shortcuts
- [README.md](README.md): what each operation does, from the user's side
- [docs/context-graph-demo/GUIDE.md](docs/context-graph-demo/GUIDE.md): internal notes on how the Tonevik demo is built (what a user needs to run it is in the template's notes)
- The semantic-graph repository: the Context Graph's wire contracts (`contracts/spec`) and ADRs (`contracts/docs/adr`), which every Context Graph behaviour below follows

---

## Scope

This document defines how the package is built: the nodes and credentials it ships, how a run flows through them, what state they keep and where, and how they meet the Enterspeed services.

**What this doc covers:**

- The nodes and credentials, and how each dispatches to its operations
- The Enterspeed Core action node, webhook trigger and credential
- The Enterspeed Context Graph node: each resource, its requests and the contract behind it
- Fields filled from the Context Graph schema, and how the node keeps that state
- Package structure, build, lint, tests and CI
- Boundary interactions with Enterspeed Core, Context Graph Ingest and Delivery, and n8n itself
- Key decisions and trade-offs

**What this doc does NOT cover:**

- What each operation's fields mean to a user (see the README)
- The Context Graph's own behaviour (processing, shapes, indexes, representations); this package only calls its APIs
- Conventions, branching and release rules (see AGENTS.md)

---

## 1. Overview

The package is an **integration**: it moves data between n8n workflows and Enterspeed, and adds no data model of its own. It ships three node types and two credential types:

| Type | File | What it is |
|---|---|---|
| `Enterspeed` ("Enterspeed Core") | `nodes/Enterspeed/Enterspeed.node.ts` | Action node for Enterspeed Core: resources `entity`, `delivery`, `query`, `route` |
| `EnterspeedTrigger` ("Enterspeed Core Webhook Trigger") | `nodes/Enterspeed/EnterspeedTrigger.node.ts` | Push trigger for view deploy/remove webhooks |
| `EnterspeedApi` ("Enterspeed Core API") | `credentials/EnterspeedApi.credentials.ts` | Shared by both Core nodes |
| `EnterspeedContextGraph` ("Enterspeed Context Graph") | `nodes/EnterspeedContextGraph/EnterspeedContextGraph.node.ts` | Action node for the Context Graph: resources `entity`, `index`, `representation`, `schema`, `shape` |
| `EnterspeedContextGraphApi` | `credentials/EnterspeedContextGraphApi.credentials.ts` | The Context Graph's own credential; never shared with Core |

Both action nodes have the same shape: the node class holds only its description and a one-line `execute()` that delegates to `actions/router.ts`, which picks the operation module from the `resource` and `operation` parameters. All real logic lives in `actions/<resource>/*.operation.ts`.

---

## 2. The Enterspeed Core Nodes

### 2.1 Action Node: Router and Operation Modules

`nodes/Enterspeed/actions/router.ts` is the dispatch table:

- Reads the `resource` and `operation` parameters and looks up the operation in a `Record<resource, { operations }>` map
- Builds an `EnterspeedCredentials` object **once per execution** from the credential (section 2.3)
- Runs the handler **once per input item**
- Wraps a thrown error as `NodeApiError` (a `NodeOperationError` passes through), and with `continueOnFail()` emits an `{ error, description }` item instead of throwing

Each resource folder (`entity`, `delivery`, `query`, `route`) holds:

- `index.ts`: the resource's `operation` selector, all its operations' `INodeProperties`, and the `operations` map the router reads
- `shared.ts`: field builders and payload assembly reused by sibling operations; e.g. `query/shared.ts` exports `buildQueryFields` (the UI shared by *Query Items* and *Multi Query Items*) and `buildQueryPayload` (`filters`, `sort`, `facets`, `search`, `pagination`, `aliases`)
- `*.operation.ts`: one file per operation, exporting `properties: INodeProperties[]` and `execute(this: IExecuteFunctions, itemIndex: number, creds: EnterspeedCredentials): Promise<INodeExecutionData[]>`

### 2.2 Webhook Trigger

Enterspeed POSTs a lightweight notification when a **view** is deployed or removed. The trigger checks the access key, normalises the PascalCase or lower-case payload and, optionally, fetches the full view from the Delivery API using the payload's URL.

- `webhookTrigger/properties.ts`: the *Actions*, *Fetch Full View* and *Access Key* parameters
- `webhookTrigger/handler.ts`: `handleWebhook(this: IWebhookFunctions)`, called by the node's one-line `webhook()`
- It calls `this.helpers.httpRequest` directly, not `transport.ts`: an `IWebhookFunctions` isn't an `IExecuteFunctions`, and there is one call site

Routes and indexes don't emit webhooks, and there is no polling node. An earlier polling node was removed and its class name `EnterspeedTrigger` reused here. "Poll a Query index on a schedule" is built as a **workflow** instead: Schedule Trigger, the Core node's Query operation and a Code node.

### 2.3 Credential and Transport

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

The router builds it from `environmentApiKey`, `sourceApiKey` and three host overrides, each falling back to its public default when blank (section 6.1). Operation modules never call `this.getCredentials()`; they receive this object.

`nodes/Enterspeed/transport.ts` is a passthrough: `enterspeedApiRequest(this, options)` calls `this.helpers.httpRequest(options)` and injects nothing. Each operation builds the full request (URL, `X-Api-Key` header, body) itself.

The credential's test request reads the Routes API (`{ingestHost}/routes/v2?first=100`).

---

## 3. The Enterspeed Context Graph Node

### 3.1 Dispatch

`nodes/EnterspeedContextGraph/actions/router.ts` dispatches like the Core router, with one difference: a handler receives **all input items at once**. Push Many and Get Many output one item per record or key rather than per input item, Index › Query sends every item's query in one request, and Schema › Get reads once per run, so the handler decides how items map to requests.

Requests go through `transport.ts`'s `contextGraphApiRequest`, a wrapper over `httpRequestWithAuthentication` with the `enterspeedContextGraphApi` credential: the credential adds the key (section 3.7), so operation code never touches it. It accepts both `IExecuteFunctions` and `ILoadOptionsFunctions`, so the editor's schema reads (section 4) use the same path.

Every resource follows one rule: **output the service's answer unchanged**. The node never reshapes a record on the way in or a response on the way out.

| Resource › Operation | Request | Items → requests | Contract / ADR |
|---|---|---|---|
| Entity › Push | `POST {ingestUrl}/entities` | One record per item, one request per item | *Ingest NDJSON*, *Ingest bulk result*; ingest/ADR-005, 013, 020 |
| Entity › Push Many | `POST {ingestUrl}/entities` | One item holding a list, split only at the body limit | as Push; cross/ADR-022 |
| Shape › Get | `GET {deliveryUrl}/shapes/v1/{manifest}/{key…}` | One key per item | *Shape key*; delivery/ADR-030 §3 |
| Shape › Get Many | `POST {deliveryUrl}/shapes/v1/{manifest}` | One item holding a list, split at 30 KiB | *Shapes batch envelope* |
| Index › Query | `POST {deliveryUrl}/query/v1/{manifest}` | One query per item, all in one request | *Query envelope*; delivery/ADR-030 §3, ADR-037 |
| Index › Get | `GET {deliveryUrl}/query/v1/{manifest}/{index}/{id}` | One document per item | delivery/ADR-030 §3, ADR-022 |
| Representation › Get | `GET {deliveryUrl}/v1/{manifest}{route}` | One route per item | *Representation envelope*; delivery/ADR-030 §3 |
| Schema › Get | `GET {deliveryUrl}/schema/{kind}/v1/{manifest}[/{prefix}]` | Once per run, first item | delivery/ADR-030 §3, ADR-036 |

### 3.2 Entity: Push and Push Many

Records follow the *Ingest NDJSON* contract and are sent unchanged as NDJSON lines (`actions/entity/shared.ts` builds and sends them).

- **Push** takes one record per item. Its five parameters set `$id`, `$type`, `$source`, `$action` and `$modifiedAt`, each defaulting to the record's own (`={{ $json.$id }}` and so on).
- **Push Many** takes one item holding a list of records (`={{ $json.data }}`, as an Aggregate node makes it); each record keeps its own `$` fields.
- **Values are sent as given.** A non-string `$id` or `$type` is reported as failed without being sent, because the contract makes it a parse error. `$source` is required by ingest (cross/ADR-010 retired the source derived from the key); a record without one is sent as it is, and the service's per-record rejection is its result. A delete line carries only the `$` fields. `$modifiedAt` is passed as given, on saves and deletes (ingest/ADR-013).
- **Not the bulk path.** A source's complete export is an artifact upload (cross/ADR-022, ingest/ADR-017, *Ingest artifact* contract): reserve, signed upload, commit, then a paced drain. Ingest and the SDK dev-server serve it; the node's Upload operation isn't built yet (sc-13877, sc-13882). Push Many splits a list only at the body limit: a request closes before 29,000,000 bytes (ingest sets no limit, so Kestrel's default of 30,000,000 applies; ingest/ADR-020 D5's 32 MiB isn't implemented yet), and requests are sent one at a time.
- **Throttling.** A `429` is retried after its `Retry-After`, up to 3 times, as ingest/ADR-020 requires of workflow-tool integrations.
- **Result.** The service answers a per-line `{ id, accepted, error?, statusCode }` array in line order (`200` all accepted, `207` otherwise), zipped back onto the records.

### 3.3 Shape: Get and Get Many

Shapes are read by the canonical shape key, `{shapeName}:{segKey}:{value}:…` (*Shape key* contract). The shapes route is the narrow read: one shape by key, without representation resolution (delivery's `ShapesEndpoints`; processing/ADR-012). An app reads representations (3.5); the demo uses shapes to check what the graph made of the pushed records.

- **Get** sends the key's colon-joined parts as percent-encoded path segments (delivery/ADR-030 §3). A segment value can't hold `:` or `/`, so the split is exact. The shape is output unchanged; a `404` fails the item.
- **Get Many** sends the list as `{ keys }`, closing a request before 30 KiB (delivery caps the body at 32 KiB), and outputs each `{ key, status, data }` of the always-`207` answer unchanged, paired to the item the list came from (*Shapes batch envelope*).
- **Visibility.** Delivery takes claims from a context token, not the API key, and the node sends none, so a shape gated by its access policy always reads as `404`. Delivery answers a denied shape and a missing one with the same bodiless `404` (sc-10848), so the node never says "denied". A key carries no claims by decision, not by omission: delivery/ADR-044 keeps everything about a caller in a verified claim, and Management stores no claims on keys. Keys carrying claims configured in Management were raised in the review of #26, but would need a new ADR superseding ADR-044. If one lands, this section, the README's *Who can see a shape* and the node's visibility behaviour change with it.
- **Malformed keys.** No contract defines an error for a malformed key. Deployed delivery rejects only an empty key (`400`) and answers anything else that names no shape `404`; the dev-server answers `400 invalid_key` with a message. The node passes either through and doesn't validate the key itself.
- **No `503` retry yet.** delivery/ADR-025 answers a shed read `503` + `Retry-After`; retrying it once is sc-14796.
- **Key From › Schema** builds the key from a shape and its ID segments chosen in the editor (section 4); it waits on the schema listing entry shapes.

### 3.4 Index: Query and Get

- **Query** sends every item's query in one array. *Query From* › **JSON** sends the item's query as written; › **Builder** assembles it from schema-filled fields (section 4): filters `and`-combined, values typed by the field's value class (delivery/ADR-037), each sort as `direction` `asc`/`desc` (*Query sort order* contract; a saved `Ascending`/`Descending` is read the same), *Results Per Page* from 1 to 100. The 100 is the platform-wide maximum (delivery/ADR-037, sc-12248 amendment; the MSD's `queryLimits.max`): a direct `/query` asking for more is a `400` for the whole request, so an item over it fails before sending and the other items are still sent.
- **Query ids.** A query's `id` is its own, else its position in the request (*Query envelope*). Two queries that would share an id are sent as they are: the platform answers such a batch `400` with its own message (delivery, and the dev-server since sc-12132), which fails every query in it.
- **Query results.** Each `{ id, index, items, totalCount, next }` is output unchanged, paired to its item by `id`. One invalid query makes the platform reject the batch (`400`, its message passed through), so a failed request fails every query in it.
- **Get** is the point read: one percent-encoded document id, the colon-joined key the document is stored under, which is the `$id` each Query match carries. The body (the document's displayed fields, delivery/ADR-022) is output unchanged; a bodiless `404` fails the item. The SDK dev-server doesn't serve this route yet, so it is unit-tested only.

### 3.5 Representation: Get

- One `GET` per route, each route segment percent-encoded. There is no batch: delivery/ADR-030 keeps per-item reads as the cacheable serving path and builds no bulk representation read.
- **Route From** › **Route** takes the path as text; › **Schema** fills a chosen route template from mapped context values (section 4.3).
- The body is output unchanged: each slot at its name plus `$metadata` (*Representation envelope*).
- `200`, `202` and `207` all succeed, because which slots resolved is in `$metadata.<slot>.$state`, not the status. A `404` (no matching route, an unresolved `required` slot, or no slot resolved) fails the item.
- Resuming a partial answer is not implemented in the node yet (sc-14303). Delivery and the SDK dev-server serve it: a `207` carries `$metadata.$resume`, sent back as `X-Resume` (delivery/ADR-033, still marked Proposed; the *Representation envelope* vectors pin `$resume`).

### 3.6 Schema: Get

Reads the manifest's schema, `kind` being `msd`, `openapi` or `jsonschema`, optionally narrowed to the representations under a route prefix, and outputs it unchanged as one item. The schema belongs to the manifest, not to an item, so it is read **once per run** with the first item's parameters and paired to item 0.

### 3.7 Credential and Authentication

| Field | Used for |
|---|---|
| `ingestUrl`, `ingestApiKey` | Uploads (`POST /entities`) |
| `deliveryUrl`, `deliveryApiKey` | Every read, the schema and the credential test |
| `manifestVersion` | The `{manifest}` segment of every Delivery route. For an SDK-published schema, the manifest id, a content hash (sdk/ADR-016) |

Ingest and Delivery are separate services, each checking its own key. The credential's `authenticate` function sets `X-Api-Key` per request: the Ingest API Key when the request URL is the ingest URL or under it, the Delivery API Key otherwise.

Neither URL has a default. The Context Graph's hosts aren't Enterspeed Core's, and no Context Graph host is settled yet, so a pre-filled Core host would send a Context Graph key to Core and fail the test with a misleading *No manifest with this version*.

The test request reads `GET {deliveryUrl}/schema/msd/v1/{manifestVersion}`, which deployed Delivery guards with the key (`401`) and answers `404` for an unhosted manifest. The ingest key isn't tested. The SDK dev-server serves both services from one host and accepts any key, so against it the test proves only reachability and the manifest version.

### 3.8 Errors

n8n hands a failed request over as a `NodeApiError` with the HTTP error as its `cause`. `transport.ts`'s `httpFailure` reads the status and body from either form. Each resource turns that into a message that says what failed (`401` rejected key, `404` not found, `410` retired API version, unreachable URL), passing the platform's own message through when it has one; the Delivery resources share `deliveryError` (`actions/shape/shared.ts`). The `NodeApiError` is built from a plain object, because its constructor returns an existing `NodeApiError` unchanged and would drop the message. With *Continue On Fail* a failed item comes out as what identifies it (e.g. `{ key, … }`, `{ route, … }`, a Push result with `accepted: false`) plus `error` and, when there is one, `description`.

---

## 4. Schema-Driven Fields and Editor State

Several Context Graph fields can be filled from the manifest's **materialised schema document** (MSD, delivery/ADR-028 §4) instead of typed in:

| Field | Operation | Filled from |
|---|---|---|
| *Index* | Index › Get, Index › Query (Builder) | `indexes` |
| Filter and sort fields | Index › Query (Builder) | the index's keyword, numeric and boolean fields (the MSD doesn't say which are `sortable`, so the sort list offers all of them) |
| Operators | Index › Query (Builder) | `filterOperators` |
| *Representation*, *Route* | Representation › Get (Schema) | `representations[].$name`, `$routes` |
| *Context* | Representation › Get (Schema) | the route's placeholders, `context.required` / `optional`, binders |
| *Shape*, *ID Segments* | Shape › Get (Schema) | not listed by the MSD yet |

`actions/schema/msd.ts` is the only code that knows the MSD's form. Its `msd*` functions turn the document into plain lists (`MsdIndex`, `MsdRepresentation`, `MsdShape`); its `get*` functions are registered on the node as `methods.loadOptions` and `methods.resourceMapping`.

### 4.1 The Schema Is Read Only in the Editor

`readMsd` (an `ILoadOptionsFunctions` call) reads `GET {deliveryUrl}/schema/msd/v1/{manifest}` with the node's credential every time n8n asks for a list: when it opens, or when a field in its `loadOptionsDependsOn` changes (choosing another index reloads the filter fields). **Nothing is cached**: no module-level cache and no workflow static data. A list always shows the hosted schema as it is now, at the cost of one request per list load.

### 4.2 Runs Never Read the Schema

Everything a run needs is saved in the workflow's node parameters, encoded so it stands on its own:

- **Names** (index, representation, route template, shape) as plain strings
- **Filter and sort fields** as `{valueClass}:{field}`, e.g. `numeric:price` (`classedField`), so the builder sends a number, boolean or string as the index declares (delivery/ADR-037)
- **Representation context** as a `resourceMapper` value whose saved `schema` lists each field with its id, `path:{placeholder}`, `query:{name}` or `header:{name}` (`contextFieldId`), and whether it's `required`. `buildSchemaRequest` fills the route template, query string and headers from that saved list alone, and fails the item before sending when a path or required value is empty.
- **Shape keys** are rebuilt from the saved `idSegments.schema` order (`buildShapeKey`)

So a run doesn't depend on the schema being reachable, and an imported workflow runs as it was built.

### 4.3 Context Targets

Where a context value goes follows delivery/ADR-036 (every non-path context entry is a query parameter):

- A placeholder in the chosen route fills its path segment and is required
- Every other caller-suppliable key (`context.required`, `context.optional`, and binders neither lists) goes in the query string under its own name
- A `query()` or `header()` binder (*binder-constraint* contract) can name another key or make it a header
- A binder with `presence: optional` or a default is not required; a binder's `enum` becomes a list of options

### 4.4 When the Schema Changes

A saved workflow keeps sending what was saved. A renamed index or field fails at run time with the platform's own message, and a new required context value isn't sent until it is added. The user fixes the drift by reopening the node and refreshing the list or the mapper's fields. An expression in any of these fields bypasses the list and is sent unchecked.

### 4.5 Known Limits

- **No entry shapes in the MSD.** The *Materialised schema document* contract (like ADR-028 §4) lists indexes and representations, not entry shapes or their ID segments, so `msdShapes()` returns `[]` and Shape's Schema mode shows *This schema lists no shapes*. It is the one place to change when the MSD lists them.
- **The MSD's form is pinned by the *Materialised schema document* contract** (semantic-graph › contracts › spec, with vectors that delivery and the SDK dev-server both pass). `msd.ts` still ignores members it doesn't know.
- **No sortable fields in the MSD.** The contract: "`sortable` on an index field reaches no member", while delivery refuses a sort on a field not declared sortable. The sort list therefore offers every keyword, numeric and boolean field, and a wrong pick fails at run time with the platform's message.
- **Context values reach the route and shape slots, never a query slot.** The contract defines `context.required` as the route's placeholders and the keys that fill a shape slot's ID segments, `context.optional` as keys only an `enabled` gate reads, and says a query slot's `filters`, `search` or `args` contribute nothing. *Context* therefore shows where each value is sent; there is no per-slot mapping to show.
- **`context.resolving` isn't used yet.** It says which routes can resolve; the route list could mark one that never does.

---

## 5. Package Structure

### 5.1 Layout

`package.json`'s `n8n` field points at the **compiled** files n8n loads. Adding, removing or renaming a node or credential means updating `n8n.nodes` / `n8n.credentials`; n8n resolves the paths literally against `dist/`.

```
nodes/Enterspeed/                  Core action node, webhook trigger, transport
  actions/{entity,delivery,query,route}/   index.ts, shared.ts, *.operation.ts
  webhookTrigger/                  properties.ts, handler.ts
nodes/EnterspeedContextGraph/      Context Graph action node, transport
  actions/{entity,shape,index,representation,schema}/
  actions/schema/msd.ts            the MSD reader behind the schema-driven fields
credentials/                       one file per credential type, plus the icon copy
tests/                             one test file per node, msd tests, mocks, template checks
workflows/templates/*.json         example workflows
scripts/                           setup.mjs, execute-workflow.mjs (Docker end-to-end)
dist/                              build output: gitignored, never hand-edited
```

### 5.2 Build, TypeScript and Lint

- **Peer dependency:** `n8n-workflow` (`*`), the SDK types and runtime helpers. No other runtime dependencies: n8n Cloud allows none.
- **TypeScript:** `strict: true`, `noUnusedLocals: true`, target `es2019`, compiling `credentials/**` and `nodes/**` only.
- **Build:** `n8n-node build` compiles to `dist/` and copies every `**/*.{png,svg}` at the same relative path. An `icon: 'file:…'` resolves relative to the compiled file that declares it, so each node folder and `credentials/` keep their own identical copy of the icon.
- **Lint:** `n8n-node lint` runs `eslint.config.mjs`: `@n8n/node-cli`'s bundled config (`@n8n/eslint-plugin-community-nodes` plus `eslint-plugin-n8n-nodes-base`'s `nodes`, `credentials` and `community` rulesets), the same rules n8n's `@n8n/scan-community-package` verification runs. One local override exempts `tests/**` from the cloud import and global restrictions; tests use `fs`/`path`/`__dirname` and never ship (`package.json` `"files"`). The one other suppression is in section 8.7.

---

## 6. Boundary Interactions

### 6.1 Core Node → Enterspeed Core APIs

Three hosts, each with a public default the customer can override per environment:

| Service | Default host | Key |
|---|---|---|
| Ingest | `api.enterspeed.com` | Source API Key |
| Delivery | `delivery.enterspeed.com` | Environment API Key |
| Query | `query.enterspeed.com` | Environment API Key |

The trigger receives Enterspeed's view webhooks and, with *Fetch Full View*, calls Delivery with the Environment API Key.

### 6.2 Context Graph Node → Ingest

Writes only, `POST {ingestUrl}/entities` with the Ingest API Key. Ingest is the platform's only write path; the node relies on its per-line result and its throttle (section 3.2).

### 6.3 Context Graph Node → Delivery

Every read and the schema, with the Delivery API Key, scoped to the credential's manifest version. In the editor the node also reads the MSD to fill lists (section 4). Against the SDK dev-server (the Tonevik demo), Ingest and Delivery share one host and some routes are missing or differ: the index point read, the MSD's form, cursor paging, a malformed shape key (`400`, not `404`). The dev-server also processes a pushed record at once, where a deployed graph processes it after accepting it (ingest/ADR-013: `accepted: true` is "landed and not yet judged"), so a read straight after a push can miss it there.

### 6.4 n8n → the Package

n8n loads the package from `dist/`. In the Docker setup (`docker-compose.yml` mounts `./dist` as a custom extension) the nodes register as `CUSTOM.enterspeed` and `CUSTOM.enterspeedContextGraph`; through `npm link` they register as `@enterspeed/n8n-nodes-enterspeed.enterspeed`. Workflow templates are authored against the Docker types, and every credential reference in them is a placeholder (`__ENTERSPEED_CREDENTIAL_ID__`, `__ENTERSPEED_CONTEXT_GRAPH_CREDENTIAL_ID__`) that `scripts/setup.mjs` replaces in memory.

---

## 7. Testing and CI

- **Unit tests** (Vitest, `tests/`): one file per node, `EnterspeedContextGraph.msd.test.ts` for MSD parsing and schema-driven requests, `mocks.ts` with minimal `IExecuteFunctions` / `IWebhookFunctions` stand-ins, and `workflow-templates.test.ts`, which checks every template's shape, node types and credential placeholders.
- **The mocks throw plain errors**, not n8n's `NodeApiError`, so error handling that depends on the real wrapping is proven only in a Docker n8n run.
- **End to end** (manual, Docker): `scripts/setup.mjs` creates the credentials and imports every template; `scripts/execute-workflow.mjs` triggers a workflow by name and polls its execution. Neither is wired into `package.json`.
- **CI** (`.github/workflows/ci.yml`): on every push and PR to `main`, `npm run lint`, `npm test` and `npm run build`, in that order. A tag (`v*`) publishes to npm. Stacked PRs that target another branch get no CI run.

---

## 8. Key Architectural Decisions

### 8.1 No Fixed Payload Schema

Every Enterspeed request and response is an opaque `IDataObject`. Entity, index and shape structures are defined per customer schema, not by this package, so nothing assumes an `id` field, a `data` wrapper or any other key beyond what the user configures on the node.

### 8.2 n8n Is Only the Integration

The Context Graph node sends records as they are and outputs answers as they are. `$id` is the source system's own key, never a domain `id`. Reshaping belongs in the workflow (a Code or Edit Fields node), where the user can see it.

### 8.3 One Operation per File

Each operation is one `*.operation.ts` with its properties and `execute()`, wired in its resource's `index.ts`. Logic never goes in the router or the node class. Shared field builders live in the resource's `shared.ts`.

### 8.4 The Credential Owns the Keys

The Core router builds `EnterspeedCredentials` once and passes it down; the Context Graph credential adds its key through `authenticate`. Either way, operation modules never read credentials themselves, and Context Graph operation code never sees a key.

### 8.5 Every Context Graph Behaviour Names Its Contract

Each field, default, limit, retry and error follows a sentence in a semantic-graph spec or ADR (the table in section 3.1). Where none defines a behaviour, the node doesn't invent one; it is noted as a gap. Behaviour isn't copied from Enterspeed Core.

### 8.6 The Schema Fills the Editor, Not the Run

Schema-driven fields read the schema while editing and save their choices in the workflow (section 4). Runs stay one request per item or batch, with no schema dependency, and an imported workflow behaves as it was built.

### 8.7 No `usableAsTool` on the Trigger

`n8n-node lint`'s preset flags `EnterspeedTrigger` for not setting `usableAsTool: true`. The type has no `false`, and n8n's verification scanner forbids `true` on triggers (an agent can't invoke a trigger), so the property is omitted and the rule is suppressed for that one file in `eslint.config.mjs`.

---

## 9. Trade-offs

### 9.1 Push vs Upload

Push and Push Many send records as they change. A complete export belongs in an artifact upload (cross/ADR-022, ingest/ADR-017), which the platform serves and the node will get as its own operation, so Push Many is deliberately not tuned for bulk: no batch-size setting, sequential requests, a split only at the body limit.

### 9.2 No Schema Cache

Reading the MSD on every list load costs a request each time, but a cache would show a stale schema with no way for the user to tell. Lists are opened rarely enough that freshness wins.

### 9.3 Per-Item Representation Reads

One request per route is slower for many routes than a batch would be, but it is the cacheable serving path delivery/ADR-030 chose, and no bulk representation read exists.

### 9.4 Saved Choices vs Live Schema

Saving the resolved context fields in the workflow makes runs independent of the schema, at the cost of drift: a schema change isn't picked up until someone reopens the node (section 4.4).

---

## Summary

The package is a thin integration between n8n and Enterspeed:

- **Two action nodes, one shape**: a node class that delegates to a router, and one file per operation
- **Core**: a credential object built once per run, one request per item, a webhook trigger for views
- **Context Graph**: records and answers passed through unchanged, each behaviour traced to a semantic-graph contract or ADR, a key per service added by the credential
- **Schema-driven fields**: the schema fills lists in the editor; the choices are saved in the workflow, so runs never read it
- **No fixed payload model**: everything Enterspeed sends or receives stays an opaque object
