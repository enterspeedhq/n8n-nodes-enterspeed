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

The package is an **integration**: it moves data between n8n workflows and Enterspeed, and adds no data model of its own. It ships four node types and three credential types:

| Type | File | What it is |
|---|---|---|
| `Enterspeed` ("Enterspeed Core") | `nodes/Enterspeed/Enterspeed.node.ts` | Action node for Enterspeed Core: resources `entity`, `delivery`, `query`, `route` |
| `EnterspeedTrigger` ("Enterspeed Core Webhook Trigger") | `nodes/Enterspeed/EnterspeedTrigger.node.ts` | Push trigger for view deploy/remove webhooks |
| `EnterspeedApi` ("Enterspeed Core API") | `credentials/EnterspeedApi.credentials.ts` | Shared by both Core nodes |
| `EnterspeedContextGraph` ("Enterspeed Context Graph") | `nodes/EnterspeedContextGraph/EnterspeedContextGraph.node.ts` | Action node for the Context Graph: resources `artifact`, `entity`, `index`, `representation`, `schema`, `shape` |
| `EnterspeedContextGraphApi` | `credentials/EnterspeedContextGraphApi.credentials.ts` | The Context Graph's own credential; never shared with Core |
| `EnterspeedContextGraphTrigger` ("Enterspeed Context Graph Trigger") | `nodes/EnterspeedContextGraph/EnterspeedContextGraphTrigger.node.ts` | Push trigger for the Context Graph's outbound envelope (section 3.10) |
| `EnterspeedContextGraphWebhookApi` ("Enterspeed Context Graph Webhook API") | `credentials/EnterspeedContextGraphWebhookApi.credentials.ts` | The trigger's signing secret and optional receiver header; one per webhook subscription |

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

Delivery reads in a run (Shape › Get and Get Many, Index › Query and Get, Representation › Get and its resume rounds) go through `deliveryReadRequest` instead, which retries a `503` once (delivery/ADR-025 Decision 3: `503` + `Retry-After` + `X-Delivery-Retry-After-Ms`; Decision 5: "503's purpose is to drive retry"). The wait is `X-Delivery-Retry-After-Ms`, else `Retry-After` in whole seconds, plus a random jitter in `[0, min(wait / 2, 1 s))`, slept with n8n's `sleep`; the same request is then sent once more. No usable value, or one over 30 s, means no retry. These are the rules of delivery's own .NET and npm clients. Delivery sends that `503` when it sheds load (`ReadLoadSheddingPolicy`, `Retry-After: 1`, on the shapes batch, query and representation routes), when Redis, Postgres or Elasticsearch fails (5 s), when search can't answer a query batch (5 s, a problem body, delivery/ADR-052) and when a representation's resolution times out. A query batch whose semantic query the embedding model can't embed is a `503` with a problem body and no `Retry-After` (sc-13789), so it isn't retried; its `detail` says the batch can be re-sent without that query. A `503` that isn't retried, or comes again, fails the item with one *busy* message (`DELIVERY_BUSY_MESSAGE`), with a problem body's `detail` as the description. Schema › Get and the editor's schema reads don't retry. The SDK dev-server never answers a read `503`; the Context Graph end to end (section 7) puts a proxy in front of it that answers one, with either header, and checks the read is sent again through n8n's real request helper.

Every resource follows one rule: **output the service's answer unchanged**. The node never reshapes a record on the way in or a response on the way out. The one exception is opt-in: Representation › Get's *Include Response Headers* wraps the body with its status and headers, and a `304` to *If-None-Match*, which has no body, comes out as a stand-in (section 3.5).

