// Copyright (c) Cesteral AB. Licensed under the Apache License, Version 2.0.
// See LICENSE.md in the project root for full license terms.

/**
 * Canonical snapshot of a DV360 line item's budget (#298).
 *
 * A line item with a fixed currency budget carries it as `budget.maxAmount`,
 * int64 micros of the ADVERTISER's currency (v4 Discovery
 * `LineItemBudget.maxAmount`). The snapshot reports it as
 * `budget.lifetime = { amountMinor, currency }` in ISO 4217 minor units, so a
 * consumer comparing the before and after snapshots of a budget change can
 * compute the delta and the percentage. Where there is no fixed currency
 * amount the lifetime stays null: it must never read as an invented 0.
 *
 * The currency is not on the line item (it is `Advertiser.generalConfig.
 * currencyCode`), so the pure builder takes it as an argument and
 * `resolveDv360Currency` supplies it.
 */

import { describe, it, expect, vi } from "vitest";
import {
  buildDv360Snapshot,
  captureDv360Snapshot,
  DV360_UNKNOWN_CURRENCY,
  resolveDv360Currency,
  snapshotFromDv360Entity,
} from "../../../../src/mcp-server/tools/utils/capture-snapshot.js";
import {
  applyDv360Patch,
  runDv360CreateDryRun,
  runDv360DeleteDryRun,
  runDv360DuplicateDryRun,
  runDv360UpdateDryRun,
} from "../../../../src/mcp-server/tools/utils/dry-run.js";

const ids = { advertiserId: "adv-1", insertionOrderId: "io-1", lineItemId: "li-1" };

function lineItem(budget?: Record<string, unknown>): Record<string, unknown> {
  return {
    lineItemId: "li-1",
    displayName: "Sample Line Item",
    entityStatus: "ENTITY_STATUS_ACTIVE",
    ...(budget ? { budget } : {}),
  };
}

const fixedCurrency = (maxAmount: string) => ({
  budgetAllocationType: "LINE_ITEM_BUDGET_ALLOCATION_TYPE_FIXED",
  budgetUnit: "BUDGET_UNIT_CURRENCY",
  maxAmount,
});

function lifetimeOf(entity: Record<string, unknown>, currency: string) {
  return buildDv360Snapshot("lineItem", ids, entity, entity, currency)!.budget!.lifetime;
}

