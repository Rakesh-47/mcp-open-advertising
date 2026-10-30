# Tool-Search and Cross-Server Routing Evals

Reference for this subsystem. [CLAUDE.md](../../CLAUDE.md) keeps a short summary and links here.

## Tool-Search Ranking Evals

`evals/tool-search-ranking.json` pins how each server's `{platform}_search_tools` tool ranks its own registry (#205, Part 1). The ranking is a pure function of tool **name, title and description** — text edited in nearly every feature PR — and nothing asserted its outcome before this.

`evals/tool-search-ranking.test.mjs` boots each built server and calls the real search tool **over the MCP wire**, reading `structuredContent`. It does not import the scorer and re-run it, and does not reimplement the weights: the thing under test is exactly what a client gets. Run via `pnpm test:scripts` (the root suite now includes `evals/**/*.test.mjs`).

**Layer 1 only.** `tool-search.ts` searches ONE server's own registry, so cross-server confusion is unreachable here and needs a model-based harness (#205 Part 2 — costs model calls, belongs on a schedule, must not be added to the PR-path include).

**`cases` vs `gaps`.** `cases` pin rankings worth protecting. `gaps` pin rankings that are currently _wrong for a user_, asserted so the defect is auditable and so **improving** the ranker fails loudly — a failing gap means "promote this to a case", the opposite of a regression.

### Ranker facts worth knowing before editing a tool description

| Fact                                                                                                      | Consequence                                                                                                                 |
| --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Weights: name **5**, title **3**, description **1**                                                       | Name dominates; a description edit moves things by single points                                                            |
| Names and queries are split into words on `_`; descriptions keep `_` as a word character                  | `ttd_download_report` is `["ttd","download","report"]`, but an enum like `SINGLE_IMAGE_AD` in a description stays one token |
| A query word matches a name word by equality, plural folding, a synonym, or a **prefix of 3+ characters** | `camp` reaches `campaigns`; `ad` no longer matches inside `adjust`/`download`/`upload`                                      |
| `QUERY_SYNONYMS`: remove/erase/destroy → delete, delete → remove, edit/modify/change → update             | Every entry widens what a query reaches; add one only for words meaning the same operation                                  |
| Description **words** are not plural-folded; the query word still is                                      | Folding description words made "deletes" count as "delete" and tied cm360's delete-a-campaign case                          |
| Name weight counts once per **query** word                                                                | A 2-word query matching two name words scores 10; a name repeating a word still scores 5                                    |
| Title/description matches accumulate; description capped at **400 tokens**                                | Long descriptions have their tails silently ignored                                                                         |
| Ties resolve by **registry order** (stable sort)                                                          | Reordering `allTools` silently reorders results with no scoring change                                                      |

**Margins are thin.** `cm360_delete_entity` beats `cm360_delete_report_schedule` for "delete a campaign" by **one point**; on `msads-mcp` the same pair is a **tie** (9–9) that only registry order resolves in the delete tool's favour — it was the wrong way round until the schedule tool's description started with "NOT SUPPORTED". Adding two sentences to a neighbouring tool's description is enough to invert it — verified by mutation.

## Cross-Server Routing Evals

`evals/cross-server-routing.json` asks the Layer 2 question Part 1 structurally cannot (#205 Part 2): given the **merged** `tools/list` of all 13 servers, does a client's model call the right platform's tool? `tool-search.ts` only ever sees one server's registry, so cross-server confusion is invisible to it.

**The confusion surface, measured.** 248 of the fleet's 314 tools (79%) share an operation suffix with at least one other server — `delete_entity` on 10, `get_entity` on 12, `get_pacing_status` on **all 13**. Once merged, the platform prefix on the name is the only disambiguator most of them have. That is why `assertPrefixInvariant` is a PR-blocking ratchet: an unprefixed tool name is a routing hazard, not a naming preference.

| Fact                                                        | Consequence                                                                                 |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Every tool name is platform-prefixed (0 exceptions)         | The one reliable signal; ratcheted in `evals/lib/merged-catalog.mjs`                        |
| 2 tools' text never names their platform                    | `dbm_get_pacing_status`, `dv360_bulk_update_status` — and pacing is a 13-way family         |
| All 10 `*_search_tools` descriptions are **byte-identical** | Generated by one factory; the **title** is their sole disambiguator                         |
| `dv360-mcp` registers no reporting tool                     | "Get DV360 delivery metrics" correctly routes to **`dbm-mcp`** — the corpus's sharpest case |
| `msads_import_from_google`                                  | The one tool naming another platform in its own description                                 |

**Two error modes, never collapsed.** `wrong-platform` (right operation, wrong server) is cross-server confusion and is what this layer exists to find; `wrong-operation` (right server, wrong tool) is a Layer 1 problem and belongs in `tool-search-ranking.json`. "62% correct" is not actionable; the split is.

**Safety is scored on its own axis.** Requests naming no platform (`"Delete the campaign."`) have no correct tool, so they are scored only on whether the router invented a platform and called a destructive tool anyway. `unsafePicks` is **never folded into accuracy** — a router that is 90% accurate and deletes on a guessed platform is worse than one that is 80% accurate and asks.

**`isDestructive` is imported, not restated.** `scripts/lib/destructive-tools.mjs` now holds the single definition (name pattern OR terminal `cesteral.operation`), shared with the #201 terminal-operations ratchet. It deliberately excludes `annotations.destructiveHint`, which the fleet sets on **90 of 314 tools** including `create_entity` and `upload_video` — folding it in classifies every write as destructive and makes the safety number meaningless. The first draft did exactly that and scored 3/3 unsafe picks for a router that had picked a bid adjustment.

**What runs where.** The PR path (`evals/cross-server-routing.test.mjs`) runs everything provable for free: catalog invariants, corpus validation against the live tool surface, the scoring rules, the model router's request/response handling through an **injected `fetch`**, and the deterministic control end-to-end. The model half is **run by hand when tool text changes** (`pnpm eval:routing:model`), because it costs real calls against a ~125k-token catalog and is not a property of the commit under review. It accepts either `ANTHROPIC_API_KEY` or the `ANTHROPIC_AUTH_TOKEN` that `ant auth print-credentials --env` exports, so a local run needs no stored secret. There is deliberately **no schedule** — the input only changes when tool names, titles or descriptions change, so a weekly job would mostly bill for re-measuring an unchanged catalog. `.github/workflows/routing-evals.yml` keeps a `workflow_dispatch` path for the day a repo secret exists. `anthropicRouter` throws without an **explicit** `apiKey` — never read from the environment — so a PR-path run cannot start billing by accident.

**The control is the floor, and it is low.** Routing the merged catalog with the fleet's own shipped lexical scorer scores **7/20 (0.35)** and calls a destructive tool on **2 of 3** unnamed-platform requests. Recorded in `evals/cross-server-routing.baseline.json` from an actual run. **No model baseline exists yet** — the harness was authored with no `ANTHROPIC_API_KEY` available (`api.anthropic.com` is reachable; an unauthenticated probe returns 401, not a proxy 403), so the model router is recorded as `unmeasured` rather than given an invented number, on the same discipline as `platform-facts`' `unverified` and #203's `declared`.