| Resource › Operation | Request | Items → requests | Contract / ADR |
|---|---|---|---|
| Artifact › Upload | `POST {ingestUrl}/v1/sources/{alias}/artifacts`, the bytes to `upload.url` without the credential, then `POST …/artifacts/{id}/commit` | One export file per item | *Ingest artifact*, *Ingest artifact format*; ingest/ADR-017, 018, 019; cross/ADR-022 |
| Artifact › Get | `GET {ingestUrl}/v1/sources/{alias}/artifacts/{id}` | One artifact per item | *Ingest artifact* (status); ingest/ADR-017 D6 |
| Artifact › Get Many | `GET {ingestUrl}/v1/sources/{alias}/artifacts?limit=&state=&cursor=` | One listing per item, Return All follows `nextCursor` | *Ingest artifact* (list) |
| Artifact › Get Lines | `GET {ingestUrl}/v1/sources/{alias}/artifacts/{id}?after=` | One artifact's lines per item, paged by `nextAfter` | *Ingest artifact* (the artifact) |
| Entity › Push | `POST {ingestUrl}/v1/entities` | One record per item, one request per item | *Ingest NDJSON*, *Ingest bulk result*; ingest/ADR-005, 013, 020 |
| Entity › Push Many | `POST {ingestUrl}/v1/entities` | One item holding a list, split only at the body limit | as Push; cross/ADR-022 |
| Shape › Get | `GET {deliveryUrl}/shapes/v1/{manifest}/{key…}` | One key per item | *Shape key*; delivery/ADR-030 §3 |
| Shape › Get Many | `POST {deliveryUrl}/shapes/v1/{manifest}` | One item holding a list, split at 30 KiB | *Shapes batch envelope* |
| Index › Query | `POST {deliveryUrl}/query/v1/{manifest}` | One query per item, split only at the body limit; Return All follows `next` in rounds | *Query envelope*; delivery/ADR-030 §3, ADR-037 |
| Index › Get | `GET {deliveryUrl}/query/v1/{manifest}/{index}/{id}` | One document per item | delivery/ADR-030 §3, ADR-022 |
| Representation › Get | `GET {deliveryUrl}/v1/{manifest}{route}` (with `If-None-Match` when set), then the same with `X-Resume` per resume round | One route per item | *Representation envelope*, *Representation slot*; delivery/ADR-030 §3, ADR-033, ADR-050 |
| Schema › Get | `GET {deliveryUrl}/schema/{kind}/v1/{manifest}[/{prefix}]` | Once per run, first item | delivery/ADR-030 §3, ADR-036 |
| Trigger (inbound) | The Context Graph `POST`s the envelope to the node's webhook URL | One run per verified delivery, one item per entry | *Outbound envelope* (format, signature headers); cross/ADR-024, ADR-026 D5 (section 3.10) |

### 3.2 Entity: Push and Push Many

Records follow the *Ingest NDJSON* contract and are sent unchanged as NDJSON lines (`actions/entity/shared.ts` builds and sends them).

- **Push** takes one record per item. Its five parameters set `$id`, `$type`, `$source`, `$action` and `$modifiedAt`, each defaulting to the record's own (`={{ $json.$id }}` and so on).
- **Push Many** takes one item holding a list of records (`={{ $json.data }}`, as an Aggregate node makes it); each record keeps its own `$` fields.
- **Values are sent as given.** A non-string `$id` or `$type` is reported as failed without being sent, because the contract makes it a parse error. `$source` is required by ingest (cross/ADR-010 retired the source derived from the key); a record without one is sent as it is, and the service's per-record rejection is its result. A delete line carries only the `$` fields. `$modifiedAt` is passed as given, on saves and deletes (ingest/ADR-013).
- **Not the bulk path.** A source's complete export is an artifact upload (cross/ADR-022, ingest/ADR-017, *Ingest artifact* contract): reserve, signed upload, commit, then a paced drain. Ingest and the SDK dev-server serve it; the node sends it with Artifact › Upload (section 3.9). Push Many splits a list only at the body limit: a request closes before 29,000,000 bytes, well under ingest's 32 MiB write body limit (ingest/ADR-020 D5), and requests are sent one at a time.
- **Throttling.** A `429` (a problem body with `Retry-After` in seconds, nothing written) is retried after its `Retry-After`, up to 3 times, as ingest/ADR-020 requires of workflow-tool integrations.
- **Result.** The service answers a per-line `{ id, accepted, error?, statusCode }` array in line order (`200` all accepted, `207` otherwise), zipped back onto the records.

### 3.3 Shape: Get and Get Many