describe("buildDv360Snapshot: line item budget.maxAmount -> budget.lifetime", () => {
  it("maps a fixed currency maxAmount, converting micros to minor units", () => {
    // 50,000,000 micros = $50.00 = 5,000 cents.
    expect(lifetimeOf(lineItem(fixedCurrency("50000000")), "USD")).toEqual({
      amountMinor: 5000,
      currency: "USD",
    });
  });

  it("gives the before and after snapshots of a budget change a computable delta", () => {
    const patch = {
      data: { budget: fixedCurrency("30000000") },
      updateMask: "budget.maxAmount",
    };
    const preState = lineItem(fixedCurrency("50000000"));

    // The pre-state through the same normalizer: an empty mask applies nothing.
    const before = applyDv360Patch("lineItem", ids, preState, {}, "", "USD")!;
    const after = applyDv360Patch("lineItem", ids, preState, patch.data, patch.updateMask, "USD")!;

    expect(before.budget!.lifetime).toEqual({ amountMinor: 5000, currency: "USD" });
    expect(after.budget!.lifetime).toEqual({ amountMinor: 3000, currency: "USD" });
    const delta = after.budget!.lifetime!.amountMinor - before.budget!.lifetime!.amountMinor;
    expect(delta).toBe(-2000);
    expect(delta / before.budget!.lifetime!.amountMinor).toBeCloseTo(-0.4);
  });

  it("keeps daily and segments null: a line item has neither", () => {
    const budget = buildDv360Snapshot(
      "lineItem",
      ids,
      lineItem(fixedCurrency("50000000")),
      lineItem(fixedCurrency("50000000")),
      "USD"
    )!.budget!;
    expect(budget.daily).toBeNull();
    expect(budget.segments).toBeNull();
  });

  it("keeps lifetime null for an unlimited allocation, even if a stale maxAmount is echoed", () => {
    expect(
      lifetimeOf(
        lineItem({
          budgetAllocationType: "LINE_ITEM_BUDGET_ALLOCATION_TYPE_UNLIMITED",
          budgetUnit: "BUDGET_UNIT_CURRENCY",
          maxAmount: "50000000",
        }),
        "USD"
      )
    ).toBeNull();
    expect(
      lifetimeOf(
        lineItem({
          budgetAllocationType: "LINE_ITEM_BUDGET_ALLOCATION_TYPE_UNLIMITED",
          budgetUnit: "BUDGET_UNIT_CURRENCY",
        }),
        "USD"
      )
    ).toBeNull();
  });

  it("keeps lifetime null for an impression-based budget: maxAmount is a count, not money", () => {
    expect(
      lifetimeOf(
        lineItem({
          budgetAllocationType: "LINE_ITEM_BUDGET_ALLOCATION_TYPE_FIXED",
          budgetUnit: "BUDGET_UNIT_IMPRESSIONS",
          maxAmount: "100000",
        }),
        "USD"
      )
    ).toBeNull();
  });

  it("keeps lifetime null for an automatic allocation: the system sets maxAmount, nobody fixed it", () => {
    expect(
      lifetimeOf(
        lineItem({
          budgetAllocationType: "LINE_ITEM_BUDGET_ALLOCATION_TYPE_AUTOMATIC",
          budgetUnit: "BUDGET_UNIT_CURRENCY",
          maxAmount: "50000000",
        }),
        "USD"
      )
    ).toBeNull();
  });

  it("keeps lifetime null when the line item has no budget, or no maxAmount", () => {
    expect(lifetimeOf(lineItem(), "USD")).toBeNull();
    expect(
      lifetimeOf(
        lineItem({
          budgetAllocationType: "LINE_ITEM_BUDGET_ALLOCATION_TYPE_FIXED",
          budgetUnit: "BUDGET_UNIT_CURRENCY",
        }),
        "USD"
      )
    ).toBeNull();
  });

  it("keeps lifetime null for a maxAmount that is not a non-negative number", () => {
    for (const bad of ["", "abc", "-5000000", "1e400"]) {
      expect(lifetimeOf(lineItem(fixedCurrency(bad)), "USD")).toBeNull();
    }
  });

  it("reports a zero maxAmount as a real zero amount, not as unknown", () => {
    expect(lifetimeOf(lineItem(fixedCurrency("0")), "USD")).toEqual({
      amountMinor: 0,
      currency: "USD",
    });
  });

  it("converts by the currency's ISO 4217 exponent, not a fixed 100", () => {
    // 1,500 major units = 1,500,000,000 micros.
    const micros = "1500000000";
    expect(lifetimeOf(lineItem(fixedCurrency(micros)), "USD")).toEqual({
      amountMinor: 150000,
      currency: "USD",
    });
    // JPY has no minor unit: 1,500 yen is 1,500.
    expect(lifetimeOf(lineItem(fixedCurrency(micros)), "JPY")).toEqual({
      amountMinor: 1500,
      currency: "JPY",
    });
    // KWD has three: 1,500 dinar is 1,500,000 fils.
    expect(lifetimeOf(lineItem(fixedCurrency(micros)), "KWD")).toEqual({
      amountMinor: 1500000,
      currency: "KWD",
    });
  });

  it("rounds a sub-minor-unit remainder to the nearest minor unit", () => {
    // 1,234,567 micros = 1.234567 USD -> 123.4567 cents -> 123.
    expect(lifetimeOf(lineItem(fixedCurrency("1234567")), "USD")?.amountMinor).toBe(123);
  });

  it("carries the unknown-currency marker through when the currency could not be read", () => {
    expect(lifetimeOf(lineItem(fixedCurrency("50000000")), DV360_UNKNOWN_CURRENCY)).toEqual({
      amountMinor: 5000,
      currency: "XXX",
    });
  });
});

describe("buildDv360Snapshot: insertion order segments use the same currency conversion", () => {
  const io = (micros: string) => ({
    insertionOrderId: "io-1",
    displayName: "Sample IO",
    entityStatus: "ENTITY_STATUS_ACTIVE",
    budget: {
      budgetUnit: "BUDGET_UNIT_CURRENCY",
      budgetSegments: [
        {
          budgetAmountMicros: micros,
          dateRange: {
            startDate: { year: 2026, month: 1, day: 1 },
            endDate: { year: 2026, month: 12, day: 31 },
          },
        },
      ],
    },
  });

  it("keeps USD segments at cents", () => {
    const budget = buildDv360Snapshot(
      "insertionOrder",
      ids,
      io("50000000"),
      io("50000000"),
      "USD"
    )!.budget!;
    expect(budget.lifetime).toEqual({ amountMinor: 5000, currency: "USD" });
    expect(budget.segments![0]).toMatchObject({ amountMinor: 5000, currency: "USD" });
  });

  it("converts a JPY segment by exponent 0 and labels it JPY", () => {
    const budget = buildDv360Snapshot(
      "insertionOrder",
      ids,
      io("1500000000"),
      io("1500000000"),
      "JPY"
    )!.budget!;
    expect(budget.lifetime).toEqual({ amountMinor: 1500, currency: "JPY" });
    expect(budget.segments![0]).toMatchObject({ amountMinor: 1500, currency: "JPY" });
  });
});

