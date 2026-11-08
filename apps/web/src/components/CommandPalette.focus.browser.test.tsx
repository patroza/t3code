import { act, render as renderScreen, fakeTimers } from "../../test/render";
import { useImperativeHandle, useRef } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@t3tools/contracts/settings";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { CommandPalette } from "./CommandPalette";
import { useComposerHandleContext } from "../composerHandleContext";
import { openCommandPalette } from "../commandPaletteBus";
import { installCommandPaletteCommands } from "../shortcuts/commandPaletteCommands";
import { userEvent, page } from "vite-plus/test/browser";
import { useCommandPaletteStore } from "../commandPaletteStore";
import { primaryServerKeybindingsAtom } from "../state/server";

const browseRace = vi.hoisted(() => ({ enabled: false, load: vi.fn<() => Promise<void>>() }));
const browseEnvironment = {
  environmentId: "browse-env",
  label: "Browse host",
  entry: { target: { _tag: "PrimaryConnectionTarget" } },
  connection: { phase: "connected", error: null },
  serverConfig: { environment: { platform: { os: "linux" }, capabilities: {} }, settings: {} },
  displayUrl: null,
};
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(),
  useParams: () => null,
  useLocation: () => "/settings",
}));
vi.mock("@effect/atom-react", async (importOriginal) => {
  const original = await importOriginal<typeof import("@effect/atom-react")>();
  return {
    ...original,
    useAtomValue: (atom: unknown) =>
      atom === primaryServerKeybindingsAtom ? DEFAULT_RESOLVED_KEYBINDINGS : [],
  };
});
vi.mock("../hooks/useTheme", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../hooks/useTheme")>()),
  useRenderedAppearance: () => "light",
  useTheme: () => ({ theme: "default", resolvedTheme: "light", appearanceMode: "light" }),
}));
vi.mock("../hooks/useCustomThemes", () => ({ useCustomThemes: () => [] }));
vi.mock("../hooks/useEnvironmentTheme", () => ({ useEnvironmentThemeDefinitions: () => [] }));
vi.mock("../hooks/useSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../hooks/useSettings")>()),
  useClientSettings: (select?: (settings: ClientSettings) => unknown) =>
    select ? select(DEFAULT_CLIENT_SETTINGS) : DEFAULT_CLIENT_SETTINGS,
}));
vi.mock("../hooks/useScratchProject", () => ({
  useScratchProject: () => ({ scratchEnvironmentId: () => null }),
}));
vi.mock("../hooks/useNewProject", () => ({ useNewProject: () => vi.fn() }));
vi.mock("../hooks/useHandleNewThread", () => ({
  useHandleNewThread: () => ({
    activeDraftThread: null,
    activeThread: null,
    defaultProjectRef: null,
    handleNewThread: vi.fn(),
  }),
  useNewThreadHandler: () => vi.fn(),
}));
vi.mock("../lib/archivedThreadsState", async (importOriginal) => {
  const state = { snapshots: [] };
  return {
    ...(await importOriginal<typeof import("../lib/archivedThreadsState")>()),
    useArchivedThreadSnapshots: () => state,
  };
});
vi.mock("../hooks/useOpenPanelPullRequestUrl", () => ({ useOpenPanelPullRequestUrl: () => null }));
vi.mock("../connection/useDesktopLocalBootstraps", () => ({ useDesktopLocalBootstraps: () => [] }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => browseRace.load }));
vi.mock("../state/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/environments")>()),
  useEnvironmentProviders: () => new Map(),
  useEnvironments: () => ({ environments: browseRace.enabled ? [browseEnvironment] : [] }),
  usePrimaryEnvironmentId: () => (browseRace.enabled ? "browse-env" : null),
}));
vi.mock("../state/entities", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/entities")>()),
  useProjects: () => [],
  useThreadShells: () => [],
  useServerConfigs: () => new Map(),
}));
vi.mock("../state/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/queries")>()),
  useThreadSearch: (_environmentIds: ReadonlyArray<unknown>, query: string) => ({
    matches: [],
    query,
    isPending: false,
  }),
}));
vi.mock("../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/session")>()),
  useEnvironmentScope: () => browseRace.enabled,
  readEnvironmentScope: () => browseRace.enabled,
}));
vi.mock("../state/query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/query")>()),
  useEnvironmentQuery: (atom: unknown) =>
    atom && typeof atom === "object" && "browseFixture" in atom
      ? {
          data: {
            entries: [{ name: "child", fullPath: "/home/test/child" }],
            parentPath: "/home/test",
          },
          isPending: false,
          error: null,
        }
      : { data: null, error: null },
}));
vi.mock("../state/filesystem", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/filesystem")>()),
  filesystemEnvironment: { browse: () => ({ browseFixture: true }) },
  useFilesystemReadAccess: () => ({
    canReadFiles: browseRace.enabled,
    isPending: false,
    error: null,
  }),
}));
vi.mock("./settings/useAvailableSettingsSearchItems", () => ({
  useAvailableSettingsSearchItems: () => [],
}));

