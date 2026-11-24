# Where the Context Graph node takes its manifest from

Research for sc-14793 (epic sc-13858). Semantic-graph references are to `main` at `da8a90a27`,
written as paths under `contracts/docs/` unless they name source.

## The problem

Every Delivery route has a `{manifest}` segment (delivery/ADR-030 §1 for the data plane, §3 for the
operations). Today the credential holds it as *Manifest Version* (`manifestVersion`), and the node,
its schema-filled lists and the credential test all read it from there.

- **On a deployed Context Graph the segment is the manifest id**, the 64-character content hash of
  the published manifest. It is "the one address" in v1; the manifest's `version` field is a label
  inside the hashed content, not an address (`adr/cross/018-manifest-content-hash-is-the-address.md`,
  Decision). The SDK CLI's `build` computes it and `publish` sends it (`adr/sdk/016-cli-package-build-publish-and-config.md`).
- **Any change gives a new id**, including a backend-only mapper fix or a new `version` label. ADR-018
  names the cost itself: "a read consumer changes its configured id on every publish".
- **The SDK dev-server takes the version it hosts** (`1.0.0` by default), not an id (found in this
  repo's #41).
- **The old id keeps serving, then stops.** Under `adr/cross/052-a-successors-flip-makes-its-predecessor-draining.md`
  (Proposed, built behind `ControlOptions.DemoteOnFlip`, which is off on deployed stacks), a newly
  `Running` manifest makes its predecessor `Draining`. A `Draining` manifest is still fed and readable
  at its own address ("the old version does not freeze in its window", point 2) until its window
  ends; then it is `Retired` and Delivery tears it down. With the switch off, the old manifest stays
  `Running` until someone retires it. So a workflow on an old id reads current data **in the old
  schema's shape**, without warning, and then fails with `404` once that id is retired.
- **Folds don't make the id stable.** cross/ADR-034 shares a model's *data* across manifests;
  RFC cross-048 (Draft) is about which sources feed a `Running` manifest. Neither changes the address.

## What semantic-graph defines for finding or pinning a manifest

| Source | What it says | Bearing |
|---|---|---|
| `adr/delivery/014-sdk-wire-versioning.md`, Decision and 2026-08-27 amendment | The manifest is per request, "written by the SDK from a configured default with optional per-call override". Exact match only: no alias, range or implicit latest | The SDK client's shape is a default plus an override (option b). Delivery resolves nothing |
| `adr/cross/018-…`, "Open in place" | Whether a name resolves to an id is RFC cross-012's; ADR-018 decides "nothing about whether one exists, who owns it or how a read selects it" | No name layer today |
| `adr/cross/052-…`, point 6 | "Any default or alias that means 'the current one' resolves to the `Running` manifest, never to a `Draining` one" | Defines what "current" would mean, not a way to ask for it |
| `rfc/cross-012-manifest-aliases.md` (Draft) | An alias is a name in **the same URL segment** (§E1, recommended: "zero grammar change"), owned by Management, resolved by Delivery. A built-in `latest` is open (§C), which the RFC calls a development and preview convenience, not a production address | If it lands as E1, a client types the alias where it types the id today |
| `rfc/cross-033-manifest-overlap-window.md` (Draft) | Family identity and the overlap window | Links ids; doesn't resolve them |
| `adr/delivery/046-representation-route-enumeration.md`, cursor | A routes cursor carries the pinned manifest | Pins inside a listing; doesn't find one |
| Management `GET /v1/manifests` (`management/src/Platform.Management.Host/Endpoints/ManifestEndpoints.cs`, sc-14272) | Lists the caller's environment's manifests with their state (`Provisioning`, `Running`, `Draining`, `Retired`) | Lets an operator read the `Running` id, but needs an operator bearer token with an `environment` claim, not a Delivery key, and it's an operator surface, not a read-client contract |
| Delivery `GET /.well-known/ai-catalog.json` (`delivery/src/Platform.Delivery.Representation/Schema/Ard/ArdCatalogEndpoints.cs`, RFC delivery-001 Draft) | Publishes each opted-in environment's current manifest (`GetLatestLiveManifestIdAsync`), the id appearing only inside schema URLs | Anonymous, only for environments in Delivery's own config, not keyed by the caller's credential, and not a client contract |

**Gap:** nothing defines how a client holding a Delivery key finds its environment's current
manifest. The node doesn't invent one or copy one from Enterspeed Core; it is noted here as a gap
(ARCHITECTURE.md §8.5).

## Options

| | (a) Credential only (today) | (b) Node field, defaulting to the credential's | (c) Node only | (d) Resolve the current manifest from Delivery |
|---|---|---|---|---|
| **Saved workflows and credentials** | No change to saved shape. A rename is free until the first release | Adds an optional node parameter: additive, so it can also come later without breaking anything | Moves a saved field from credential to every node; hardest to undo after release | Field becomes optional or goes; needs a platform capability that doesn't exist |
| **Lists read the run's manifest** | Yes: lists, runs and the test all read the one credential value | Only reliably for a constant. For an expression, the editor resolves it (at best) against sample data, so the list may read a different manifest from the run | As (b), with no fallback | No: a list filled against one id, a run resolved later against another. Saved index, field and route names (ARCHITECTURE.md §4.2) can stop existing |
| **Credential test** | Tests the manifest the node uses (`GET /schema/msd/v1/{manifest}`) | Tests only the default; an override is first checked at list load or run | Nothing to test it against: every Delivery route needs a manifest, and the only one without (the catalogue) skips the key | Would test the resolve, if one existed |
| **Expressions per item** | Not with this node: the router and `readMsd` read the credential once, without an item index | Possible, but Get Many, Index › Query (all items in one request) and the once-per-run schema read are each scoped to one manifest | As (b) | Not applicable |
| **Customers who publish often** | One edit per credential per publish; every workflow on it moves together. A shared credential has to be edited | Same edit, plus every override found and changed by hand | Every node in every workflow, every publish | No edit, but drift is silent: a breaking publish changes what saved workflows read |

## Recommendation

**Keep the manifest on the credential only (a), and before the first release rename it from
*Manifest Version* to *Manifest* (`manifest`), with no default and a description that it takes the
manifest id, the dev-server's version, or later a name.** It is the only option where the lists, the
run and the credential test always read the same manifest; a node override (b) is additive and can
follow if a customer needs to canary one workflow, while removing one after release would break
saved workflows.

Why not the others:

- **(c)** multiplies the per-publish edit by every node and leaves the test nothing to check.
- **(d)** needs a capability the platform doesn't offer to a Delivery client (the gap above), and
  "always current" would change what saved workflows read behind their back, including after a
  breaking publish.
- **The publish-often pain is real, and the fix is a name, not a node field.** If RFC cross-012 lands
  as §E1, a customer puts an alias (say `production`) in the credential once and moves it in their
  publish pipeline; the node changes nothing. That is why the field should be named for the segment,
  not for a version.

## Open question for the platform

Is there, or will there be before Beta, a supported way for a client holding a Delivery key to read
its environment's current manifest: an alias in the `{manifest}` segment (RFC cross-012 §E1), or an
authenticated read returning the current id? Is Management's `GET /v1/manifests` meant to serve
integrations like this node? Until one is decided, customers re-enter a 64-character id in the
credential after every publish.

## Follow-up implementation story

Not filed yet. Draft:

**Title:** n8n Context Graph credential: rename Manifest Version to Manifest before the first release

Acceptance criteria:

- The Context Graph credential's field is *Manifest* (`manifest`), required, with no default and a
  placeholder showing a 64-character id. Its description says it is the `{manifest}` segment of every
  Delivery route: the manifest id on a deployed Context Graph, or the version the SDK dev-server
  hosts.
- Every read, the schema-filled lists and the credential test read `manifest`.
- The credential test's `404` message and the schema read's not-found message (lists and Schema ›
  Get) say the manifest may have been retired after a newer publish and name the credential's
  *Manifest* field.
- `scripts/setup.mjs` reads `CONTEXT_GRAPH_MANIFEST` (defaulting to `1.0.0` for the dev-server), and
  `.env.example` and the README's setup section name it; the CI end to end passes against the
  dev-server.
- No user-facing text says *Manifest Version*, and `grep -rn manifestVersion` finds nothing outside
  this note. That covers README (credential tables, the route tables, the schema and dev-server
  sections), ARCHITECTURE.md §3.7, AGENTS.md's layout table, and the existing `[Unreleased]`
  CHANGELOG entries, which are edited in place since nothing has been released.
- No node-level manifest field is added.
