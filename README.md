# @enterspeed/n8n-nodes-enterspeed

[![CI](https://github.com/enterspeedhq/n8n-nodes-enterspeed/actions/workflows/ci.yml/badge.svg)](https://github.com/enterspeedhq/n8n-nodes-enterspeed/actions/workflows/ci.yml)

n8n community nodes for [Enterspeed](https://www.enterspeed.com): get data **into** Enterspeed and feeds **out** of it, then wire it to any of n8n's 1,100+ destinations. No keys are bundled; each customer enters their own credentials.

```bash
npm install @enterspeed/n8n-nodes-enterspeed
```

Or in n8n: **Settings → Community Nodes → Install** and enter `@enterspeed/n8n-nodes-enterspeed`.

## Nodes

| Node | Kind | What it does | Credential |
|---|---|---|---|
| **Enterspeed Core** | action | Ingest, Delivery, Query and Routes operations | Enterspeed Core API |
| **Enterspeed Core Webhook Trigger** | trigger (push) | Starts a workflow when a view is deployed or removed | Enterspeed Core API |
| **Enterspeed Context Graph** | action | Pushes records into a Context Graph; reads its shapes, index documents, representations and schema; queries its indexes | Enterspeed Context Graph API |

The Core nodes and the Context Graph node talk to different products and never share a credential.

Before 0.2.0 the Core nodes were labelled **Enterspeed**, **Enterspeed Webhook Trigger** and **Enterspeed API** (credential). Only the labels changed: the internal names (`enterspeed`, `enterspeedTrigger`, `enterspeedApi`) are the same, so existing workflows and credentials need no action, and nodes already in a workflow keep their names.

---

## Enterspeed Core

### Credentials

Create an **Enterspeed Core API** credential with:

| Field | Where to get it | Used by |
|---|---|---|
| Environment API Key | Settings → Environment settings | Delivery, Query, Routes |
| Source API Key | Settings → Data sources | Ingest |
| Hosts | pre-filled with the public endpoints | override for dedicated tenants |

### Operations

| Resource › Operation | Request | Notes |
|---|---|---|
| Entity › Save | `POST https://api.enterspeed.com/ingest/v2/{originId}` | Origin ID, Entity Type (immutable after first ingest) and a JSON body |
| Entity › Delete | `DELETE https://api.enterspeed.com/ingest/v2/{originId}` | Origin ID |
| Entity › Save Entities (Bulk) | `POST https://api.enterspeed.com/ingest/v2` | A JSON array of up to 50 entities |
| Entity › Delete Entities (Bulk) | `DELETE https://api.enterspeed.com/ingest/v2` | `{ "originIds": [...] }`, up to 50 |
| Delivery › Get Content | `GET https://delivery.enterspeed.com/v2` | By URL, comma-separated view IDs and/or handles |
| Query › Query Index | `POST https://query.enterspeed.com/v1/{indexAlias}` | A JSON body with `filters`, `sort`, `pagination`, `facets` (all optional) |
| Route › Get Many | `GET https://api.enterspeed.com/routes/v2` | Paged by `X-Continuation-Token` |

- *Delete* and *Delete Entities (Bulk)* always output `deleted: true`, merged on top of whatever the Ingest API returned.
- *Route › Get Many*: leave *Continuation Token* empty for the first page, then feed the response's `continuationToken` back in for the next.

### Webhook trigger (views)

Enterspeed pushes a webhook whenever a **view** is deployed (published or updated) or removed (deleted). Configure the webhook in Enterspeed, pointing it at this node's production URL, and optionally set an **access key**: the node checks it against the `X-Api-Key` header and rejects a mismatch with 403.

Enterspeed POSTs a lightweight notification, not the full view:

```jsonc
{
  "Id": "<view id>",
  "OriginId": "<source entity id>",
  "Type": "<view handle>",
  "Action": "Deploy" | "Remove",
  "Url": "<absolute Delivery API URL>"   // present only on Deploy
}
```

With *Fetch Full View* on (the default), the node fetches the view from that `Url` with the Environment API Key and attaches it as `view`. Removals carry no `Url`, so nothing is fetched. *Actions* picks deploys, removals or both.

### Polling for changes (indexes)

Routes and indexes don't emit webhooks, and there is no polling node. Watch an index with native n8n nodes and the **Query** operation instead: a Schedule Trigger runs the query on an interval, and a Code node compares each result with what it saw last time (kept in the workflow's static data), emitting only new or changed items. The first run sets a baseline (no flood) unless *Emit On First Poll* is on; change detection uses a configurable marker field (e.g. `updatedAt`) and ID field. See the [`poll-index-for-changes`](workflows/templates/poll-index-for-changes.json) example workflow.

### Typical flows

- **Ingest**: source (PIM, CMS, ERP) → map → **Enterspeed Core: Save Entity**.
- **Delivery / last mile**: poll an index for changes → map to a feed (XML, CSV) → push to Google, Meta or a marketplace.

---

## Enterspeed Context Graph

**New to the Context Graph?** Import the workflow `workflows/templates/Context-Graph-Tonevik-Demo.json`. It builds the Tonevik demo shop against the local dev-server one step at a time, and its notes say what it needs and what each step should return.

### Credentials

Create an **Enterspeed Context Graph API** credential with:

| Field | Used for |
|---|---|
| Ingest URL | Writes. No default: the Context Graph's hosts aren't Enterspeed Core's |
| Ingest API Key | Sent as the `X-Api-Key` header on requests to the Ingest URL only |
| Delivery URL | Reads. No default, as for the Ingest URL |
| Delivery API Key | Sent as the `X-Api-Key` header on every other request: shapes, indexes, representations and the schema |
| Manifest Version | The `{manifest}` segment of every Delivery route (default `1.0.0`). For a schema published with the SDK this is the manifest's id, a content hash, not its version label. |

Ingest and Delivery are separate services, and each checks its own key. The node picks the key by where the request goes: a request whose URL starts with the Ingest URL gets the Ingest API Key, any other the Delivery API Key.

Testing the credential reads `GET {Delivery URL}/schema/msd/v1/{Manifest Version}` with the Delivery API Key. It fails with a clear message if the URL can't be reached, the Delivery API Key is rejected (401) or the manifest version isn't hosted (404). It doesn't check the Ingest API Key; a wrong one shows on the first Push as a 401.

### Operations

| Resource › Operation | Request | Input → requests |
|---|---|---|
| [Entity › Push](#entity--push-and-push-many) | `POST {Ingest URL}/entities` | One record per item, one request per item |
| [Entity › Push Many](#entity--push-and-push-many) | `POST {Ingest URL}/entities` | One item holding a list, one request |
| [Shape › Get](#shape--get-and-get-many) | `GET {Delivery URL}/shapes/v1/{Manifest Version}/{key}` | One key per item |
| [Shape › Get Many](#shape--get-and-get-many) | `POST {Delivery URL}/shapes/v1/{Manifest Version}` | One item holding a list of keys, one request |
| [Index › Query](#index--query) | `POST {Delivery URL}/query/v1/{Manifest Version}` | One query per item, all in one request |
| [Index › Get](#index--get) | `GET {Delivery URL}/query/v1/{Manifest Version}/{Index Name}/{Document ID}` | One document per item |
| [Representation › Get](#representation--get) | `GET {Delivery URL}/v1/{Manifest Version}{Route}` | One route per item |
| [Schema › Get](#schema--get) | `GET {Delivery URL}/schema/{Kind}/v1/{Manifest Version}[/{Prefix}]` | Once per run |

Every operation outputs the Context Graph's answer exactly as it was returned; the node never reshapes records on the way in or answers on the way out. With *Continue On Fail*, a failed item comes out with `error` and, when there is one, `description`, next to what identifies it (its key, route, query or record).

### Entity › Push and Push Many

Both send records as they change, to the Context Graph as they are:

- **Push** takes one record per item and sends **one request per item**.
- **Push Many** takes one item holding a **list** of records and sends the whole list in **one request**. Collect the records into one item with an **Aggregate** node (*All Item Data*) first; *Records* defaults to the list it makes, `{{ $json.data }}`.

A Context Graph record looks like this:

| Field | | What it is |
|---|---|---|
| `$id` | required, text | The source system's own record key: unique within the source and the same every time the record is sent. It is not a domain field like `id`: the graph keeps both, and `$id` is what links the entity back to the record it came from. |
| `$type` | required, text | The entity type. |
| `$source` | required | The source the record belongs to. A record without one is rejected by the Context Graph. |
| `$action` | optional | `delete` (in any letter case) removes the entity; anything else saves the record. |
| `$modifiedAt` | optional | When the record last changed in the source (ISO 8601 with an offset). Saves and deletes to an entity are applied in this order, so an older write that arrives late doesn't overwrite a newer one. In production, sources are expected to send it: a record without one is applied, but a later upload of the source's export can overwrite it. |
| anything else | | The entity's properties, stored exactly as sent. A save replaces the whole stored record. |

Push has one field per `$` field (*Entity ID*, *Entity Type*, *Source*, *Action* and *Modified At*), each defaulting to the record's own (`{{ $json.$id }}` and so on). Records that already have these fields need no setup; change a field only to take the value from somewhere else, e.g. *Action* `{{ $json.deleted ? 'delete' : '' }}`.

Push Many has no such fields: each record in the list carries its own `$id` and `$type`, and `$source`, `$action` and `$modifiedAt` where it has them. Either way, values are sent as given, never converted or trimmed: a `$id` that isn't text is reported as failed.

If the source's records need more than that (renamed fields, transformed values, another format), reshape them in a **Code** or **Edit Fields** node before Push, or before the Aggregate node for Push Many:

```js
// Fit each source record to a Context Graph record.
return $input.all().map(({ json }) => ({
  json: {
    ...json,                      // the record's own fields, stored as they are
    $id: json.recordKey,          // the source system's own record key
    $type: 'category',            // the entity type
    $source: 'pim',               // the source the record belongs to
    ...(json.deleted === true && { $action: 'delete' }),    // remove instead of save
    ...(json.updatedAt && { $modifiedAt: json.updatedAt }), // when it changed in the source
  },
}));
```

- **Output:** one result per record, `{ id, type, source, action, accepted, statusCode, error? }`, paired to the item it came from. A rejected record, or one without a valid `$id` or `$type`, comes out with `accepted: false` and the reason; the rest are still stored. `accepted: true` also covers a record whose content was unchanged, and one superseded by a newer *Modified At*: both are accepted with nothing written. `accepted: true` means the record has landed, not that the graph has processed it: on a deployed graph a read straight after a push can briefly miss it, so read again. The local dev-server processes at once.
- **Deletes** send only `$id`, `$type`, `$source` and `$modifiedAt`.
- **Not for a complete export.** A source's full export goes in as an upload (see [Not built yet](#not-built-yet)).
- **Request size:** Push Many splits a list into more requests only to stay under the Context Graph's request limit (30,000,000 bytes); a single record too large for one request is reported as failed. Push Many fails an item whose *Records* isn't a list.
- **Throttling:** when the Context Graph is busy it refuses a request with `429` and says how long to wait. The node waits that long and resends the refused request, up to 3 times (nothing was written when it was refused). If it's still refused, or asked to wait more than five minutes, the run fails.
- **Errors:** a rejected key (401), a key without write access (403), a request that's too large (413), continued throttling (429) or an unreachable Ingest URL fails the run with a message saying which.

### Shape › Get and Get Many

Both read the graph's **shapes**, the views its schema declares over the data, by **shape key**: the shape's name, then each ID segment's name and value, joined with colons: `productPage:id:42`, or with two segments `productVariant:productId:42:sku:SKU-9`. The values are the record's own data (its `id`, say), not its `$id`.

- **Get Many** is the one to use for a list of keys. It takes one item holding the list in *Shape Keys* (default `{{ $json.keys }}`, e.g. built in a Code node: `return [{ json: { keys: [...] } }]`), sends the whole list in one request (several only past the 32 KiB request limit) and outputs one item per key, in list order: `{ key, status, data }` exactly as returned. A key with no shape comes out as `status: 404` with `data: null`, and the other keys still return. The request succeeds even when no key is found, so check each item's `status`. With no keys, nothing is sent; an item whose *Shape Keys* isn't a list fails.
- **Get** is for a workflow that handles one key at a time, such as a lookup triggered by a webhook. It takes one *Shape Key* per item and outputs the shape exactly as returned. A key with no shape fails with *No shape for key …*.
- **Who can see a shape:** a shape whose access policy needs a claim always comes back as `404`, the same as a shape that doesn't exist. The node sends no claims, and the Context Graph deliberately doesn't tell "missing" from "not allowed".
- **Errors:** a key that names no shape, malformed or not, is a `404` like any missing shape (the local dev-server differs, see [Against the local dev-server](#against-the-local-dev-server)). A rejected key (401), an API version the Context Graph no longer serves (410) or an unreachable Delivery URL fails the run with a message saying which.
- **Key From › Schema** (*Get* only) will let you pick the shape and fill in each ID segment instead of typing the key. The schema doesn't list entry shapes yet, so the list says *This schema lists no shapes*; use *Shape Key* until it does.

### Index › Query

Finds documents in an **index** the schema declares, with filters, sorting and paging. *Query From* sets how the query is given:

| Query From | How |
|---|---|
| **JSON** (default) | The *Query* field takes the query as a JSON object, sent as written. It starts with a working example to edit. |
| **Builder** | Pick the *Index* from the schema (see [Fields filled from the schema](#fields-filled-from-the-schema)), then add *Search* text, *Filters* (field, operator, value) and *Sort* (field, Ascending/Descending, sent as `direction` `asc`/`desc`), with *Results Per Page* (1 to 100, the Context Graph's maximum), *Page* and an optional *Query ID*. |

In the Builder, the field lists show only the fields the chosen index can filter on, and the operators the schema lists. *Sort* offers the same fields, but only those the index declares sortable can be sorted on: the schema doesn't say which ones are, and a sort on any other field is refused. Filters are all combined with `and`; for `or` or nesting, use JSON. A value is sent as the field's type: a number for a numeric field, `true`/`false` for a boolean one, text otherwise. For `in`, separate the values with commas. Aggregations, `cursor` and `args` are JSON-only.

The query members:

| Member | Required | What it is |
|---|---|---|
| `index` | yes | The name of the index shape, e.g. `ProductIndex`. |
| `filters` | no | One condition `{ "field", "operator", "value" }`, or a group `{ "and": [...] }` / `{ "or": [...] }`, nested freely. Only fields the index declares filterable. |
| `sort` | no | `[{ "field", "direction": "asc" \| "desc" }]`, in order of priority (`order` is accepted for `direction`, and `ascending`/`descending`, in any case). Only fields the index declares sortable; a sort on any other field is refused. |
| `limit` | no | Results per page, up to 100. Default 20. |
| `page` | no | The page, counted from 0. Default 0. |
| `cursor` | no | The `next` of the previous result, for the page after it. |
| `search` | no | Full-text search: `{ "query", "literal"?, "fields"?, "language"? }`. `literal: true` turns fuzzy matching off. |
| `aggregations` | no | `[{ "type": "values" \| "metrics" \| "range", "name", "field", "size"?, "ranges"? }]`. |
| `args` | no | Values for `${token}` placeholders in `filters` and `search.query`, by name. |
| `id` | no | Labels the query's result; otherwise its position in the request. |

Operators: `equals`, `notEquals`, `greaterThan`, `greaterThanOrEquals`, `lessThan`, `lessThanOrEquals`, `contains`, `in` (the value is a list).

```json
{
  "index": "ProductIndex",
  "filters": {
    "and": [
      { "field": "categoryId", "operator": "equals", "value": "cat-headphones" },
      { "field": "inStock", "operator": "equals", "value": true }
    ]
  },
  "sort": [{ "field": "price", "direction": "desc" }],
  "limit": 20
}
```

- **Output:** each input item is one query. All items' queries are sent in one request, and each item gets back its result exactly as returned: `{ id, index, items, totalCount, next }`. A query that matches nothing returns `items: []`; it doesn't fail.
- **Ids:** two queries in one run can't share an id; the Context Graph rejects the request with its own message, which fails every query in it.
- **Paging:** `totalCount` counts all matches. For the next page, raise `page`, or set `cursor` to the previous result's `next`, e.g. `"cursor": "{{ $json.next }}"`. The local dev-server hands out no cursors (`next` is always `null`), so use `page` there.
- **Errors:** an invalid query, such as a filter on a field the index doesn't allow, fails with the Context Graph's own message. The Context Graph then rejects the whole request, so with *Continue On Fail* every query in it comes out with `error`.
- **With an AI Agent:** the node can be an agent's tool. Click ✨ on *Query* to let the model write the query; it reads the field's description, which states the format above. Tell the agent which indexes and fields exist, in its prompt or the `$fromAI` description, or give it the output of *Schema › Get*.

### Index › Get

Reads one document from an index by its ID, one per input item, and outputs it exactly as returned.

- *Index Name* is a list of the indexes in the schema, or an expression.
- *Document ID* is the document's key in the index, its parts joined with colons (e.g. `ProductIndex:productId:p-1001`). Every match a query returns carries it as `$id`, and *Document ID* defaults to `{{ $json.$id }}`, so after *Index › Query* and a **Split Out** on `items`, Get reads each match.
- **Errors:** a document that doesn't exist fails with *No document … in index …*; the Context Graph answers a document the key may not see the same way. A blank *Index Name* or *Document ID* fails before anything is sent. With *Continue On Fail*, failed items come out as `{ indexName, documentId, error, description? }`.
- The local dev-server doesn't serve this read yet (it answers 404), so the Tonevik demo doesn't use it.

### Representation › Get

Reads the **representation** served for a route: one resource the schema composes from **slots** (shapes and queries), e.g. a product with its category and related products. *Route From* sets how the route is given:

| Route From | How |
|---|---|
| **Route** (default) | The *Route* field takes the route path, starting with `/`, e.g. `/products/42` (default `{{ $json.route }}`). |
| **Schema** | Pick the *Representation* and one of its *Routes* (e.g. `/products/{productId}`) from the schema. *Context* then lists the values that route takes, each marked with where it's sent. Map each to an expression, e.g. `{{ $json.productId }}`. |

With **Schema**, *Context* lists each route placeholder first (`productId (path)`), then any other context the schema lists (`locale (query)`, `market (header: X-Market)`). Path values fill the route and are required; the rest go in the query string or a header, as the schema declares, and an empty optional value is left out. A missing required value fails the item before anything is sent.

- **Output:** one route per item, one request per item. The representation comes out exactly as returned: each slot's value at the slot's name, plus `$metadata` with each slot's `$state`.
- **Check `$state`, not the status.** A representation where only some slots resolved still succeeds: an unresolved slot is `null`, with `$state` `missing` (or `deferred`/`pending` when the graph didn't resolve it in this response). A slot the key may not see has no entry at all.
- **Errors:** a route with no representation fails with *No representation for route …*, or with the Context Graph's own message: a route that matches none, a `required` slot that didn't resolve, or no slot resolved at all. An invalid request value fails with the Context Graph's message too.

### Schema › Get

Reads the manifest's schema and outputs it as one item, exactly as returned. Use it to see what the graph serves (indexes, representations, their routes and slots), or to hand the schema to an AI Agent or a Code node.

| Field | What it does |
|---|---|
| *Kind* | **Materialised Schema (MSD)**, the Context Graph's own schema document; **OpenAPI 3.1**; or **JSON Schema** 2020-12 |
| *Prefix* | Only the representations with a route under this path, e.g. `/products`. Empty for the whole schema. Indexes and the other parts are always included. |

- The schema belongs to the manifest, not to an item, so it's read **once per run**, with the first item's *Kind* and *Prefix*, however many items come in.
- **Errors:** a prefix no route falls under, or a kind or manifest version the Context Graph doesn't serve, fails with a message saying which. With *Continue On Fail* it comes out as `{ kind, prefix, error, description? }`.

### Common errors

On every Delivery read, a rejected key (401), an API version the Context Graph no longer serves (410) or an unreachable Delivery URL fails the run with a message saying which.

---

## Fields filled from the schema

Several Context Graph fields can be filled from the manifest's schema instead of typed in:

| Field | Operation |
|---|---|
| *Index* | Index › Get; Index › Query (Builder) |
| Filter fields, sort fields, operators | Index › Query (Builder) |
| *Representation*, *Route*, *Context* | Representation › Get (Schema) |
| *Shape*, *ID Segments* | Shape › Get (Schema), once the schema lists entry shapes |

**When the schema is read.** Only while you edit the node: n8n reads `GET {Delivery URL}/schema/msd/v1/{Manifest Version}` with the node's credential each time it fills one of these lists, e.g. when you open it, or when a field it depends on changes (picking another index reloads the filter fields). Nothing is cached between reads, so a list always shows the schema as it is now. A workflow **run never reads the schema** for these fields.

**What is saved.** Your choices are saved in the workflow like any other parameter, as plain text: the index, representation and route names, each filter and sort field with its type (`numeric:price`), and for *Context* both the values you mapped and the field list itself, with where each value goes (`path:productId`, `query:locale`, `header:X-Market`) and whether it's required. A run builds the request from what was saved, so it doesn't depend on the schema being reachable, and a workflow imported elsewhere runs as it was built.

**When the schema changes.** A saved workflow keeps sending what was saved. A renamed index or field then fails at run time with the Context Graph's own message, and a new required context value isn't sent until you add it. Open the node and pick again; for *Context*, refresh its field list, so the saved list matches the schema again.

**Expressions still work.** Every list also takes an expression, e.g. an index name from the incoming item. The node then sends what the expression gives, without checking it against the schema.

---

## Against the local dev-server

The Tonevik demo runs against the Context Graph SDK's local dev-server.

- **Credential:** set both URLs to the dev-server's address. From the Docker n8n in this repo that's `http://host.docker.internal:5200`, not `localhost`. The dev-server accepts any key, so put anything in both key fields; the credential test there checks only the URL and manifest version.
- **`scripts/setup.mjs`** creates the credential from `CONTEXT_GRAPH_INGEST_URL`, `CONTEXT_GRAPH_DELIVERY_URL`, `CONTEXT_GRAPH_INGEST_API_KEY`, `CONTEXT_GRAPH_DELIVERY_API_KEY` and `CONTEXT_GRAPH_MANIFEST_VERSION`, with dev-server defaults.

Where the dev-server differs from a deployed Context Graph:

| Area | Dev-server | Use instead |
|---|---|---|
| Index › Get | Not served (404) | Index › Query |
| Query paging | No cursors (`next` is always `null`) | `page` |
| Text filtering | Exact and in memory, not like Elasticsearch | Expect some queries to match differently in production |
| API keys | Not checked | — |
| Processing | A pushed record is processed at once, so a read straight after a push sees it | On a deployed graph, read again if it isn't there yet |
| A malformed shape key | `400` with a message (with Get Many, a `400` item) | A deployed graph answers `404`, as for any missing shape |

---

## Not built yet

The Context Graph serves these; the node doesn't use them yet.

- **Upload a source's complete export.** The Context Graph takes a snapshot as an artifact: reserve it, upload the file, commit it, and the graph drains it into the source. Push and Push Many are for records as they change, and Push Many isn't tuned for bulk (no batch-size setting, one request at a time), so use them for a full export only until Upload arrives.
- **Resuming a partly resolved representation.** A `207` carries `$metadata.$resume`, which a client sends back as `X-Resume` to get the slots still pending. Until the node does that, read the route again later.
- **Following `next` automatically** (Return All) on Index › Query. Use `page` or `cursor` yourself.
- **Retrying a busy Delivery.** Under load, Delivery refuses a read with `503` and says how long to wait. The node doesn't retry it yet, so the item fails; run it again.

## Not included (deliberately)

- **A bulk representation read.** Representations are read one route per request, the cacheable path the Context Graph serves.
- **A delivery policy header** (`X-Delivery-Policy`). The policy it sets is still a proposal. Under the default policy a representation's query slots come back `deferred`, with no items; to get those items, write the query yourself in Index › Query.
- **Reshaping records.** The node sends records and outputs answers as they are; reshape in a Code or Edit Fields node.
- **Protected shapes.** The node reads with an API key only and sends no context token, so a shape protected by an access policy always reads as `404`. Read protected content from an app that sends the customer's context token.

---

## Development

```bash
npm run build   # n8n-node build → dist/
npm run lint    # the rules n8n's verification scanner runs
npm test        # vitest
```

For local end-to-end runs in Docker n8n, see [CONTRIBUTING.md](CONTRIBUTING.md). How the package is built is in [ARCHITECTURE.md](ARCHITECTURE.md); conventions and rules for contributors and coding agents are in [AGENTS.md](AGENTS.md).

## Licence

MIT © Enterspeed A/S
