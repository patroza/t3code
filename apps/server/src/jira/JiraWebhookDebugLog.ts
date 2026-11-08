/**
 * @deprecated Import from `../webhooks/WebhookDebugLog.ts`.
 * Thin re-export so existing paths keep working during the multi-webhook rollout.
 */
export {
  classifyWebhookBodyFailure,
  JIRA_WEBHOOK_DEBUG_BODY_PREVIEW_CHARS,
  JIRA_WEBHOOK_DEBUG_FILENAME,
  JIRA_WEBHOOK_DEBUG_MAX_AGE_MS,
  JIRA_WEBHOOK_DEBUG_MAX_RECORDS,
  layer,
  previewWebhookBody,
  pruneJiraWebhookDebugRecords,
  pruneWebhookDebugRecords,
  WebhookDebugLog as JiraWebhookDebugLog,
  type WebhookDebugAppendInput as JiraWebhookDebugAppendInput,
  type WebhookDebugOutcome as JiraWebhookDebugOutcome,
  type WebhookDebugRecord as JiraWebhookDebugRecord,
} from "../webhooks/WebhookDebugLog.ts";
