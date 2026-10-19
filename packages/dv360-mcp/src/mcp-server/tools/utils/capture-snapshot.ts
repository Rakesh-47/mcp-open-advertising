// Copyright (c) Cesteral AB. Licensed under the Apache License, Version 2.0.
// See LICENSE.md in the project root for full license terms.

/**
 * Snapshot capture helpers for DV360 `update_entity`. PR-D wiring.
 *
 * Extracted from `dry-run.ts` so the same read-and-normalize logic is reused
 * for:
 * - Symbolic dry-run (PR-C): read current entity, overlay updateMask fields,
 *   normalize.
 * - Real-write before/after (PR-D): read pre-state at handler start, execute
 *   the write, normalize the patched resource that DV360 returns.
 *
 * The canonical shape covers status, budget (an insertion order's segments, a
 * line item's fixed `maxAmount`; micros → ISO 4217 minor units of the
 * advertiser's currency), and basic flight schedule. Other DV360 entity types
 * (creatives, ad groups) fall outside round 1.
 */

import type {
  CanonicalEntityKind,
  CanonicalStatus,
  NormalizedEntitySnapshot,
  RequestContext,
} from "@cesteral/shared";

export interface Dv360ServiceLike {
  getEntity?: (
    entityType: string,
    ids: Record<string, string>,
    context?: RequestContext
  ) => Promise<unknown>;
  /** ISO 4217 currency of the advertiser (`DV360Service.getAdvertiserCurrency`). */
  getAdvertiserCurrency?: (advertiserId: string, context?: RequestContext) => Promise<string>;
}

/**
 * ISO 4217 "no currency involved" code, used when the advertiser's currency
 * cannot be read, so a snapshot never claims a currency it does not know.
 */
export const DV360_UNKNOWN_CURRENCY = "XXX";

export const ENTITY_KIND_MAP: Record<string, CanonicalEntityKind> = {
  campaign: "campaign",
  insertionOrder: "insertion_order",
  lineItem: "line_item",
};

/**
 * The advertiser's currency for snapshots of `entityType`: every DV360 money
 * amount is micros of it, and neither the line item nor the insertion order
 * carries it. Degrades to DV360_UNKNOWN_CURRENCY when the service cannot
 * provide it, rather than failing the write or dry run the snapshot belongs
 * to. Reads nothing for a type with no canonical snapshot.
 */
export async function resolveDv360Currency(
  service: Dv360ServiceLike,
  entityType: string,
  ids: Record<string, string>,
  context?: RequestContext
): Promise<string> {
  const advertiserId = ids.advertiserId;
  if (!ENTITY_KIND_MAP[entityType] || !advertiserId || !service.getAdvertiserCurrency) {
    return DV360_UNKNOWN_CURRENCY;
  }
  try {
    const code = await service.getAdvertiserCurrency(advertiserId, context);
    return /^[A-Z]{3}$/.test(code) ? code : DV360_UNKNOWN_CURRENCY;
  } catch {
    return DV360_UNKNOWN_CURRENCY;
  }
}

const STATUS_MAP: Record<string, CanonicalStatus> = {
  ENTITY_STATUS_ACTIVE: "active",
  ENTITY_STATUS_PAUSED: "paused",
  ENTITY_STATUS_ARCHIVED: "archived",
  ENTITY_STATUS_DELETED: "deleted",
  ENTITY_STATUS_DRAFT: "unknown",
  ENTITY_STATUS_SCHEDULED_FOR_DELETION: "deleted",
};

function normalizeStatus(raw: unknown): { canonical: CanonicalStatus; platformRaw: string } {
  const platformRaw = typeof raw === "string" ? raw : "";
  return { canonical: STATUS_MAP[platformRaw] ?? "unknown", platformRaw };
}

/**
 * ISO 4217 minor-unit exponent for `currency` (USD 2, JPY 0, KWD 3), read from
 * the runtime's ICU currency data. Falls back to 2 for codes ICU does not know
 * (including DV360_UNKNOWN_CURRENCY).
 */
function currencyExponent(currency: string): number {
  if (currency === DV360_UNKNOWN_CURRENCY) return 2;
  try {
    const digits = new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions()
      .maximumFractionDigits;
    return typeof digits === "number" ? digits : 2;
  } catch {
    return 2;
  }
}

/**
 * Micros of the advertiser currency → its minor units. 1,000,000 micros is one
 * major unit: $1.00 = 100 cents, but ¥1 = 1 minor unit (JPY has none smaller).
 * Only a non-negative integer counts: an int64 arrives as a digit string.
 */
function microsToMinor(micros: unknown, currency: string): number | undefined {
  if (typeof micros !== "string" && typeof micros !== "number") return undefined;
  const n = typeof micros === "string" ? (/^\d+$/.test(micros) ? Number(micros) : NaN) : micros;
  if (!Number.isFinite(n) || n < 0) return undefined;
  const minor = Math.round(n / 10 ** (6 - currencyExponent(currency)));
  return Number.isSafeInteger(minor) ? minor : undefined;
}

/**
 * A line item's lifetime budget: a FIXED allocation in currency carries its
 * cap in `budget.maxAmount`, micros of the advertiser's currency (v4 Discovery
 * `LineItemBudget.maxAmount`). Everything else has no fixed currency amount, so
 * the lifetime stays null rather than reading as 0:
 * - UNLIMITED: "this field is not applicable and will be ignored by the system",
 *   so a stale value may still be echoed back;
 * - AUTOMATIC: "immutable and is set by the system", not a cap anyone fixed;
 * - BUDGET_UNIT_IMPRESSIONS: `maxAmount` is a number of impressions.
 */
