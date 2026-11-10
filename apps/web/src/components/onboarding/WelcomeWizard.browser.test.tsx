import { RegistryContext } from "@effect/atom-react";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type AgentSessionProjectCandidate,
  type AuthEnvironmentScope,
  type AuthSessionState,
  type EnvironmentCloudLinkStateResult,
  type ServerProvider,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { act, render } from "../../../test/render";

type SessionResult = AsyncResult.AsyncResult<AuthSessionState, Error>;
type Project = { id: ProjectId; environmentId: EnvironmentId; workspaceRoot: string };
type CreateProjectInput = {
  environmentId: EnvironmentId;
  input: { projectId: ProjectId; workspaceRoot: string };
};
const state = vi.hoisted(() => ({
  sessions: new Map<string, unknown>(),
  projects: null as unknown,
  providers: null as unknown,
  config: null as unknown,
  candidates: null as unknown,
  createProject: vi.fn(),
  importThreads: vi.fn(),
  refreshProviders: vi.fn(),
  completeOnboarding: vi.fn(),
  onDone: vi.fn(),
  scan: vi.fn(),
  refreshScan: vi.fn(),
  waitForProject: vi.fn(),
  cloud: false,
  auth: { isLoaded: true, isSignedIn: false, userId: null as string | null },
  linkState: null as unknown,
  linkError: null as string | null,
  refreshLinkState: vi.fn(),
  scanError: null as string | null,
  scanPending: false,
}));

vi.mock(import("@t3tools/client-runtime/state/session"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    createEnvironmentSessionAtoms: ((runtime: never) => ({
      ...actual.createEnvironmentSessionAtoms(runtime),
      sessionStateAtom: (id: EnvironmentId) => state.sessions.get(id),
    })) as never,
  };
});
vi.mock(import("../../cloud/publicConfig"), async (original) => ({
  ...(await original()),
  hasCloudPublicConfig: () => state.cloud,
}));
vi.mock(import("@clerk/react"), async (original) => ({
  ...(await original()),
  useAuth: (() => state.auth) as never,
}));
vi.mock(import("../clerk/useT3ConnectAuthPrompt"), async (original) => ({
  ...(await original()),
  useT3ConnectAuthPrompt: (() => ({ openAuthPrompt: () => {} })) as never,
}));
vi.mock(import("../../cloud/cloudLinkState"), async (original) => {
  const { useAtomValue } = await import("@effect/atom-react");
  return {
    ...(await original()),
    useCloudLinkState: (() => ({
      data: useAtomValue(state.linkState as Atom.Atom<EnvironmentCloudLinkStateResult | null>),
      error: state.linkError,
      isPending: false,
      refresh: state.refreshLinkState,
    })) as never,
  };
});
vi.mock(import("../../onboarding/firstRun"), async (original) => ({
  ...(await original()),
  completeOnboarding: state.completeOnboarding,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({
    environments: [{ environmentId: "primary", label: "primary" }],
  })) as never,
  usePrimaryEnvironmentId: (() => "primary") as never,
}));
vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      providersValueAtom: (() => state.providers) as never,
      configValueAtom: (() => state.config) as never,
      refreshProviders: "refreshProviders" as never,
    },
  };
});
vi.mock(import("../../state/entities"), async (original) => {
  const { useAtomValue } = await import("@effect/atom-react");
  return {
    ...(await original()),
    useProjects: (() => useAtomValue(state.projects as Atom.Atom<Project[]>)) as never,
    readProjects: (() => appAtomRegistry.get(state.projects as Atom.Atom<Project[]>)) as never,
    waitForProject: ((ref: unknown) => state.waitForProject(ref)) as never,
  };
});
vi.mock(import("../../state/projects"), async (original) => ({
  ...(await original()),
  projectEnvironment: { create: "createProject" } as never,
}));
vi.mock(import("../../state/agentSessions"), async (original) => ({
  ...(await original()),
  agentSessionImport: "importThreads" as never,
}));
vi.mock(import("../../onboarding/useProjectScans"), async (original) => {
  const { useAtomValue } = await import("@effect/atom-react");
  return {
    ...(await original()),
    useProjectScans: (ids: readonly EnvironmentId[]) => {
      const candidates = useAtomValue(
        state.candidates as Atom.Atom<AgentSessionProjectCandidate[]>,
      );
      return ids.map((environmentId) => {
        state.scan({ environmentId });
        return {
          environmentId,
          data: (state.scanPending ? null : { candidates, truncated: false }) as never,
          isPending: state.scanPending,
          error: state.scanError,
          refresh: state.refreshScan,
        };
      });
    },
  };
});
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: "createProject" | "importThreads" | "refreshProviders") =>
    state[command]) as never,
}));

