# Cesteral Repository Structure

## Overview

This repository contains the **open-source connector layer** for Cesteral: thirteen MCP servers plus shared runtime, the governance-contract libraries, and deployment infrastructure.

The proprietary hosted product, `Cesteral Intelligence`, is intentionally **not** implemented in this repository. It sits above this connector layer and adds tenancy, managed credential configuration, orchestration, approvals, audit, and hosted operations.

## Repository Layout

```text
mcp-open-advertising/
├── packages/
│   ├── shared/              # @cesteral/shared — runtime: auth, transport, factories, telemetry
│   ├── contract-schema/     # @cesteral/contract-schema — shape of cesteral.* annotations and the manifest
│   ├── contract-hash/       # @cesteral/contract-hash — canonical tool-definition hash
│   ├── dbm-mcp/             # 13 MCP servers, one per platform
│   ├── dv360-mcp/
│   ├── ttd-mcp/
│   ├── gads-mcp/
│   ├── meta-mcp/
│   ├── linkedin-mcp/
│   ├── tiktok-mcp/
│   ├── cm360-mcp/
│   ├── sa360-mcp/
│   ├── pinterest-mcp/
│   ├── snapchat-mcp/
│   ├── amazon-dsp-mcp/
│   └── msads-mcp/
├── docs/                    # guides, architecture, governance, runbooks, plans, reviews
├── scripts/                 # deploy/bootstrap shell scripts, CI checks, generators
│   └── lib/                 # shared script modules and repo-wide invariant tests (*.test.mjs)
├── evals/                   # tool-search ranking and cross-server routing evals
├── conformance/             # expected-failures baseline for the MCP conformance suite
├── terraform/               # GCP infrastructure (Cloud Run, Secret Manager, LB, Firestore)
├── .github/workflows/       # CI, release, and scheduled drift/freshness checks
├── registry.json            # per-server metadata; source for README counts, the server card and the fleet server lists
├── platform-facts.json      # ledger of load-bearing claims about external platforms
├── cloudbuild.yaml
├── cloudbuild-manual.yaml
└── README.md
```

## Packages

### MCP servers

The `packages/` directory contains 13 independently deployable MCP servers:

- `dbm-mcp`
- `dv360-mcp`
- `ttd-mcp`
- `gads-mcp`
- `meta-mcp`
- `linkedin-mcp`
- `tiktok-mcp`
- `cm360-mcp`
- `sa360-mcp`
- `pinterest-mcp`
- `snapchat-mcp`
- `amazon-dsp-mcp`
- `msads-mcp`

These are the open-source connectors that customers can self-host or that Cesteral can host as part of the commercial product. The layout inside each one is described in [CLAUDE.md](../CLAUDE.md#mcp-server-architecture-pattern).

### Shared runtime

`packages/shared/` contains reusable infrastructure used by the server packages:

- auth strategies and adapters
- MCP HTTP transport helpers
- telemetry and logging utilities
- tool handler and session helpers
- common config parsing and runtime utilities

### Governance-contract libraries

Two small packages define the contract shared with the governance layer. They are published to npm separately from the servers:

- `packages/contract-schema/` — the canonical shape of the `cesteral.*` tool annotations, the dry-run and snapshot response schemas, and the release manifest.
- `packages/contract-hash/` — the canonical SHA-256 of a tool definition, kept bit-identical with the downstream governance repo.

## Docs, Scripts, Evals, and Infra

- `docs/` contains design docs, architecture notes, strategy documents, and operational guides relevant to the open-source connector layer. [docs/README.md](README.md) is the index.
- `scripts/` contains project bootstrap, secret creation, build, and deployment helpers, the `check-*` scripts CI runs, and the generators for manifests and registry data. [scripts/README.md](../scripts/README.md) describes the deployment helpers.
- `scripts/lib/` holds modules shared by those scripts and the repo-wide invariant tests (for example, that every write tool has a wire test), run with `pnpm test:scripts`.
- `evals/` pins how each server's tool search ranks its own tools, and whether a client picks the right platform from the merged tool list.
- `conformance/` holds the baseline of expected failures for `scripts/conformance-test.sh`.
- `terraform/` contains GCP infrastructure for deploying the connector fleet and its supporting resources.
- `.github/workflows/` runs CI, the tag-triggered release, and the scheduled checks for codegen drift, Terraform drift, platform-facts freshness, and routing evals.
- `cloudbuild.yaml` and `cloudbuild-manual.yaml` define CI/CD and manual build/deploy flows for the connector fleet.
- `registry.json` and `platform-facts.json` are data files at the root because scripts, CI, and docs all read them.

## What Is Deliberately Out of Scope Here

This repo does not contain the implementation of `Cesteral Intelligence`, including:

- org/workspace/project tenancy
- hosted connector configuration UI
- managed customer secret UX
- approval workflows and governance UX
- cross-server orchestration product logic
- commercial optimization/agent workflows
- hosted control-plane APIs

Those belong in the proprietary hosted product above this connector layer.
