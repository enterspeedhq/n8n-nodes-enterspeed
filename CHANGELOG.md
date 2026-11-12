# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Enterspeed Context Graph** node and **Enterspeed Context Graph API** credential (ingest URL and Ingest API Key, delivery URL and Delivery API Key, manifest version). Each key is sent only to its own service. Neither URL has a default, so a Context Graph key never goes to an Enterspeed Core host. The credential test reads the manifest document from the Delivery URL with the Delivery API Key. **Entity — Push** sends each input item, as the record it is, to the Context Graph (`POST {Ingest URL}/entities`), one request per item. Entity ID, Entity Type, Source, Action and Modified At set the record's `$id`, `$type`, `$source`, `$action` and `$modifiedAt`, each defaulting to the record's own. **Entity — Push Many** sends a list of records held in one item (e.g. from an Aggregate node) in one request; each record keeps its own `$` fields. Both output one accepted/rejected result per record.
- **Enterspeed Context Graph — Shape — Get / Get Many**: read the graph's shapes by shape key (e.g. `productPage:id:42`). *Get* takes one key per item and reads one shape per request (`GET {Delivery URL}/shapes/v1/{Manifest Version}/…`), outputting it as returned; a key with no shape fails the item. *Get Many* takes one item holding a list of keys (e.g. built in a Code node) and reads them in one request (`POST {Delivery URL}/shapes/v1/{Manifest Version}`), outputting `{ key, status, data }` per key, with a missing key as `status: 404`, `data: null`. The Tonevik demo workflow and guide now read back each step's shapes.
- **Enterspeed Context Graph — Index — Query**: query an index with filters, sorting and paging (`POST {Delivery URL}/query/v1/{Manifest Version}`). Each input item is one query; all are sent in one request, and each item gets back its result as returned (`{ id, index, items, totalCount, next }`). The Tonevik demo gains step 4, querying the product index.
- **Enterspeed Context Graph — Index — Get**: read one document from an index by its ID (`GET {Delivery URL}/query/v1/{Manifest Version}/{Index Name}/{Document ID}`), one per item, outputting it as returned. Document ID defaults to the item's `$id`, so a query's matches can be read one by one. A missing document fails the item. The SDK dev-server doesn't serve this read yet.
- **Enterspeed Context Graph — Representation — Get**: read the representation served for a route (e.g. `/products/42`), one route per item and one request each (`GET {Delivery URL}/v1/{Manifest Version}{Route}`). Outputs the representation as returned: each slot at its name, plus `$metadata` with each slot's `$state`. A partly resolved representation succeeds, with the unresolved slots `null`; a route with no representation fails the item. The Tonevik demo gains step 5, reading the product representation.
- **Enterspeed Context Graph — Schema — Get**: read the manifest's schema (`GET {Delivery URL}/schema/{Kind}/v1/{Manifest Version}`) as the materialised schema (MSD), OpenAPI 3.1 or JSON Schema, optionally only the routes under a prefix. Read once per run and output as one item.
- **Enterspeed Context Graph — fields filled from the schema**: Index — Get and Index — Query's new *Builder* mode pick the index, filter and sort fields and operators from the manifest's schema; Representation — Get's new *Schema* mode picks the representation and route and lists the context values it takes (path, query string or header). The schema is read only while the node is edited; the choices are saved in the workflow, so runs don't read it. The JSON query and the *Route* field remain the defaults. Shape — Get's *Schema* mode waits on the schema listing entry shapes.
- **Context Graph: Tonevik demo** example workflow (`workflows/templates/Context-Graph-Tonevik-Demo.json`): the Tonevik demo shop's PIM categories, products and a retired product, pushed step by step with Push Many against the local dev-server, with a guide (`docs/context-graph-demo/GUIDE.md`). `scripts/setup.mjs` now creates an Enterspeed Context Graph credential (local dev-server by default).

### Changed

- **Enterspeed Context Graph — Index — Query** sends a sort as `direction` `asc`/`desc`, the form the Context Graph's query contract names, in the Builder, the JSON example and the Tonevik demo. A Builder sort saved as Ascending/Descending is sent the same way. The Sort field now says only fields the index declares sortable can be sorted on.
- The action node, trigger and credential are now labelled **Enterspeed Core**, **Enterspeed Core Webhook Trigger** and **Enterspeed Core API** (previously **Enterspeed**, **Enterspeed Webhook Trigger** and **Enterspeed API**), to tell them apart from the upcoming Enterspeed Context Graph node. Newly added nodes get the default name "Enterspeed Core". Only display names changed — the internal names `enterspeed`, `enterspeedTrigger` and `enterspeedApi` are unchanged, so existing workflows and credentials need no action and existing nodes keep their names.

## [0.1.1] — 2026-08-17

### Added

- Example workflow: Contentful → Enterspeed ingestion (`workflows/templates/ingest-contentful-into-enterspeed.json`), syncing entry and asset publish/unpublish/delete events across locales.
- Automated npm publishing via GitHub Actions (`.github/workflows/publish.yml`) with npm provenance, ahead of n8n's 1 May 2026 requirement for verified community nodes.
- **Enterspeed** node is now usable as an AI agent tool (`usableAsTool: true`), so agents can invoke Ingest/Delivery/Query/Route operations directly.

### Changed

- **Breaking:** package renamed from `n8n-nodes-enterspeed` to the scoped `@enterspeed/n8n-nodes-enterspeed`. Update the install command (`npm install @enterspeed/n8n-nodes-enterspeed`) and the Community Nodes package name in n8n's UI accordingly.
- `workflows/templates/fetch-transform-reingest.json` example workflow now includes a `Verify Data` step that validates the re-ingested `productMetadata` matches the properties sent from the metadata source entity, so the fetch → enrich → re-ingest pattern is demonstrated end-to-end.
- **Entity — Delete / Delete Entities (Bulk)** now always merge `deleted: true` onto whatever the Ingest API's delete response returned, instead of passing the raw response through unchanged.

### Fixed

- **Enterspeed** node now surfaces the underlying Enterspeed API error (via `NodeApiError`) instead of the generic Axios "Request failed with status code X" message, so failures like a 422 validation error are actionable.
- `scripts/setup.mjs` now updates the Enterspeed credential in place when re-run — e.g. after rotating API keys in `.env` — instead of skipping silently and leaving the old keys in place.

## [0.1.0] — 2026-06-25

### Added

- **Enterspeed** action node with Ingest (Save/Delete), Delivery, Query and Routes operations.
- **Enterspeed Trigger** polling node — emits new/changed items from a Query index on a schedule, with configurable change-detection field and baseline-on-first-poll behaviour.
- `EnterspeedApi` credential type supporting Environment API Key, Source API Key and host overrides for dedicated tenants.
