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
  DryRunValidationError,
  NormalizedEntitySnapshot,
  RequestContext,
} from "@cesteral/shared";
import { currencyMinorUnitExponent, knownCurrencyOrNull } from "./iso-4217.js";

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
 * cannot be read or is not a known ISO 4217 code, so a snapshot never claims a
 * currency it does not know. Governance reads a snapshot in it as an unknown
 * currency and refuses a non-zero exposure rather than defaulting one.
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
    return knownCurrencyOrNull(code) ?? DV360_UNKNOWN_CURRENCY;
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
 * The exponent for a currency that is unresolved (DV360_UNKNOWN_CURRENCY). An
 * amount in an unresolved currency is magnitude-only: the XXX label beside it
 * is what governance refuses on, so the exponent chosen here cannot size an
 * exposure. Governance converts such an amount at 2 for display, and so does
 * this.
 */
const UNRESOLVED_CURRENCY_EXPONENT = 2;

/**
 * Micros of the advertiser currency → its ISO 4217 minor units (the table in
 * `iso-4217.ts`, equal to the governance layer's). 1,000,000 micros is one
 * major unit: $1.00 = 100 cents, ¥1 = 1 minor unit (JPY has none smaller),
 * 1 KWD = 1,000 fils. Only a non-negative integer counts: an int64 arrives as
 * a digit string.
 */
function microsToMinor(micros: unknown, currency: string): number | undefined {
  if (typeof micros !== "string" && typeof micros !== "number") return undefined;
  const n = typeof micros === "string" ? (/^\d+$/.test(micros) ? Number(micros) : NaN) : micros;
  if (!Number.isFinite(n) || n < 0) return undefined;
  const exponent = currencyMinorUnitExponent(currency) ?? UNRESOLVED_CURRENCY_EXPONENT;
  const minor = Math.round(n / 10 ** (6 - exponent));
  return Number.isSafeInteger(minor) ? minor : undefined;
}

const FIXED_ALLOCATION = "LINE_ITEM_BUDGET_ALLOCATION_TYPE_FIXED";
type LineItemBudgetUnit = "BUDGET_UNIT_CURRENCY" | "BUDGET_UNIT_IMPRESSIONS";

/**
 * A line item's budget unit. `LineItemBudget.budgetUnit` is "Output only ...
 * inherited from the parent insertion order" (v4 Discovery), so a payload that
 * creates a line item or replaces its whole `budget` does not carry it. It is
 * taken from the budget being normalized, else from the entity it replaces
 * (`current`). `undefined` when neither says: the unit, and so whether
 * `maxAmount` is money or a count of impressions, is not known.
 */
function resolveLineItemBudgetUnit(
  budget: Record<string, unknown> | undefined,
  currentBudget: Record<string, unknown> | undefined
): LineItemBudgetUnit | undefined {
  for (const unit of [budget?.budgetUnit, currentBudget?.budgetUnit]) {
    if (unit === "BUDGET_UNIT_CURRENCY" || unit === "BUDGET_UNIT_IMPRESSIONS") return unit;
  }
  return undefined;
}

/**
 * The dry-run error for a line item whose budget has a fixed amount but no
 * determinable unit. The snapshot cannot say whether `maxAmount` is money, and
 * a lifetime of null is read downstream as "books no exposure". An explicit
 * failure is the only way to say "unknown, not zero" through the canonical
 * shape, so the dry run does not pass. `undefined` when the unit is known or
 * there is no fixed amount to size.
 */
export function lineItemBudgetUnitUndetermined(
  entityType: string,
  current: Record<string, unknown>,
  applied: Record<string, unknown>
): DryRunValidationError | undefined {
  if (entityType !== "lineItem") return undefined;
  const budget = applied.budget as Record<string, unknown> | undefined;
  if (budget?.budgetAllocationType !== FIXED_ALLOCATION || budget.maxAmount == null) {
    return undefined;
  }
  const currentBudget = current.budget as Record<string, unknown> | undefined;
  if (resolveLineItemBudgetUnit(budget, currentBudget)) return undefined;
  return {
    code: "BUDGET_UNIT_UNDETERMINED",
    message:
      "The line item's budget unit (currency or impressions) is output-only and could not be " +
      "determined from the payload, the current line item or the parent insertion order, so the " +
      "size of its budget is unknown.",
    field: "budget.budgetUnit",
  };
}