function lineItemLifetime(
  budget: Record<string, unknown> | undefined,
  currency: string
): { amountMinor: number; currency: string } | null {
  if (
    budget?.budgetAllocationType !== "LINE_ITEM_BUDGET_ALLOCATION_TYPE_FIXED" ||
    budget?.budgetUnit !== "BUDGET_UNIT_CURRENCY"
  ) {
    return null;
  }
  const amountMinor = microsToMinor(budget.maxAmount, currency);
  return amountMinor == null ? null : { amountMinor, currency };
}

/**
 * Pure builder. `applied` is the entity post-overlay (or post-write); `current`
 * is only used for status fallback when `applied.entityStatus` is missing.
 * `currency` is the advertiser's ISO 4217 code (`resolveDv360Currency`): DV360
 * amounts are micros of it, which the entity itself does not carry.
 */
export function buildDv360Snapshot(
  entityType: string,
  ids: Record<string, string>,
  current: Record<string, unknown>,
  applied: Record<string, unknown>,
  currency: string
): NormalizedEntitySnapshot | null {
  const entityKind = ENTITY_KIND_MAP[entityType];
  if (!entityKind) return null;

  const platformEntityId =
    ids.lineItemId ?? ids.insertionOrderId ?? ids.campaignId ?? ids.advertiserId ?? "";

  const merged = applied as Record<string, any>;

  const segments: Array<{
    amountMinor: number;
    currency: string;
    startAt: string | null;
    endAt: string | null;
  }> = [];
  const segArr = merged?.budget?.budgetSegments;
  if (Array.isArray(segArr)) {
    for (const seg of segArr) {
      const amountMinor = microsToMinor(seg?.budgetAmountMicros, currency);
      if (amountMinor == null) continue;
      const start = seg?.dateRange?.startDate;
      const end = seg?.dateRange?.endDate;
      const startAt = start
        ? `${start.year}-${String(start.month).padStart(2, "0")}-${String(start.day).padStart(2, "0")}`
        : null;
      const endAt = end
        ? `${end.year}-${String(end.month).padStart(2, "0")}-${String(end.day).padStart(2, "0")}`
        : null;
      segments.push({ amountMinor, currency, startAt, endAt });
    }
  }
  const lifetimeMinor = segments.reduce((sum, s) => sum + s.amountMinor, 0);

  const flightStart = merged?.flight?.dateRange?.startDate;
  const flightEnd = merged?.flight?.dateRange?.endDate;

  return {
    schemaVersion: 1,
    platform: "dv360",
    entityKind,
    platformEntityId,
    displayName: typeof merged.displayName === "string" ? merged.displayName : null,
    accountId: typeof ids.advertiserId === "string" ? ids.advertiserId : null,
    status: normalizeStatus(merged.entityStatus ?? (current as any).entityStatus),
    budget: {
      daily: null,
      lifetime:
        entityKind === "line_item"
          ? lineItemLifetime(merged?.budget, currency)
          : lifetimeMinor > 0
            ? { amountMinor: lifetimeMinor, currency }
            : null,
      segments: segments.length > 0 ? segments : null,
    },
    schedule: {
      startAt: flightStart
        ? `${flightStart.year}-${String(flightStart.month).padStart(2, "0")}-${String(flightStart.day).padStart(2, "0")}`
        : null,
      endAt: flightEnd
        ? `${flightEnd.year}-${String(flightEnd.month).padStart(2, "0")}-${String(flightEnd.day).padStart(2, "0")}`
        : null,
    },
  };
}

/**
 * Read the entity through the service-layer abstraction and normalize.
 * Returns `undefined` if the entity type is not in the canonical scope or
 * the read fails.
 */
export async function captureDv360Snapshot(
  dv360Service: Dv360ServiceLike,
  entityType: string,
  ids: Record<string, string>,
  context: RequestContext
): Promise<NormalizedEntitySnapshot | undefined> {
  if (!ENTITY_KIND_MAP[entityType] || !dv360Service.getEntity) return undefined;
  try {
    const current = (await dv360Service.getEntity(entityType, ids, context)) as Record<
      string,
      unknown
    >;
    if (!current || typeof current !== "object") return undefined;
    const currency = await resolveDv360Currency(dv360Service, entityType, ids, context);
    const snapshot = buildDv360Snapshot(entityType, ids, current, current, currency);
    return snapshot ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Normalize an entity object that's already in hand (e.g. the patched resource
 * returned by the DV360 PATCH call). No I/O.
 *
 * Returns undefined when the object lacks every field the canonical snapshot
 * would surface (status, displayName, budget). DV360 PATCH normally returns
 * the patched resource in full, but if the SDK shape is unexpected (e.g. an
 * empty `{}` or a wrapped envelope), callers should fall back to a re-read
 * rather than emit a snapshot with `status: unknown` derived from absent data.
 * `currency` is the advertiser's (`resolveDv360Currency`).
 */
export function snapshotFromDv360Entity(
  entityType: string,
  ids: Record<string, string>,
  entity: Record<string, unknown>,
  currency: string
): NormalizedEntitySnapshot | undefined {
  if (!ENTITY_KIND_MAP[entityType]) return undefined;
  if (
    !entity ||
    (entity.entityStatus == null && entity.displayName == null && entity.budget == null)
  ) {
    return undefined;
  }
  const snapshot = buildDv360Snapshot(entityType, ids, entity, entity, currency);
  return snapshot ?? undefined;
}
