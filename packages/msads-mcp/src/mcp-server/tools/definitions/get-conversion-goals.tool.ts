// Copyright (c) Cesteral AB. Licensed under the Apache License, Version 2.0.
// See LICENSE.md in the project root for full license terms.

import { z } from "zod";
import { resolveSessionServices } from "../utils/resolve-session.js";
import {
  collectMsAdsBatchErrors,
  describeMsAdsBatchError,
} from "../../../services/msads/partial-errors.js";
import type { RequestContext, McpTextContent, SdkContext } from "@cesteral/shared";

const TOOL_NAME = "msads_get_conversion_goals";
const TOOL_TITLE = "Get Microsoft Ads Conversion Goals";
const TOOL_DESCRIPTION = `Get the conversion goals set up in a Microsoft Advertising account, meaning how conversion tracking is configured. Read-only.

Returns each goal's settings: name, type, status, tracking status, category, counting method (All or Unique), conversion window, attribution model, revenue value, and ExcludeFromBidding (true means the goal is left out of the Conversions columns and automated bidding). Omit goalIds to get every goal in the account.

This tool does NOT return conversion counts or performance. Use msads_get_report with reportType GoalsAndFunnelsReportRequest and column AllConversionsQualified for those.
Some automatically managed goals may not be returned.`;

// ConversionGoalType. InStoreTransaction is opt-in: requesting it for a customer outside
// that pilot fails the whole call (InStoreTransactionPilotNotEnabledForCustomer).
const GOAL_TYPES = [
  "Url",
  "Duration",
  "PagesViewedPerVisit",
  "Event",
  "AppInstall",
  "AppDownload",
  "OfflineConversion",
  "InStoreTransaction",
] as const;
const DEFAULT_GOAL_TYPES = GOAL_TYPES.filter((type) => type !== "InStoreTransaction");

// Not returned unless requested (ConversionGoalAdditionalField).
const ADDITIONAL_FIELDS = "AttributionModelType,ViewThroughConversionWindowInMinutes,GoalCategory";

export const GetConversionGoalsInputSchema = z
  .object({
    goalIds: z
      .array(z.string())
      .min(1)
      // GetConversionGoalsByIds: "A maximum of 100 identifiers".
      .max(100)
      .optional()
      .describe("Only return these conversion goal IDs. Omit for every goal in the account."),
    goalTypes: z
      .array(z.enum(GOAL_TYPES))
      .min(1)
      .optional()
      .describe(
        "Goal types to return. Defaults to every type except InStoreTransaction, which fails for accounts outside that pilot."
      ),
  })
  .describe("Parameters for getting conversion goals");

export const GetConversionGoalsOutputSchema = z
  .object({
    entities: z.array(z.record(z.any())).describe("One raw ConversionGoal record per goal"),
    count: z.number(),
    errors: z.array(z.string()).describe("Goals Microsoft could not read, with the reason"),
    timestamp: z.string().datetime(),
  })
  .describe("Conversion goals result");

type GetConversionGoalsInput = z.infer<typeof GetConversionGoalsInputSchema>;
type GetConversionGoalsOutput = z.infer<typeof GetConversionGoalsOutputSchema>;

export async function getConversionGoalsLogic(
  input: GetConversionGoalsInput,
  context: RequestContext,
  sdkContext?: SdkContext
): Promise<GetConversionGoalsOutput> {
  const { msadsService } = resolveSessionServices(sdkContext);

  const result = (await msadsService.executeReadOperation(
    "/ConversionGoals/QueryByIds",
    {
      ...(input.goalIds ? { ConversionGoalIds: input.goalIds } : {}),
      ConversionGoalTypes: (input.goalTypes ?? DEFAULT_GOAL_TYPES).join(","),
      ReturnAdditionalFields: ADDITIONAL_FIELDS,
    },
    context
  )) as { ConversionGoals?: (Record<string, unknown> | null)[] };

  const entities = (result.ConversionGoals ?? []).filter((goal) => goal !== null);

  return {
    entities,
    count: entities.length,
    errors: collectMsAdsBatchErrors(result).map(describeMsAdsBatchError),
    timestamp: new Date().toISOString(),
  };
}

export function getConversionGoalsResponseFormatter(
  result: GetConversionGoalsOutput
): McpTextContent[] {
  const rows =
    result.entities.length > 0
      ? `\n\nConversion goals:\n${JSON.stringify(result.entities, null, 2)}`
      : "\n\nNo conversion goals found.";
  const errors = result.errors.length > 0 ? `\n\nErrors:\n${result.errors.join("\n")}` : "";

  return [
    {
      type: "text" as const,
      text: `Found ${result.count} conversion goals${rows}${errors}\n\nTimestamp: ${result.timestamp}`,
    },
  ];
}

export const getConversionGoalsTool = {
  name: TOOL_NAME,
  title: TOOL_TITLE,
  description: TOOL_DESCRIPTION,
  inputSchema: GetConversionGoalsInputSchema,
  outputSchema: GetConversionGoalsOutputSchema,
  annotations: {
    readOnlyHint: true,
    openWorldHint: false,
    idempotentHint: true,
    destructiveHint: false,
  },
  inputExamples: [
    {
      label: "Get every conversion goal",
      input: {},
    },
    {
      label: "Get specific goals by ID",
      input: { goalIds: ["160426384"] },
    },
  ],
  logic: getConversionGoalsLogic,
  responseFormatter: getConversionGoalsResponseFormatter,
  // entities are raw goal records with advertiser-entered names and URLs, printed in block 0.
  untrustedContent: {
    structuredPaths: ["$.entities"],
    contentBlocks: [0],
  },
};