import { welcomeImportSelectionKey } from "../../onboarding/welcomeState";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { toastManager } from "../ui/toast";
import { WelcomePage } from "./WelcomePage";

const primaryId = EnvironmentId.make("primary");
const readyClaude: ServerProvider = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-01-01T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

function session(scopes: ReadonlyArray<AuthEnvironmentScope>): AuthSessionState {
  return {
    authenticated: true,
    scopes: [AuthOrchestrationReadScope, ...scopes],
    auth: {
      policy: "remote-reachable",
      bootstrapMethods: ["one-time-token"],
      sessionMethods: ["bearer-access-token"],
      sessionCookieName: "t3_session",
    },
  };
}

function projectsAtom() {
  return state.projects as Atom.Writable<ReadonlyArray<Project>>;
}

function candidatesAtom() {
  return state.candidates as Atom.Writable<ReadonlyArray<AgentSessionProjectCandidate>>;
}

// Default selection only picks recently active projects, so pin "now".
const NOW = Date.parse("2026-01-01T00:00:00.000Z");

function candidate(
  path: string,
  overrides: Partial<AgentSessionProjectCandidate> = {},
): AgentSessionProjectCandidate {
  return {
    path,
    title: path.split("/").at(-1)!,
    sources: ["codex"],
    threadCount: 10,
    lastActiveAt: new Date(NOW - 60_000).toISOString(),
    alreadyImported: false,
    ...overrides,
  };
}

function recordProject({ environmentId, input }: CreateProjectInput) {
  appAtomRegistry.set(projectsAtom(), [
    ...appAtomRegistry.get(projectsAtom()),
    { id: input.projectId, environmentId, workspaceRoot: input.workspaceRoot },
  ]);
  return AsyncResult.success(undefined);
}

// Resolves once the project reaches the mocked projects atom; the real helper's timeout is
// replaced per test with a rejection.
function waitForRecordedProject(ref: { environmentId: EnvironmentId; projectId: string }) {
  const find = () =>
    appAtomRegistry
      .get(projectsAtom())
      .find(
        (project) => project.id === ref.projectId && project.environmentId === ref.environmentId,
      );
  return new Promise<Project>((resolve) => {
    const current = find();
    if (current) return resolve(current);
    const unsubscribe = appAtomRegistry.subscribe(projectsAtom(), () => {
      const project = find();
      if (!project) return;
      unsubscribe();
      resolve(project);
    });
  });
}

