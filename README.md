# @enterspeed/n8n-nodes-enterspeed

[![CI](https://github.com/enterspeedhq/n8n-nodes-enterspeed/actions/workflows/ci.yml/badge.svg)](https://github.com/enterspeedhq/n8n-nodes-enterspeed/actions/workflows/ci.yml)

n8n community nodes for [Enterspeed](https://www.enterspeed.com) — get data **into** Enterspeed and feeds **out** of it, then wire it to any of n8n's 1,100+ destinations.

This package ships three nodes:

- **Enterspeed Core** (action) — Ingest, Delivery, Query and Routes operations.
- **Enterspeed Core Webhook Trigger** (push) — starts a workflow when a view is deployed or removed.
- **Enterspeed Context Graph** (action) — pushes workflow items into a Context Graph as source entities; see [Context Graph](#context-graph).

Before 0.2.0 these were labelled **Enterspeed**, **Enterspeed Webhook Trigger** and **Enterspeed API** (credential). Only the labels changed — the internal names (`enterspeed`, `enterspeedTrigger`, `enterspeedApi`) are the same, so existing workflows and credentials need no action. Nodes already in a workflow keep their names.

No keys are bundled. The customer enters their own Enterspeed credentials at runtime.

## Installation

In n8n: **Settings → Community Nodes → Install** and enter `@enterspeed/n8n-nodes-enterspeed`.

Self-hosted via npm:

```bash
npm install @enterspeed/n8n-nodes-enterspeed
```

## Credentials

Create an **Enterspeed Core API** credential with:

| Field | Where to get it | Used by |
|---|---|---|
| Environment API Key | Settings → Environment settings | Delivery, Query, Routes |
| Source API Key | Settings → Data sources | Ingest |
| Hosts | pre-filled with public endpoints | override for dedicated tenants |

## Operations

**Entity (Ingest)** — `POST/DELETE https://api.enterspeed.com/ingest/v2/{originId}` or `/ingest/v2` (bulk)
- *Save*: requires Origin ID, Entity Type (immutable after first ingest) and a JSON body.
- *Delete*: requires Origin ID.
- *Save Entities (Bulk)*: POST a JSON array of up to 50 entities (no path params).
- *Delete Entities (Bulk)*: DELETE with `{ "originIds": [...] }` body of up to 50 origin IDs.
- *Delete* and *Delete Entities (Bulk)* output always includes `deleted: true`, merged on top of whatever the Ingest API returned.

**Delivery — Get Content** — `GET https://delivery.enterspeed.com/v2`
- Fetch by URL, comma-separated view IDs, and/or handles.

**Query — Query Index** — `POST https://query.enterspeed.com/v1/{indexAlias}`
- Pass a JSON body with `filters`, `sort`, `pagination`, `facets` (all optional).

**Route — Get Many** — `GET https://api.enterspeed.com/routes/v2`
- Paginated via the `X-Continuation-Token` header. Leave Continuation Token empty for the first page, then feed the response's `continuationToken` back in to fetch subsequent pages.

## Webhook trigger (views)

Enterspeed pushes a webhook whenever a **view** is deployed (published/updated) or
removed (deleted). Configure the webhook manually in Enterspeed, pointing it at this
node's production URL, and optionally set an **access key** (the node verifies it
against the `X-Api-Key` header and rejects mismatches with 403).

Enterspeed POSTs a lightweight notification — not the full view:

```jsonc
{
  "Id": "<view id>",
  "OriginId": "<source entity id>",
  "Type": "<view handle>",
  "Action": "Deploy" | "Remove",
  "Url": "<absolute Delivery API URL>"   // present only on Deploy
}
```

With *Fetch Full View* enabled (default), the node fetches the view from that `Url`
using the Environment API Key and attaches it as `view`. Removals carry no `Url`, so
nothing is fetched. Use *Actions* to react to only deploys, only removals, or both.

Routes and indices do **not** emit webhooks — use the polling workflow below for those.

## Polling for changes (indices)

There is no polling node — indices are watched by combining native n8n nodes
with the **Query** operation above: a Schedule Trigger runs the Query on an
interval, and a Code node compares each result against what was seen last
time (kept in the workflow's static data), emitting only items that are new
or changed. The first run sets a baseline (no flood) unless *Emit On First
Poll* is enabled; change detection uses a configurable marker field (e.g.
`updatedAt`) and ID field. See the
[`poll-index-for-changes`](workflows/templates/poll-index-for-changes.json)
example workflow.

## Context Graph

The **Enterspeed Context Graph** node uses its own **Enterspeed Context Graph API** credential, so it can't be run with an Enterspeed Core key by mistake.

| Field | Used for |
|---|---|
| API Key | Sent as the `X-Api-Key` header on every call |
| Ingest URL | Uploads (pre-filled with `https://api.enterspeed.com`, as in the Core credential) |
| Delivery URL | Reads (pre-filled with `https://delivery.enterspeed.com`, as in the Core credential) |
| Manifest Version | The `{manifest}` segment of every Delivery route (default `1.0.0`) |

Testing the credential reads `GET {Delivery URL}/schema/msd/v1/{Manifest Version}`. It fails with a clear message if the URL can't be reached, the key is rejected (401) or the manifest version isn't hosted (404).

**Entity — Push** — `POST {Ingest URL}/entities`

Push sends records as they change. Each input item **is** the record, and Push sends it to the Context Graph as it is. A Context Graph record looks like this:

| Field | | What it is |
|---|---|---|
| `$id` | required, text | The source system's own record key: unique within the source and the same every time the record is sent. It is not a domain field like `id` — the graph keeps both, and `$id` is what links the entity back to the record it came from. |
| `$type` | required, text | The entity type. |
| `$source` | optional | The source the record belongs to. When it's left out, the Context Graph takes it from the API key; the local dev-server can't, and rejects the record. |
| `$action` | optional | `delete` (in any letter case) removes the entity; anything else saves the record. |
| `$modifiedAt` | optional | When the record last changed in the source (ISO 8601 with an offset). Saves and deletes to an entity are applied in this order, so an older write that arrives late doesn't overwrite a newer one. In production, sources are expected to send it: a record without one is applied, but a later upload of the source's export can overwrite it. |
| anything else | | The entity's properties, stored exactly as sent. A save replaces the whole stored record. |

Push has one field per `$` field — *Entity ID*, *Entity Type*, *Source*, *Action* and *Modified At* — each defaulting to the record's own (`{{ $json.$id }}` and so on). Records that already have these fields need no setup; change a field only to take the value from somewhere else, e.g. *Action* `{{ $json.deleted ? 'delete' : '' }}`. Values are sent as given, never converted or trimmed: an ID that isn't text is reported as failed.

If the source's records need more than that — renamed fields, transformed values, another format — reshape them in a **Code** or **Edit Fields** node before Push:

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

- A delete sends only `$id`, `$type`, `$source` and `$modifiedAt`.
- Push is not for bulk loads; a source's complete export goes in as an upload (coming in a later release). A run is sent in as few requests as fit under the Context Graph's 32 MiB request limit; a single record too large for one request is reported as failed.
- Outputs one result per item — `{ id, type, source, action, accepted, statusCode, error? }`. A rejected record, or one without a valid ID or type, comes out with `accepted: false` and the reason; the rest are still stored. `accepted: true` also covers a record whose content was unchanged, and one superseded by a newer *Modified At* — both are accepted with nothing written.
- When the Context Graph is busy it refuses a request with `429` and says how long to wait. The node waits that long and resends the refused request, up to 3 times (nothing was written when it was refused). If it is still refused, or asked to wait more than five minutes, the run fails.
- A rejected key (401), a key without write access (403), a request that is too large (413), continued throttling (429) or an unreachable Ingest URL fails the run with a message saying which. With *Continue On Fail*, the affected records come out with `error` and `description` instead.

**New to the Context Graph?** Follow the step-by-step guide, [docs/context-graph-demo/GUIDE.md](docs/context-graph-demo/GUIDE.md): it builds the Tonevik demo shop with the workflow `workflows/templates/Context-Graph-Tonevik-Demo.json` against the local dev-server.

**Against the local dev-server**, set both URLs to the dev-server's address. From the Docker n8n in this repo that is `http://host.docker.internal:5200`, not `localhost`. The dev-server accepts any API key, so the credential test there checks only the URL and manifest version.

## Typical flows

- **Ingest**: Source (PIM/CMS/ERP) → map → **Enterspeed Core: Save Entity**.
- **Delivery / last mile**: **Poll Index for Changes** → map to feed (XML/CSV) → push to Google / Meta / marketplace.

## Licence

MIT © Enterspeed A/S
