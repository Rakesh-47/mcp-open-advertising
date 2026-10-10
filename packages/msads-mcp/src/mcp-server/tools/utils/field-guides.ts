/**
 * Field guides for the free-form `data` / `items` / `columns` / `filters` inputs.
 *
 * Callers that only see tool definitions (no MCP resources) still need the
 * request shape and required fields, so these strings go into the input
 * schema descriptions. Shapes were exercised against the Microsoft Advertising
 * sandbox; required/optional rules follow the Campaign Management v13 object
 * pages (campaign.md, adgroup.md, keyword.md, responsivesearchad.md) and the
 * report columns follow the Reporting v13 *ReportColumn enums.
 */

const MONEY_NOTE =
  "Money is a plain amount in the account currency (50 means 50.00), never micros.";

export const CREATE_DATA_GUIDE = `Request body for the entity type: the entities go in their plural array, and the parent id sits next to that array (never inside the entity).
- campaign: { "AccountId": <accountId>, "Campaigns": [{ "Name": "...", "BudgetType": "DailyBudgetStandard", "DailyBudget": 50, "TimeZone": "EasternTimeUSCanada", "Languages": ["English"], "Status": "Paused" }] }. Required: Name (max 128, unique in the account), TimeZone, and BudgetType + DailyBudget unless BudgetId points to a shared budget. Optional: CampaignType (default "Search", cannot be changed later), Status (default "Paused"), Languages, BudgetId.
- adGroup: { "CampaignId": <campaignId>, "AdGroups": [{ "Name": "...", "CpcBid": { "Amount": 1.5 }, "Language": "English", "Status": "Paused" }] }. Required: Name; Language unless the campaign sets Languages. Optional: CpcBid (default: account minimum), Status (default "Paused"), StartDate / EndDate as { "Year": 2026, "Month": 12, "Day": 31 }.
- keyword: { "AdGroupId": <adGroupId>, "Keywords": [{ "Text": "...", "MatchType": "Phrase", "Bid": { "Amount": 2 } }] }. Required: Text (max 100), MatchType ("Exact", "Phrase" or "Broad"). Optional: Bid (default: the ad group CpcBid), Status (default "Active").
- ad (responsive search ad): { "AdGroupId": <adGroupId>, "Ads": [{ "Type": "ResponsiveSearch", "Headlines": [{ "Asset": { "Type": "TextAsset", "Text": "..." } }, ...], "Descriptions": [{ "Asset": { "Type": "TextAsset", "Text": "..." } }, ...], "FinalUrls": ["https://..."], "Path1": "..." }] }. Required: 3-15 Headlines (30 characters shown), 2-4 Descriptions (90 characters shown), FinalUrls. A bare { "Text": "..." } headline is rejected. Optional: "PinnedField": "Headline1" on a headline, Path1 / Path2 (max 15 characters, no "/"), Status.
- adExtension (callout): { "AccountId": <accountId>, "AdExtensions": [{ "Type": "CalloutAdExtension", "Text": "..." }] }. Link it to a campaign with msads_manage_ad_extensions (setAssociations).
- budget (shared): { "Budgets": [{ "Name": "...", "Amount": 100, "BudgetType": "DailyBudgetStandard" }] }. No parent id. Use it by setting a campaign's BudgetId.
${MONEY_NOTE}`;

export const BULK_CREATE_ITEMS_GUIDE = `Entity objects to create, one per item, without the plural wrapper and without the parent id (pass the parent once as accountId / campaignId / adGroupId). Fields per type are the same as msads_create_entity:
- campaign: { "Name", "BudgetType": "DailyBudgetStandard", "DailyBudget": 50, "TimeZone", "Languages": ["English"], "Status": "Paused" }
- adGroup: { "Name", "CpcBid": { "Amount": 1.5 }, "Language": "English", "Status": "Paused" }
- keyword: { "Text", "MatchType": "Exact" | "Phrase" | "Broad", "Bid": { "Amount": 2 } }
- ad: { "Type": "ResponsiveSearch", "Headlines" and "Descriptions" as [{ "Asset": { "Type": "TextAsset", "Text": "..." } }], "FinalUrls": ["https://..."] }
Maximum per call: 100 campaigns, 1000 ad groups, 1000 keywords, 50 ads. ${MONEY_NOTE}`;

