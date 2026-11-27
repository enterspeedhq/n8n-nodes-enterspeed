# feature/sc-14196/context-graph-trigger — 2026-11-24

## Changed files

- `AGENTS.md`
- `ARCHITECTURE.md`
- `CHANGELOG.md`
- `CONTRIBUTING.md`
- `README.md`
- `credentials/EnterspeedContextGraphWebhookApi.credentials.ts`
- `eslint.config.mjs`
- `nodes/EnterspeedContextGraph/EnterspeedContextGraphTrigger.node.ts`
- `nodes/EnterspeedContextGraph/webhookTrigger/handler.ts`
- `nodes/EnterspeedContextGraph/webhookTrigger/properties.ts`
- `nodes/EnterspeedContextGraph/webhookTrigger/signature.ts`
- `package.json`
- `tests/EnterspeedContextGraphTrigger.node.test.ts`
- `tests/fixtures/outbound-envelope/guids-render-lowercase.json`
- `tests/fixtures/outbound-envelope/mixed-tags-in-one-envelope.json`
- `tests/fixtures/outbound-envelope/non-ascii-tag-key-round-trips.json`
- `tests/fixtures/outbound-envelope/removal-is-deleted-with-a-null-hash.json`
- `tests/fixtures/outbound-envelope/set-tag-is-upserted-with-a-null-hash.json`
- `tests/fixtures/outbound-envelope/upserted-entry-carries-its-hash.json`
- `tests/fixtures/webhook-signature/body-bytes-are-signed-as-sent.json`
- `tests/fixtures/webhook-signature/escaped-body-is-signed-as-sent.json`
- `tests/fixtures/webhook-signature/golden-one-signature.json`
- `tests/fixtures/webhook-signature/golden-overlap-two-signatures.json`
- `tests/fixtures/webhook-signature/standard-webhooks-reference.json`

## Observations

The receiver header's name and value sit in the webhook credential rather than as node parameters, so the value is stored encrypted and never ends up in an exported workflow. The Core trigger keeps its access key as a node parameter. Is the credential the right home for it?

The lint rule that credential display names end in "API" made the credential "Enterspeed Context Graph Webhook API" rather than "Enterspeed Context Graph Webhook". Is that acceptable?

Event Types offers only model-changed. A type added later starts the workflow when the filter is empty, but can't be picked until the node lists it. Should there be a free-text type as well?

n8n's scanner fails at this branch's base on two existing description errors in Push and Push Many, which the release-scan PR fixes; this branch adds nothing to the scan. Fine to leave to that PR?
