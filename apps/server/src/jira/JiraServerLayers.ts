/**
 * Everything the server runs for Jira, as one route layer: the `/api/jira/webhook` handler and the
 * issue bridge behind it. The issue tracker read path registers in `IssueTrackerRegistry` instead.
 */
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/http";

import * as JiraAppClient from "./JiraAppClient.ts";
import * as JiraAppConfig from "./JiraAppConfig.ts";
import * as JiraDeliveryStore from "./JiraDeliveryStore.ts";
import * as JiraIssueBridge from "./JiraIssueBridge.ts";
import * as JiraWebhookDebugLog from "./JiraWebhookDebugLog.ts";
import { jiraWebhookRouteLayer } from "./http.ts";

const layerDependencies = Layer.mergeAll(
  JiraAppClient.layer,
  JiraDeliveryStore.layer,
  JiraWebhookDebugLog.layer,
).pipe(Layer.provideMerge(JiraAppConfig.layer));

export const layer = jiraWebhookRouteLayer.pipe(
  HttpRouter.provideRequest(JiraIssueBridge.layer.pipe(Layer.provideMerge(layerDependencies))),
);