describe("snapshotFromDv360Entity", () => {
  it("passes the currency through to the line item lifetime", () => {
    const snapshot = snapshotFromDv360Entity(
      "lineItem",
      ids,
      lineItem(fixedCurrency("1500000000")),
      "JPY"
    );
    expect(snapshot!.budget!.lifetime).toEqual({ amountMinor: 1500, currency: "JPY" });
  });
});

describe("resolveDv360Currency", () => {
  it("returns the advertiser's currency from the service", async () => {
    const service = { getAdvertiserCurrency: vi.fn().mockResolvedValue("EUR") };
    await expect(resolveDv360Currency(service, "lineItem", ids, {} as any)).resolves.toBe("EUR");
    expect(service.getAdvertiserCurrency).toHaveBeenCalledWith("adv-1", {});
  });

  it("degrades to XXX, never USD, when the currency cannot be read", async () => {
    const failing = { getAdvertiserCurrency: vi.fn().mockRejectedValue(new Error("403")) };
    await expect(resolveDv360Currency(failing, "lineItem", ids)).resolves.toBe("XXX");
    await expect(resolveDv360Currency({}, "lineItem", ids)).resolves.toBe("XXX");
    await expect(resolveDv360Currency(failing, "lineItem", {})).resolves.toBe("XXX");
    const garbage = { getAdvertiserCurrency: vi.fn().mockResolvedValue("dollars") };
    await expect(resolveDv360Currency(garbage, "lineItem", ids)).resolves.toBe("XXX");
    expect(failing.getAdvertiserCurrency).toHaveBeenCalledTimes(1);
  });

  it("reads nothing for an entity type that has no canonical snapshot", async () => {
    const service = { getAdvertiserCurrency: vi.fn().mockResolvedValue("EUR") };
    await expect(resolveDv360Currency(service, "creative", ids)).resolves.toBe("XXX");
    expect(service.getAdvertiserCurrency).not.toHaveBeenCalled();
  });
});

describe("captureDv360Snapshot", () => {
  it("resolves the advertiser's currency itself for the re-read fallback", async () => {
    const service = {
      getEntity: vi.fn().mockResolvedValue(lineItem(fixedCurrency("1500000000"))),
      getAdvertiserCurrency: vi.fn().mockResolvedValue("JPY"),
    };
    const snapshot = await captureDv360Snapshot(service, "lineItem", ids, {} as any);
    expect(snapshot!.budget!.lifetime).toEqual({ amountMinor: 1500, currency: "JPY" });
  });
});

describe("dry-run runners project the line item budget in the advertiser's currency", () => {
  const archived = {
    ...lineItem(fixedCurrency("1500000000")),
    entityStatus: "ENTITY_STATUS_ARCHIVED",
  };
  const service = () => ({
    getEntity: vi.fn().mockResolvedValue(archived),
    getAdvertiserCurrency: vi.fn().mockResolvedValue("JPY"),
  });
  const jpy1500 = { amountMinor: 1500, currency: "JPY" };

  it("create: the would-be-created line item carries its budget", async () => {
    const svc = service();
    const result = await runDv360CreateDryRun(
      {
        entityType: "lineItem",
        ids: { advertiserId: "adv-1" },
        data: { displayName: "New", budget: fixedCurrency("1500000000") },
      },
      svc,
      {} as any
    );
    expect(result.expectedPostState!.budget!.lifetime).toEqual(jpy1500);
    expect(svc.getAdvertiserCurrency).toHaveBeenCalledWith("adv-1", {});
  });

  it("delete: the deleted line item keeps its budget", async () => {
    const result = await runDv360DeleteDryRun(
      { entityType: "lineItem", ids },
      service(),
      {} as any
    );
    expect(result.expectedPostState!.status.canonical).toBe("deleted");
    expect(result.expectedPostState!.budget!.lifetime).toEqual(jpy1500);
  });

  it("duplicate: the copy carries the source's budget", async () => {
    const result = await runDv360DuplicateDryRun(
      { entityType: "lineItem", ids },
      service(),
      {} as any
    );
    expect(result.expectedPostState!.budget!.lifetime).toEqual(jpy1500);
  });

  it("update: only the masked field changes, in the advertiser's currency", async () => {
    const result = await runDv360UpdateDryRun(
      {
        entityType: "lineItem",
        ids,
        data: { budget: fixedCurrency("1000000000") },
        updateMask: "budget.maxAmount",
      },
      service(),
      {} as any
    );
    expect(result.expectedPostState!.budget!.lifetime).toEqual({
      amountMinor: 1000,
      currency: "JPY",
    });
  });
});

