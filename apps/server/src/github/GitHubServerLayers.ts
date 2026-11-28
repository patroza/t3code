/**
 * Everything the server runs for the GitHub App, as one route layer: the `/api/github/webhook`
 * handler and the pull request bridge behind it.
 */
import * as GitHubAppInstallationAuth from "@t3tools/source-control-github/server/appInstallationAuth";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/http";

import * as WebhookDebugLog from "../webhooks/WebhookDebugLog.ts";
import * as GitHubAppClient from "./GitHubAppClient.ts";
import * as GitHubAppConfig from "./GitHubAppConfig.ts";
import * as GitHubDeliveryStore from "./GitHubDeliveryStore.ts";
import * as GitHubPrBridge from "./GitHubPrBridge.ts";
import { githubWebhookRouteLayer } from "./http.ts";

const layerDependencies = Layer.mergeAll(
  GitHubAppClient.layer,
  GitHubDeliveryStore.layer,
  WebhookDebugLog.layer("github"),
).pipe(Layer.provideMerge(GitHubAppConfig.layer));

export const appAuthLayer = GitHubAppInstallationAuth.layer.pipe(
  Layer.provide(
    Layer.effect(
      GitHubAppInstallationAuth.GitHubAppInstallationAuthConfig,
      Effect.map(
        GitHubAppConfig.GitHubAppConfig,
        (config) => config.agentAuth ?? { mode: "disabled" as const },
      ),
    ),
  ),
  Layer.provide(GitHubAppConfig.layer),
);

export const layer = githubWebhookRouteLayer.pipe(
  HttpRouter.provideRequest(GitHubPrBridge.layer.pipe(Layer.provideMerge(layerDependencies))),
);
