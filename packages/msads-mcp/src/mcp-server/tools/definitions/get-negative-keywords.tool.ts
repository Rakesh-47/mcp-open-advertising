// Copyright (c) Cesteral AB. Licensed under the Apache License, Version 2.0.
// See LICENSE.md in the project root for full license terms.

import { z } from "zod";
import { resolveSessionServices } from "../utils/resolve-session.js";
import {
  collectMsAdsBatchErrors,
  describeMsAdsBatchError,
} from "../../../services/msads/partial-errors.js";
import type { RequestContext, McpTextContent, SdkContext } from "@cesteral/shared";

const TOOL_NAME = "msads_get_negative_keywords";
const TOOL_TITLE = "Get Microsoft Ads Negative Keywords";
const TOOL_DESCRIPTION = `Get the negative keywords assigned directly to Microsoft Advertising campaigns or ad groups. Negative keywords are the excluded searches an ad must not show for. Read-only.

Returns one row per negative keyword: its text, match type (Exact or Phrase) and the campaign or ad group it sits on.

This tool does NOT return negatives held in shared lists. Use msads_get_negative_keyword_lists for those; a complete view of what a campaign excludes needs both tools.
Use msads_list_entities with entityType "keyword" for the keywords an account bids on, not this tool.`;

// GetNegativeKeywordsByEntityIds: "This array can contain a maximum of 1 element",
// so the tool makes one call per id.
const MAX_ENTITY_IDS = 100;

export const GetNegativeKeywordsInputSchema = z
  .object({
    entityType: z
      .enum(["campaign", "adGroup"])
      .describe("Whether entityIds are campaign IDs or ad group IDs"),
    entityIds: z
      .array(z.string())
      .min(1)
      .max(MAX_ENTITY_IDS)
      .describe("Campaign IDs or ad group IDs to read negatives from"),
    campaignId: z
      .string()
      .optional()
      .describe(
        "Required when entityType is adGroup: the campaign containing every ad group in entityIds. Ad groups from different campaigns need separate calls."
      ),
  })
  .superRefine((data, ctx) => {
    if (data.entityType === "adGroup" && !data.campaignId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["campaignId"],
        message: "campaignId is required when entityType is adGroup",
      });
    }
  })
  .describe("Parameters for getting negative keywords");

export const GetNegativeKeywordsOutputSchema = z
  .object({
    entities: z
      .array(z.record(z.any()))
      .describe("One row per negative keyword: entityType, entityId, id, text, matchType"),
    entityType: z.string(),
    count: z.number(),
    errors: z.array(z.string()).describe("IDs Microsoft could not read, with the reason"),
    timestamp: z.string().datetime(),
  })
  .describe("Negative keywords result");

type GetNegativeKeywordsInput = z.infer<typeof GetNegativeKeywordsInputSchema>;
type GetNegativeKeywordsOutput = z.infer<typeof GetNegativeKeywordsOutputSchema>;

interface EntityNegativeKeyword {
  NegativeKeywords?: { Id?: string; Text?: string; MatchType?: string }[] | null;
}

export async function getNegativeKeywordsLogic(
  input: GetNegativeKeywordsInput,
  context: RequestContext,
  sdkContext?: SdkContext
): Promise<GetNegativeKeywordsOutput> {
  const { msadsService } = resolveSessionServices(sdkContext);
  const entities: Record<string, unknown>[] = [];
  const errors: string[] = [];

  for (const entityId of input.entityIds) {
    const result = (await msadsService.executeReadOperation(
      "/NegativeKeywords/QueryByEntityIds",
      {
        EntityIds: [entityId],
        EntityType: input.entityType === "campaign" ? "Campaign" : "AdGroup",
        ...(input.entityType === "adGroup" ? { ParentEntityId: input.campaignId } : {}),
      },
      context
    )) as Record<string, unknown>;

    collectMsAdsBatchErrors(result).forEach((error) =>
      errors.push(`${entityId}: ${describeMsAdsBatchError(error)}`)
    );

    const [entry] = (result.EntityNegativeKeywords ?? []) as (EntityNegativeKeyword | null)[];
    (entry?.NegativeKeywords ?? []).forEach((negative) =>
      entities.push({
        entityType: input.entityType,
        entityId,
        id: negative.Id,
        text: negative.Text,
        matchType: negative.MatchType,
      })
    );
  }

  return {
    entities,
    entityType: input.entityType,
    count: entities.length,
    errors,
    timestamp: new Date().toISOString(),
  };
}

export function getNegativeKeywordsResponseFormatter(
  result: GetNegativeKeywordsOutput
): McpTextContent[] {
  const rows =
    result.entities.length > 0
      ? `\n\nNegative keywords:\n${JSON.stringify(result.entities, null, 2)}`
      : "\n\nNo directly assigned negative keywords found. Shared lists are not included here.";
  const errors = result.errors.length > 0 ? `\n\nErrors:\n${result.errors.join("\n")}` : "";

  return [
    {
      type: "text" as const,
      text: `Found ${result.count} negative keywords on ${result.entityType} level${rows}${errors}\n\nTimestamp: ${result.timestamp}`,
    },
  ];
}

export const getNegativeKeywordsTool = {
  name: TOOL_NAME,
  title: TOOL_TITLE,
  description: TOOL_DESCRIPTION,
  inputSchema: GetNegativeKeywordsInputSchema,
  outputSchema: GetNegativeKeywordsOutputSchema,
  annotations: {
    readOnlyHint: true,
    openWorldHint: false,
    idempotentHint: true,
    destructiveHint: false,
  },
  inputExamples: [
    {
      label: "Get negatives on two campaigns",
      input: { entityType: "campaign", entityIds: ["111", "222"] },
    },
    {
      label: "Get negatives on ad groups in one campaign",
      input: { entityType: "adGroup", entityIds: ["333", "444"], campaignId: "111" },
    },
  ],
  logic: getNegativeKeywordsLogic,
  responseFormatter: getNegativeKeywordsResponseFormatter,
  // entities carry advertiser-entered keyword text, printed in block 0.
  untrustedContent: {
    structuredPaths: ["$.entities"],
    contentBlocks: [0],
  },
};