describe("ISO 4217 exponents in snapshots (#300 review S2)", () => {
  it("reads RSD 1,500 as 150,000 minor units, the unit the governance layer reads back", () => {
    // 1,500 dinar = 1,500,000,000 micros. ISO 4217 says RSD has exponent 2; the
    // CLDR display digits `Intl` reports are 0, which gave 1,500 here and made
    // governance read 15.00 RSD (100x low, so an increase booked 1% of its size).
    expect(lifetimeOf(lineItem(fixedCurrency("1500000000")), "RSD")).toEqual({
      amountMinor: 150000,
      currency: "RSD",
    });
  });

  it("converts every code on which Intl and ISO 4217 disagree by the ISO exponent", () => {
    const micros = "1500000000";
    for (const code of ["AFN", "ALL", "IRR", "KPW", "LAK", "LBP", "MGA", "MMK", "SLL", "SOS"]) {
      expect(lifetimeOf(lineItem(fixedCurrency(micros)), code)?.amountMinor, code).toBe(150000);
    }
    // IQD is exponent 3 in ISO 4217 (Intl says 0).
    expect(lifetimeOf(lineItem(fixedCurrency(micros)), "IQD")?.amountMinor).toBe(1500000);
  });

  it("labels the amounts XXX, not the code, when the currency is not a known ISO 4217 code", () => {
    expect(lifetimeOf(lineItem(fixedCurrency("50000000")), "ZZZ")).toEqual({
      amountMinor: 5000,
      currency: "XXX",
    });
    expect(lifetimeOf(lineItem(fixedCurrency("50000000")), "usd")?.currency).toBe("XXX");
  });

  it("resolveDv360Currency treats a code the table does not know as unresolved", async () => {
    const service = { getAdvertiserCurrency: vi.fn().mockResolvedValue("ZZZ") };
    await expect(resolveDv360Currency(service, "lineItem", ids)).resolves.toBe("XXX");
  });

  it("applyDv360Patch refuses a call without the currency instead of guessing one", () => {
    expect(() =>
      (applyDv360Patch as (...args: unknown[]) => unknown)(
        "lineItem",
        ids,
        lineItem(fixedCurrency("50000000")),
        {},
        ""
      )
    ).toThrow(/currency/);
  });
});

