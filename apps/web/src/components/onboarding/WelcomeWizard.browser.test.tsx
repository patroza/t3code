import { act, render as renderScreen } from "../../../test/render";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  importThreads: vi.fn(),
  createProject: vi.fn(),
  complete: vi.fn(),
  refresh: vi.fn(),
  toast: vi.fn(),
  projects: [] as Array<{ id: string; environmentId: string; workspaceRoot: string }>,
}));
vi.mock("../../state/session", () => ({
  useEnvironmentScope: () => true,
  useEnvironmentsWithScope: (environments: Array<{ environmentId: string }>) =>
    new Set(environments.map((entry) => entry.environmentId)),
  readEnvironmentScope: () => true,
}));
vi.mock("../../state/agentSessions", () => ({ agentSessionImport: "import" }));
vi.mock("../../state/projects", () => ({ projectEnvironment: { create: "create" } }));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) =>
    command === "import"
      ? mocks.importThreads
      : command === "create"
        ? mocks.createProject
        : mocks.refresh,
}));
vi.mock("../../onboarding/firstRun", () => ({ completeOnboarding: mocks.complete }));
vi.mock("../../state/entities", () => ({
  useProjects: () => mocks.projects,
  readProjects: () => mocks.projects,
  waitForProject: async () => mocks.projects[0],
  // Partial mocks leak under isolate:false. Preview reopen needs this export.
  readEnvironmentSupportsServerBrowser: () => false,
}));
vi.mock("../../state/environments", () => {
  const environment = {
    environmentId: "test-env",
    label: "Computer",
    connection: { phase: "connected" },
    entry: { enabled: true },
  };
  return {
    useEnvironments: () => ({ environments: [environment] }),
    usePrimaryEnvironment: () => environment,
  };
});
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    providersValueAtom: () => [],
    configValueAtom: () => null,
    refreshProviders: "refresh",
  },
}));
vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useAtomValue: (value: unknown) => value,
}));
vi.mock("../../onboarding/useProjectScans", () => ({
  useProjectScans: () => [
    {
      environmentId: "test-env",
      isPending: false,
      error: null,
      refresh: mocks.refresh,
      data: {
        truncated: false,
        candidates: [
          {
            path: "/project",
            title: "project",
            projectId: "test-project",
            threadCount: 29,
            lastActiveAt: new Date().toISOString(),
            sources: ["codex"],
          },
        ],
      },
    },
  ],
}));
vi.mock("../../connection/onboarding", () => ({ connectPairing: vi.fn() }));
vi.mock("../../state/terminal", () => ({ terminalEnvironment: {} }));
vi.mock("../clerk/useT3ConnectAuthPrompt", () => ({ useT3ConnectAuthPrompt: vi.fn() }));
vi.mock("../../cloud/publicConfig", () => ({ hasCloudPublicConfig: () => false }));
vi.mock("../ThreadTerminalDrawer", () => ({ TerminalViewport: () => null }));
vi.mock("../settings/ChatGptWelcomeCoordinator", () => ({ ChatGptWelcomeCoordinator: () => null }));
vi.mock("../settings/CodexSetupSection", () => ({
  CodexSetupSection: () => null,
  AddManagedCodexAccountDialog: () => null,
}));
vi.mock("../cloud/CloudEnvironmentConnectList", () => ({
  CloudEnvironmentConnectRows: () => null,
}));
vi.mock("../ui/toast", () => ({
  toastManager: { add: mocks.toast, close: vi.fn(), update: vi.fn() },
}));

import { WelcomeWizard } from "./WelcomeWizard";

async function setup() {
  await using resources = new AsyncDisposableStack();
  resources.defer(async () => {});
  const container = document.createElement("div");

  vi.clearAllMocks();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  mocks.projects = [{ id: "test-project", environmentId: "test-env", workspaceRoot: "/project" }];
  mocks.complete.mockResolvedValue(undefined);
  mocks.refresh.mockResolvedValue(undefined);
  mocks.importThreads.mockResolvedValue({
    _tag: "Success",
    value: { importedCount: 28, skippedCount: 1 },
  });

  const screen = resources.use(await renderScreen(<></>, { container }));

  async function click(label: string) {
    const button = [...document.querySelectorAll("button")].find(
      (element) => element.textContent?.trim() === label,
    );
    expect(button, `button ${label}`).toBeDefined();
    await act(async () => button!.click());
  }
  const lifetime = resources.move();
  return { screen, container, click, [Symbol.asyncDispose]: () => lifetime.disposeAsync() };
}

