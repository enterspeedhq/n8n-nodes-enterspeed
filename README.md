# n8n-nodes-enterspeed

[![CI](https://github.com/enterspeedhq/n8n-nodes-enterspeed/actions/workflows/ci.yml/badge.svg)](https://github.com/enterspeedhq/n8n-nodes-enterspeed/actions/workflows/ci.yml)

n8n community nodes for [Enterspeed](https://www.enterspeed.com) — get data **into** Enterspeed and feeds **out** of it, then wire it to any of n8n's 1,100+ destinations.

This package ships two nodes:

- **Enterspeed** (action) — Ingest, Delivery, Query and Routes operations.
- **Enterspeed Webhook Trigger** (push) — starts a workflow when a view is deployed or removed.

No keys are bundled. The customer enters their own Enterspeed credentials at runtime.

## Installation

In n8n: **Settings → Community Nodes → Install** and enter `n8n-nodes-enterspeed`.

Self-hosted via npm:

```bash
npm install n8n-nodes-enterspeed
```

## Credentials

Create an **Enterspeed API** credential with:

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

## Typical flows

- **Ingest**: Source (PIM/CMS/ERP) → map → **Enterspeed: Save Entity**.
- **Delivery / last mile**: **Poll Index for Changes** → map to feed (XML/CSV) → push to Google / Meta / marketplace.

## Licence

MIT © Enterspeed A/S
