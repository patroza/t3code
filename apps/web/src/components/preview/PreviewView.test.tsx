import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(async (_tabId: string, _url: string): Promise<void> => undefined),
  rememberPreviewUrl: vi.fn(),
  readPreparedConnection: vi.fn(() => ({ httpBaseUrl: "http://172.25.85.75:3773" })),
  // Reachability is the resolver's job and is covered by its own tests; here it
  // stands in for "whatever the environment says is reachable".
  resolveNavigableUrl: vi.fn(
    async (_environmentId: string, target: { readonly url?: string }): Promise<string> =>
      (target.url ?? "").replace("localhost", "172.25.85.75"),
  ),
  submittedUrl: null as ((url: string) => void) | null,
  emptyStateUrl: null as ((url: string) => void) | null,
  togglePictureInPicture: null as (() => void) | null,
  toggleNativePictureInPicture: null as (() => void) | null,
  pictureInPicturePressed: false,
  miniPlayerTabId: null as string | null,
  openMiniPlayer: vi.fn(),
  closeMiniPlayer: vi.fn(),
  closeRightPanel: vi.fn(),
  openPictureInPicture: vi.fn(async (_tabId: string): Promise<void> => undefined),
  closePictureInPicture: vi.fn(async (_tabId: string): Promise<void> => undefined),
  pictureInPicture: false,
  showEmptyState: false,
}));

vi.mock("~/state/session", () => ({
  readPreparedConnection: mocks.readPreparedConnection,
}));

vi.mock("~/composerDraftStore", () => ({
  useComposerDraftStore: (
    select: (store: { addPreviewAnnotation: () => void; addImage: () => void }) => unknown,
  ) => select({ addPreviewAnnotation: vi.fn(), addImage: vi.fn() }),
}));

vi.mock("~/lib/previewAnnotation", () => ({
  previewAnnotationScreenshotFile: vi.fn(),
}));

vi.mock("~/localApi", () => ({
  ensureLocalApi: vi.fn(),
}));

vi.mock("~/previewStateStore", () => ({
  rememberPreviewUrl: mocks.rememberPreviewUrl,
  updatePreviewServerSnapshot: vi.fn(),
  useThreadPreviewState: () => ({
    activeTabId: "tab-1",
    desktopByTabId: {
      "tab-1": {
        hasWebContents: true,
        canGoBack: false,
        canGoForward: false,
        loading: false,
        zoomFactor: 1,
        pictureInPicture: mocks.pictureInPicture,
        colorScheme: "system",
        controller: "none",
      },
    },
    recentlySeenUrls: [],
    sessions: mocks.showEmptyState
      ? {}
      : {
          "tab-1": {
            threadId: "thread-1",
            tabId: "tab-1",
            navStatus: {
              _tag: "Success",
              url: "http://example.com/",
              title: "Example",
            },
            canGoBack: false,
            canGoForward: false,
            updatedAt: "2026-07-13T00:00:00.000Z",
          },
        },
  }),
}));

vi.mock("~/state/environments", () => ({
  useEnvironment: () => ({ label: "WSL" }),
  useEnvironmentHttpBaseUrl: () => "http://172.25.85.75:3773",
}));

vi.mock("~/state/preview", () => ({
  previewEnvironment: { open: {}, resize: {} },
}));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => vi.fn(),
}));

vi.mock("~/browser/browserRecording", () => ({
  findActiveBrowserRecordingRuntimeTabId: vi.fn(() => null),
  startBrowserRecording: vi.fn(),
  stopBrowserRecording: vi.fn(),
  useActiveBrowserRecordingTabIds: () => new Set(),
}));

vi.mock("~/browser/browserSurfaceStore", () => ({
  useBrowserSurfaceStore: (
    select: (state: { byTabId: Record<string, { rect?: unknown }> }) => unknown,
  ) => select({ byTabId: {} }),
}));

