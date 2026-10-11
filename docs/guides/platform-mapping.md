# Platform to MCP Package Mapping

This table tracks current and planned ad-platform packages. The Current
Platforms table must list exactly the servers in `registry.json`;
`scripts/lib/fleet-inventory.test.mjs` fails otherwise.

## Current Platforms

| Platform         | Package                   | Primary Purpose                                          | Status |
| ---------------- | ------------------------- | -------------------------------------------------------- | ------ |
| DV360 Reporting  | `packages/dbm-mcp`        | Bid Manager reporting and diagnostics                    | Active |
| DV360 Management | `packages/dv360-mcp`      | DV360 entity creation/updates                            | Active |
| The Trade Desk   | `packages/ttd-mcp`        | TTD entity management and reporting                      | Active |
| Google Ads       | `packages/gads-mcp`       | Google Ads campaign management and reporting             | Active |
| Meta Ads         | `packages/meta-mcp`       | Meta Marketing API v26.0 campaign management             | Active |
| LinkedIn Ads     | `packages/linkedin-mcp`   | LinkedIn Marketing API campaign management               | Active |
| TikTok Ads       | `packages/tiktok-mcp`     | TikTok Marketing API v1.3 campaign management            | Active |
| Campaign Manager | `packages/cm360-mcp`      | CM360 entity management, reporting and scheduling        | Active |
| Search Ads 360   | `packages/sa360-mcp`      | SA360 cross-engine reporting and conversion upload       | Active |
| Pinterest Ads    | `packages/pinterest-mcp`  | Pinterest Ads campaign management and reporting          | Active |
| Snapchat Ads     | `packages/snapchat-mcp`   | Snap campaign management (Ad Squad terminology kept)     | Active |
| Amazon DSP       | `packages/amazon-dsp-mcp` | Amazon DSP entity management (Unified API) and reporting | Active |
| Microsoft Ads    | `packages/msads-mcp`      | Microsoft Advertising campaign management and reports    | Active |

## Planned/Target Platforms

Candidates from [ROADMAP.md](../../ROADMAP.md). Open an issue before starting
one; see [Adding a New Server](adding-a-new-server.md).

| Platform    | Notes                                  |
| ----------- | -------------------------------------- |
| Reddit Ads  | Candidate; no package or prefix agreed |
| X (Twitter) | Candidate; no package or prefix agreed |

## Rules

- New platform packages must be listed here before release.
- Each platform must include MCP prompts for core workflows (campaign setup, entity updates, troubleshooting).
- Each platform must include MCP resources for entity schemas and examples.
