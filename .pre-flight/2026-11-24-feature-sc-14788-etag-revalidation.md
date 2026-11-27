# feature/sc-14788/etag-revalidation — 2026-11-24

## Changed files

- `ARCHITECTURE.md`
- `CHANGELOG.md`
- `README.md`
- `nodes/EnterspeedContextGraph/actions/representation/get.operation.ts`
- `nodes/EnterspeedContextGraph/transport.ts`
- `tests/EnterspeedContextGraph.node.test.ts`

## Observations

The "no ETag carried over from an earlier response" rule after resume rounds is only exercised where the earlier response had no ETag either; on delivery only the fallback re-GET could carry one before a later round, so I left it at the fallback test. Worth a dedicated test if the resume path changes?

I couldn't run the 304 path against a live n8n here. It relies on n8n's request helper rejecting a 304 with the response as the failure's cause, which I read in @n8n/backend-network 1.22.5; is the e2e job the right place to pin that once the dev-server's ETags are in a template?