export const UPDATE_DATA_GUIDE = `Only the fields to change (a partial update; do not include Id, it is added for you). Common fields:
- campaign: Name, Status ("Active" or "Paused"), DailyBudget (not when the campaign uses a shared budget), Languages (replaces the whole list), BudgetId. CampaignType cannot be changed.
- adGroup: Name, Status ("Active" or "Paused"), CpcBid: { "Amount": 1.5 }, Language, StartDate / EndDate as { "Year", "Month", "Day" }.
- keyword: Status ("Active" or "Paused"), Bid: { "Amount": 2 }, MatchType. Text cannot be changed.
- ad: Status ("Active" or "Paused"), FinalUrls, Path1 / Path2, Headlines / Descriptions (replace the whole list; same Asset format as create).
${MONEY_NOTE}`;

export const BULK_UPDATE_ITEMS_GUIDE = `One object per entity: { "Id": <entity id>, ...only the fields to change }, e.g. [{ "Id": 123, "Status": "Paused" }, { "Id": 456, "DailyBudget": 80 }]. Fields are the same as msads_update_entity. All items belong to one parent (accountId for campaigns, campaignId for ad groups, adGroupId for ads and keywords); for several parents make one call per parent. Maximum per call: 100 campaigns, 1000 ad groups, 1000 keywords, 50 ads. ${MONEY_NOTE}`;

export const REPORT_TYPE_GUIDE = `Report type: AccountPerformanceReportRequest, CampaignPerformanceReportRequest, AdGroupPerformanceReportRequest, KeywordPerformanceReportRequest, AdPerformanceReportRequest or SearchQueryPerformanceReportRequest (others exist in Reporting v13). The report covers the whole account.`;

export const REPORT_COLUMNS_GUIDE = `Microsoft report column names; valid columns depend on the report type.
- Metrics (all six types): Impressions, Clicks, Ctr, AverageCpc, Spend, Conversions, ConversionRate, CostPerConversion, Revenue.
- Dimensions: AccountName (all); CampaignName, CampaignId (all except Account); CampaignStatus (Campaign); AdGroupName, AdGroupId (AdGroup, Keyword, Ad, SearchQuery); Keyword, KeywordId (Keyword, SearchQuery); QualityScore (Campaign, AdGroup, Keyword); AdId, AdTitle (Ad); SearchQuery (SearchQuery); DeviceType, Network (all).
- TimePeriod: include it for one row per day / week / month (see aggregation); leave it out for totals over the whole date range.`;

export const LIST_FILTERS_GUIDE = `Optional extra request fields; usually leave empty. Campaigns: { "CampaignType": "Search" } limits the campaign types (default: all types). Ads: { "AdTypes": ["ResponsiveSearch"] } limits the ad types (default: all types).`;

export const CRITERIONS_DATA_GUIDE = `Request body for the operation (campaign level shown; for ad groups use AdGroupCriterions / AdGroupCriterionIds / AdGroupId):
- add: { "CriterionType": "Targets", "CampaignCriterions": [{ "Type": "BiddableCampaignCriterion", "CampaignId": <campaignId>, "Criterion": { "Type": "LocationCriterion", "LocationId": 190 } }] }
- getByCampaign: { "CampaignId": <campaignId>, "CriterionType": "Location" } (one type, e.g. Location, Age, Gender, Device, DayTime; "Targets" is not allowed here)
- delete: { "CampaignCriterionIds": [<criterionId>], "CampaignId": <campaignId>, "CriterionType": "Targets" }`;

export const AD_EXTENSIONS_DATA_GUIDE = `Request body for the operation:
- setAssociations / deleteAssociations: { "AccountId": <accountId>, "AdExtensionIdToEntityIdAssociations": [{ "AdExtensionId": <adExtensionId>, "EntityId": <campaignId> }], "AssociationType": "Campaign" }
- getAssociations: { "AccountId": <accountId>, "AdExtensionType": "CalloutAdExtension", "AssociationType": "Campaign", "EntityIds": [<campaignId>] }
Create the extension first with msads_create_entity (entityType "adExtension").`;
