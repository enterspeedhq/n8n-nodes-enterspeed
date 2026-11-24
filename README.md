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
| [Artifact › Upload](#artifact--upload) | `POST {Ingest URL}/v1/sources/{Source}/artifacts`, the file to its signed URL, then `…/{id}/commit` | One export file per item |
| [Artifact › Get](#artifact--get-get-many-and-get-lines) | `GET {Ingest URL}/v1/sources/{Source}/artifacts/{Artifact ID}` | One artifact per item |
| [Artifact › Get Many](#artifact--get-get-many-and-get-lines) | `GET {Ingest URL}/v1/sources/{Source}/artifacts` | One source's listing per item |
| [Artifact › Get Lines](#artifact--get-get-many-and-get-lines) | `GET {Ingest URL}/v1/sources/{Source}/artifacts/{Artifact ID}?after=…` | One artifact's refused lines per item |
| [Entity › Push](#entity--push-and-push-many) | `POST {Ingest URL}/v1/entities` | One record per item, one request per item |
| [Entity › Push Many](#entity--push-and-push-many) | `POST {Ingest URL}/v1/entities` | One item holding a list, one request |
| [Shape › Get](#shape--get-and-get-many) | `GET {Delivery URL}/shapes/v1/{Manifest Version}/{key}` | One key per item |
| [Shape › Get Many](#shape--get-and-get-many) | `POST {Delivery URL}/shapes/v1/{Manifest Version}` | One item holding a list of keys, one request |
| [Index › Query](#index--query) | `POST {Delivery URL}/query/v1/{Manifest Version}` | One query per item, all in one request (several only past the 32 KiB request limit); Return All follows `next` |
| [Index › Get](#index--get) | `GET {Delivery URL}/query/v1/{Manifest Version}/{Index Name}/{Document ID}` | One document per item |
| [Representation › Get](#representation--get) | `GET {Delivery URL}/v1/{Manifest Version}{Route}` | One route per item |
| [Schema › Get](#schema--get) | `GET {Delivery URL}/schema/{Kind}/v1/{Manifest Version}[/{Prefix}]` | Once per run |

Every operation outputs the Context Graph's answer exactly as it was returned; the node never reshapes records on the way in or answers on the way out. The one exception is opt-in: Representation › Get's *Include Response Headers* wraps the answer as `{ status, headers, body }`, and a `304` to its *If-None-Match* comes out as a stand-in, since it has no body. With *Continue On Fail*, a failed item comes out with `error` and, when there is one, `description`, next to what identifies it (its key, route, query or record).

### Artifact › Upload

Uploads a source's **complete export**, the file its system already produces, as it is. Use it on a schedule for the whole source; use Entity › Push for records as they change. The source must be a **snapshot** source: a push source refuses an upload.

| Field | What it is |
|---|---|
| *Source* | The source's alias, e.g. `pim` |
| *Input Binary Field* | The input item's binary field holding the file (default `data`), e.g. from an HTTP Request, Read Files or Convert to File node. The file is sent as it is: never parsed, mapped or converted. |
| *Content Type* | **NDJSON** (one record per line, keyed by its own `$id` and `$type` unless the source has a field map) or **CSV** (read through the source's field map; every value arrives as text). Set it here: n8n often labels `.ndjson` files `application/octet-stream`. |
| *As Of* | When the export **started** in the source, as ISO 8601 with an offset, e.g. `2026-11-19T02:00:00Z`. Not when the file was fetched or uploaded: every row is ordered at this time against pushes, so a push made after the export started still wins. Each upload must be later than the last one committed, and no more than five minutes ahead. |
| *Row Count* | How many records the source exported: CSV rows after the header, or NDJSON lines that aren't blank. Take it from the source system, not from counting the file. A count that differs from the file is how a cut-off file is caught: its content still lands, but it deletes nothing. |

What the node does, per item:

1. Computes the file's SHA-256.
2. **Reserves** the upload with *As Of*, *Row Count*, the content type and the hash, using the Ingest API Key.
3. **Uploads** the file to the signed storage URL the reservation answers, with exactly the headers it names. This request carries **no API key**: the URL itself grants access to that one file.
4. **Commits** it, and outputs the artifact exactly as returned (`id`, `state`, …), paired to the item.

- **Running it again is safe.** The same file with the same *As Of* is recognised as a retry: an export already committed comes back as it is, with nothing sent again. Different bytes with the same *As Of* are refused; a corrected file is a new export with a later *As Of*.
- **What happens next.** The Context Graph drains the file into the source after the commit; on a deployed graph that can take a while (a 4-hour target), and the output's `state` is `committed` until then. The first complete upload is the source's **seed** and deletes nothing. A later one deletes the records it leaves out only if the source declares a cycle, and a large set of deletions waits for a person to release it. The local dev-server drains at once, so `state` is already `drained`.
- **Size limit: under 2 GB.** The file is held in memory while it is sent, so it must be under 2 GB, which is also the Context Graph's limit, and n8n needs that much memory free. A file of 2 GiB or more fails the item before anything is sent. In queue mode n8n keeps binary data in its database, which caps a file at 512 MiB by default (`N8N_BINARY_DATA_DATABASE_MAX_FILE_SIZE`, at most 1 GiB). The node shows the limit in its notice.
- **From Docker n8n against the local Context Graph stack:** the stack's storage signs the upload URL for `localhost`, which inside the n8n container is the container itself, so the upload can't reach it. Run n8n on the host network there, or publish the storage endpoint under a name the container can reach. The SDK dev-server doesn't have this problem (see [Against the local dev-server](#against-the-local-dev-server)).
- **Errors:** a refusal fails the item with the Context Graph's own title and reason, e.g. *A push source takes no artifacts. (push-source)*, *asOf is not later than the source's latest artifact. (as-of-not-later)* or *A CSV artifact needs a field map. (field-map-required)*, with the explanation as its description. An item with no file, *Source*, *As Of* or *Row Count* fails before anything is sent. A failed upload names the storage host only, never the signed URL. With *Continue On Fail* it comes out as `{ source, asOf, error, description? }`.

### Artifact › Get, Get Many and Get Lines

Read what became of an upload, with the Ingest API Key. The node doesn't wait for a drain: on a deployed graph it can take hours (a 4-hour target), so a scheduled workflow waits with n8n's **Wait** node, e.g. *Upload → Wait → Artifact › Get → IF `state` is `drained`*.

- **Get** reads one artifact per item (*Source*, *Artifact ID*, which defaults to the item's `id`, so it follows an Upload directly) and outputs it as returned: `state`, and once committed its `drain` (counts by outcome), `deletions`, and the first page of `lines` with `nextAfter`.
- **Get Many** lists a source's artifacts, newest reservation first, one item per artifact as returned. *State* keeps only artifacts in that state (`reserved`, `committed`, `superseded`, `draining`, `drained`, `failed`, `expired`). *Return All* follows `nextCursor`, sending the same state each time; otherwise up to *Limit* (1–200, default 50). A listing never carries the signed upload URL, nor lines.
- **Get Lines** outputs each record of one artifact that didn't land (refused, failed or unparseable) as its own item, `{ number, outcome, type, id, reason }` as returned. *Return All* follows `nextAfter` to the end; otherwise it stops at *Limit*. The Context Graph pages 1,000 at a time; that isn't a setting. An artifact not committed yet has no lines and outputs nothing.
- **Errors:** an *Artifact ID* that isn't a GUID fails the item before anything is sent. An unknown source or artifact fails the item as *not-found*, an invalid state or cursor as *invalid-listing*, a missing or rejected key as `401`, a key without write scope, or one whose scope leaves the source out, as `403`. With *Continue On Fail* it comes out as `{ source, id?, error, description? }`.

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
- **Not for a complete export.** A source's full export goes in with [Artifact › Upload](#artifact--upload).
- **Request size:** Push Many splits a list into more requests only to stay under the Context Graph's request limit (32 MiB; the node closes a request before 29,000,000 bytes); a single record too large for one request is reported as failed. Push Many fails an item whose *Records* isn't a list.
- **Throttling:** when the Context Graph is busy it refuses a request with `429` and a `Retry-After` in seconds, and nothing is written. The node waits that long and resends the refused request, up to 3 times (nothing was written when it was refused). If it's still refused, or asked to wait more than five minutes, the run fails.
- **Errors:** a rejected key (401), a key without write access (403), a request that's too large (413), continued throttling (429) or an unreachable Ingest URL fails the run with a message saying which.

### Shape › Get and Get Many

Both read the graph's **shapes**, the views its schema declares over the data, by **shape key**: the shape's name, then each ID segment's name and value, joined with colons: `productPage:id:42`, or with two segments `productVariant:productId:42:sku:SKU-9`. The values are the record's own data (its `id`, say), not its `$id`.

- **Get Many** is the one to use for a list of keys. It takes one item holding the list in *Shape Keys* (default `{{ $json.keys }}`, e.g. built in a Code node: `return [{ json: { keys: [...] } }]`), sends the whole list in one request (several only past the 32 KiB request limit) and outputs one item per key, in list order: `{ key, status, data }` exactly as returned. A key with no shape comes out as `status: 404` with `data: null`, and the other keys still return. The request succeeds even when no key is found, so check each item's `status`. With no keys, nothing is sent; an item whose *Shape Keys* isn't a list fails.
- **Get** is for a workflow that handles one key at a time, such as a lookup triggered by a webhook. It takes one *Shape Key* per item and outputs the shape exactly as returned. A key with no shape fails with *No shape for key …*.
- **Who can see a shape:** a shape whose access policy needs a claim always comes back as `404`, the same as a shape that doesn't exist. The node sends no claims, and the Context Graph deliberately doesn't tell "missing" from "not allowed".
- **Errors:** a key that names no shape, malformed or not, is a `404` like any missing shape, and so is a key whose shape the schema doesn't declare. A rejected key (401), an API version the Context Graph no longer serves (410) or an unreachable Delivery URL fails the run with a message saying which.
- **Key From › Schema** (*Get* only) will let you pick the shape and fill in each ID segment instead of typing the key. The schema doesn't list entry shapes yet, so the list says *This schema lists no shapes*; use *Shape Key* until it does.

### Index › Query

Finds documents in an **index** the schema declares, with filters, sorting and paging. *Query From* sets how the query is given:

| Query From | How |
|---|---|
| **JSON** (default) | The *Query* field takes the query as a JSON object, sent as written. It starts with a working example to edit. |
| **Builder** | Pick the *Index* from the schema (see [Fields filled from the schema](#fields-filled-from-the-schema)), then add *Search* text, *Filters* (field, operator, value) and *Sort* (field, Ascending/Descending, sent as `direction` `asc`/`desc`), with *Results Per Page* (1 to 100, the Context Graph's maximum), *Page* (hidden under *Return All*) and an optional *Query ID*. |

In the Builder, the field lists show only the fields the chosen index can filter on, and the operators the schema lists. *Sort* offers only the fields the schema lists as sortable for the index, as delivery refuses a sort on any other field; when the index lists none, the list says *This index lists no sortable fields*. Filters are all combined with `and`; for `or` or nesting, use JSON. A value is sent as the field's type: a number for a numeric field, `true`/`false` for a boolean one, text otherwise. For `in`, separate the values with commas. Aggregations, `cursor` and `args` are JSON-only.

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

- **Output:** each input item is one query. All items' queries are sent in one request, or in several when they'd pass the Context Graph's 32 KiB request limit, and each item gets back its result exactly as returned: `{ id, index, items, totalCount, next }`. A query that matches nothing returns `items: []`; it doesn't fail.
- **Ids:** a query's `id` is its own, else its position among the queries sent. When the queries are split, the node sends that position as the query's `id`, so each result still finds its item. Two queries in one run can't share an id: in one request the Context Graph rejects it with its own message, and in a split run the node refuses it before sending; either way every query fails. A single query over the limit fails before anything is sent.
- **Paging:** `totalCount` counts all matches. For the next page, raise `page`, or set `cursor` to the previous result's `next`, e.g. `"cursor": "{{ $json.next }}"`. A full page has a `next` even when it holds the last matches; the page after it is then empty, with `next: null`. A `semantic` or `hybrid` query never has a `next`: a `semantic` one pages with `page` (only its first page on an index with more than one semantic field), and a `hybrid` one serves only its first page.
- **Return All** (off by default) fetches every page: the node sends each query again with `cursor` set to its last `next` until `next` is `null`, in rounds that hold only the queries still going, each with its `id`, split at the request limit the same way. Each item still gets one result: its first page's `id`, `index`, `totalCount` (and any `aggregations`), with every page's matches in `items` and `next: null`. *Results Per Page* or `limit` sets the size of each page, not a total. A query that sets `page` (other than 0) fails before sending, as `page` and `cursor` are two ways of paging; a query's own `cursor` is where it starts. If the Context Graph hands back a `next` it has already been sent for that query, the query fails rather than loop. A failed round fails the queries in it, with *Continue On Fail* as for the first request; queries that already finished keep their result.
- **Errors:** an invalid query, such as a filter on a field the index doesn't allow, fails with the Context Graph's own message. The Context Graph then rejects the whole request, so with *Continue On Fail* every query in it comes out with `error`. When search can't answer, the Context Graph answers `503` and the node retries once (see *Common errors*); if it still can't, the request fails as busy, with the Context Graph's own reason, e.g. *Search could not answer this batch…*, as the description. A `500` means a retry would fail the same way, and fails with the Context Graph's own message.
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
| **Route** (default) | The *Route* field takes the route path, starting with `/`, e.g. `/products/42` (default `{{ $json.route }}`). Only the path: a route with `?` or `#` fails before anything is sent. To send query or header values, use **Schema**. |
| **Schema** | Pick the *Representation* and one of its *Routes* (e.g. `/products/{productId}`) from the schema. *Context* then lists the values that route takes, each marked with where it's sent. Map each to an expression, e.g. `{{ $json.productId }}`. |

With **Schema**, *Context* lists each route placeholder first (`productId (path)`), then any other context the schema lists (`locale (query)`, `market (header: X-Delivery-market)`). Path values fill the route and are required; the rest go in the query string or a header, as the schema declares (a header value is sent as `X-Delivery-<name>`, the header the Context Graph reads), and an empty optional value is left out. A missing required value fails the item before anything is sent.

- **Output:** one route per item, one request per item. The representation comes out exactly as returned: each slot's value at the slot's name, plus `$metadata` with each slot's `$state`.
- **Check `$state`, not the status.** A representation where only some slots resolved still succeeds: an unresolved slot is `null`, with `$state` `missing` (not there), `pending` (not resolved in time) or `deferred` (held back on purpose, e.g. a slot that needs a claim). The node sends no claims, so a slot gated by a claim has no entry at all, and a route gated by one answers `404`.
- **One read resolves everything it can.** The node sends no delivery policy header, so the Context Graph resolves the whole representation in the one read, query slots included, within a time limit and a limit on query passes. An answer cut short by either is partial: the slots it didn't finish are left open and `$metadata.$resume` carries a checkpoint.
- **Errors:** a route with no representation fails with *No representation for route …*, or with the Context Graph's own message: a route that matches none, a `required` slot that didn't resolve, or no slot resolved at all. An invalid request value fails with the Context Graph's message too.

**Resume Partial Answers** (off by default) completes a partial answer in the same run. When an answer carries `$metadata.$resume`, the node reads the same route again with that checkpoint in `X-Resume`, repeating the query string and headers, and merges what comes back into the answer by slot name. Each item still gives one output item.

| Field | What it does |
|---|---|
| *Max Rounds* | How many resume requests to send at most per item (default 3). At the limit the item is output as it is: each still-open slot's `$state` says so, and `$metadata.$resume` holds the latest checkpoint. |
| *Max Wait Between Rounds (Ms)* | Before a round the node waits for the largest `$timeoutMs` among the open slots, up to this (default 5000). A `deferred` slot carries no `$timeoutMs`, so it's resumed at once. |

- **What resumes:** slots whose `$state` is `pending` or `deferred`. The node sends no context token, so a slot whose `$requires` names a claim is left as it is; if no other slot is open, no round is sent.
- **What a round resolves:** a round also sends no policy header, so the Context Graph tries to resolve every open slot, query slots included. A slot it still can't finish stays open, and at *Max Rounds* the item is output as it stands.
- **The merge:** a resume round answers only the slots that were open; each replaces its slot and its `$metadata` entry. `$metadata.$changedAt` is the newest across rounds.
- **A refused checkpoint** (`401` *invalid_checkpoint*, `410` *checkpoint_expired*, or `409` for another manifest or route) is answered once by reading the route again without it; that fresh answer replaces the rounds so far. Refused a second time, the item fails. A `404` on a resume round fails the item, as on the first read.

**Skipping unchanged representations.** A complete answer (status `200`) carries a weak `ETag`. Keep it, send it back on the next run, and an unchanged representation answers `304 Not Modified` with no body, so a scheduled workflow processes only what changed. Both fields are off by default, and then the output is as described above.

| Field | What it does |
|---|---|
| *If-None-Match* | An expression for the ETag kept from the last run, e.g. `{{ $json.etag }}`, sent as the `If-None-Match` header (a comma-separated list or `*` also works). Empty sends nothing. |
| *Include Response Headers* | Outputs each item as `{ status, headers, body }`, where `headers` holds whichever of `ETag`, `Cache-Control`, `Cache-Tag` and `Vary` the Context Graph sent: the shape the Context Graph MCP server's `includeHeaders` returns. |

- **Not modified:** a `304` succeeds. With *Include Response Headers* it comes out as `{ status: 304, headers, body: null }`, otherwise as `{ notModified: true }`. Drop those items with an **IF** node.
- **No ETag, no `304`:** a partial answer, a resume round and an error carry no `ETag`, and the node doesn't add one. With *Continue On Fail* a failed item keeps its `{ route, error }` shape, without `status` or `headers`. With *Resume Partial Answers*, *If-None-Match* goes only on the first read of the route, and `status` and `headers` are those of the last response read.
- **Keeping the ETag between runs** is the workflow's job: store `headers.ETag` per route in an n8n **Data Table**, and read it back before Representation › Get. Workflow static data isn't saved by manual runs.
- **Store the tag from the server you read.** Each deployed Context Graph keys its tags, and the dev-server's never match a deployed one's.

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

**A busy Delivery (503).** Under load, or while one of its stores is down, Delivery refuses a read with `503` and says how long to wait (`X-Delivery-Retry-After-Ms`, or `Retry-After` in seconds). Shape › Get and Get Many, Index › Query and Get, and Representation › Get (resume rounds included) wait that long plus a little at random (under half the wait, and under a second), then send the same request once more. Schema › Get doesn't retry. If Delivery is still busy, or asked for a wait over 30 seconds, or gave none, the item fails with a message saying Delivery is busy; with *Continue On Fail* it comes out with `error`. Run it again later.

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

**What is saved.** Your choices are saved in the workflow like any other parameter, as plain text: the index, representation and route names, each filter and sort field with its type (`numeric:price`), and for *Context* both the values you mapped and the field list itself, with where each value goes (`path:productId`, `query:locale`, `header:market`) and whether it's required. A run builds the request from what was saved, so it doesn't depend on the schema being reachable, and a workflow imported elsewhere runs as it was built.

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
| Query paging | Run from the Context Graph SDK's `master`, both tiers hand out a real `next`, as delivery does. `@enterspeed/dev-server@0.2.0-alpha.3` and earlier answer `next: null` on the default in-memory tier, so Return All reads one page there | `page`, on those versions |
| Text filtering | Exact and in memory, not like Elasticsearch | Expect some queries to match differently in production |
| API keys | Not checked | — |
| Processing | A pushed record is processed at once, so a read straight after a push sees it | On a deployed graph, read again if it isn't there yet |
| Partial representations | Only for a slot the server's `budgetCut` option names. Tonevik's representations are never partial | Start a dev-server with `budgetCut` to try Resume Partial Answers |
| Entity › Push, Artifact | The node sends ingest's `/v1` routes. `@enterspeed/dev-server@0.2.0-alpha.3`, the current published `alpha`, still serves only the unversioned ones and answers `404`, so use the next alpha, or run the dev-server from the Context Graph SDK's `master` (the Tonevik demo does). `latest` (0.2.0-alpha.0) has no upload. A source takes uploads only when the server declares it a snapshot source (`createDevServer(schema, { sources: { pim: { mode: "snapshot" } } })`); Tonevik declares none. The file drains at commit, so `state` is `drained` at once, and Get, Get Many and Get Lines read it straight after. An unknown source lists as empty rather than `not-found`. No size limit, URL expiry or key check, and the upload URL names no headers. It signs the upload URL with the request's host, so `host.docker.internal` works from Docker n8n | — |

---

## Not built yet

The Context Graph serves these; the node doesn't use them yet.

- **Releasing or discarding held deletions**, and reading a source's mirror status.
- **Uploading in blocks.** Artifact › Upload sends the file in one request, so a failed transfer starts again.

## Not included (deliberately)

- **A bulk representation read.** Representations are read one route per request, the cacheable path the Context Graph serves.
- **A delivery policy header** (`X-Delivery-Policy`). Without it the Context Graph resolves the whole representation in one read, which is what a workflow needs. Its one other policy, `progressive`, is for a website that shows the page first and fills in the rest: query slots come back `deferred` for the client to resume.
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