/**
 * `data` for the snapshot of a line item that is about to be created, with the
 * output-only `budget.budgetUnit` filled in from the parent insertion order
 * (`data.insertionOrderId`), which the new line item inherits it from. Reads
 * the parent only when the budget has a fixed amount and no unit; a read
 * failure propagates, like an unreadable pre-state does for an update dry run.
 * Returns `data` unchanged when there is nothing to inherit.
 */
export async function inheritLineItemBudgetUnit(
  service: Dv360ServiceLike,
  entityType: string,
  ids: Record<string, string>,
  data: Record<string, unknown>,
  context?: RequestContext
): Promise<Record<string, unknown>> {
  const budget = data.budget as Record<string, unknown> | undefined;
  const advertiserId = ids.advertiserId ?? data.advertiserId;
  const insertionOrderId = data.insertionOrderId;
  if (
    entityType !== "lineItem" ||
    budget?.budgetAllocationType !== FIXED_ALLOCATION ||
    budget.maxAmount == null ||
    resolveLineItemBudgetUnit(budget, undefined) ||
    typeof advertiserId !== "string" ||
    typeof insertionOrderId !== "string" ||
    !service.getEntity
  ) {
    return data;
  }
  const parent = (await service.getEntity(
    "insertionOrder",
    { advertiserId, insertionOrderId },
    context
  )) as Record<string, any> | undefined;
  const unit = resolveLineItemBudgetUnit(parent?.budget, undefined);
  return unit ? { ...data, budget: { ...budget, budgetUnit: unit } } : data;
}

/**
 * A line item's lifetime budget: a FIXED allocation in currency carries its
 * cap in `budget.maxAmount`, micros of the advertiser's currency (v4 Discovery
 * `LineItemBudget.maxAmount`). Everything else has no fixed currency amount, so
 * the lifetime stays null rather than reading as 0:
 * - UNLIMITED: "this field is not applicable and will be ignored by the system",
 *   so a stale value may still be echoed back;
 * - AUTOMATIC: "immutable and is set by the system", not a cap anyone fixed;
 * - BUDGET_UNIT_IMPRESSIONS: `maxAmount` is a number of impressions;
 * - no determinable unit: see {@link lineItemBudgetUnitUndetermined}.
 */
function lineItemLifetime(
  budget: Record<string, unknown> | undefined,
  unit: LineItemBudgetUnit | undefined,
  currency: string
): { amountMinor: number; currency: string } | null {
  if (budget?.budgetAllocationType !== FIXED_ALLOCATION || unit !== "BUDGET_UNIT_CURRENCY") {
    return null;
  }
  const amountMinor = microsToMinor(budget.maxAmount, currency);
  return amountMinor == null ? null : { amountMinor, currency };
}

/**
 * Pure builder. `applied` is the entity post-overlay (or post-write); `current`
 * is the entity it replaces, used for the status when `applied.entityStatus` is
 * missing and for a line item's budget unit when `applied.budget` omits it.
 * `currency` is the advertiser's ISO 4217 code (`resolveDv360Currency`): DV360
 * amounts are micros of it, which the entity itself does not carry. A code that
 * is not a known ISO 4217 currency is reported as DV360_UNKNOWN_CURRENCY.
 */
export function buildDv360Snapshot(
  entityType: string,
  ids: Record<string, string>,
  current: Record<string, unknown>,
  applied: Record<string, unknown>,
  currencyCode: string
): NormalizedEntitySnapshot | null {
  const entityKind = ENTITY_KIND_MAP[entityType];
  if (!entityKind) return null;
  const currency = knownCurrencyOrNull(currencyCode) ?? DV360_UNKNOWN_CURRENCY;

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
          ? lineItemLifetime(
              merged?.budget,
              resolveLineItemBudgetUnit(
                merged?.budget,
                current.budget as Record<string, unknown> | undefined
              ),
              currency
            )
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
  context: RequestContext,
  /** The currency the caller already resolved, so the two snapshots of one write cannot differ. */
  resolvedCurrency?: string
): Promise<NormalizedEntitySnapshot | undefined> {
  if (!ENTITY_KIND_MAP[entityType] || !dv360Service.getEntity) return undefined;
  try {
    const current = (await dv360Service.getEntity(entityType, ids, context)) as Record<
      string,
      unknown
    >;
    if (!current || typeof current !== "object") return undefined;
    const currency =
      resolvedCurrency ?? (await resolveDv360Currency(dv360Service, entityType, ids, context));
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
