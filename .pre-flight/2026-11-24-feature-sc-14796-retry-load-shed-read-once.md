# feature/sc-14796/retry-load-shed-read-once — 2026-11-24

## Changed files

- `ARCHITECTURE.md`
- `CHANGELOG.md`
- `README.md`
- `nodes/EnterspeedContextGraph/actions/index/get.operation.ts`
- `nodes/EnterspeedContextGraph/actions/index/query.operation.ts`
- `nodes/EnterspeedContextGraph/actions/representation/get.operation.ts`
- `nodes/EnterspeedContextGraph/actions/shape/get.operation.ts`
- `nodes/EnterspeedContextGraph/actions/shape/getMany.operation.ts`
- `nodes/EnterspeedContextGraph/actions/shape/shared.ts`
- `nodes/EnterspeedContextGraph/transport.ts`
- `tests/EnterspeedContextGraph.node.test.ts`

## Observations

The tests build the 503 in the shape the transport reads (headers on the error's cause), and n8n's 429 and checkpoint paths already rely on the same read, but nothing here proves real n8n keeps the 503's headers. Is one Docker n8n run against a stub that answers 503 then 200 worth doing before this merges?

The embedding-unavailable 503 on /query has no Retry-After, so it isn't retried and now fails with the generic busy message, its detail as the description. Is "busy or can't answer right now" good enough there, or should a 503 with a detail and no wait keep the detail as the message?
