# feature/sc-14787/artifact-status-and-listing — 2026-11-24

## Changed files

- `AGENTS.md`
- `ARCHITECTURE.md`
- `CHANGELOG.md`
- `README.md`
- `nodes/EnterspeedContextGraph/EnterspeedContextGraph.node.ts`
- `nodes/EnterspeedContextGraph/actions/artifact/get.operation.ts`
- `nodes/EnterspeedContextGraph/actions/artifact/getLines.operation.ts`
- `nodes/EnterspeedContextGraph/actions/artifact/getMany.operation.ts`
- `nodes/EnterspeedContextGraph/actions/artifact/index.ts`
- `nodes/EnterspeedContextGraph/actions/artifact/shared.ts`
- `tests/EnterspeedContextGraph.node.test.ts`

## Observations

A bare 403 from ingest is worded as "The API key isn't allowed to write to this Context Graph.", which is also what a key whose scope leaves the source out gets. Should the fallback say "this source" instead? It is shared with Upload, so I left it.

Artifact › Upload re-reads its parameters on the Continue On Fail path, so a Source or As Of expression that throws still fails the whole node there. The new reads guard against it; should Upload get the same guard in its own PR?

The Artifact ID check takes only the dashed GUID form, the form the platform answers. Is anyone likely to paste a GUID without dashes or with braces?