vi.mock("~/previewMiniPlayerStore", () => {
  const usePreviewMiniPlayerStore = Object.assign(
    (select: (state: unknown) => unknown) =>
      select({
        byThreadKey: mocks.miniPlayerTabId
          ? {
              "environment-1:thread-1": {
                tabId: mocks.miniPlayerTabId,
                position: null,
              },
            }
          : {},
      }),
    {
      getState: () => ({
        open: mocks.openMiniPlayer,
        close: mocks.closeMiniPlayer,
      }),
    },
  );
  return {
    selectThreadPreviewMiniPlayer: (
      byThreadKey: Record<string, { tabId: string; position: null }>,
    ) => byThreadKey["environment-1:thread-1"] ?? null,
    usePreviewMiniPlayerStore,
  };
});

vi.mock("~/rightPanelStore", () => ({
  useRightPanelStore: {
    getState: () => ({ close: mocks.closeRightPanel }),
  },
}));

vi.mock("~/components/ui/toast", () => ({
  stackedThreadToast: vi.fn(),
  toastManager: { add: vi.fn() },
}));

vi.mock("./previewBridge", () => ({
  previewBridge: {
    navigate: mocks.navigate,
    pictureInPicture: {
      open: mocks.openPictureInPicture,
      close: mocks.closePictureInPicture,
    },
  },
}));

vi.mock("./PreviewChromeRow", () => ({
  PreviewChromeRow: (props: {
    onSubmit: (url: string) => void;
    onPictureInPicture?: () => void;
    pictureInPicture?: boolean;
    trailingActions?: {
      props: { onNativePictureInPicture?: () => void };
    };
  }) => {
    mocks.submittedUrl = props.onSubmit;
    mocks.togglePictureInPicture = props.onPictureInPicture ?? null;
    mocks.toggleNativePictureInPicture =
      props.trailingActions?.props.onNativePictureInPicture ?? null;
    mocks.pictureInPicturePressed = props.pictureInPicture ?? false;
    return null;
  },
}));

vi.mock("./PreviewEmptyState", () => ({
  PreviewEmptyState: (props: { onOpenUrl: (url: string) => void }) => {
    mocks.emptyStateUrl = props.onOpenUrl;
    return null;
  },
}));
vi.mock("./PreviewMoreMenu", () => ({
  PreviewMoreMenu: (props: { onNativePictureInPicture: () => void }) => {
    mocks.toggleNativePictureInPicture = props.onNativePictureInPicture;
    return null;
  },
}));
vi.mock("./PreviewUnreachable", () => ({ PreviewUnreachable: () => null }));
vi.mock("./ZoomIndicator", () => ({ ZoomIndicator: () => null }));
vi.mock("./AgentBrowserCursor", () => ({ AgentBrowserCursor: () => null }));
vi.mock("~/browser/BrowserSurfaceSlot", () => ({ BrowserSurfaceSlot: () => null }));
vi.mock("./useLoadingProgress", () => ({ useLoadingProgress: () => 0 }));
vi.mock("./usePreviewSession", () => ({ usePreviewSession: vi.fn() }));

vi.mock("~/browser/browserTargetResolver", () => ({
  resolveNavigableUrl: mocks.resolveNavigableUrl,
}));

import { PreviewView } from "./PreviewView";
import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";

const TEST_THREAD_REF = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
} as const;
const TEST_RUNTIME_TAB_ID = previewRuntimeTabId(TEST_THREAD_REF, null, "tab-1");