describe("a line item's budget unit is output-only, so it is not read from the payload alone (#300 review S1)", () => {
  const FIXED = "LINE_ITEM_BUDGET_ALLOCATION_TYPE_FIXED";
  // What a caller sends: allocation and amount, no `budgetUnit`.
  const noUnit = (maxAmount: string) => ({ budgetAllocationType: FIXED, maxAmount });
  const parent = (budgetUnit?: string) => ({
    insertionOrderId: "io-1",
    displayName: "IO",
    entityStatus: "ENTITY_STATUS_ACTIVE",
    budget: budgetUnit ? { budgetUnit } : {},
  });
  const parentCalls = (svc: { getEntity: ReturnType<typeof vi.fn> }) =>
    svc.getEntity.mock.calls.filter(([type]) => type === "insertionOrder");

  function createArgs(budget: Record<string, unknown>, data: Record<string, unknown> = {}) {
    return {
      entityType: "lineItem",
      ids: { advertiserId: "adv-1" },
      data: { displayName: "New", insertionOrderId: "io-1", budget, ...data },
    };
  }

  function createService(parentEntity: Record<string, unknown> | Error) {
    return {
      getEntity: vi.fn(async (type: string) => {
        if (type !== "insertionOrder") throw new Error(`unexpected read of ${type}`);
        if (parentEntity instanceof Error) throw parentEntity;
        return parentEntity;
      }),
      getAdvertiserCurrency: vi.fn().mockResolvedValue("JPY"),
    };
  }

  describe("create dry run", () => {
    it("takes the unit from the parent insertion order", async () => {
      const svc = createService(parent("BUDGET_UNIT_CURRENCY"));
      const result = await runDv360CreateDryRun(createArgs(noUnit("1500000000")), svc, {
        requestId: "r",
      } as any);
      expect(svc.getEntity).toHaveBeenCalledWith(
        "insertionOrder",
        { advertiserId: "adv-1", insertionOrderId: "io-1" },
        { requestId: "r" }
      );
      expect(result.wouldSucceed).toBe(true);
      expect(result.expectedPostState!.budget!.lifetime).toEqual({
        amountMinor: 1500,
        currency: "JPY",
      });
    });

    it("leaves lifetime null, and passes, when the parent's budget is impression-based", async () => {
      const svc = createService(parent("BUDGET_UNIT_IMPRESSIONS"));
      const result = await runDv360CreateDryRun(createArgs(noUnit("100000")), svc, {} as any);
      expect(result.wouldSucceed).toBe(true);
      expect(result.expectedPostState!.budget!.lifetime).toBeNull();
    });

    it("reads no parent when the payload carries the unit or sets no fixed amount", async () => {
      const svc = createService(parent("BUDGET_UNIT_CURRENCY"));
      await runDv360CreateDryRun(createArgs(fixedCurrency("1500000000")), svc, {} as any);
      await runDv360CreateDryRun(
        createArgs({ budgetAllocationType: "LINE_ITEM_BUDGET_ALLOCATION_TYPE_UNLIMITED" }),
        svc,
        {} as any
      );
      await runDv360CreateDryRun(
        { entityType: "campaign", ids: { advertiserId: "adv-1" }, data: { displayName: "C" } },
        svc,
        {} as any
      );
      expect(parentCalls(svc)).toHaveLength(0);
    });

    it("says the budget is undetermined, and does not pass, when no unit can be found", async () => {
      for (const [label, svc, args] of [
        [
          "no insertionOrderId in the payload",
          createService(parent("BUDGET_UNIT_CURRENCY")),
          createArgs(noUnit("1500000000"), { insertionOrderId: undefined }),
        ],
        [
          "the parent has no budget unit",
          createService(parent()),
          createArgs(noUnit("1500000000")),
        ],
      ] as const) {
        const result = await runDv360CreateDryRun(args, svc, {} as any);
        expect(result.wouldSucceed, label).toBe(false);
        expect(result.validationErrors, label).toEqual([
          expect.objectContaining({ code: "BUDGET_UNIT_UNDETERMINED", field: "budget.budgetUnit" }),
        ]);
        // Unknown, never 0: the amount is not claimed.
        expect(result.expectedPostState!.budget!.lifetime, label).toBeNull();
      }
    });

    it("fails the dry run when the parent cannot be read, as an unreadable pre-state does", async () => {
      const svc = createService(new Error("insertion order 404"));
      await expect(
        runDv360CreateDryRun(createArgs(noUnit("1500000000")), svc, {} as any)
      ).rejects.toThrow(/404/);
    });
  });

  describe("update dry run", () => {
    const wholeBudget = (maxAmount: string) => ({
      entityType: "lineItem",
      ids,
      data: { budget: noUnit(maxAmount) },
      updateMask: "budget",
    });

    it("keeps the current line item's unit when the mask replaces the whole budget", async () => {
      const svc = {
        getEntity: vi.fn().mockResolvedValue(lineItem(fixedCurrency("1500000000"))),
        getAdvertiserCurrency: vi.fn().mockResolvedValue("JPY"),
      };
      const result = await runDv360UpdateDryRun(wholeBudget("1000000000"), svc, {} as any);
      expect(result.expectedPostState!.budget!.lifetime).toEqual({
        amountMinor: 1000,
        currency: "JPY",
      });
    });

    it("says the budget is undetermined when neither the payload nor the current line item has a unit", async () => {
      const svc = {
        getEntity: vi.fn().mockResolvedValue(lineItem(noUnit("1500000000"))),
        getAdvertiserCurrency: vi.fn().mockResolvedValue("JPY"),
      };
      const result = await runDv360UpdateDryRun(wholeBudget("1000000000"), svc, {} as any);
      expect(result.wouldSucceed).toBe(false);
      expect(result.validationErrors).toEqual([
        expect.objectContaining({ code: "BUDGET_UNIT_UNDETERMINED" }),
      ]);
      expect(result.expectedPostState!.budget!.lifetime).toBeNull();
    });
  });

  it("buildDv360Snapshot falls back to the current entity's unit, and to null without one", () => {
    const current = lineItem(fixedCurrency("1500000000"));
    const applied = lineItem(noUnit("1000000000"));
    expect(buildDv360Snapshot("lineItem", ids, current, applied, "JPY")!.budget!.lifetime).toEqual({
      amountMinor: 1000,
      currency: "JPY",
    });
    expect(
      buildDv360Snapshot("lineItem", ids, lineItem(noUnit("1500000000")), applied, "JPY")!.budget!
        .lifetime
    ).toBeNull();
  });
});
