# pinterest-mcp

Platform notes for this package: quirks that are easy to forget when editing it. Repo-wide conventions are in the [root CLAUDE.md](../../CLAUDE.md).

cursor-based pagination via `bookmark` tokens. Video upload via `/v5/media`; image creatives reference URLs directly (Pinterest's `/v5/media` endpoint only supports `media_type="video"`). `pinterest_duplicate_entity` copies campaigns only (read + create, no native copy; ad groups and ads are not copied) and always creates the copy `PAUSED`, ignoring a `status` in `options`, as msads does.