describe("PreviewView navigation", () => {
  beforeEach(() => {
    mocks.navigate.mockClear();
    mocks.rememberPreviewUrl.mockClear();
    mocks.readPreparedConnection.mockClear();
    mocks.resolveNavigableUrl.mockClear();
    mocks.submittedUrl = null;
    mocks.emptyStateUrl = null;
    mocks.togglePictureInPicture = null;
    mocks.toggleNativePictureInPicture = null;
    mocks.pictureInPicturePressed = false;
    mocks.miniPlayerTabId = null;
    mocks.openMiniPlayer.mockClear();
    mocks.closeMiniPlayer.mockClear();
    mocks.closeRightPanel.mockClear();
    mocks.openPictureInPicture.mockClear();
    mocks.closePictureInPicture.mockClear();
    mocks.pictureInPicture = false;
    mocks.showEmptyState = false;
  });

  // A typed localhost URL means "the dev server on the environment host", so it
  // goes through the same reachability resolution as a clicked port. Typing it
  // used to navigate verbatim, which cannot work from a remote client.
  it.each([
    [
      "https://localhost:8000/dashboard?mode=test#top",
      "https://172.25.85.75:8000/dashboard?mode=test#top",
    ],
    ["localhost:5173/app", "http://172.25.85.75:5173/app"],
  ])("resolves a submitted localhost URL against the environment", async (submitted, expected) => {
    renderToStaticMarkup(
      <PreviewView
        threadRef={{
          environmentId: EnvironmentId.make("environment-1"),
          threadId: ThreadId.make("thread-1"),
        }}
        tabId="tab-1"
        visible
      />,
    );

    expect(mocks.submittedUrl).not.toBeNull();
    mocks.submittedUrl?.(submitted);

    await vi.waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith(TEST_RUNTIME_TAB_ID, expected),
    );
    expect(mocks.rememberPreviewUrl).toHaveBeenCalledWith(
      {
        environmentId: "environment-1",
        threadId: "thread-1",
      },
      expected,
    );
  });

  it("resolves an empty-state localhost server against the environment", async () => {
    mocks.showEmptyState = true;
    renderToStaticMarkup(
      <PreviewView
        threadRef={{
          environmentId: EnvironmentId.make("environment-1"),
          threadId: ThreadId.make("thread-1"),
        }}
        tabId="tab-1"
        visible
      />,
    );

    expect(mocks.emptyStateUrl).not.toBeNull();
    mocks.emptyStateUrl?.("http://localhost:5173/app?mode=test#top");

    await vi.waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith(
        TEST_RUNTIME_TAB_ID,
        "http://172.25.85.75:5173/app?mode=test#top",
      ),
    );
    expect(mocks.rememberPreviewUrl).toHaveBeenCalledWith(
      {
        environmentId: "environment-1",
        threadId: "thread-1",
      },
      "http://172.25.85.75:5173/app?mode=test#top",
    );
  });

  it("opens and closes a thread-scoped floating preview for the active tab", async () => {
    const props = {
      threadRef: {
        environmentId: EnvironmentId.make("environment-1"),
        threadId: ThreadId.make("thread-1"),
      },
      tabId: "tab-1",
      visible: true,
    } as const;

    renderToStaticMarkup(<PreviewView {...props} />);
    expect(mocks.pictureInPicturePressed).toBe(false);
    mocks.togglePictureInPicture?.();
    expect(mocks.openMiniPlayer).toHaveBeenCalledWith(props.threadRef, "tab-1");
    expect(mocks.closeRightPanel).toHaveBeenCalledWith(props.threadRef);

    mocks.miniPlayerTabId = "tab-1";
    renderToStaticMarkup(<PreviewView {...props} />);
    expect(mocks.pictureInPicturePressed).toBe(true);
    mocks.togglePictureInPicture?.();
    expect(mocks.closeMiniPlayer).toHaveBeenCalledWith(props.threadRef);
  });

  it("keeps the native preview window as a secondary action", async () => {
    const props = {
      threadRef: {
        environmentId: EnvironmentId.make("environment-1"),
        threadId: ThreadId.make("thread-1"),
      },
      tabId: "tab-1",
      visible: true,
    } as const;

    renderToStaticMarkup(<PreviewView {...props} />);
    mocks.toggleNativePictureInPicture?.();
    await vi.waitFor(() =>
      expect(mocks.openPictureInPicture).toHaveBeenCalledWith(TEST_RUNTIME_TAB_ID),
    );

    mocks.pictureInPicture = true;
    renderToStaticMarkup(<PreviewView {...props} />);
    mocks.toggleNativePictureInPicture?.();
    await vi.waitFor(() =>
      expect(mocks.closePictureInPicture).toHaveBeenCalledWith(TEST_RUNTIME_TAB_ID),
    );
  });
});