function button(label: string) {
  const found = [...document.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === label,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

async function click(label: string) {
  const target = button(label);
  expect(target.disabled).toBe(false);
  await act(async () => target.click());
}

async function mountWelcome() {
  return render(
    <RegistryContext.Provider value={appAtomRegistry}>
      <WelcomePage environmentId={primaryId} onDone={state.onDone} />
    </RegistryContext.Provider>,
  );
}

// The mocked modules read `state`, so every test starts by replacing all of it.
// Returns the clock spy so each test can `using` it; the spy would otherwise outlive the test.
function setup() {
  const now = vi.spyOn(Date, "now").mockReturnValue(NOW);
  state.sessions.clear();
  for (const id of [primaryId]) {
    state.sessions.set(
      id,
      Atom.make<SessionResult>(AsyncResult.success(session([AuthOrchestrationOperateScope]))).pipe(
        Atom.keepAlive,
      ),
    );
  }
  state.projects = Atom.make<ReadonlyArray<Project>>([]).pipe(Atom.keepAlive);
  state.providers = Atom.make<ReadonlyArray<ServerProvider>>([readyClaude]).pipe(Atom.keepAlive);
  state.config = Atom.make(null).pipe(Atom.keepAlive);
  state.candidates = Atom.make<ReadonlyArray<AgentSessionProjectCandidate>>([
    candidate("/projects/first"),
    candidate("/projects/second"),
  ]).pipe(Atom.keepAlive);
  state.createProject
    .mockReset()
    .mockImplementation(async (input: CreateProjectInput) => recordProject(input));
  state.importThreads
    .mockReset()
    .mockResolvedValue(AsyncResult.success({ importedCount: 1, skippedCount: 0 }));
  state.refreshProviders.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.completeOnboarding.mockReset().mockResolvedValue(undefined);
  state.onDone.mockReset();
  state.scan.mockReset();
  state.refreshScan.mockReset();
  state.waitForProject.mockReset().mockImplementation(waitForRecordedProject);
  state.cloud = false;
  state.auth = { isLoaded: true, isSignedIn: false, userId: null };
  state.linkState = Atom.make<EnvironmentCloudLinkStateResult | null>(null).pipe(Atom.keepAlive);
  state.linkError = null;
  state.refreshLinkState.mockReset();
  state.scanError = null;
  state.scanPending = false;
  localStorage.removeItem(welcomeImportSelectionKey(primaryId));
  return now;
}

it.each([
  [0, 0, null],
  [29, 0, null],
  [1, 0, null],
  [0, 1, "1 thread could not be imported."],
  [0, 2, "2 threads could not be imported."],
] as const)(
  "finishes setup with %i imported and %i skipped threads",
  async (importedCount, skippedCount, warning) => {
    using _now = setup();
    appAtomRegistry.set(candidatesAtom(), [candidate("/projects/first")]);
    state.importThreads.mockResolvedValue(AsyncResult.success({ importedCount, skippedCount }));
    await using _screen = await mountWelcome();
    using toastAdd = vi.spyOn(toastManager, "add");

    await click("Import 1 project and start");
    await vi.waitFor(() => expect(state.onDone).toHaveBeenCalledOnce());
    if (warning !== null) {
      await vi.waitFor(() =>
        expect(toastAdd).toHaveBeenCalledWith(
          expect.objectContaining({ type: "warning", description: warning }),
        ),
      );
    } else if (importedCount > 0) {
      await vi.waitFor(() =>
        expect(toastAdd).toHaveBeenCalledWith({
          type: "success",
          title: `Imported ${importedCount} ${importedCount === 1 ? "thread" : "threads"}`,
        }),
      );
    } else {
      expect(toastAdd).not.toHaveBeenCalled();
    }
  },
);

it("preserves the partial-import warning when saving setup fails and is retried", async () => {
  using _now = setup();
  appAtomRegistry.set(candidatesAtom(), [candidate("/projects/first")]);
  state.importThreads
    .mockResolvedValueOnce(AsyncResult.success({ importedCount: 28, skippedCount: 1 }))
    // Imported history is idempotent; retry only reports the still-skipped thread.
    .mockResolvedValue(AsyncResult.success({ importedCount: 0, skippedCount: 1 }));
  state.completeOnboarding.mockRejectedValueOnce(new Error("settings unavailable"));
  await using _screen = await mountWelcome();
  using toastAdd = vi.spyOn(toastManager, "add");
  await click("Import 1 project and start");
  await vi.waitFor(() => expect(state.completeOnboarding).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(button("Import threads and start").disabled).toBe(false));
  expect(state.onDone).not.toHaveBeenCalled();
  await click("Import threads and start");
  await vi.waitFor(() => expect(state.onDone).toHaveBeenCalledOnce());
  await vi.waitFor(() =>
    expect(toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "warning",
        description: "Imported 28 threads. 1 thread could not be imported.",
      }),
    ),
  );
});
