import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { isThreadRoutePathname } from "./threadRoutes";

it("matches encoded MCP thread IDs from router navigation", async () => {
  const root = createRootRoute();
  const thread = createRoute({ getParentRoute: () => root, path: "$environmentId/$threadId" });
  const newThread = createRoute({ getParentRoute: () => root, path: "new" });
  const router = createRouter({
    routeTree: root.addChildren([thread, newThread]),
    history: createMemoryHistory({ initialEntries: ["/new"] }),
  });
  await router.load();
  const ref = scopeThreadRef("local" as never, ThreadId.make("mcp:example"));
  await router.navigate({
    to: "/$environmentId/$threadId",
    params: { environmentId: ref.environmentId, threadId: ref.threadId },
  });
  expect(router.state.location.pathname).toBe("/local/mcp%3Aexample");
  expect(router.state.matches.at(-1)?.params).toEqual(ref);
  expect(isThreadRoutePathname(router.state.location.pathname, ref)).toBe(true);
  await router.navigate({ to: "/new" });
  expect(isThreadRoutePathname(router.state.location.pathname, ref)).toBe(false);
});
