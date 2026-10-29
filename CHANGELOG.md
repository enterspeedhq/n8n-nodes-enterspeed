# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Enterspeed Context Graph** node and **Enterspeed Context Graph API** credential (API key, ingest URL, delivery URL, manifest version). The credential test reads the manifest document from the Delivery URL. **Entity — Push** sends each input item, as the record it is, to the Context Graph (`POST {Ingest URL}/entities`), one request per item. Entity ID, Entity Type, Source, Action and Modified At set the record's `$id`, `$type`, `$source`, `$action` and `$modifiedAt`, each defaulting to the record's own. **Entity — Push Many** sends a list of records held in one item (e.g. from an Aggregate node) in one request; each record keeps its own `$` fields. Both output one accepted/rejected result per record.
- **Context Graph: Tonevik demo** example workflow (`workflows/templates/Context-Graph-Tonevik-Demo.json`): the Tonevik demo shop's PIM categories, products and a retired product, pushed step by step with Push Many against the local dev-server, with a guide (`docs/context-graph-demo/GUIDE.md`). `scripts/setup.mjs` now creates an Enterspeed Context Graph credential (local dev-server by default).

### Changed

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
