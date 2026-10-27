import { ProjectId, EnvironmentId } from "@t3tools/contracts";
import { createElement } from "react";
import { render } from "../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";

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
vi.mock("../components/HostedEmptyState", () => ({ HostedEmptyState: "div" }));
vi.mock("../components/WorkspacePageHeader", () => ({ WorkspacePageHeader: "div" }));
vi.mock("../components/ui/sidebar", () => ({ SidebarInset: "div" }));
vi.mock("../components/ui/button", () => ({
  Button: "button",
  InlineButton: "button",
  buttonVariants: () => "",
}));
vi.mock("../components/ui/empty", () => ({
  Empty: "div",
  EmptyDescription: "div",
  EmptyHeader: "div",
  EmptyTitle: "div",
}));
vi.mock("~/components/ui/refresh-icon", () => ({ RefreshIcon: "span" }));

import { Route } from "./_chat.index";

function setup() {
  state.pathname = "/";
  state.deepLink = false;
  state.projectPresent = true;
  state.snapshotProjectId = "project";
  state.startDraft.mockReset().mockResolvedValue({ threadId: "draft" });
}

async function landOnIndex() {
  const component = Route.options.component!;
  if ("preload" in component && typeof component.preload === "function") {
    await component.preload();
  }
  return render(createElement(Route.options.component!), { router: false });
}

describe("index draft landing", () => {
  it("starts a draft in the selected project", async () => {
    setup();
    await using _screen = await landOnIndex();
    expect(state.startDraft).toHaveBeenCalledWith(
      { environmentId: project.environmentId, projectId: project.id },
      { replace: true },
    );
  });
  it("leaves pending thread deep links to their coordinator", async () => {
    setup();
    state.deepLink = true;
    await using _screen = await landOnIndex();
    expect(state.startDraft).not.toHaveBeenCalled();
  });
  it("does not replace a destination while the old index remains mounted", async () => {
    setup();
    state.pathname = "/local/existing-thread";
    await using _screen = await landOnIndex();
    expect(state.startDraft).not.toHaveBeenCalled();
  });
  it("does not start a draft for a project removed since the render snapshot", async () => {
    setup();
    state.projectPresent = false;
    await using _screen = await landOnIndex();
    expect(state.startDraft).not.toHaveBeenCalled();
  });
  it("tries the replacement project when the first project disappears during draft startup", async () => {
    setup();
    state.startDraft.mockImplementationOnce(async () => {
      state.snapshotProjectId = "replacement";
      return null;
    });
    await using _screen = await landOnIndex();
    expect(state.startDraft).toHaveBeenCalledTimes(2);
    expect(state.startDraft).toHaveBeenLastCalledWith(
      { environmentId: project.environmentId, projectId: ProjectId.make("replacement") },
      { replace: true },
    );
  });
});
