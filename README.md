# n8n-nodes-enterspeed

n8n community nodes for [Enterspeed](https://www.enterspeed.com) — get data **into** Enterspeed and feeds **out** of it, then wire it to any of n8n's 1,100+ destinations.

This package ships two nodes:

- **Enterspeed** (action) — Ingest, Delivery, Query and Routes operations.
- **Enterspeed Trigger** (polling) — starts a workflow when items in an index change.

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

**Entity (Ingest)** — `POST/DELETE https://api.enterspeed.com/ingest/v2/{originId}`
- *Save*: requires Origin ID, Entity Type (immutable after first ingest) and a JSON body.
- *Delete*: requires Origin ID.

**Delivery — Get Content** — `GET https://delivery.enterspeed.com/v2`
- Fetch by URL, comma-separated view IDs, and/or handles.

**Query — Query Index** — `POST https://query.enterspeed.com/v1/{indexAlias}`
- Pass a JSON body with `filters`, `sort`, `pagination`, `facets` (all optional).

**Route — Get Many** — `GET https://api.enterspeed.com/routes/v1`
- Page size 100–500.

## Trigger (polling)

Enterspeed builds views at publish time and does not push outbound webhooks, so
the trigger polls a Query index on a schedule and emits items that are new or
changed since the last run. The first run sets a baseline (no flood) unless
*Emit On First Poll* is enabled. Change detection uses a configurable marker
field (e.g. `updatedAt`) and ID field.

## Typical flows

- **Ingest**: Source (PIM/CMS/ERP) → map → **Enterspeed: Save Entity**.
- **Delivery / last mile**: **Enterspeed Trigger** → map to feed (XML/CSV) → push to Google / Meta / marketplace.

## Build from source

```bash
npm install
npm run build      # tsc + copies icons to dist
npm run lint       # n8n community-node linter
```

## Status & next steps

Starter implementation, verified against the public Enterspeed OpenAPI spec
(v0.4.0). Before publishing: run in a local n8n against a real tenant, run
`npm run lint`, then `npm publish` and submit for n8n's verified-node program.

## Licence

MIT © Enterspeed A/S
