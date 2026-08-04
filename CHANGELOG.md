# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Example workflow: Contentful → Enterspeed ingestion (`workflows/templates/ingest-contentful-into-enterspeed.json`), syncing entry and asset publish/unpublish/delete events across locales.

### Changed

- `workflows/templates/fetch-transform-reingest.json` example workflow now includes a `Verify Data` step that validates the re-ingested `productMetadata` matches the properties sent from the metadata source entity, so the fetch → enrich → re-ingest pattern is demonstrated end-to-end.

### Fixed

- **Enterspeed** node now surfaces the underlying Enterspeed API error (via `NodeApiError`) instead of the generic Axios "Request failed with status code X" message, so failures like a 422 validation error are actionable.
- `scripts/setup.mjs` now updates the Enterspeed credential in place when re-run — e.g. after rotating API keys in `.env` — instead of skipping silently and leaving the old keys in place.

## [0.1.0] — 2026-06-25

### Added

- **Enterspeed** action node with Ingest (Save/Delete), Delivery, Query and Routes operations.
- **Enterspeed Trigger** polling node — emits new/changed items from a Query index on a schedule, with configurable change-detection field and baseline-on-first-poll behaviour.
- `EnterspeedApi` credential type supporting Environment API Key, Source API Key and host overrides for dedicated tenants.
