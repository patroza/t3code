// @vitest-environment jsdom
import { ProjectId, EnvironmentId } from "@t3tools/contracts";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  pathname: "/",
  deepLink: false,
  projectPresent: true,
  snapshotProjectId: "project",
  startDraft: vi.fn(),
}));

const project = { id: ProjectId.make("project"), environmentId: EnvironmentId.make("local") };

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  createFileRoute: () => (options: unknown) => ({
    options,
    useRouteContext: () => ({ authGateState: { status: "connected" } }),
  }),
  useRouter: () => ({ state: { location: { pathname: state.pathname } } }),
  Link: "a",
}));
vi.mock("../hooks/useHandleNewThread", () => ({ useNewThreadHandler: () => state.startDraft }));
vi.mock("../deepLinkStore", () => ({ hasThreadDeepLinkIntent: () => state.deepLink }));
vi.mock("../state/entities", () => ({
  readProject: () => (state.projectPresent ? project : null),
  useProjects: () => [{ ...project, id: ProjectId.make(state.snapshotProjectId) }],
  useThreadShells: () => [],
  useAllEnvironmentShellsBootstrapped: () => true,
}));
vi.mock("../state/environments", () => ({
  useEnvironments: () => ({ environments: [], isReady: true }),
}));
vi.mock("../components/Sidebar.logic", () => ({
  sortScopedProjectsForSidebar: (projects: unknown) => projects,
}));
vi.mock("../components/NoProjectsHero", () => ({ NoProjectsHero: "div" }));
vi.mock("../components/WorkspacePageHeader", () => ({ WorkspacePageHeader: "div" }));
vi.mock("../components/ui/sidebar", () => ({ SidebarInset: "div" }));
vi.mock("../components/ui/button", () => ({ Button: "button" }));
vi.mock("../components/ui/empty", () => ({
  Empty: "div",
  EmptyDescription: "div",
  EmptyHeader: "div",
  EmptyTitle: "div",
}));
vi.mock("~/components/ui/refresh-icon", () => ({ RefreshIcon: "span" }));

import { Route } from "./_chat.index";

let root: Root | undefined;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.pathname = "/";
  state.deepLink = false;
  state.projectPresent = true;
  state.snapshotProjectId = "project";
  state.startDraft.mockReset().mockResolvedValue({ threadId: "draft" });
});
afterEach(async () => {
  if (root) await act(() => root!.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

async function landOnIndex() {
  const component = Route.options.component!;
  if ("preload" in component && typeof component.preload === "function") {
    await component.preload();
  }
  root = createRoot(document.createElement("div"));
  await act(async () => {
    root!.render(createElement(Route.options.component!));
  });
}

describe("index draft landing", () => {
  it("starts a draft in the selected project", async () => {
    await landOnIndex();
    expect(state.startDraft).toHaveBeenCalledWith(
      { environmentId: project.environmentId, projectId: project.id },
      { replace: true },
    );
  });
  it("leaves pending thread deep links to their coordinator", async () => {
    state.deepLink = true;
    await landOnIndex();
    expect(state.startDraft).not.toHaveBeenCalled();
  });
  it("does not replace a destination while the old index remains mounted", async () => {
    state.pathname = "/local/existing-thread";
    await landOnIndex();
    expect(state.startDraft).not.toHaveBeenCalled();
  });
  it("does not start a draft for a project removed since the render snapshot", async () => {
    state.projectPresent = false;
    await landOnIndex();
    expect(state.startDraft).not.toHaveBeenCalled();
  });
  it("tries the replacement project when the first project disappears during draft startup", async () => {
    state.startDraft.mockImplementationOnce(async () => {
      state.snapshotProjectId = "replacement";
      return null;
    });
    await landOnIndex();
    expect(state.startDraft).toHaveBeenCalledTimes(2);
    expect(state.startDraft).toHaveBeenLastCalledWith(
      { environmentId: project.environmentId, projectId: ProjectId.make("replacement") },
      { replace: true },
    );
  });
});