it("enters the workspace after a partial import and warns after navigation finishes", async () => {
  await using harness = await setup();
  const { screen, click } = harness;

  let finishNavigation = () => {};
  const navigation = new Promise<void>((resolve) => {
    finishNavigation = resolve;
  });
  const onDone = vi.fn(() => navigation);
  await act(async () => screen.rerender(<WelcomeWizard localAvailable onDone={onDone} />));
  await click("Continue");
  await click("Continue");
  await click("Import 1 project");
  expect(onDone).toHaveBeenCalledWith({
    environmentId: EnvironmentId.make("test-env"),
    projectId: ProjectId.make("test-project"),
  });
  expect(mocks.toast).not.toHaveBeenCalled();
  await act(async () => finishNavigation());
  expect(mocks.toast).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "warning",
      description: "Imported 28 threads. 1 thread could not be imported.",
    }),
  );
  expect(mocks.toast.mock.invocationCallOrder[0]).toBeGreaterThan(
    onDone.mock.invocationCallOrder[0]!,
  );
});

it.each([
  [0, 0, null],
  [29, 0, null],
  [1, 0, null],
  [0, 1, "1 thread could not be imported."],
  [0, 2, "2 threads could not be imported."],
] as const)(
  "finishes setup with %i imported and %i skipped threads",
  async (importedCount, skippedCount, warning) => {
    await using harness = await setup();
    const { screen, click } = harness;

    mocks.importThreads.mockResolvedValue({
      _tag: "Success",
      value: { importedCount, skippedCount },
    });
    const onDone = vi.fn();
    await act(async () => screen.rerender(<WelcomeWizard localAvailable onDone={onDone} />));
    await click("Continue");
    await click("Continue");
    await click("Import 1 project");
    expect(onDone).toHaveBeenCalledOnce();
    if (warning === null && importedCount > 0) {
      expect(mocks.toast).toHaveBeenCalledWith({
        type: "success",
        title: `Imported ${importedCount} ${importedCount === 1 ? "thread" : "threads"}`,
      });
    } else if (warning === null) {
      expect(mocks.toast).not.toHaveBeenCalled();
    } else {
      expect(mocks.toast).toHaveBeenCalledWith(
        expect.objectContaining({ type: "warning", description: warning }),
      );
    }
  },
);

it("keeps setup open when saving completion fails and preserves the import warning on retry", async () => {
  await using harness = await setup();
  const { screen, click } = harness;

  mocks.complete.mockRejectedValueOnce(new Error("settings unavailable"));
  const onDone = vi.fn();
  await act(async () => screen.rerender(<WelcomeWizard localAvailable onDone={onDone} />));
  await click("Continue");
  await click("Continue");
  await click("Import 1 project");
  expect(onDone).not.toHaveBeenCalled();
  expect(mocks.toast).toHaveBeenCalledWith(
    expect.objectContaining({ type: "error", title: "Could not finish setup" }),
  );
  await click("Do not import projects");
  expect(onDone).toHaveBeenCalledOnce();
  expect(mocks.importThreads).toHaveBeenCalledOnce();
  expect(mocks.toast).toHaveBeenLastCalledWith(
    expect.objectContaining({
      type: "warning",
      description: "Imported 28 threads. 1 thread could not be imported.",
    }),
  );
});

it("requires explicit Close to complete local setup", async () => {
  await using harness = await setup();
  const { screen } = harness;

  const onDone = vi.fn();
  await act(async () => screen.rerender(<WelcomeWizard localAvailable onDone={onDone} />));
  await act(async () => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    const backdrop = document.querySelector<HTMLElement>('[data-slot="dialog-backdrop"]')!;
    backdrop.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" }),
    );
    backdrop.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    backdrop.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    backdrop.click();
  });
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  expect(mocks.complete).not.toHaveBeenCalled();
  expect(onDone).not.toHaveBeenCalled();

  const close = document.querySelector<HTMLButtonElement>('button[aria-label="Close"]');
  expect(close).not.toBeNull();
  await act(async () => close!.click());
  expect(mocks.complete).toHaveBeenCalledOnce();
  expect(onDone).toHaveBeenCalledWith(undefined);
});
