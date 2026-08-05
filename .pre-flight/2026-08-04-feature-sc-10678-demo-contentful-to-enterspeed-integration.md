# feature/sc-10678/demo-contentful-to-enterspeed-integration — 2026-08-04

## Changed files

tests/workflow-templates.test.ts
workflows/templates/ingest-contentful-into-enterspeed.json

## Observations

1. **OPEN** — `scripts/setup.mjs` only substitutes `__ENTERSPEED_CREDENTIAL_ID__`. This template introduces a second placeholder, `__CONTENTFUL_CREDENTIAL_ID__`, that the documented setup flow never replaces. Was `setup.mjs` meant to be updated alongside this template, or is the Contentful credential expected to be wired up manually after import?

2. **OPEN** — the "Get ID" node still reads `$('Clean up IDs').first().json.entryId`, but "Clean up IDs" only ever sets `.json.Id` (the sibling "GetId2" node reads `.Id` correctly on the asset path). Is `entryId` meant to resolve to something else, or should this read `.Id`?

3. **Addressed** — the "Get Entry" node's `entryId` parameter now reads `{{ $('Clean up IDs').item.json.Id }}`, matching the field "Clean up IDs" actually sets.

4. **Addressed** — "Get asset" node's `contentfulApi` credential object now reads `"name": "Contentful account"`.

5. **Addressed** — the Switch node's dead-end "Seed" branch has been removed.

6. **Addressed** — a `[Unreleased]` entry was added to `CHANGELOG.md` for the new example workflow, matching the PR checklist's checked box.

## New since last check

7. **OPEN** — the template's top-level JSON lost its array wrapper (`[ {...} ]` → bare `{...}`) during editing. `fetch-transform-reingest.json` (the sibling template) and the test suite's `const [workflow] = JSON.parse(raw)` both assume the array-wrapped shape; right now `npm test` fails 3 cases with `TypeError: object is not iterable`. Confirmed with the developer that n8n accepts both shapes on import — resolution is pending (either normalize the test helper to accept both shapes, or re-add the wrapper).
