# sa360-mcp

Platform notes for this package: quirks that are easy to forget when editing it. Repo-wide conventions are in the [root CLAUDE.md](../../CLAUDE.md).

Cross-engine layer above Google/Microsoft/Yahoo Japan/Baidu. The **Reporting API v0 is read-only for campaign entities** — there are no campaign/ad-group/ad mutate ops, so the only governed writes are **offline conversion upload/modify via the legacy v2 (DoubleClick Search) API**. Reads use SQL-like queries that mirror GAQL; async reports follow submit → poll → download. OAuth2 refresh-token auth.