Shapes are read by the canonical shape key, `{shapeName}:{segKey}:{value}:…` (*Shape key* contract). The shapes route is the narrow read: one shape by key, without representation resolution (delivery's `ShapesEndpoints`; processing/ADR-012). An app reads representations (3.5); the demo uses shapes to check what the graph made of the pushed records.

- **Get** sends the key's colon-joined parts as percent-encoded path segments (delivery/ADR-030 §3). A segment value can't hold `:` or `/`, so the split is exact. The shape is output unchanged; a `404` fails the item.
- **Get Many** sends the list as `{ keys }`, closing a request before 30 KiB (delivery caps the body at 32 KiB), and outputs each `{ key, status, data }` of the always-`207` answer unchanged, paired to the item the list came from (*Shapes batch envelope*).
- **Visibility.** A request's claims come from one place, fixed by the key's kind when it is issued (cross/ADR-051): the claims Management stores on the key, or a verified context token. The node sends the Delivery API Key and no context token, so with a key that takes its claims from a token a shape gated by its access policy reads as `404`, and with a key that has stored claims it reads whatever those claims open. Delivery answers a denied shape and a missing one with the same bodiless `404` (sc-10848), so the node never says "denied". The node needs nothing of its own for either kind: the key decides.
- **Malformed and unknown keys.** No contract defines an error for a malformed key. Delivery and the SDK dev-server reject only an empty key (`400 "Missing shape key"`) and answer any other key that names no shape with a bodiless `404`. A key whose shape the manifest doesn't declare is a `404` with an `application/problem+json` body titled *Unknown shape* on Get, and a `404` item on Get Many (*Shapes batch envelope*). The node doesn't validate the key itself. `deliveryError` reads only a body's `message`, so it reports an unknown shape with its own not-found message.
- **A busy Delivery.** A `503` is retried once (section 3.1); the shapes batch is one of the load-shed routes.
- **Key From › Schema** builds the key from a shape and its ID segments chosen in the editor (section 4); it waits on the schema listing entry shapes.

### 3.4 Index: Query and Get

- **Query** sends every item's query in one array, split into several requests only to keep each body under 30 KiB (delivery caps it at 32 KiB), sent one at a time. A single query over that fails before sending. *Query From* › **JSON** sends the item's query as written; › **Builder** assembles it from schema-filled fields (section 4): filters `and`-combined, values typed by the field's value class (delivery/ADR-037), each sort as `direction` `asc`/`desc` (*Query sort order* contract; a saved `Ascending`/`Descending` is read the same), *Results Per Page* from 1 to 100. The 100 is the platform-wide maximum (delivery/ADR-037, sc-12248 amendment; the MSD's `queryLimits.max`): a direct `/query` asking for more is a `400` for the whole request, so an item over it fails before sending and the other items are still sent.
- **Query ids.** A query's `id` is its own, else its position in the request (*Query envelope*). When the run is split, a query without an id is sent with its position among the run's queries as an explicit `id`, since a positional id restarts in each request; an unsplit run is sent exactly as written. In one request, two queries that would share an id are sent as they are: the platform answers such a batch `400` with its own message (delivery, and the dev-server since sc-12132), which fails every query in it. Split, they could land in different requests that each pass, so the node checks the run's derived ids before sending and fails every query the same way.
- **Query results.** Each `{ id, index, items, totalCount, next }` is output unchanged, paired to its item by `id`. One invalid query makes the platform reject the batch (`400`, its message passed through), so a failed request fails every query in it, and no other request. When search can't answer, delivery answers `503` + `Retry-After` with a problem body, or `500` when a retry fails the same way (delivery/ADR-052); the `503` is retried once (section 3.1), and if it fails again the node says Delivery is busy, with the `detail` as the description. Other statuses show the body's `message`, else `detail`, else name the status.
- **Query Return All.** A query whose result has a `next` is sent again with it as `cursor` (*Query envelope*: a cursor takes precedence over `page`; `next` is set on a full page, so the walk ends on the first page that isn't full, or on the empty page after a full last one). Each round holds only the queries still going, each with its explicit `id`, and is split at the body limit like the first; its pages go through `deliveryReadRequest`, so each round's `503` is retried once. The output is the first page with every page's `items` concatenated and `next: null`. A `page` other than 0 fails the item before sending; the Builder hides *Page* and sends none. So does `search.mode` `semantic` or `hybrid`: delivery never sets `next` on either (*Query envelope*, `next`; `QueryExecutor`), so the walk would end after the first page and its output would look complete. Refusing it is the honest answer, as delivery refuses a `cursor` there; a note in the output would change the answer, and a doc note isn't read by someone turning Return All on. Every cursor sent for a query is kept, and a `next` among them fails the query, so a server that repeats a cursor can't loop the node. A failed round fails its queries as a failed first request does. A later round isn't checked for repeated ids: delivery refuses a first round whose ids repeat, so its later rounds hold distinct ones.
- **Get** is the point read: one percent-encoded document id, the colon-joined key the document is stored under, which is the `$id` each Query match carries (delivery/ADR-022: a query result's `$id` is the point-read id; delivery's importer uses the same key for both). The body (the document's displayed fields, delivery/ADR-022) is output unchanged; a bodiless `404` fails the item. The SDK dev-server doesn't serve this route yet, so it is unit-tested only.

### 3.5 Representation: Get

- One `GET` per route, each route segment percent-encoded. There is no batch: delivery/ADR-030 keeps per-item reads as the cacheable serving path and builds no bulk representation read.
- **Route From** › **Route** takes the path as text; › **Schema** fills a chosen route template from mapped context values (section 4.3).
- The body is output unchanged: each slot at its name plus `$metadata` (*Representation envelope*).
- `200`, `202` and `207` all succeed, because which slots resolved is in `$metadata.<slot>.$state`, not the status. A `404` (no matching route, an unresolved `required` slot, or no slot resolved) fails the item.
- **No `X-Delivery-Policy`.** With no header, delivery gives one complete resolution, entry and query slots together, bounded by a 5-second budget and 3 query passes. A read cut short by either bound is a `207` with the open slots in `$metadata` (*Representation slot*, *Resolution policy*; delivery/ADR-050). That default is ADR-050's answer for a machine caller, so the node sends no header. The one opt-in, `progressive`, defers every query slot for a client that paints first, which a workflow doesn't do. Any other value is a `400` `invalid_policy`.
- **Resume Partial Answers** (off by default) follows `$metadata.$resume` (delivery/ADR-033, still Proposed; the *Representation envelope* vectors pin `$resume`, chained rounds included, through `follows`):
  - A round repeats the request exactly, query string and headers included (delivery reads them again on a resume), and adds the checkpoint verbatim as `X-Resume`. The token is never parsed or logged.
  - Delivery and the SDK dev-server answer a round with one JSON body holding only the slots that were open, not the stream ADR-033 §2b describes. Each slot and its `$metadata` entry replace the earlier ones by name; `$changedAt` is the newest across rounds (*Representation envelope*); `$resume` is the latest round's, so it is gone once nothing is open.
  - Rounds go on while the answer carries `$resume` and a slot that may be resumed, up to *Max Rounds*. Open means `pending` or `deferred` (the pending status class). The node sends no context token, so a slot whose `$requires` names a claim is skipped (*Representation slot*, client resume guard, rule 1).
  - Before a round the node waits for the largest `$timeoutMs` among those slots, capped by *Max Wait Between Rounds*, with `sleep` from `n8n-workflow`. `deferred` withholds `$timeoutMs`, so such a round goes at once.
  - A refused checkpoint is answered once by a plain `GET` that replaces the rounds so far: `410` with `checkpoint_expired` and `409` (ADR-033 §3: "the client re-GETs"), and `401` with `invalid_checkpoint` (the ADR names no client action; the dev-server's message asks for this). Delivery's `WWW-Authenticate` hint tells these from a rejected key or a retired API version. A second refusal or a `404` fails the item.
  - A resume round re-applies the policy its own request carries (*Resolution policy*). The node's rounds carry no header, so each round may resolve query slots too. A slot that still doesn't resolve comes back open with a fresh `$resume`, and *Max Rounds* is what stops it.
- **ETag revalidation** (*If-None-Match* and *Include Response Headers*, both off by default). No contract pins this; the source is delivery's `RepresentationEndpoints` (sc-13417 amendment to delivery/ADR-032): a complete `200` to a fresh `GET` carries a weak `ETag`, an HMAC over the body keyed per deployment, and a matching `If-None-Match` (a comma-separated list or `*`, compared weakly) is answered `304` with the same headers and no body. A `207`, a `202`, a resume round and an error carry none. The SDK dev-server does the same with its own, unkeyed tag.
  - With either field set, the operation keeps the response's status and headers (every request is read in full, section 3.8). With both off the output is as before.
  - *If-None-Match* goes only on the first `GET` of the route, not on resume rounds (delivery doesn't revalidate those) and not on the fallback after a refused checkpoint.
  - `contextGraphApiRequest` fails any status outside 2xx, `304` included, with the response as the failure's `cause` (section 3.8). The node reads a `304` from that failure, but only when it sent *If-None-Match*; every other status keeps its wording and a `503` its retry.
  - Output: with *Include Response Headers*, `{ status, headers, body }` with whichever of `Cache-Tag`, `ETag`, `Cache-Control` and `Vary` the last response carried (the Context Graph MCP server's `includeHeaders` set, `OUTPUT_HEADERS`), and `body: null` on a `304`; without it, the body as before, or `{ notModified: true }` on a `304`. After resume rounds the headers are the last round's, so no `ETag` from an earlier response is carried over.
  - Keeping ETags between runs is left to the workflow (an n8n Data Table); the node keeps no state.

### 3.6 Schema: Get

Reads the manifest's schema, `kind` being `msd`, `openapi` or `jsonschema`, optionally narrowed to the representations under a route prefix, and outputs it unchanged as one item. The schema belongs to the manifest, not to an item, so it is read **once per run** with the first item's parameters and paired to item 0.

### 3.7 Credential and Authentication

| Field | Used for |
|---|---|
| `ingestUrl`, `ingestApiKey` | Writes: `POST /v1/entities`, and the artifact routes (reserve, commit, status, list) |
| `deliveryUrl`, `deliveryApiKey` | Every read, the schema and the credential test |
| `manifestVersion` | The `{manifest}` segment of every Delivery route. For an SDK-published schema, the manifest id, a content hash (sdk/ADR-016) |

Ingest and Delivery are separate services, each checking its own key. The credential's `authenticate` function sets `X-Api-Key` per request: the Ingest API Key when the request URL is under the ingest URL, the Delivery API Key when it is under the delivery URL, and no key to any other host. "Under" means the same origin and a path at or below the configured one, trailing slashes ignored; if one URL is under the other, the more specific wins, so with both URLs the same (the SDK dev-server) that host gets the Ingest API Key.

Neither URL has a default. The Context Graph's hosts aren't Enterspeed Core's, and no Context Graph host is settled yet, so a pre-filled Core host would send a Context Graph key to Core and fail the test with a misleading *No manifest with this version*.

The test request reads `GET {deliveryUrl}/schema/msd/v1/{manifestVersion}`, which deployed Delivery guards with the key (`401`) and answers `404` for an unhosted manifest. The ingest key isn't tested. The SDK dev-server serves both services from one host and accepts any key, so against it the test proves only reachability and the manifest version.

### 3.8 Errors

Every request goes through `contextGraphApiRequest` (`transport.ts`), which sends it with `ignoreHttpStatusErrors` and `returnFullResponse` and fails a status outside 2xx itself, as a `NodeApiError` whose `cause` holds the response (status, body, headers). It doesn't let n8n fail the request: the `NodeApiError` n8n's request helper throws keeps only the status code, not the body or the headers (its `cause` is undefined; seen in n8n 2.27.4 by the end-to-end run, section 7), so a problem's `detail`, a `503`'s `Retry-After` and a `304`'s `ETag` would be lost. `httpFailure` reads the status, body and headers from that `cause`, or from a plain HTTP error. Each resource turns that into a message that says what failed (`401` rejected key, `404` not found, `410` retired API version, unreachable URL), passing the platform's own message through when it has one; the Delivery resources share `deliveryError` (`actions/shape/shared.ts`). The `NodeApiError` is built from a plain object, because its constructor returns an existing `NodeApiError` unchanged and would drop the message. With *Continue On Fail* a failed item comes out as what identifies it (e.g. `{ key, … }`, `{ route, … }`, a Push result with `accepted: false`) plus `error` and, when there is one, `description`.

### 3.9 Artifact: Upload

A snapshot source's complete export goes in as one artifact (cross/ADR-022 D1, ingest/ADR-017 D1, *Ingest artifact* spec), one file per input item, through `actions/artifact/`:

- **Declared facts.** The reservation sends `asOf`, `rowCount`, `contentType` and `contentHash` (ingest/ADR-017 D2). *As Of* and *Row Count* are the source's and sent as given: `asOf` is when the export started, which nothing on the platform can check (ingest/ADR-019 D2), and `rowCount` exists to catch a cut-off file, so counting the file in n8n would defeat it (a mismatch voids the deletions, ingest/ADR-018 D2). Only a missing value, or a *Row Count* that isn't a whole number, fails the item before sending. *Content Type* is chosen on the node (NDJSON or CSV, ingest/ADR-019 D1), never taken from the binary's MIME type. `contentHash` is the SHA-256 of exactly the bytes sent.
- **The file is not read.** It is hashed and sent as it is; never parsed, mapped or counted. A CSV is read by the source's field map (ingest/ADR-019 D2), which is the source contract's, not the node's.
- **The upload carries no credential.** The bytes go to `upload.url` with `upload.method` and exactly `upload.headers` through plain `this.helpers.httpRequest`: the credential's `authenticate` would add a key to any URL (the Delivery key to anything outside the Ingest URL). The signed URL is access in itself, so an error names only its origin.
- **In memory.** n8n's `httpRequest` takes a `Buffer` body, not a stream, so the file is held in memory while sent. Measured in the Docker n8n (2.27.4, Node 24, filesystem binary mode): a 2,000,000,000-byte file (ingest/ADR-017 D1's 2 GB) reads and sends whole; one of exactly 2 GiB fails Node's `fs.readFile`. In queue mode n8n's database binary mode caps a file at 512 MiB by default (1 GiB at most). Block upload (resumable) isn't possible through one request and isn't built.
- **Retries.** A reservation with the same `asOf` and `contentHash` is a retry (ingest/ADR-017 D3). For one already committed the answer has `upload: null`, and the node outputs it without uploading or committing; one not committed comes with a fresh URL and is uploaded and committed again. So n8n's *Retry On Fail* is safe.
- **Output.** The artifact as the commit answered, unchanged. The node doesn't wait for the drain: deployed ingest drains later against a 4-hour target (ingest/ADR-017 D7), so a workflow reads the status later; the dev-server drains at commit.
- **Errors.** Refusals are problem details whose `type` is `urn:enterspeed:problem:artifact:{reason}`; `ingestError` (`actions/artifact/shared.ts`) words them as the platform's `title` plus the reason, with `detail` as the description. The artifact routes don't count against the write throttle (*Ingest artifact* spec; ingest/ADR-020 D6), so there is no `429` retry. With *Continue On Fail* an item comes out as `{ source, asOf, error, description? }`.
- **Not built:** releasing or discarding a held deletion set and the mirror status. They change state and need their own credential rules (`403` `policy-forbids`, `409` `deletions-not-held`).

**Reading an upload back** (Get, Get Many, Get Lines; *Ingest artifact* spec, status and list). The node doesn't wait for a drain; a workflow waits with n8n's Wait node. Each input item is one read, and every output item is paired to it (`readEachItem` in `actions/artifact/shared.ts`).

- **Get** outputs the status route's answer unchanged, one item.
- **Get Many** outputs each `artifacts[]` entry unchanged. *State* is sent as `state` on every page; *Return All* sends `limit=200` (the route's maximum) and follows `nextCursor` until `null`; otherwise one page of *Limit* (1–200, checked before sending).
- **Get Lines** pages the status route with `?after={nextAfter}` and outputs each `lines[]` entry unchanged, stopping at `nextAfter: null` (*Return All*) or once *Limit* lines are out, reading no further page than it needs. The page size (1,000) is the platform's. An artifact not committed yet answers no lines, so it outputs nothing. *Artifact ID* must be a GUID, checked before sending: the routes take only a GUID, and anything else answers a bare `404` that names no reason.
- **Errors.** As Upload: `ingestError` words a refusal by its problem type (`not-found`, `invalid-listing`), and a bare `401`/`403` by status. With *Continue On Fail* an item comes out as `{ source, id?, error, description? }` (`id` for Get and Get Lines).

### 3.10 Trigger: the Outbound Envelope

The Context Graph posts an **outbound envelope** to each webhook subscription when a commit changes entries (semantic-graph `contracts/spec/outbound-envelope.md`; cross/ADR-024 for the signature, cross/ADR-026 Decision 5 for `type`). The SDK dev-server posts the same envelope to its `webhookUrl`, signed with `webhookSecret` (or its dev key) and with an optional `webhookHeader`, and both run the same `contracts/vectors/outbound-envelope/` and `webhook-signature/` vectors; `tests/fixtures/` holds verbatim copies the unit tests run.

- **Its own credential.** Each subscription has its own signing secret, so `EnterspeedContextGraphWebhookApi` holds it (and the optional receiver header), never the API credential. Nothing in it is sent. There is no request to test it with, so the trigger's `testedBy` method only checks the secret decodes to at least 24 bytes and a header name has a value.
- **Verified over the raw bytes.** `webhookTrigger/signature.ts` checks Standard Webhooks with Node's `crypto` (allowed on n8n Cloud): HMAC-SHA256 keyed by the secret's base64 after `whsec_`, over `{webhook-id}.{webhook-timestamp}.` and n8n's `rawBody`, compared in constant time. A re-serialised body would not verify: the sender escapes non-ASCII and `&<>`. The Docker n8n run (2.27.4) confirmed `rawBody` holds the bytes as sent. During a rotation `webhook-signature` holds two signatures; either verifying passes. The timestamp tolerance is five minutes either way, the libraries' default the spec names.
- **Rejected before a run.** A bad or missing signature, a timestamp outside the tolerance or a missing or wrong receiver header is answered `401` with `noWebhookResponse` (the Core trigger rejects the same way, with `403`); a verified body that isn't an envelope (no `tags` array) is answered `400`. Neither starts a run. A message names which check failed, never the secret.
- **Answered at once.** `responseMode: 'onReceived'`, so a verified delivery is answered `200` before the workflow runs and a slow workflow never makes the sender retry.
- **Output.** One item per `tags[]` entry, as it came, plus every envelope field but `tags` (`type`, `environmentId`, `deliveryId` and any added later); an envelope field wins over an entry's of the same name. *Event Types* (empty: all) filters by `type`; another type is acknowledged and starts nothing. Unknown types and properties pass through (cross/ADR-026 Decision 5; the spec's *Unknown properties must be tolerated on read*). Redeliveries share a `deliveryId`, which the README's Remove Duplicates recipe uses with each entry's `key`.
- **Registration is manual.** `webhookMethods` report "already handled": registering on activation would put an operator token in n8n, which is a separate decision.

---

## 4. Schema-Driven Fields and Editor State

Several Context Graph fields can be filled from the manifest's **materialised schema document** (MSD, delivery/ADR-028 §4) instead of typed in:

| Field | Operation | Filled from |
|---|---|---|
| *Index* | Index › Get, Index › Query (Builder) | `indexes` |
| Filter fields | Index › Query (Builder) | the index's `keywordFields`, `numericFields` and `booleanFields` |
| Sort fields | Index › Query (Builder) | the index's `sortableFields`, each with the value class its filter list gives it |
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

Where a context value goes follows the *binder-constraint* contract and delivery/ADR-036:

- A placeholder in the chosen route fills its path segment and is required
- A `query()` or `header()` binder puts its key in the query string or an `X-Delivery-` header, under the name it gives
- No other key is offered. Once a representation declares `$context`, which the SDK always emits, delivery drops every query param and `X-Delivery-*` header no binder reads (*binder-constraint*, "Undeclared params are dropped"), so a key outside the path with no binder would be sent and ignored. Delivery's OpenAPI form follows the same rule for an MSD that carries `context.resolving` (delivery/ADR-036, sc-14279). The MSD can't tell a `$context` with no query or header binder from no `$context`, so a hand-written manifest without one gives such a key up too
- A binder with `presence: optional` or a default is not required; a binder's `enum` becomes a list of options

### 4.4 When the Schema Changes

A saved workflow keeps sending what was saved. A renamed index or field fails at run time with the platform's own message, and a new required context value isn't sent until it is added. The user fixes the drift by reopening the node and refreshing the list or the mapper's fields. An expression in any of these fields bypasses the list and is sent unchecked.

### 4.5 Known Limits

- **No entry shapes in the MSD.** The *Materialised schema document* contract (like ADR-028 §4) lists indexes and representations, not entry shapes or their ID segments, so `msdShapes()` returns `[]` and Shape's Schema mode shows *This schema lists no shapes*. It is the one place to change when the MSD lists them.
- **The MSD's form is pinned by the *Materialised schema document* contract** (semantic-graph › contracts › spec, with vectors that delivery and the SDK dev-server both pass). `msd.ts` still ignores members it doesn't know.
- **Sort fields follow `sortableFields`.** The contract lists each index's `sortableFields` ("the fields a query may sort on", sc-14481), and delivery refuses a sort on any other field (sc-14365). A member is present only when non-empty, so a missing `sortableFields` means none, and the sort list shows *This index lists no sortable fields* rather than offering fields delivery would refuse. The SDK dev-server lists the member too (sc-14753). A sortable field no filter list classifies is offered and saved by its plain name.
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
nodes/EnterspeedContextGraph/      Context Graph action node and trigger, transport
  webhookTrigger/                  properties.ts, handler.ts, signature.ts (the trigger)
  actions/{entity,shape,index,representation,schema}/
  actions/schema/msd.ts            the MSD reader behind the schema-driven fields
credentials/                       one file per credential type, plus the icon copy
tests/                             one test file per node, msd tests, mocks, template checks
  fixtures/                        semantic-graph's webhook-signature and outbound-envelope vectors, verbatim
workflows/templates/*.json         example workflows
workflows/fixtures/*.json          test workflows that need more than n8n (not imported)
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

Writes only, `POST {ingestUrl}/v1/entities` with the Ingest API Key. Ingest serves every route under `/v1` (`INGEST_API_VERSION` in `actions/entity/shared.ts`); an unversioned path answers `404`. Ingest is the platform's only write path; the node relies on its per-line result and its throttle (section 3.2). An export goes through ingest's artifact routes with the same key; only its bytes go elsewhere, to the storage URL ingest signs (section 3.9).

### 6.3 Context Graph Node → Delivery

Every read and the schema, with the Delivery API Key, scoped to the credential's manifest version. In the editor the node also reads the MSD to fill lists (section 4). Against the SDK dev-server (the Tonevik demo), Ingest and Delivery share one host and some routes are missing or differ: the index point read, and cursor paging on the published `0.2.0-alpha.3` and earlier (SDK `master` hands out `next` on both tiers). The dev-server also processes a pushed record at once, where a deployed graph processes it after accepting it (ingest/ADR-013: `accepted: true` is "landed and not yet judged"), so a read straight after a push can miss it there.

### 6.4 n8n → the Package

n8n loads the package from `dist/`. In the Docker setup (`docker-compose.yml` mounts `./dist` as a custom extension) the nodes register as `CUSTOM.enterspeed`, `CUSTOM.enterspeedTrigger`, `CUSTOM.enterspeedContextGraph` and `CUSTOM.enterspeedContextGraphTrigger`; through `npm link` they register as `@enterspeed/n8n-nodes-enterspeed.enterspeed`. Workflow templates are authored against the Docker types, and every credential reference in them is a placeholder (`__ENTERSPEED_CREDENTIAL_ID__`, `__ENTERSPEED_CONTEXT_GRAPH_CREDENTIAL_ID__`) that `scripts/setup.mjs` replaces in memory.

---

## 7. Testing and CI

- **Unit tests** (Vitest, `tests/`): one file per node, `EnterspeedContextGraph.msd.test.ts` for MSD parsing and schema-driven requests, `mocks.ts` with minimal `IExecuteFunctions` / `IWebhookFunctions` stand-ins, and `workflow-templates.test.ts`, which checks every template's shape, node types and credential placeholders.
- **The mocks answer as n8n does with `ignoreHttpStatusErrors`** (`asN8nFullResponse` in `mocks.ts`): a test's mock returns a body or throws a failure with a status, and the node gets the full response. Behaviour that depends on n8n itself (its request helper, item pairing, expressions) is proven only in a Docker n8n run.
- **End to end** (Docker): `scripts/setup.mjs` creates the credentials and imports every template (and the folders in `N8N_WORKFLOW_DIRS`); `scripts/execute-workflow.mjs` triggers a workflow by name, polls its execution and, with `N8N_EXECUTION_OUT`, writes what each node output. Neither is wired into `package.json`.
- **Context Graph end to end** (`e2e/`, Node 26): `e2e/context-graph.mjs` starts the SDK dev-server with an empty graph (`e2e/schema.mjs`, a snapshot source `catalogue`), a source system serving an export on `:5500`, and a proxy on `:5200` that can answer one Delivery read `503`. It runs the round-trip template (`Context-Graph-Round-Trip.json`) with a complete export (the upload drains and the read-out returns exactly its records) and with a malformed line (the run fails with the graph's reason, nothing is read back), then `e2e/workflows/Context-Graph-E2E-Delivery-Reads.json`: a second Representation › Get with the stored ETag is a real `304`, and a `503` with `Retry-After` or `X-Delivery-Retry-After-Ms` is retried through n8n's real request helper. The dev-server version is pinned in `e2e/package.json` (`0.2.0-alpha.4`, the first with ingest's `/v1` routes; until it is published, CONTRIBUTING says how to install a build of the SDK's `master`).
- **CI** (`.github/workflows/ci.yml`): on every push and PR to `main`, `npm run lint`, `npm test` and `npm run build` on Node 20, 22 and 24, then the e2e job: Docker n8n, the Enterspeed Core workflow against the demo tenant, and the Context Graph end to end (which runs even if the Core workflow fails). A tag (`v*`) publishes to npm. Stacked PRs that target another branch get no CI run.

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

### 8.7 No `usableAsTool` on the Triggers

`n8n-node lint`'s preset flags `EnterspeedTrigger` and `EnterspeedContextGraphTrigger` for not setting `usableAsTool: true`. The type has no `false`, and n8n's verification scanner forbids `true` on triggers (an agent can't invoke a trigger), so the property is omitted and the rule is suppressed for those two files in `eslint.config.mjs`.

---

## 9. Trade-offs

### 9.1 Push vs Upload

Push and Push Many send records as they change. A complete export belongs in an artifact upload (cross/ADR-022, ingest/ADR-017), which the platform serves and the node sends with Artifact › Upload (section 3.9), so Push Many is deliberately not tuned for bulk: no batch-size setting, sequential requests, a split only at the body limit.

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
