// Copyright (c) Cesteral AB. Licensed under the Apache License, Version 2.0.
// See LICENSE.md in the project root for full license terms.

/**
 * A line item's budget in the canonical snapshot, end to end over the wire
 * (#298). Real tool logic over real session services (DV360Service,
 * DV360HttpClient, the Google OAuth2 refresh adapter, a real `RateLimiter`),
 * with only `globalThis.fetch` stubbed.
 *
 * The snapshot amounts are denominated in the ADVERTISER's currency, which the
 * line item does not carry, so a governed write reads it once per advertiser
 * and session:
 *
 * basis: `advertisers.get` — GET `v4/advertisers/{advertisersId}`, response
 * Advertiser; `schemas.AdvertiserGeneralConfig.currencyCode`: "Required.
 * Immutable. Advertiser's currency in ISO 4217 format." (v4 Discovery,
 * https://displayvideo.googleapis.com/$discovery/rest?version=v4, vendored in
 * `src/generated/schemas`). `schemas.LineItemBudget.maxAmount`: with
 * `LINE_ITEM_BUDGET_ALLOCATION_TYPE_FIXED` and `BUDGET_UNIT_CURRENCY`, "the
 * maximum budget amount to spend, in micros of the advertiser's currency. For
 * example, 1500000 represents 1.5 standard units of the currency."
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mcpConfig } from "../../src/config/index.js";
import {
  updateEntityLogic,
  UpdateEntityInputSchema,
} from "../../src/mcp-server/tools/definitions/update-entity.tool.js";
import {
  installFetchStub,
  createWireSession,
  acceptingSdkContext,
  DV360_HOST,
  type FetchStub,
  type WireRequest,
  type WireSession,
} from "../helpers/wire.js";

const API = "https://displayvideo.googleapis.com/v4";
const ADV = "111";
const ctx = { requestId: "wire-currency" } as any;

function advertiser(currencyCode: string) {
  return {
    name: `advertisers/${ADV}`,
    advertiserId: ADV,
    partnerId: "7",
    displayName: "Wire Advertiser",
    entityStatus: "ENTITY_STATUS_ACTIVE",
    updateTime: "2026-09-01T00:00:00Z",
    adServerConfig: { thirdPartyOnlyConfig: {} },
    billingConfig: { billingProfileId: "55" },
    creativeConfig: {},
    generalConfig: { currencyCode, domainUrl: "https://example.com", timeZone: "Etc/UTC" },
  };
}

const fixedBudget = (maxAmount: string) => ({
  budgetAllocationType: "LINE_ITEM_BUDGET_ALLOCATION_TYPE_FIXED",
  budgetUnit: "BUDGET_UNIT_CURRENCY",
  maxAmount,
});

function lineItem(maxAmount: string) {
  return {
    name: `advertisers/${ADV}/lineItems/222`,
    advertiserId: ADV,
    campaignId: "444",
    insertionOrderId: "333",
    lineItemId: "222",
    displayName: "LI 222",
    lineItemType: "LINE_ITEM_TYPE_DISPLAY_DEFAULT",
    entityStatus: "ENTITY_STATUS_ACTIVE",
    updateTime: "2026-09-01T00:00:00Z",
    flight: { flightDateType: "LINE_ITEM_FLIGHT_DATE_TYPE_INHERITED" },
    budget: fixedBudget(maxAmount),
    pacing: { pacingPeriod: "PACING_PERIOD_FLIGHT", pacingType: "PACING_TYPE_ASAP" },
    frequencyCap: { unlimited: true },
    partnerRevenueModel: {
      markupType: "PARTNER_REVENUE_MODEL_MARKUP_TYPE_TOTAL_MEDIA_COST_MARKUP",
      markupAmount: "0",
    },
    bidStrategy: { fixedBid: { bidAmountMicros: "1500000" } },
    containsEuPoliticalAds: "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING",
  };
}

const echo = (req: WireRequest) => req.body as Record<string, unknown>;

let stub: FetchStub;
let session: WireSession;
let sdk: ReturnType<typeof acceptingSdkContext>;

beforeEach(async () => {
  stub = installFetchStub();
  session = await createWireSession();
  sdk = acceptingSdkContext(session.sessionId);
});

afterEach(() => {
  session.dispose();
  stub.restore();
});

function requests(): string[] {
  return stub.to(DV360_HOST).map((r) => `${r.method} ${r.path}`);
}

function lowerBudget(maxAmount: string, extra: Record<string, unknown> = {}) {
  return UpdateEntityInputSchema.parse({
    entityType: "lineItem",
    advertiserId: ADV,
    lineItemId: "222",
    data: { budget: fixedBudget(maxAmount) },
    updateMask: "budget.maxAmount",
    ...extra,
  });
}

describe("dv360_update_entity on a line item: before/after carry the budget", () => {
  it("reads the advertiser's currency and reports lifetime in its minor units (JPY, exponent 0)", async () => {
    stub.route({ method: "GET", path: `/v4/advertisers/${ADV}`, response: advertiser("JPY") });
    stub.route({
      method: "GET",
      path: `/v4/advertisers/${ADV}/lineItems/222`,
      response: lineItem("1500000000"),
    });
    stub.route({ method: "PATCH", path: `/v4/advertisers/${ADV}/lineItems/222`, response: echo });

    // 1,500,000,000 micros = ¥1,500 -> ¥1,000.
    const out = await updateEntityLogic(lowerBudget("1000000000"), ctx, sdk);

    expect(out.before!.budget!.lifetime).toEqual({ amountMinor: 1500, currency: "JPY" });
    expect(out.after!.budget!.lifetime).toEqual({ amountMinor: 1000, currency: "JPY" });
    // One advertisers.get for the currency, shared by `before` and `after`.
    expect(requests()).toEqual([
      `GET /v4/advertisers/${ADV}/lineItems/222`,
      `GET /v4/advertisers/${ADV}`,
      `PATCH /v4/advertisers/${ADV}/lineItems/222`,
    ]);
    const get = stub.to(DV360_HOST).find((r) => r.path === `/v4/advertisers/${ADV}`)!;
    expect(get.url).toBe(`${API}/advertisers/${ADV}`);
    // Every displayvideo call, the currency read included, drew one token from
    // the advertiser's real `dv360:{advertiserId}` bucket.
    expect(session.rateLimiter.getRemainingTokens(`dv360:${ADV}`)).toBe(
      mcpConfig.dv360RateLimitPerMinute - stub.to(DV360_HOST).length
    );
  });

  it("reads the currency once per advertiser and session", async () => {
    stub.route({ method: "GET", path: `/v4/advertisers/${ADV}`, response: advertiser("USD") });
    stub.route({
      method: "GET",
      path: `/v4/advertisers/${ADV}/lineItems/222`,
      response: lineItem("50000000"),
    });
    stub.route({ method: "PATCH", path: `/v4/advertisers/${ADV}/lineItems/222`, response: echo });

    await updateEntityLogic(lowerBudget("30000000"), ctx, sdk);
    const second = await updateEntityLogic(lowerBudget("20000000"), ctx, sdk);

    expect(second.after!.budget!.lifetime).toEqual({ amountMinor: 2000, currency: "USD" });
    expect(requests().filter((r) => r === `GET /v4/advertisers/${ADV}`)).toHaveLength(1);
  });

  it("labels the amounts XXX, not USD, when the currency cannot be read, and still writes", async () => {
    stub.route({
      method: "GET",
      path: `/v4/advertisers/${ADV}`,
      status: 404,
      response: { error: { code: 404, message: "Advertiser not found", status: "NOT_FOUND" } },
    });
    stub.route({
      method: "GET",
      path: `/v4/advertisers/${ADV}/lineItems/222`,
      response: lineItem("50000000"),
    });
    stub.route({ method: "PATCH", path: `/v4/advertisers/${ADV}/lineItems/222`, response: echo });

    const out = await updateEntityLogic(lowerBudget("30000000"), ctx, sdk);

    expect(out.before!.budget!.lifetime).toEqual({ amountMinor: 5000, currency: "XXX" });
    expect(out.after!.budget!.lifetime).toEqual({ amountMinor: 3000, currency: "XXX" });
    expect(requests()).toContain(`PATCH /v4/advertisers/${ADV}/lineItems/222`);

    // A failed read is not kept: the next write asks again and gets the answer.
    stub.route({ method: "GET", path: `/v4/advertisers/${ADV}`, response: advertiser("EUR") });
    const next = await updateEntityLogic(lowerBudget("20000000"), ctx, sdk);
    expect(next.after!.budget!.lifetime).toEqual({ amountMinor: 2000, currency: "EUR" });
  });

  it("dry_run projects the post-state in the advertiser's currency (KWD, exponent 3)", async () => {
    stub.route({ method: "GET", path: `/v4/advertisers/${ADV}`, response: advertiser("KWD") });
    stub.route({
      method: "GET",
      path: `/v4/advertisers/${ADV}/lineItems/222`,
      response: lineItem("50000000"),
    });

    const out = await updateEntityLogic(lowerBudget("30000000", { dry_run: true }), ctx, sdk);

    // 30,000,000 micros = 30 dinar = 30,000 fils.
    expect(out.dryRun!.expectedPostState!.budget!.lifetime).toEqual({
      amountMinor: 30000,
      currency: "KWD",
    });
    expect(stub.to(DV360_HOST).filter((r) => r.method !== "GET")).toHaveLength(0);
  });
});
