# Release Attestation and Verification Status

Reference for this subsystem. [CLAUDE.md](../../CLAUDE.md) keeps a short summary and links here.

## Release Attestation Manifest

`scripts/generate/generate-manifests.mjs` (`pnpm run generate:manifests`) boots each server, reads its raw `tools/list`, and writes `dist/cesteral-manifest.json` for every package with governed tools (those carrying an `annotations.cesteral` block). Each entry is validated against `cesteralManifestSchema` (from `@cesteral/contract-schema`); the manifest hard-fails on contractId/schemaVersion/slug inconsistency **and** when a tool's `cesteral` block does not satisfy the full `cesteralAnnotationSchema` — the same loose schema the governance layer parses released tool lists with at admission, so a malformed annotation fails the release here rather than silently failing to reach `attested` downstream. Each tool's `definitionHash` is a canonical SHA-256 from `@cesteral/contract-hash` — kept bit-identical with the downstream `cesteral-intelligence` governance repo. An entry may carry an optional `hashAlg` (`cesteral-c14n-v1`, the default when absent, or `rfc8785`) naming the canonicalization that hash used; a decision token's signed `hashAlg` must equal it, so the release — not the minter — decides which algorithm a server is on (`docs/plans/2026-10-09-hash-alg-selector-handoff.md`). The generator still emits the default. The tag-triggered `release.yml` publishes to npm with build provenance, signing the manifest transitively inside the tarball; the governance system verifies that provenance and promotes matching tools to `attested` trust.

## Verification Status (#203)

`attested` answers _is this the definition we published?_ It says nothing about whether the tool works. Each manifest entry therefore also carries a `verification` block, on an orthogonal axis, so a consumer can require `attested` **and** `live-verified` before permitting `enforce` on a money-moving write.

| Status             | Meaning                                                                                                                |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `declared`         | Annotation present; nothing verified against this hash. **The default, including for a tool absent from the ledger.**  |
| `fixture-verified` | Passes fixtures/mocks in CI at this hash                                                                               |
| `live-verified`    | Exercised against a real authorized account at this hash; findings triaged; evidence links to the specific tool result |
| `disabled`         | Deliberately off — **requires a reason**                                                                               |

**The status is bound to the hash it was verified against, and demotion is automatic.** `resolveVerification` (`scripts/lib/verification-ledger.mjs`) discards any claim whose `verifiedDefinitionHash` does not equal the definition being shipped and replaces it with `declared` — no override exists in the ledger or the annotation. A status that survives a definition change is worse than no status, because it is confidently wrong. The discarded status is preserved as `demotedFrom` so a stale report stays distinguishable from a tool nobody ever tested; only one of those has something to re-run.

**The ledger is `packages/<pkg>/verification.json`, never the tool annotation.** A tool must not promote itself: an annotation field would be a claim authored in the same file, in the same commit, as the behaviour change. A package with no ledger file has every tool at `declared`.

**`manifestVersion` stays `1`.** `verification` is an optional field, so a consumer pinned to an older `@cesteral/contract-schema` strips it and is unaffected. Bumping to `2` would make every older consumer reject the whole manifest and drop every tool out of `attested` until the governance repo upgraded — far worse than an ignored field.

**Everything is backfilled to `declared`, including tools that were genuinely live-tested.** This is the control working, not a gap: the 2026-04-01 TTD run (7 distinct tools genuinely exercised — the report's 12 "PASS" rows count entity-type variations, not tools) and the 2026-05-15 Amazon DSP run both predate hash binding and recorded no `definitionHash`, so neither can be bound to a definition. An unbindable claim is exactly what this mechanism refuses. Re-running the tool is what promotes it; the ledger notes preserve which tools have prior evidence so a future live run knows where to start. Note also that neither report is a promotion list on its own — the TTD one marks 8 tools `PASS (untested live)` on the strength of code review, and the Amazon one flags one of its own passes as false.