async function setup() {
  await using resources = new AsyncDisposableStack();
  resources.defer(async () => {
    vi.unstubAllGlobals();
  });
  const container = document.createElement("div");

  resources.use(fakeTimers());

  const screen = resources.use(await renderScreen(<></>, { container }));
  resources.defer(
    installCommandPaletteCommands(screen.router!, {
      keybindings: () => DEFAULT_RESOLVED_KEYBINDINGS,
    }),
  );

  async function flushFocus() {
    await act(() => vi.advanceTimersByTimeAsync(0));
    await act(() => vi.runOnlyPendingTimersAsync());
  }
  async function dismissPalette() {
    await act(() =>
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      ),
    );
    await flushFocus();
    expect(document.querySelector("[data-command-palette]")).toBeNull();
  }
  function Composer() {
    const handle = useComposerHandleContext();
    const input = useRef<HTMLTextAreaElement>(null);
    useImperativeHandle(
      handle,
      () =>
        ({
          focusAtEnd: () => {
            input.current?.focus();
            input.current?.setSelectionRange(
              input.current.value.length,
              input.current.value.length,
            );
          },
        }) as NonNullable<NonNullable<typeof handle>["current"]>,
    );
    return <textarea ref={input} aria-label="Composer" defaultValue="Draft prompt" />;
  }
  const lifetime = resources.move();
  return {
    screen,
    container,
    flushFocus,
    dismissPalette,
    Composer,
    [Symbol.asyncDispose]: () => lifetime.disposeAsync(),
  };
}

describe("command palette focus restoration", () => {
  it("returns to the previously focused Settings field when no composer is mounted", async () => {
    await using harness = await setup();
    const { screen, container, flushFocus, dismissPalette } = harness;

    await act(() =>
      screen.rerender(
        <CommandPalette>
          <input aria-label="Settings field" />
        </CommandPalette>,
      ),
    );
    const field = container.querySelector("input")!;
    await act(() => field.focus());
    await act(() => openCommandPalette());
    await flushFocus();
    expect(document.activeElement?.closest("[data-command-palette]")).not.toBeNull();
    await dismissPalette();
    expect(document.activeElement).toBe(field);
  });

  it("focuses the replacement command input after leaving the file picker", async () => {
    await using harness = await setup();
    const { screen, container, flushFocus, dismissPalette } = harness;

    await act(() =>
      screen.rerender(
        <CommandPalette>
          <input aria-label="Settings field" />
        </CommandPalette>,
      ),
    );
    const field = container.querySelector("input")!;
    await act(() => field.focus());
    await act(() =>
      field.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "p",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    await flushFocus();
    expect(document.querySelector('[data-palette-mode="files"]')).not.toBeNull();
    await act(() =>
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    await flushFocus();
    expect(document.activeElement?.closest('[data-palette-mode="command"]')).not.toBeNull();
    expect(document.activeElement?.tagName).toBe("INPUT");
    await dismissPalette();
    expect(document.activeElement).toBe(field);
  });

  it("focuses the mounted composer at the end instead of the previous field", async () => {
    await using harness = await setup();
    const { screen, container, flushFocus, dismissPalette, Composer } = harness;

    await act(() =>
      screen.rerender(
        <CommandPalette>
          <input aria-label="Previous field" />
          <Composer />
        </CommandPalette>,
      ),
    );
    await act(() => container.querySelector("input")!.focus());
    await act(() => openCommandPalette());
    await flushFocus();
    expect(document.activeElement?.closest("[data-command-palette]")).not.toBeNull();
    await dismissPalette();
    const composer = container.querySelector("textarea")!;
    expect(document.activeElement).toBe(composer);
    expect(composer.selectionStart).toBe(composer.value.length);
  });
  it("keeps the source picker restored when Back cancels an unfinished folder browse", async () => {
    browseRace.enabled = true;
    browseRace.load.mockResolvedValue(undefined);
    useCommandPaletteStore.setState(useCommandPaletteStore.getInitialState(), true);
    try {
      await using harness = await setup();
      const { screen, flushFocus } = harness;
      await act(() => screen.rerender(<CommandPalette>{null}</CommandPalette>));
      await act(() => openCommandPalette({ open: "add-project" }));
      await flushFocus();
      await userEvent.click(page.getByText("Local folder", { exact: true }));
      await flushFocus();
      expect(document.querySelector<HTMLInputElement>("[data-command-palette] input")?.value).toBe(
        "~/",
      );
      expect(browseRace.load).toHaveBeenCalledOnce();
      let finishBrowse!: () => void;
      browseRace.load.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishBrowse = resolve;
          }),
      );
      await userEvent.click(page.getByText("child", { exact: true }));
      await flushFocus();
      expect(finishBrowse).toBeTypeOf("function");
      await act(() =>
        document.querySelector<HTMLButtonElement>('button[aria-label="Back"]')!.click(),
      );
      await flushFocus();
      const restored = document.querySelector<HTMLInputElement>(
        "[data-command-palette] input",
      )?.value;
      expect(restored).toBe("");
      await act(async () => {
        finishBrowse();
        await Promise.resolve();
      });
      await flushFocus();
      expect(document.querySelector<HTMLInputElement>("[data-command-palette] input")?.value).toBe(
        restored,
      );
      await expect.element(page.getByText("Local folder", { exact: true })).toBeVisible();
    } finally {
      browseRace.enabled = false;
      browseRace.load.mockReset();
    }
  });
});
