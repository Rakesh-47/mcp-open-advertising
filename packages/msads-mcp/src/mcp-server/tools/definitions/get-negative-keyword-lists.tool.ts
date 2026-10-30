// Copyright (c) Cesteral AB. Licensed under the Apache License, Version 2.0.
// See LICENSE.md in the project root for full license terms.

import { z } from "zod";
import { resolveSessionServices } from "../utils/resolve-session.js";
import {
  collectMsAdsBatchErrors,
  describeMsAdsBatchError,
} from "../../../services/msads/partial-errors.js";
import type { RequestContext, McpTextContent, SdkContext } from "@cesteral/shared";

const TOOL_NAME = "msads_get_negative_keyword_lists";
const TOOL_TITLE = "Get Microsoft Ads Shared Negative Keyword Lists";
const TOOL_DESCRIPTION = `Get the shared negative keyword lists in a Microsoft Advertising account, which are reusable lists of excluded searches attached to campaigns. Read-only.

By default returns each list's ID, name, keyword count and campaign count. Set includeKeywords to also get the keywords inside each list, and includeCampaigns to get the campaigns each list is attached to. Use listIds to read specific lists; start without it to find their IDs.

This tool does NOT return negatives assigned directly to a campaign or ad group. Use msads_get_negative_keywords for those; a complete view of what a campaign excludes needs both tools.`;

const LIST_TYPE = "NegativeKeywordList";

export const GetNegativeKeywordListsInputSchema = z
  .object({
    listIds: z
      .array(z.string())
      .min(1)
      .optional()
      .describe("Only return these shared list IDs. Omit for every list in the account."),
    includeKeywords: z
      .boolean()
      .optional()
      .describe("Also return the negative keywords inside each list (one extra call per list)"),
    includeCampaigns: z
      .boolean()
      .optional()
      .describe("Also return the campaigns each list is attached to (one extra call per list)"),
  })
  .describe("Parameters for getting shared negative keyword lists");

export const GetNegativeKeywordListsOutputSchema = z
  .object({
    entities: z
      .array(z.record(z.any()))
      .describe(
        "One row per list: id, name, keywordCount, campaignCount, plus keywords and campaigns when requested"
      ),
    count: z.number(),
    errors: z.array(z.string()).describe("Lists Microsoft could not read, with the reason"),
    timestamp: z.string().datetime(),
  })
  .describe("Shared negative keyword lists result");

type GetNegativeKeywordListsInput = z.infer<typeof GetNegativeKeywordListsInputSchema>;
type GetNegativeKeywordListsOutput = z.infer<typeof GetNegativeKeywordListsOutputSchema>;

interface SharedEntity {
  Id: string;
  Name?: string;
  ItemCount?: number;
  AssociationCount?: number;
}

interface SharedListItem {
  Id?: string;
  Text?: string;
  MatchType?: string;
}

interface SharedEntityAssociation {
  EntityId?: string;
  Status?: string;
}

export async function getNegativeKeywordListsLogic(
  input: GetNegativeKeywordListsInput,
  context: RequestContext,
  sdkContext?: SdkContext
): Promise<GetNegativeKeywordListsOutput> {
  const { msadsService } = resolveSessionServices(sdkContext);
  const errors: string[] = [];

  const { SharedEntities = [] } = (await msadsService.executeReadOperation(
    "/SharedEntities/Query",
    { SharedEntityType: LIST_TYPE, SharedEntityScope: "Account" },
    context
  )) as { SharedEntities?: SharedEntity[] };

  const wanted = input.listIds ? new Set(input.listIds) : null;
  const lists = SharedEntities.filter((list) => !wanted || wanted.has(String(list.Id)));

  const entities: Record<string, unknown>[] = [];
  for (const list of lists) {
    const row: Record<string, unknown> = {
      id: list.Id,
      name: list.Name,
      keywordCount: list.ItemCount,
      campaignCount: list.AssociationCount,
    };

    if (input.includeKeywords) {
      const { ListItems = [] } = (await msadsService.executeReadOperation(
        "/ListItems/QueryBySharedList",
        { SharedList: { Id: list.Id, Type: LIST_TYPE } },
        context
      )) as { ListItems?: SharedListItem[] };
      row.keywords = ListItems.map((item) => ({
        id: item.Id,
        text: item.Text,
        matchType: item.MatchType,
      }));
    }

    if (input.includeCampaigns) {
      const result = (await msadsService.executeReadOperation(
        "/SharedEntityAssociations/QueryBySharedEntityIds",
        { EntityType: "Campaign", SharedEntityIds: [list.Id], SharedEntityType: LIST_TYPE },
        context
      )) as { Associations?: (SharedEntityAssociation | null)[] };
      collectMsAdsBatchErrors(result).forEach((error) =>
        errors.push(`${list.Id}: ${describeMsAdsBatchError(error)}`)
      );
      row.campaigns = (result.Associations ?? [])
        .filter((association) => association !== null)
        .map((association) => ({ campaignId: association.EntityId, status: association.Status }));
    }

    entities.push(row);
  }

  return {
    entities,
    count: entities.length,
    errors,
    timestamp: new Date().toISOString(),
  };
}

export function getNegativeKeywordListsResponseFormatter(
  result: GetNegativeKeywordListsOutput
): McpTextContent[] {
  const rows =
    result.entities.length > 0
      ? `\n\nLists:\n${JSON.stringify(result.entities, null, 2)}`
      : "\n\nNo shared negative keyword lists found.";
  const errors = result.errors.length > 0 ? `\n\nErrors:\n${result.errors.join("\n")}` : "";

  return [
    {
      type: "text" as const,
      text: `Found ${result.count} shared negative keyword lists${rows}${errors}\n\nTimestamp: ${result.timestamp}`,
    },
  ];
}

export const getNegativeKeywordListsTool = {
  name: TOOL_NAME,
  title: TOOL_TITLE,
  description: TOOL_DESCRIPTION,
  inputSchema: GetNegativeKeywordListsInputSchema,
  outputSchema: GetNegativeKeywordListsOutputSchema,
  annotations: {
    readOnlyHint: true,
    openWorldHint: false,
    idempotentHint: true,
    destructiveHint: false,
  },
  inputExamples: [
    {
      label: "List every shared negative keyword list",
      input: {},
    },
    {
      label: "Get one list with its keywords and campaigns",
      input: { listIds: ["555"], includeKeywords: true, includeCampaigns: true },
    },
  ],
  logic: getNegativeKeywordListsLogic,
  responseFormatter: getNegativeKeywordListsResponseFormatter,
  // entities carry advertiser-entered list names and keyword text, printed in block 0.
  untrustedContent: {
    structuredPaths: ["$.entities"],
    contentBlocks: [0],
  },
};
