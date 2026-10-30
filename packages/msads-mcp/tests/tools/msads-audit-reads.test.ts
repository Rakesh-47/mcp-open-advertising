// Copyright (c) Cesteral AB. Licensed under the Apache License, Version 2.0.
// See LICENSE.md in the project root for full license terms.

/**
 * Request and response contracts for the read tools covering negative keywords,
 * shared negative keyword lists and conversion goals. Paths and bodies match the
 * Microsoft Advertising v13 Campaign Management docs and were confirmed against a
 * live account.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockResolveSessionServices } = vi.hoisted(() => ({
  mockResolveSessionServices: vi.fn(),
}));
vi.mock("../../src/mcp-server/tools/utils/resolve-session.js", () => ({
  resolveSessionServices: mockResolveSessionServices,
}));

import {
  getNegativeKeywordsLogic,
  getNegativeKeywordsResponseFormatter,
  GetNegativeKeywordsInputSchema,
} from "../../src/mcp-server/tools/definitions/get-negative-keywords.tool.js";
import {
  getNegativeKeywordListsLogic,
  getNegativeKeywordListsResponseFormatter,
} from "../../src/mcp-server/tools/definitions/get-negative-keyword-lists.tool.js";
import {
  getConversionGoalsLogic,
  getConversionGoalsResponseFormatter,
  GetConversionGoalsInputSchema,
} from "../../src/mcp-server/tools/definitions/get-conversion-goals.tool.js";

const ctx = { requestId: "r" } as any;
const sdk = { sessionId: "s" } as any;

let read: ReturnType<typeof vi.fn>;

beforeEach(() => {
  read = vi.fn();
  mockResolveSessionServices.mockReturnValue({ msadsService: { executeReadOperation: read } });
});

describe("msads_get_negative_keywords", () => {
  it("makes one call per id, because Microsoft accepts one entity per request", async () => {
    read.mockResolvedValue({ EntityNegativeKeywords: [{ NegativeKeywords: [] }] });

    await getNegativeKeywordsLogic({ entityType: "campaign", entityIds: ["1", "2"] }, ctx, sdk);

    expect(read).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenNthCalledWith(
      1,
      "/NegativeKeywords/QueryByEntityIds",
      { EntityIds: ["1"], EntityType: "Campaign" },
      ctx
    );
    expect(read).toHaveBeenNthCalledWith(
      2,
      "/NegativeKeywords/QueryByEntityIds",
      { EntityIds: ["2"], EntityType: "Campaign" },
      ctx
    );
  });

  it("sends the parent campaign for ad groups", async () => {
    read.mockResolvedValue({ EntityNegativeKeywords: [] });

    await getNegativeKeywordsLogic(
      { entityType: "adGroup", entityIds: ["3"], campaignId: "1" },
      ctx,
      sdk
    );

    expect(read).toHaveBeenCalledWith(
      "/NegativeKeywords/QueryByEntityIds",
      { EntityIds: ["3"], EntityType: "AdGroup", ParentEntityId: "1" },
      ctx
    );
  });

  it("requires campaignId for ad groups", () => {
    expect(
      GetNegativeKeywordsInputSchema.safeParse({ entityType: "adGroup", entityIds: ["3"] }).success
    ).toBe(false);
    expect(
      GetNegativeKeywordsInputSchema.safeParse({ entityType: "campaign", entityIds: ["1"] }).success
    ).toBe(true);
  });

  it("returns flat rows under entities and keeps per-id failures", async () => {
    read
      .mockResolvedValueOnce({
        EntityNegativeKeywords: [
          { NegativeKeywords: [{ Id: "9", Text: "free", MatchType: "Phrase" }] },
        ],
      })
      .mockResolvedValueOnce({
        EntityNegativeKeywords: [null],
        PartialErrors: [{ ErrorCode: "CampaignServiceInvalidCampaignId", Message: "bad id" }],
      });

    const result = await getNegativeKeywordsLogic(
      { entityType: "campaign", entityIds: ["1", "2"] },
      ctx,
      sdk
    );

    expect(result.entities).toEqual([
      { entityType: "campaign", entityId: "1", id: "9", text: "free", matchType: "Phrase" },
    ]);
    expect(result.count).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("2: CampaignServiceInvalidCampaignId");
  });

  it("says shared lists are excluded when nothing is found", () => {
    const [block] = getNegativeKeywordsResponseFormatter({
      entities: [],
      entityType: "campaign",
      count: 0,
      errors: [],
      timestamp: "2026-10-30T00:00:00.000Z",
    });
    expect(block!.text).toContain("Shared lists are not included");
  });
});

describe("msads_get_negative_keyword_lists", () => {
  const lists = {
    SharedEntities: [
      { Id: "10", Name: "Brand", ItemCount: 2, AssociationCount: 1 },
      { Id: "20", Name: "General", ItemCount: 5, AssociationCount: 3 },
    ],
  };

  it("returns list summaries from one call by default", async () => {
    read.mockResolvedValue(lists);

    const result = await getNegativeKeywordListsLogic({}, ctx, sdk);

    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(
      "/SharedEntities/Query",
      { SharedEntityType: "NegativeKeywordList", SharedEntityScope: "Account" },
      ctx
    );
    expect(result.entities).toEqual([
      { id: "10", name: "Brand", keywordCount: 2, campaignCount: 1 },
      { id: "20", name: "General", keywordCount: 5, campaignCount: 3 },
    ]);
  });

  it("adds keywords and campaigns for the requested lists only", async () => {
    read.mockImplementation(async (path: string) => {
      if (path === "/SharedEntities/Query") return lists;
      if (path === "/ListItems/QueryBySharedList") {
        return { ListItems: [{ Id: "1", Text: "cheap", MatchType: "Exact" }] };
      }
      return { Associations: [{ EntityId: "77", Status: "Active" }, null] };
    });

    const result = await getNegativeKeywordListsLogic(
      { listIds: ["20"], includeKeywords: true, includeCampaigns: true },
      ctx,
      sdk
    );

    expect(read).toHaveBeenCalledWith(
      "/ListItems/QueryBySharedList",
      { SharedList: { Id: "20", Type: "NegativeKeywordList" } },
      ctx
    );
    expect(read).toHaveBeenCalledWith(
      "/SharedEntityAssociations/QueryBySharedEntityIds",
      { EntityType: "Campaign", SharedEntityIds: ["20"], SharedEntityType: "NegativeKeywordList" },
      ctx
    );
    expect(result.entities).toEqual([
      {
        id: "20",
        name: "General",
        keywordCount: 5,
        campaignCount: 3,
        keywords: [{ id: "1", text: "cheap", matchType: "Exact" }],
        campaigns: [{ campaignId: "77", status: "Active" }],
      },
    ]);
  });

  it("reports an account with no lists", async () => {
    read.mockResolvedValue({});

    const result = await getNegativeKeywordListsLogic({}, ctx, sdk);

    expect(result.count).toBe(0);
    expect(getNegativeKeywordListsResponseFormatter(result)[0]!.text).toContain(
      "No shared negative keyword lists found"
    );
  });
});

describe("msads_get_conversion_goals", () => {
  it("asks for every usable goal type and the fields Microsoft omits by default", async () => {
    read.mockResolvedValue({ ConversionGoals: [] });

    await getConversionGoalsLogic({}, ctx, sdk);

    expect(read).toHaveBeenCalledWith(
      "/ConversionGoals/QueryByIds",
      {
        ConversionGoalTypes:
          "Url,Duration,PagesViewedPerVisit,Event,AppInstall,AppDownload,OfflineConversion",
        ReturnAdditionalFields:
          "AttributionModelType,ViewThroughConversionWindowInMinutes,GoalCategory",
      },
      ctx
    );
  });

  it("passes goal IDs and explicit types through", async () => {
    read.mockResolvedValue({ ConversionGoals: [] });

    await getConversionGoalsLogic({ goalIds: ["5"], goalTypes: ["Event", "Url"] }, ctx, sdk);

    expect(read).toHaveBeenCalledWith(
      "/ConversionGoals/QueryByIds",
      expect.objectContaining({ ConversionGoalIds: ["5"], ConversionGoalTypes: "Event,Url" }),
      ctx
    );
  });

  it("rejects more than 100 goal IDs", () => {
    const goalIds = Array.from({ length: 101 }, (_, i) => String(i));
    expect(GetConversionGoalsInputSchema.safeParse({ goalIds }).success).toBe(false);
  });

  it("drops null entries and surfaces partial errors", async () => {
    read.mockResolvedValue({
      ConversionGoals: [{ Id: "1", Name: "Thank you" }, null],
      PartialErrors: [{ ErrorCode: "CampaignServiceInvalidConversionGoalId", Message: "bad" }],
    });

    const result = await getConversionGoalsLogic({ goalIds: ["1", "2"] }, ctx, sdk);

    expect(result.entities).toEqual([{ Id: "1", Name: "Thank you" }]);
    expect(result.errors).toHaveLength(1);
    expect(getConversionGoalsResponseFormatter(result)[0]!.text).toContain("Thank you");
  });
});
