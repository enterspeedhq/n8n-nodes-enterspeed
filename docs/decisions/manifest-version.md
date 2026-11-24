# Where the Context Graph node takes its manifest from

Research for sc-14793 (epic sc-13858). Semantic-graph references are to `main` at `da8a90a27`,
written as paths under `contracts/docs/`.

## The problem

Every Delivery route has a `{manifest}` segment (delivery/ADR-030 §3). Today the credential holds it
as *Manifest Version* (`manifestVersion`), and the node and its schema-filled lists read it from
there.

- **On a deployed Context Graph the segment is the manifest id**, the 64-character content hash of
  the published manifest. It is "the one address" in v1; the manifest's `version` field is a label
  inside the hashed content, not an address (`adr/cross/018-manifest-content-hash-is-the-address.md`,
  Decision). `enterspeed-graph publish` computes it at `build` (`adr/sdk/016-cli-package-build-publish-and-config.md`).
- **Any change gives a new id**, including a backend-only mapper fix or a new `version` label. ADR-018
  names the cost itself: "a read consumer changes its configured id on every publish".
- **The SDK dev-server takes the version it hosts** (`1.0.0` by default), not an id (found in #41).
- **The old id keeps serving for a while, then stops.** Under `adr/cross/052-a-successors-flip-makes-its-predecessor-draining.md`
  (Proposed), a newly `Running` manifest makes its predecessor `Draining`: still readable at its own
  address until its window ends, then `Retired`, and Delivery tears it down. The switch is off on
  deployed stacks today (`DemoteOnFlip`), so an old manifest stays readable until someone retires it.
  Either way a workflow pinned to an old id reads stale data silently, then fails with `404`.
- **Folds don't make the id stable.** cross/ADR-034 shares a model's *data* across manifests;
  RFC cross-048 (Draft) is about which sources feed a `Running` manifest. Neither changes the address.

## What semantic-graph defines for finding or pinning a manifest

| Source | What it says | Bearing |
|---|---|---|
| `adr/delivery/014-sdk-wire-versioning.md`, Decision and 2026-08-27 amendment | The manifest is per request, "written by the SDK from a configured default with optional per-call override". Exact match only: no alias, range or implicit latest | The SDK client's shape is a default plus an override (option b). Delivery resolves nothing |
| `adr/cross/018-…`, "Open in place" | Whether a name resolves to an id is RFC cross-012's, and decides "nothing about whether one exists, who owns it or how a read selects it" | No name layer today |
| `adr/cross/052-…`, point 6 | "Any default or alias that means 'the current one' resolves to the `Running` manifest, never to a `Draining` one" | Defines what "current" would mean, but no way to ask for it |
| `rfc/cross-012-manifest-aliases.md` (Draft, Alex's) | An alias is a name in **the same URL segment** (§E1, recommended: "zero grammar change"), owned by Management, resolved by Delivery; a built-in `latest` is open (§C) | If it lands as E1, a client types the alias where it types the id today |
| `rfc/cross-033-manifest-overlap-window.md` (Draft) | Family identity and the overlap window | Linking ids, not resolving them |
| `adr/delivery/046-representation-route-enumeration.md`, cursor | A routes cursor carries the pinned manifest | Pins inside a listing; doesn't find one |
| Delivery's `GET /.well-known/ai-catalog.json` (`ArdCatalogEndpoints.cs`, RFC delivery-001 Draft) | Publishes each opted-in environment's current manifest (`GetLatestLiveManifestIdAsync`) | Anonymous, only for environments in Delivery's own config, not keyed by the caller's credential, and not a client contract |

**Gap:** nothing defines how a Delivery client holding an environment key finds that environment's
current manifest. The node doesn't fill it in from Enterspeed Core (ARCHITECTURE.md §8.5).

## Options

| | (a) Credential only (today) | (b) Node field, defaulting to the credential's | (c) Node only | (d) Resolve the current manifest from Delivery |
|---|---|---|---|---|
| **Saved workflows and credentials** | No change to saved shape. A rename is free until the first release | Adds an optional node parameter: additive, so it can also come later without breaking anything | Moves a saved field from credential to every node; worst to undo after release | Field becomes optional or goes; needs a platform endpoint that doesn't exist |
| **Lists read the run's manifest** | Yes: lists, runs and the test all read the one credential value | Only if the node value is a constant. An item expression can't be resolved in the editor, so lists fall back to the credential and may differ from the run | Same as (b), with no fallback | No: a list filled against one id, a run resolved later against another. Saved index, field and route names (ARCHITECTURE.md §4.2) can stop existing |
| **Credential test** | Tests the manifest the node uses (`GET /schema/msd/v1/{manifest}`) | Tests only the default; an override is first checked at list load or run | Nothing to test it against: every Delivery route needs a manifest, and the only one without (the catalogue) skips the key | Tests the resolve, if one existed |
| **Expressions per item** | Not available (credentials don't see item data) | Possible, but batched reads (Get Many, the once-per-run schema read) are scoped to one manifest | As (b) | Not applicable |
| **Customers who publish often** | One edit per credential per publish; every workflow on it moves together. Shared credential has to be edited | Same edit, plus every override found and changed by hand | Every node in every workflow, every publish | No edit, but drift is silent: a breaking publish changes what saved workflows read |

## Recommendation

**Keep the manifest on the credential only (a), and before the first release rename it from
*Manifest Version* to *Manifest* (`manifest`), with no default and a description that it takes the
manifest id, the dev-server's version, or later a name.** It is the only option where the lists, the
run and the credential test always read the same manifest; a node override (b) is additive and can
follow if a customer needs to canary one workflow, while removing one after release would break
saved workflows.

Why not the others:

- **(c)** multiplies the per-publish edit by every node and leaves the test nothing to check.
- **(d)** needs a capability the platform doesn't have (the gap above), and "always current" would
  change what saved workflows read behind their back, including after a breaking publish.
- **The publish-often pain is real, and the fix is a name, not a node field.** If RFC cross-012 lands
  as §E1, a customer puts the alias (say `production`) in the credential once and never edits it
  again; the node changes nothing. That is why the field should be named for the segment, not for a
  version.

## Question for Alex

> RFC cross-012 is Draft, and cross/ADR-018 leaves the name layer open. For the n8n Context Graph
> node (and any Delivery client that holds an environment key), is there, or will there be before
> Beta, a supported way to read "the environment's current manifest"? Either an alias in the
> `{manifest}` segment (§E1, perhaps a built-in name meaning the `Running` manifest, as cross/ADR-052
> point 6 describes), or an authenticated read that returns the current manifest id. Today the only
> thing is the anonymous ARD catalogue, which covers opted-in environments only. If E1 is the
> direction, the node keeps one *Manifest* field on its credential and customers type the alias
> there; if nothing is planned, they re-enter a 64-character id after every publish.

## Follow-up implementation story

Not filed yet. Draft:

**Title:** n8n Context Graph credential: rename Manifest Version to Manifest before the first release

Acceptance criteria:

- The Context Graph credential's field is *Manifest* (`manifest`), required, with no default and a
  placeholder showing a 64-character id. Its description says it is the `{manifest}` segment of every
  Delivery route: the manifest id `enterspeed-graph publish` prints on a deployed Context Graph, or
  the version the SDK dev-server hosts.
- Every read, the schema-filled lists and the credential test read `manifest`; no code or test reads
  `manifestVersion`.
- The credential test's `404` message and the schema read's not-found message (lists and Schema ›
  Get) say the manifest may have been retired after a newer publish and name the credential's
  *Manifest* field.
- `scripts/setup.mjs`, the end to end and the CI workflow set the renamed field (and its environment
  variable), and the end to end passes against the dev-server.
- README (credential section), ARCHITECTURE.md (§3.7, §4.1 and the layout table in AGENTS.md) and a
  CHANGELOG entry under `[Unreleased]` describe the field and link this note.
- No node-level manifest field is added.
