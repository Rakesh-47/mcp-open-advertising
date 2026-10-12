# dv360-mcp

Platform notes for this package: quirks that are easy to forget when editing it. Repo-wide conventions are in the [root CLAUDE.md](../../CLAUDE.md).

`dv360_delete_entity` performs a **hard delete** on most entities (verified live for `campaign`: subsequent `get_entity` returns 404). **Line items must be archived first** (`bulk_update_status` → `ENTITY_STATUS_ARCHIVED`) before delete — DV360 returns 400 otherwise. Use `dv360_update_entity` with `entityStatus=ENTITY_STATUS_ARCHIVED` for reversible removal on other entity types — archiving is itself irreversible (cannot unarchive). `dv360_duplicate_entity` always lands the copy in a non-running state: line items use DV360's native `lineItems:duplicate` (server-side copy; an ACTIVE copy is patched to `PAUSED`), insertion orders have no native duplicate and are copied GET→POST in `DRAFT` — the only status `CreateInsertionOrder`/`CreateLineItem` accept (v4 Discovery `entityStatus`). `inventorySource` / `inventorySourceGroup` list calls require either `partnerId` or `advertiserId` (validated client-side).

## Dynamic Schema Pattern (DV360 MCP)

Full discriminated union schemas exceed ~1MB (EPIPE on stdio). Solution: simplified schemas for tool registration + MCP Resources for full details on-demand.

- Entity types declared in `STATIC_ENTITY_API_METADATA` in `entity-mapping-dynamic.ts`
- Resource URIs: `entity-schema://{type}`, `entity-fields://{type}`, `entity-examples://{type}`
- Adding new entity: add 5-line entry to `STATIC_ENTITY_API_METADATA`; schemas/resources auto-generated
- Test sizes: `cd packages/dv360-mcp && node tests/test-schema-size.cjs`
