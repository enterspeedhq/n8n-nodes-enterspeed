# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-06-25

### Added

- **Enterspeed** action node with Ingest (Save/Delete), Delivery, Query and Routes operations.
- **Enterspeed Trigger** polling node — emits new/changed items from a Query index on a schedule, with configurable change-detection field and baseline-on-first-poll behaviour.
- `EnterspeedApi` credential type supporting Environment API Key, Source API Key and host overrides for dedicated tenants.
