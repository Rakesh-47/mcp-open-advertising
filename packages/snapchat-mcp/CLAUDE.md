# snapchat-mcp

Platform notes for this package: quirks that are easy to forget when editing it. Repo-wide conventions are in the [root CLAUDE.md](../../CLAUDE.md).

Ad Squads (adGroups), cursor-based pagination. `snapchat_duplicate_entity` copies campaigns only (read + create, no native copy) and always creates the copy `PAUSED`, ignoring a `status` in `options`, as gads, dv360, msads and pinterest do.
