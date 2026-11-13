import { RegistryProvider } from "@effect/atom-react";
import { injectHtmlRenderBootstrap } from "@t3tools/shared/htmlRender";
import { HtmlRenderDocument } from "../files/BrowserDocumentFrame";
import { flushSync } from "react-dom";
import { AudioPreview } from "../files/AudioPreview";
import { commands, cdp, page } from "vite-plus/test/browser";
import {
  CheckpointRef,
  ComposerContextId,
  EnvironmentId,
  IdentityUsername,
  MessageId,
  PersonId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  TurnItemId,
  ScheduledTaskId,
  ThreadId,
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";
import {
  COMPOSER_CONTEXT_CLIPBOARD_MIME,
  decodeComposerContextClipboardHtml,
  decodeComposerContextFragment,
} from "@t3tools/shared/composerContextClipboard";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import {
  createRef,
  Profiler,
  StrictMode,
  useState,
  useRef,
  type ComponentProps,
  type ReactElement,
} from "react";
import { describe, expect, it, onTestFinished, vi } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import { Atom, AsyncResult } from "effect/reactivity";

import { userEvent } from "vite-plus/test/browser";
import { serverEnvironment } from "../../state/server";
import { PullRequestLinkPreview } from "../pullRequest/PullRequestLinkPreview";
import { Tooltip, TooltipPopup, TooltipScrollDismissArea, TooltipTrigger } from "../ui/tooltip";
import { readTimelinePosition } from "./timelineScrollAnchoring";
import { useComposerFocusState } from "./useComposerFocusState";
import "~/index.css";

import { environmentThreadDetails } from "../../state/threads";
import { act, fakeTimers, render, stubGlobal } from "../../../test/render";
import { ChangedFilesCard } from "./ChangedFilesTree";
import { MessagesTimeline } from "./MessagesTimeline";
import { createWorkspaceFocusController, workspaceAreaProps } from "../../lib/workspaceFocus";
import { resolveTimelineIsAtEnd } from "./MessagesTimeline.logic";
import { makeStreamingTimelineFixture } from "../../test-fixtures";
import {
  type PendingApproval,
  deriveTimelineEntriesFromVisibleTurnItems,
} from "../../session-logic";
import type { Root } from "mdast";
import { ViewedImagesTimelineRow } from "./TimelineWorkEntryRow";
import { remarkThoughtPreview, THOUGHT_PREVIEW_MAX_LENGTH } from "./TimelineWorkEntryRow.logic";
import { TimelineRowCtx } from "./timelineRowContext";
import { parseMarkdownWithMath } from "@t3tools/shared/markdownMath";
import { collectThreadFindRanges } from "./threadFindHighlights";
import { toastManager } from "../ui/toast";
import type { CitedHistory } from "./citationProcedure";
import type { TimelineNavigation } from "./timelineViewport";
import { useTimelineFollow } from "./useTimelineFollow";
import { rememberTimelinePosition } from "./timelineScrollAnchoring";
import { collectComposerContextReferences } from "@t3tools/shared/composerContextReferences";

const environmentQuery = vi.hoisted(() => ({
  error: "Pull request not found" as string | null,
  data: null as unknown,
}));
vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({
    data: environmentQuery.data,
    dataUpdatedAt: 0,
    error: environmentQuery.error,
    failure: null,
    isPending: false,
    isSuccess: false,
    refresh: () => {},
  })) as never,
}));

const stubbedAsset = vi.hoisted(() => ({ url: "" }));
vi.mock(import("~/assets/assetUrls"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    useAssetUrlState: ((...args: Parameters<typeof actual.useAssetUrlState>) =>
      stubbedAsset.url
        ? { _tag: "Success", url: stubbedAsset.url }
        : actual.useAssetUrlState(...args)) as typeof actual.useAssetUrlState,
  };
});

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const CREATED_AT = "2026-03-17T19:12:28.000Z";

type TimelineProps = ComponentProps<typeof MessagesTimeline>;
type Entry = TimelineProps["timelineEntries"][number];

// The timeline remembers scroll position and open disclosures per thread key,
// so every render gets a fresh thread.
function baseProps(): Omit<TimelineProps, "timelineEntries"> {
  return {
    isWorking: false,
    listRef: createRef<LegendListRef | null>(),
    latestRun: null,
    turnDiffSummaries: [],
    runs: [],
    routeThreadKey: `environment-local:thread-${Math.random().toString(36).slice(2)}`,
    onOpenTurnDiff: () => {},
    onOpenThread: () => {},
    onForkFromRun: async () => {},
    supportsConversationRollback: false,
    onRevertToTurnCount: () => {},
    isRevertingCheckpoint: false,
    onImageExpand: () => {},
    activeThreadEnvironmentId: ENVIRONMENT_ID,
    markdownCwd: undefined,
    resolvedTheme: "light",
    timestampFormat: "locale",
    workspaceRoot: undefined,
    anchorMessageId: null,
    onAnchorReady: () => {},
    onAnchorSizeChanged: () => {},
    contentInsetEndAdjustment: 0,
    emptyPlaceholderInset: 0,
    liveFollowEnabled: true,
    onIsAtEndChange: () => {},
  };
}

function message(
  text: string,
  overrides: Partial<Extract<Entry, { kind: "message" }>["message"]> = {},
  id = "message-1",
): Entry {
  return {
    id: `entry-${id}`,
    kind: "message",
    createdAt: CREATED_AT,
    message: {
      id: MessageId.make(id),
      role: "user",
      text,
      runId: null,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      streaming: false,
      ...overrides,
    },
  };
}

function work(id: string, entry: Record<string, unknown>): Entry {
  return {
    id,
    kind: "work",
    createdAt: CREATED_AT,
    entry: { id, createdAt: CREATED_AT, ...entry },
  } as Entry;
}

function v2Item(type: string, fields: Record<string, unknown>) {
  const id = (fields.id as string | undefined) ?? type;
  return {
    position: 0,
    visibility: "local",
    sourceThreadId: "thread-1",
    sourceItemId: id,
    item: {
      id,
      threadId: "thread-1",
      runId: "run-1",
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "completed",
      title: null,
      startedAt: null,
      completedAt: null,
      updatedAt: {},
      type,
      ...fields,
    },
  } as never;
}

function longText(tail = "deep hidden detail only after expand") {
  return Array.from({ length: 9 }, (_, index) =>
    index === 8 ? tail : `Line ${index + 1}: ${"verbose prompt content ".repeat(8).trim()}`,
  ).join("\n");
}

async function renderElement(element: ReactElement, options: { router?: false } = {}) {
  const container = document.createElement("div");
  container.style.cssText = "height: 1200px; width: 900px; display: flex; flex-direction: column;";
  const screen = await render(element, { container, ...options });
  const buttons = (name: string | RegExp) =>
    [...screen.container.querySelectorAll<HTMLElement>("button, [role=button]")].filter(
      (button) => {
        const label = button.getAttribute("aria-label") ?? button.textContent ?? "";
        return typeof name === "string" ? label === name : name.test(label);
      },
    );
  return Object.assign(screen, {
    text: () => container.textContent ?? "",
    buttons,
    button: (name: string | RegExp) => {
      const [match] = buttons(name);
      if (!match) throw new Error(`Missing button: ${String(name)}`);
      return match;
    },
  });
}

async function renderTimeline(entries: ReadonlyArray<Entry>, props: Partial<TimelineProps> = {}) {
  const defaults = baseProps();
  const timeline = (next: ReadonlyArray<Entry>, overrides: Partial<TimelineProps> = {}) => (
    <MessagesTimeline {...defaults} timelineEntries={next as Entry[]} {...overrides} />
  );
  const screen = await renderElement(timeline(entries, props));
  return Object.assign(screen, {
    rerenderTimeline: (next: ReadonlyArray<Entry>, overrides: Partial<TimelineProps> = {}) =>
      screen.rerender(timeline(next, overrides)),
  });
}

async function copyRange(range: Range) {
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  const clipboardData = new DataTransfer();
  const event = new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData });
  const target = range.startContainer.parentElement!;
  try {
    await act(async () => target.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    return clipboardData;
  } finally {
    selection.removeAllRanges();
  }
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
}

function setup({ scheduledTasks = [] as ReadonlyArray<{ id: string; title: string }> } = {}) {
  environmentQuery.error = "Pull request not found";
  environmentQuery.data = { tasks: scheduledTasks };
}

const TASK_ID = ScheduledTaskId.make("task-1");
const AUTOMATION_PROMPT = "Triage the inbox\n\nLabel every new issue and close duplicates.";

describe("MessagesTimeline work rows", () => {
  it("keeps a tall HTML preview in place when its last accordion opens at the bottom", async () => {
    const props = baseProps();
    const html = injectHtmlRenderBootstrap(`<div style="height:1400px">Earlier preview content</div>
      <details><summary>More rows</summary><div style="height:900px">More rows</div></details>
      <script>addEventListener('message', e => { if(e.data === 'toggle') document.querySelector('details').open = !document.querySelector('details').open; }); parent.postMessage('listening', '*');</script>`);
    const src = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    using _url = { [Symbol.dispose]: () => URL.revokeObjectURL(src) };
    // The frame loads on its own clock, and a toggle posted before its script runs is lost.
    const listening = new Promise<void>((resolve) => {
      const onMessage = (event: MessageEvent) => {
        if (event.data !== "listening") return;
        window.removeEventListener("message", onMessage);
        resolve();
      };
      window.addEventListener("message", onMessage);
    });
    function Preview() {
      const [height, setHeight] = useState(1437);
      return (
        <div style={{ height }}>
          <HtmlRenderDocument
            src={src}
            title="Tall preview"
            className="size-full"
            onContentHeight={setHeight}
          />
        </div>
      );
    }
    const container = document.createElement("div");
    container.style.cssText = "height:600px;width:900px;display:flex;flex-direction:column";
    await using screen = await render(
      <MessagesTimeline
        {...props}
        renderHtmlRender={() => <Preview />}
        timelineEntries={[
          {
            id: "preview",
            kind: "html-render",
            createdAt: CREATED_AT,
            runId: RunId.make("preview-run"),
            htmlRender: { attachmentId: "preview", title: "Tall preview", height: 1450 },
          },
          message("Done", { role: "assistant" }, "preview-done"),
        ]}
      />,
      { container },
    );
    const viewport = props.listRef.current!.getScrollableNode()!;
    const frame = screen.getByTitle("Tall preview").element() as HTMLIFrameElement;
    await vi.waitFor(() => {
      expect(frame.clientHeight).toBe(1437);
      expect(viewport.scrollTop).toBeGreaterThan(0);
      expect(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop).toBeLessThan(2);
    });
    await listening;
    const top = frame.getBoundingClientRect().top;
    frame.focus();
    frame.contentWindow!.postMessage("toggle", "*");
    await vi.waitFor(() => {
      expect(frame.clientHeight).toBe(2337);
      expect(frame.getBoundingClientRect().top).toBeCloseTo(top, 0);
    });
    frame.contentWindow!.postMessage("toggle", "*");
    await vi.waitFor(() => {
      expect(frame.clientHeight).toBe(1437);
      expect(frame.getBoundingClientRect().top).toBeCloseTo(top, 0);
    });
  });

  it("keeps the worked-for heading in place when expanded at the bottom", async () => {
    // Expansion can overtake the initial scroll before it has relinquished its old row index.
    await commands.setCpuThrottling(6);
    onTestFinished(() => commands.setCpuThrottling(1));
    const props = baseProps();
    const runId = RunId.make("completed-run");
    const container = document.createElement("div");
    // Keep the heading on screen so Playwright does not scroll it before clicking.
    container.style.cssText =
      "height: min(600px, 100vh); width: 900px; display: flex; flex-direction: column;";
    await using screen = await render(
      <MessagesTimeline
        {...props}
        timelineEntries={[
          ...Array.from({ length: 12 }, (_, index) =>
            message(`Earlier context ${index}`, {}, `context-${index}`),
          ),
          message("Progress details\n\n".repeat(50), { role: "assistant", runId }, "progress"),
          message("Done", { role: "assistant", runId }, "final"),
        ]}
      />,
      { container },
    );
    const heading = screen.getByRole("button", { name: /^Worked for/ });
    // LegendList keeps rows click-through until its initial scroll settles on animation
    // frames, which the fake clock below would freeze.
    await expect.element(heading).toHaveStyle({ pointerEvents: "auto" });
    const viewport = props.listRef.current!.getScrollableNode()!;
    // Legend keeps rows transparent and unclickable until its initial scroll settles.
    await vi.waitFor(() => {
      expect(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop).toBeLessThan(2);
      expect(heading.element().checkVisibility({ opacityProperty: true })).toBe(true);
    });
    expect(viewport.scrollTop).toBeGreaterThan(0);
    const top = heading.element().getBoundingClientRect().top;
    const height = viewport.scrollHeight;
    const headingElement = heading.element();
    if (!(headingElement instanceof HTMLElement)) throw new Error("Expected an HTML disclosure");
    await click(headingElement);
    await vi.waitFor(() => {
      expect(viewport.scrollHeight).toBeGreaterThan(height + 500);
      expect(heading.element().getBoundingClientRect().top).toBeCloseTo(top, 0);
      expect(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop).toBeGreaterThan(
        500,
      );
    });
  });

  it("keeps following a streaming turn after a heading is expanded at the bottom", async () => {
    const props = { ...baseProps(), isWorking: true };
    const runId = RunId.make("live-run");
    const container = document.createElement("div");
    container.style.cssText =
      "height: min(600px, 100vh); width: 900px; display: flex; flex-direction: column;";
    const entries = [
      ...Array.from({ length: 12 }, (_, index) =>
        message(`Earlier context ${index}`, {}, `context-${index}`),
      ),
      message("Progress details\n\n".repeat(50), { role: "assistant", runId }, "progress"),
      message("Done", { role: "assistant", runId }, "final"),
    ];
    await using screen = await render(<MessagesTimeline {...props} timelineEntries={entries} />, {
      container,
    });
    const heading = screen.getByRole("button", { name: /^Worked for/ });
    await expect.element(heading).toHaveStyle({ pointerEvents: "auto" });
    const viewport = props.listRef.current!.getScrollableNode()!;
    const distanceFromEnd = () =>
      viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;
    await vi.waitFor(() => expect(distanceFromEnd()).toBeLessThan(2));
    await heading.click();
    await screen.rerender(
      <MessagesTimeline
        {...props}
        timelineEntries={[
          ...entries,
          message("Streamed reply\n\n".repeat(40), { role: "assistant", runId }, "streamed"),
        ]}
      />,
    );
    await vi.waitFor(() => expect(distanceFromEnd()).toBeLessThan(2));
  });

  it.each(["delegated", "legacy", "missing"] as const)(
    "uses the reported task for %s completion notifications",
    async (source) => {
      setup();
      const now = DateTime.makeUnsafe(CREATED_AT);
      const childThreadId = ThreadId.make("shared-child");
      const task = (
        id: string,
        status: OrchestrationV2Subagent["status"],
        result: string,
      ): OrchestrationV2Subagent => ({
        id: NodeId.make(id),
        threadId: ThreadId.make("thread-1"),
        runId: null,
        parentNodeId: NodeId.make("parent-root"),
        origin: "app_owned",
        createdBy: "agent",
        driver: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        providerThreadId: null,
        childThreadId,
        nativeTaskRef: null,
        prompt: "Simplify delivery",
        title: "Simplify delivery",
        model: null,
        status,
        result,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
      });
      const tasks = [
        task("original", "interrupted", "Old interrupted progress"),
        task("continued", "completed", "Final implementation report"),
        task("follow-up", "completed", "Follow-up explanation"),
      ];
      using _threadAtom = vi.spyOn(environmentThreadDetails, "threadAtom").mockReturnValue(
        Atom.make({
          projection: { subagents: tasks, turnItems: [], visibleTurnItems: [] },
        }) as never,
      );
      const onOpenThread = vi.fn();
      await using screen = await renderTimeline(
        (source === "delegated" ? ["continued", "follow-up"] : [source]).map((id) =>
          work(`notification-${id}`, {
            label: "Notification fallback",
            tone: "info",
            itemType: "notification",
            projectedItem: v2Item("notification", {
              id: `notification-${id}`,
              source:
                source === "legacy"
                  ? { kind: "subagent", childThreadId }
                  : { kind: "delegated_task", childThreadId, taskIds: [NodeId.make(id)] },
              outcome: "completed",
              summary: "Notification fallback",
            }),
          }),
        ),
        { onOpenThread },
      );
      if (source === "delegated") {
        expect(screen.text()).toContain("Final implementation report");
        expect(screen.text()).toContain("Follow-up explanation");
        expect(screen.text()).not.toContain("Old interrupted progress");
        await click(screen.buttons("Open Simplify delivery")[0]!);
        expect(onOpenThread).toHaveBeenCalledWith(childThreadId);
      } else if (source === "legacy") {
        expect(screen.text()).toContain("Old interrupted progress");
      } else {
        expect(screen.text()).toContain("Notification fallback");
        expect(screen.text()).not.toContain("Old interrupted progress");
      }
    },
  );
});

describe("MessagesTimeline messages", () => {
  it("exports context records only after selecting the chip, not its link in Mermaid source", async () => {
    const record = {
      version: 1 as const,
      kind: "image" as const,
      contextId: ComposerContextId.make("image-1"),
      label: "shot.png",
      attachmentId: "attachment-1",
      name: "shot.png",
      mimeType: "image/png",
      sizeBytes: 1,
    };
    const link = `[shot.png](t3-context://v1/image/${record.contextId})`;
    const code = `flowchart LR\n    A --> B\n%% ${link}`;
    const source = `\`\`\`mermaid\n${code}\n\`\`\``;
    await using screen = await renderTimeline([
      message(`Before\n\n${source}\n\nAfter\n\n${link}`, {
        context: { version: 1, records: [record] },
        attachments: [
          {
            type: "image",
            id: record.attachmentId,
            name: record.name,
            mimeType: record.mimeType,
            sizeBytes: record.sizeBytes,
          },
        ],
      }),
    ]);
    await vi.waitFor(() =>
      expect(screen.container.querySelector('[aria-label="Expand diagram"] svg')).not.toBeNull(),
    );
    const paragraphs = [...screen.container.querySelectorAll("p")];
    const before = paragraphs.find((p) => p.textContent === "Before")!.firstChild!;
    const after = paragraphs.find((p) => p.textContent === "After")!.firstChild!;
    const chip = screen.button(/^Image attachment, shot\.png,/);
    const range = document.createRange();
    range.setStart(before, 0);
    range.setEnd(after, 5);

    const withoutChip = await copyRange(range);
    expect(withoutChip.getData("text/plain")).toBe(`Before\n\n${source}\n\nAfter`);
    expect(withoutChip.getData(COMPOSER_CONTEXT_CLIPBOARD_MIME)).toBe("");
    expect(decodeComposerContextClipboardHtml(withoutChip.getData("text/html"))).toBeNull();

    range.setEndAfter(chip);
    const withChip = await copyRange(range);
    expect(withChip.getData("text/plain")).toBe(`Before\n\n${source}\n\nAfter\n\n!${link}`);
    expect(
      decodeComposerContextFragment(withChip.getData(COMPOSER_CONTEXT_CLIPBOARD_MIME))?.records,
    ).toEqual([record]);
    expect(decodeComposerContextClipboardHtml(withChip.getData("text/html"))?.records).toEqual([
      record,
    ]);
    const html = new DOMParser().parseFromString(withChip.getData("text/html"), "text/html");
    expect(html.body.textContent).toContain(code);
  });

  it("settles when equally long messages have very different rendered heights", async () => {
    const props = baseProps();
    const tall = message("a\n\n".repeat(6000), { role: "assistant" }, "tall");
    const earlier = Array.from({ length: 80 }, (_, index) =>
      message(
        `<details><summary>Reply ${index}</summary>${"compact ".repeat(2250)}</details>`,
        { role: "assistant" },
        `earlier-${index}`,
      ),
    );
    let nestedCommits = 0;
    let maxNestedCommits = 0;
    const onRender = (_id: string, phase: string) => {
      nestedCommits = phase === "nested-update" ? nestedCommits + 1 : 0;
      maxNestedCommits = Math.max(maxNestedCommits, nestedCommits);
    };
    const timeline = (entries: Entry[]) => (
      <Profiler id="timeline" onRender={onRender}>
        <MessagesTimeline {...props} timelineEntries={entries} />
      </Profiler>
    );
    await using screen = await renderElement(timeline([tall]));
    await vi.waitFor(() =>
      expect(props.listRef.current?.getState().sizeAtIndex(0)).toBeGreaterThan(100_000),
    );
    const viewport = props.listRef.current!.getScrollableNode()!;
    await act(() => {
      viewport.scrollTop = 0;
      viewport.dispatchEvent(new Event("scroll"));
    });
    await screen.rerender(timeline([...earlier, tall]));
    await act(() => {
      void props.listRef.current!.scrollToIndex({ index: 0, animated: false });
    });
    await vi.waitFor(async () => {
      await act(() => {
        viewport.scrollTop = 0;
        viewport.dispatchEvent(new Event("scroll"));
      });
      expect(screen.text().includes("Reply 0")).toBe(true);
      expect(props.listRef.current!.getState().sizeAtIndex(0)).toBeGreaterThan(0);
    });
    expect(maxNestedCommits).toBeLessThan(20);
  });

  it("folds a user message only when the fold hides at least as much as it shows", async () => {
    setup();
    const lines = (count: number) =>
      Array.from({ length: count }, (_, index) => `Line ${index}`).join("\n");
    await using screen = await renderTimeline([
      message(lines(12), {}, "medium"),
      message(lines(60), {}, "long"),
    ]);
    await vi.waitFor(() => expect(screen.buttons("Show full message")).toHaveLength(1));
    const [medium, long] = [
      ...screen.container.querySelectorAll<HTMLElement>("[data-user-message-body]"),
    ];
    expect(medium!.dataset.userMessageCollapsible).toBe("false");
    expect(medium!.textContent).toContain("Line 11");
    const foldedHeight = long!.offsetHeight;
    await click(screen.button("Show full message"));
    expect(long!.offsetHeight).toBeGreaterThanOrEqual(foldedHeight * 2);
  });

  it("keeps the first and last message headings reachable from either end", async () => {
    setup();
    const props = baseProps();
    // Folded messages at both ends: their headings must not live inside the fold.
    const entries = Array.from({ length: 120 }, (_, index) =>
      index === 0
        ? message("First turn", { scheduledTaskId: TASK_ID }, "turn-0")
        : index === 119
          ? message(
              "Last turn",
              { createdBy: "agent", senderThreadId: ThreadId.make("thread-sender") },
              "turn-119",
            )
          : message(
              `Turn ${index}:\n\n${"x ".repeat(200)}`,
              { role: index % 2 === 0 ? "user" : "assistant" },
              `turn-${index}`,
            ),
    );
    await using screen = await renderElement(
      <MessagesTimeline {...props} timelineEntries={entries} />,
    );
    const headings = () => [...screen.container.querySelectorAll("h3")];
    const headingFor = (text: string) =>
      headings().find((heading) => heading.parentElement?.textContent?.includes(text));
    const viewport = props.listRef.current!.getScrollableNode()!;
    // A screen reader scrolls the heading it moves to into view.
    const expectHeadingInView = async (text: string, neighbour: string) => {
      await act(() => headingFor(text)!.scrollIntoView({ block: "start" }));
      await vi.waitFor(() => expect(screen.text()).toContain(neighbour));
      const row = headingFor(text)!.parentElement!.getBoundingClientRect();
      const view = viewport.getBoundingClientRect();
      expect(row.top).toBeLessThan(view.bottom);
      expect(row.bottom).toBeGreaterThan(view.top);
    };

    await vi.waitFor(() => {
      expect(screen.text()).toContain("Turn 118:");
      // LegendList can retain an unused offscreen container until it needs recycling.
      const middle = screen.container.querySelector('[data-message-id="turn-60"]');
      if (middle) {
        const row = middle.getBoundingClientRect();
        const view = viewport.getBoundingClientRect();
        expect(row.bottom <= view.top || row.top >= view.bottom).toBe(true);
      }
    });
    // Wrapping follows DOM order, so the ends must also sit first and last.
    await vi.waitFor(() => {
      expect(headings()[0]).toBe(headingFor("First turn"));
      expect(headings().at(-1)).toBe(headingFor("Last turn"));
    });

    await expectHeadingInView("First turn", "Turn 1:");
    expect(headingFor("Last turn")).toBeDefined();
    await expectHeadingInView("Last turn", "Turn 118:");
  });

  it("scrolls from the keyboard once F6 moves into the conversation", async () => {
    setup();
    const props = baseProps();
    const entries = Array.from({ length: 40 }, (_, index) =>
      message(`Turn ${index}:\n\n${"x ".repeat(200)}`, {}, `turn-${index}`),
    );
    await using _screen = await renderElement(
      <>
        <div
          {...workspaceAreaProps("conversation", 1, "Conversation")}
          className="relative flex min-h-0 flex-1 flex-col"
        >
          <MessagesTimeline {...props} timelineEntries={entries} />
        </div>
        <div {...workspaceAreaProps("composer", 2, "Message input")}>
          <button type="button">Send</button>
        </div>
      </>,
    );
    const focus = createWorkspaceFocusController(document);
    using _focus = { [Symbol.dispose]: focus.dispose };
    const viewport = props.listRef.current!.getScrollableNode()!;
    await vi.waitFor(() => expect(viewport.scrollTop).toBeGreaterThan(0));
    const atEnd = viewport.scrollTop;
    page.getByRole("button", { name: "Send" }).element().focus();
    await userEvent.keyboard("{F6}");
    focus.move(-1);
    expect(viewport).toHaveAttribute("data-workspace-keyboard-focus");
    await userEvent.keyboard("{PageUp}");
    await vi.waitFor(() => expect(viewport.scrollTop).toBeLessThan(atEnd));
  });

  it("disables the minimap's next turn button at the bottom of the thread", async () => {
    setup();
    const props = baseProps();
    const entries = Array.from({ length: 16 }, (_, index) => [
      message(`Question ${index}`, {}, `user-${index}`),
      message(`Answer ${index}`, { role: "assistant" }, `assistant-${index}`),
    ]).flat();
    await using screen = await renderTimeline(entries, props);
    const viewport = props.listRef.current!.getScrollableNode()!;
    const strips = () => [
      ...screen.container.querySelectorAll<HTMLElement>("[data-minimap-strip]"),
    ];
    // Several final turns share the last screen, so the current turn is not the last one.
    await vi.waitFor(() => {
      expect(viewport.scrollTop).toBeGreaterThan(0);
      expect(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop).toBeLessThan(2);
      expect(strips()[0]?.dataset.inView).toBe("false");
      expect(
        strips()
          .slice(-2)
          .map((strip) => strip.dataset.inView),
      ).toEqual(["true", "true"]);
      expect(screen.button("Previous turn")).not.toBeDisabled();
    });

    expect(screen.button("Next turn")).toBeDisabled();

    viewport.scrollTop -= 30;
    await vi.waitFor(() => expect(screen.button("Next turn")).not.toBeDisabled());
    // Legend keeps its initial end anchor until a scroll leaves the end, and re-pins on resize.
    viewport.scrollTop = 0;
    await vi.waitFor(() => expect(strips()[0]?.dataset.inView).toBe("true"));

    // Shrinking a detached viewport moves the bottom away without a scroll event.
    await screen.rerender(
      <MessagesTimeline {...props} timelineEntries={entries} liveFollowEnabled={false} />,
    );
    viewport.scrollTop = viewport.scrollHeight;
    await vi.waitFor(() => expect(screen.button("Next turn")).toBeDisabled());
    screen.container.style.height = "600px";
    await vi.waitFor(() => {
      expect(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop).toBeGreaterThan(
        500,
      );
      expect(screen.button("Next turn")).not.toBeDisabled();
    });

    // So does a footer that grows below a detached bottom.
    viewport.scrollTop = viewport.scrollHeight;
    await vi.waitFor(() => expect(screen.button("Next turn")).toBeDisabled());
    await screen.rerender(
      <MessagesTimeline
        {...props}
        timelineEntries={entries}
        liveFollowEnabled={false}
        footer={<div style={{ height: 400 }} />}
      />,
    );
    await vi.waitFor(() => {
      expect(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop).toBeGreaterThan(
        300,
      );
      expect(screen.button("Next turn")).not.toBeDisabled();
    });
  });

  it("enables the minimap's next turn button on a thread restored above its bottom", async () => {
    setup();
    const base = baseProps();
    const turns = (prefix: string) =>
      Array.from({ length: 16 }, (_, index) => [
        message(`${prefix} question ${index}`, {}, `${prefix}-user-${index}`),
        message(`${prefix} answer ${index}`, { role: "assistant" }, `${prefix}-assistant-${index}`),
      ]).flat();
    const other = "environment-local:thread-minimap-restored";
    rememberTimelinePosition(
      other,
      { rowId: "entry-b-user-4", offsetWithinRow: 0, scrollOffset: 0, atEnd: false },
      false,
    );
    await using screen = await renderElement(
      <MessagesTimeline {...base} timelineEntries={turns("a")} />,
    );
    const viewport = base.listRef.current!.getScrollableNode()!;
    await vi.waitFor(() => {
      expect(viewport.scrollTop).toBeGreaterThan(0);
      expect(screen.button("Next turn")).toBeDisabled();
    });

    await screen.rerender(
      <MessagesTimeline
        {...base}
        routeThreadKey={other}
        timelineEntries={turns("b")}
        liveFollowEnabled={false}
      />,
    );
    await vi.waitFor(() => {
      const row = screen.container.querySelector('[data-timeline-row-id="entry-b-user-4"]');
      expect(row).not.toBeNull();
      expect(
        Math.abs(row!.getBoundingClientRect().top - viewport.getBoundingClientRect().top),
      ).toBeLessThanOrEqual(2);
      expect(screen.button("Next turn")).not.toBeDisabled();
    });
  });

  it("keeps rows in item order after a reload or thread switch, before any timer runs", async () => {
    setup();
    // NVDA's browse mode keeps the first DOM order it reads, so a timer that sorts rows later is too late.
    using _timers = fakeTimers();
    const thread = (name: string) =>
      Array.from({ length: 120 }, (_, index) =>
        message(
          `${name} turn ${index}:\n\n${"x ".repeat(200)}`,
          { role: index % 2 === 0 ? "user" : "assistant" },
          `${name}-${index}`,
        ),
      );
    const props = baseProps();
    await using screen = await renderElement(
      <MessagesTimeline {...props} timelineEntries={thread("A")} />,
    );
    const turnsInDomOrder = () =>
      [...screen.container.querySelectorAll("h3")].map((heading) =>
        Number(/turn (\d+):/.exec(heading.parentElement?.textContent ?? "")?.[1]),
      );
    const expectItemOrder = () => {
      const turns = turnsInDomOrder();
      expect(turns).toEqual(turns.toSorted((a, b) => a - b));
    };

    expect(screen.text()).toContain("A turn 118:");
    expect(turnsInDomOrder()).toContain(0);
    expectItemOrder();

    await screen.rerender(
      <MessagesTimeline
        {...props}
        routeThreadKey={`${props.routeThreadKey}-other`}
        timelineEntries={thread("B")}
      />,
    );
    expect(screen.text()).toContain("B turn 118:");
    expect(screen.text()).not.toContain("A turn");
    expectItemOrder();
  });

  it("puts rows back in item order soon after a continuous scroll stops", async () => {
    setup();
    const props = baseProps();
    await using screen = await renderElement(
      <MessagesTimeline
        {...props}
        timelineEntries={Array.from({ length: 120 }, (_, index) =>
          message(
            `Turn ${index}:\n\n${"x ".repeat(200)}`,
            { role: index % 2 === 0 ? "user" : "assistant" },
            `turn-${index}`,
          ),
        )}
      />,
    );
    await vi.waitFor(() => expect(screen.text()).toContain("Turn 118:"));
    using _timers = fakeTimers();
    const turnsInDomOrder = () =>
      [...screen.container.querySelectorAll("h3")].map((heading) =>
        Number(/Turn (\d+):/.exec(heading.parentElement?.textContent ?? "")?.[1]),
      );
    const viewport = props.listRef.current!.getScrollableNode()!;

    const scroll = async (by: number) => {
      for (let step = 0; step < 40; step++) {
        await act(() => {
          viewport.scrollTop += by;
          viewport.dispatchEvent(new Event("scroll"));
          vi.advanceTimersByTime(16);
        });
      }
      // Wrapping right after a scroll must still reach the first and last message.
      expect(turnsInDomOrder()[0]).toBe(0);
      expect(turnsInDomOrder().at(-1)).toBe(119);
    };

    await act(() => {
      viewport.scrollTop = 0;
      viewport.dispatchEvent(new Event("scroll"));
      vi.advanceTimersByTime(300);
    });
    await scroll(300);
    expect(turnsInDomOrder().filter((turn) => turn > 0 && turn < 100).length).toBeGreaterThan(0);
    await scroll(-300);

    await act(() => vi.advanceTimersByTime(300));
    const turns = turnsInDomOrder();
    expect(turns).toEqual(turns.toSorted((a, b) => a - b));
  });

  it("steps the minimap's next turn past two adjacent user messages", async () => {
    const props = baseProps();
    const reply = (id: string) => message("Reply.\n\n".repeat(120), { role: "assistant" }, id);
    const userIds = ["turn-0", "turn-1", "turn-2", "pair-a", "pair-b", "turn-3", "turn-4"];
    const entries = [
      ...["turn-0", "turn-1", "turn-2"].flatMap((id) => [message(id, {}, id), reply(`${id}-r`)]),
      message("pair-a", {}, "pair-a"),
      message("pair-b", {}, "pair-b"),
      reply("pair-b-r"),
      ...["turn-3", "turn-4"].flatMap((id) => [message(id, {}, id), reply(`${id}-r`)]),
    ];
    const session = cdp();
    await session.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    try {
      await using screen = await renderTimeline(entries, props);
      const viewport = props.listRef.current!.getScrollableNode()!;
      const strips = () => [...screen.container.querySelectorAll("[data-minimap-strip]")];
      const turnAtTop = () =>
        userIds.find((id) => {
          const row = screen.container.querySelector(`[data-message-id="${id}"]`);
          if (!row) return false;
          const offset = row.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
          return offset >= 0 && offset < 100;
        });
      await act(() => {
        void props.listRef.current!.scrollToIndex({ index: 0, animated: false });
      });
      await vi.waitFor(() => expect(strips()[0]?.getAttribute("data-in-view")).toBe("true"));

      // Clicks again while the view has not moved, as a user would.
      for (const id of userIds.slice(1)) {
        const from = turnAtTop();
        await vi.waitFor(async () => {
          if (turnAtTop() === from) await click(screen.button("Next turn"));
          expect(turnAtTop(), "turn at the top after Next turn").toBe(id);
        });
      }
    } finally {
      await session.send("Emulation.setEmulatedMedia", { features: [] });
    }
  });

  it("preserves XML-like tags and comparisons in user messages as text", async () => {
    const source = [
      'Without reading a file, do you have <global-agent-instructions scope="workspace">',
      'Before <nested data-value="a&b">inside</nested> after',
      "</global-agent-instructions> in your context?",
      "Comparison: 2 < 3 and 5 > 4.",
    ];
    await using screen = await renderTimeline([message(source.join("\n"))]);
    for (const line of source) expect(screen.text()).toContain(line);
    expect(screen.container.querySelector("global-agent-instructions, nested")).toBeNull();
  });

  it("renders unsafe user HTML as inert source text", async () => {
    const source =
      '<script>globalThis.__t3Xss = 1</script><img src="x" onerror="globalThis.__t3Xss = 2">';
    await using screen = await renderTimeline([message(source)]);
    expect(screen.text()).toContain(source);
    expect(screen.container.querySelector("script, img")).toBeNull();
    expect((globalThis as { __t3Xss?: number }).__t3Xss).toBeUndefined();
  });

  it("keeps single tildes in user paths literal without changing double tildes or assistant text", async () => {
    const source =
      "Install the skill as ~/folder-a/skills/x, then follow the guide (~/folder-a/guide.md).";
    await using screen = await renderTimeline([
      message(source),
      message("Drop ~~the old plan~~", {}, "message-2"),
      message(source, { role: "assistant" }, "assistant-1"),
    ]);
    const [user, doubleTilde, assistant] = screen.container.querySelectorAll<HTMLElement>(
      "[data-timeline-row-kind=message]",
    );
    expect(user?.textContent).toContain(source);
    expect(user?.querySelector("del")).toBeNull();
    expect(doubleTilde?.querySelector("del")?.textContent).toBe("the old plan");
    expect(assistant?.querySelector("del")?.textContent).toBe(
      "/folder-a/skills/x, then follow the guide (",
    );
  });

  it("renders sanitized raw HTML in assistant messages", async () => {
    await using screen = await renderTimeline([
      message(
        [
          '<details onclick="globalThis.__t3Xss = 1">',
          "<summary>Safe details</summary>",
          "<script>globalThis.__t3Xss = 2</script>",
          '<img src="x" onerror="globalThis.__t3Xss = 3">',
          '<a href="javascript:globalThis.__t3Xss = 4">Unsafe link</a>',
          "</details>",
        ].join(""),
        { role: "assistant" },
      ),
    ]);
    expect(screen.container.querySelector("[data-markdown-details]")?.textContent).toContain(
      "Safe details",
    );
    expect(screen.text()).not.toContain("<details");
    expect(screen.container.querySelector("script, [onclick], [onerror]")).toBeNull();
    expect(screen.container.innerHTML).not.toContain("javascript:");
    await click(screen.button("Safe details"));
    expect((globalThis as { __t3Xss?: number }).__t3Xss).toBeUndefined();
  });

  it("collapses long user messages behind a toggle and keeps their copy button", async () => {
    await using screen = await renderTimeline([message(longText())]);
    const toggle = screen.button("Show full message");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.buttons("Copy message")).toHaveLength(1);
    await click(toggle);
    expect(screen.button("Show less").getAttribute("aria-expanded")).toBe("true");
  });

  it("does not offer a collapse toggle for short user messages", async () => {
    await using screen = await renderTimeline([message("Short prompt.")]);
    expect(screen.buttons(/Show full message|Show less/)).toHaveLength(0);
  });

  it("attributes user messages that this client did not send", async () => {
    const messageViewer = {
      personId: "patroza",
      username: "patroza",
      channel: "desktop",
      identityReady: true,
    };
    await using screen = await renderTimeline(
      [message("Review this area", { createdBy: "agent", creationSource: "provider" })],
      { messageViewer },
    );
    expect(screen.text()).toContain("Sent by another agent");
    expect(
      screen.container.querySelector('[data-user-message-attribution="sender"]'),
    ).not.toBeNull();

    await screen.rerenderTimeline([message("Review this area")], { messageViewer });
    expect(screen.text()).not.toContain("Sent by another agent");
    expect(screen.container.querySelector("[data-user-message-attribution]")).toBeNull();

    await screen.rerenderTimeline(
      [
        message("Review this area", {
          createdBy: "user",
          source: {
            channel: "bot",
            personId: PersonId.make("andreasimonecosta"),
            username: IdentityUsername.make("andreasimonecosta"),
          },
        }),
      ],
      { messageViewer },
    );
    expect(screen.text()).toContain("andreasimonecosta@bot");

    await screen.rerenderTimeline(
      [
        message("Review this area", {
          createdBy: "user",
          source: {
            channel: "discord",
            personId: PersonId.make("patroza"),
            username: IdentityUsername.make("patroza"),
          },
        }),
      ],
      { messageViewer },
    );
    expect(screen.text()).toContain("discord");
    expect(screen.text()).not.toContain("patroza@discord");

    await screen.rerenderTimeline(
      [
        message("Review this area", {
          createdBy: "user",
          source: {
            channel: "desktop",
            personId: PersonId.make("patroza"),
            username: IdentityUsername.make("patroza"),
          },
        }),
      ],
      { messageViewer },
    );
    expect(screen.container.querySelector("[data-user-message-attribution]")).toBeNull();
  });

  it("keeps each sender caption on adjacent grouped user messages", async () => {
    await using screen = await renderTimeline(
      [
        message(
          "From another person",
          {
            source: {
              channel: "bot",
              personId: PersonId.make("andrea"),
              username: IdentityUsername.make("andrea"),
            },
          },
          "other-person",
        ),
        message(
          "From my other channel",
          {
            source: {
              channel: "discord",
              personId: PersonId.make("patroza"),
              username: IdentityUsername.make("patroza"),
            },
          },
          "other-channel",
        ),
        message(
          "From this client",
          {
            source: {
              channel: "desktop",
              personId: PersonId.make("patroza"),
              username: IdentityUsername.make("patroza"),
            },
          },
          "this-client",
        ),
      ],
      {
        messageViewer: {
          personId: "patroza",
          username: "patroza",
          channel: "desktop",
          identityReady: true,
        },
      },
    );
    expect(
      [...screen.container.querySelectorAll('[data-user-message-attribution="sender"]')].map(
        (element) => element.textContent,
      ),
    ).toEqual(["andrea@bot", "discord"]);
    expect(screen.text()).toContain("From this client");
  });

  it("shows steer intent ahead of committed user messages", async () => {
    await using screen = await renderTimeline([
      message("Adjust the current turn", { inputIntent: "steer" }),
    ]);
    expect(screen.text().indexOf("Steer")).toBeGreaterThanOrEqual(0);
    expect(screen.text().indexOf("Steer")).toBeLessThan(
      screen.text().indexOf("Adjust the current turn"),
    );
  });

  it("renders inline terminal labels as chips", async () => {
    await using screen = await renderTimeline([
      message(
        [
          longText("yoo what's @terminal-1:1-5 mean"),
          "",
          "<terminal_context>",
          "- Terminal 1 lines 1-5:",
          "  1 | julius@mac effect-http-ws-cli % bun i",
          "  2 | bun install v1.3.9 (cf6cdbbb)",
          "</terminal_context>",
        ].join("\n"),
      ),
    ]);
    expect(screen.text()).toContain("Terminal 1 lines 1-5");
    expect(screen.text()).toContain("yoo what's");
    expect(screen.text()).not.toContain("terminal_context");
    expect(screen.buttons("Show full message")).toHaveLength(1);
  });

  it("renders chips for standalone element-pick context messages", async () => {
    await using screen = await renderTimeline([
      message(
        [
          "<element_context>",
          "- <SubmitButton> (Button.tsx:12):",
          "  url: https://example.com/dashboard",
          "  selector: button.submit",
          "  source: /repo/src/Button.tsx:12:5",
          "  html:",
          '  <button class="submit">Save</button>',
          "</element_context>",
        ].join("\n"),
      ),
    ]);
    expect(screen.text()).toContain("SubmitButton");
    expect(screen.text()).not.toContain("element_context");
  });

  it("renders review comment contexts as structured cards instead of raw tags", async () => {
    await using screen = await renderTimeline([
      message(
        [
          '<review_comment sectionId="turn:2" sectionTitle="Turn 2" filePath="apps/web/src/lib/contextWindow.test.ts" startIndex="3" endIndex="14" rangeLabel="+47 to +58">',
          "Wadduo",
          "```diff",
          "@@ -0,0 +47,2 @@",
          '+  it("keeps valid zero-usage snapshots", () => {',
          "+    expect(snapshot).not.toBeNull();",
          "```",
          "</review_comment>",
        ].join("\n"),
      ),
    ]);
    expect(screen.text()).toContain("contextWindow.test.ts L47 to L58");
    expect(screen.text()).not.toContain("review_comment");
  });

  it("renders file review comments as source code", async () => {
    await using screen = await renderTimeline([
      message(
        [
          '<review_comment sectionId="file:docs/plan.md" sectionTitle="File comment" filePath="docs/plan.md" startIndex="0" endIndex="1" rangeLabel="L1 to L2">',
          "Clarify this.",
          "```md",
          "# Plan",
          "- Step one",
          "```",
          "</review_comment>",
        ].join("\n"),
      ),
    ]);
    expect(screen.text()).toContain("plan.md L1 to L2");
    expect(screen.text()).not.toContain("review_comment");
  });

  it("collapses superseded attempt output behind a disclosure", async () => {
    const runId = RunId.make("run-steered");
    const attempt = (id: string, ordinal: number, status: string) =>
      ({
        id,
        runId,
        attemptOrdinal: ordinal,
        rootNodeId: `node-${id}`,
        status,
        completedAt: null,
      }) as never;
    await using screen = await renderTimeline(
      [
        {
          ...message(
            "Partial response from the old attempt",
            { role: "assistant", runId },
            "superseded-response",
          ),
          attempt: attempt("attempt-1", 1, "superseded"),
        } as Entry,
        {
          ...message(
            "Current response remains visible",
            { role: "assistant", runId, streaming: true },
            "active-response",
          ),
          attempt: attempt("attempt-2", 2, "running"),
        } as Entry,
      ],
      {
        latestRun: { runId, status: "running", startedAt: CREATED_AT, completedAt: null },
      },
    );
    expect(screen.text()).toContain("Current response remains visible");
    expect(screen.text()).not.toContain("Partial response from the old attempt");
    const disclosure = screen.button(/Superseded attempt/);
    expect(disclosure.textContent).toContain("Cut off by a steer");
    await click(disclosure);
    expect(screen.text()).toContain("Partial response from the old attempt");
  });

  it("forks from a completed assistant response", async () => {
    const onForkFromRun = vi.fn(async () => {});
    await using screen = await renderTimeline(
      [
        {
          ...message("Done", { role: "assistant", runId: RunId.make("run-1") }, "assistant-1"),
          projectedItem: v2Item("assistant_message", {
            id: "assistant-item-1",
            messageId: "assistant-1",
            text: "Done",
            streaming: false,
          }),
        } as Entry,
      ],
      { onForkFromRun },
    );
    await click(screen.button("Fork from this response"));
    expect(onForkFromRun).toHaveBeenCalledWith({ sourceThreadId: "thread-1", runId: "run-1" });
  });

  it("opens the changed files of an assistant response", async () => {
    const assistantMessageId = MessageId.make("assistant-with-files");
    const runId = RunId.make("run-with-files");
    const onOpenTurnDiff = vi.fn();
    await using screen = await renderTimeline(
      [message("Updated the fixture.", { role: "assistant", runId }, assistantMessageId)],
      {
        onOpenTurnDiff,
        latestRun: { runId, status: "completed", startedAt: CREATED_AT, completedAt: CREATED_AT },
        turnDiffSummaries: [
          {
            runId,
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.make("checkpoint-with-files"),
            status: "ready",
            files: [{ path: "README.md", kind: "modified", additions: 2, deletions: 1 }],
            assistantMessageId,
            completedAt: CREATED_AT,
          },
        ],
      },
    );
    expect(screen.text()).toContain("1 changed file");
    await click(screen.button("Open diff"));
    expect(onOpenTurnDiff).toHaveBeenCalledWith(runId, "README.md");
  });

  const revealModes = ["inline", "at-end", "delayed", "grouped-delayed", "grouped-end"];
  it.each(revealModes)("reveals %s output", async (mode) => {
    const inline = mode === "inline" || mode === "at-end";
    setup();
    environmentQuery.data =
      mode === "grouped-end"
        ? {
            output: { text: `${"output line\n".repeat(10)}TOOL_INPUT_END`, truncated: false },
            running: false,
          }
        : null;
    environmentQuery.error = null;
    const props = baseProps();
    const composerOverlayHeight = mode === "grouped-end" ? 140 : 200;
    const tallEntries = Array.from({ length: 12 }, (_, index) =>
      message(
        `Message ${index}\n\n${"Long paragraph. ".repeat(80)}`,
        { role: "assistant" },
        `tall-${index}`,
      ),
    );
    const projectedItem = makeStreamingTimelineFixture().visibleTurnItems[1]!;
    const source = {
      detail: () => Atom.make(AsyncResult.initial()),
      commandOutput: () => Atom.make(AsyncResult.initial()),
    };
    let outerGrowth = false;
    let routeThreadKey = props.routeThreadKey;
    const timeline = () => (
      <MessagesTimeline
        {...props}
        routeThreadKey={routeThreadKey}
        liveFollowEnabled={false}
        {...(inline
          ? {}
          : {
              turnItemSource: {
                detail: () => source.detail(),
                commandOutput: () => source.commandOutput(),
              },
            })}
        contentInsetEndAdjustment={composerOverlayHeight}
        timelineEntries={[
          ...tallEntries.slice(0, 6),
          {
            id: "tool-near-composer",
            kind: "work",
            createdAt: CREATED_AT,
            entry: {
              id: "tool-near-composer",
              createdAt: CREATED_AT,
              label: "Example tool",
              toolTitle: "Example tool",
              tone: "tool",
              itemType: "dynamic_tool",
              toolLifecycleStatus: "completed",
              toolData: { input: { query: `${"x".repeat(1200)} TOOL_INPUT_END` } },
              ...(inline
                ? {}
                : {
                    itemType: "command_execution",
                    projectedItem,
                    structuredPayload: projectedItem.item,
                  }),
            },
          },
          ...(mode.startsWith("grouped-")
            ? [
                {
                  id: "another-tool",
                  kind: "work" as const,
                  createdAt: CREATED_AT,
                  entry: {
                    id: "another-tool",
                    createdAt: CREATED_AT,
                    label: "Other tool",
                    tone: "tool" as const,
                    itemType: "dynamic_tool" as const,
                    toolLifecycleStatus: "completed" as const,
                    toolData: { input: { query: "other" } },
                  },
                },
              ]
            : []),
          ...(mode === "grouped-end"
            ? [message("Completed.", { role: "assistant" }, "final-message")]
            : mode === "at-end"
              ? [message("Done.", { role: "assistant" }, "final-message")]
              : tallEntries.slice(6)),
          ...(outerGrowth
            ? [message("Later output\n\n".repeat(20), { role: "assistant" }, "outer-growth")]
            : []),
        ]}
      />
    );
    await using screen = await renderElement(
      mode === "grouped-delayed" ? (
        <MessagesTimeline {...props} timelineEntries={[message("Previous thread")]} />
      ) : (
        timeline()
      ),
    );
    if (mode === "grouped-end") screen.container.style.height = "648px";
    await vi.waitFor(() => expect(props.listRef.current?.getScrollableNode()).toBeTruthy());
    const viewport = props.listRef.current!.getScrollableNode()!;
    if (mode === "grouped-delayed") {
      routeThreadKey = `${routeThreadKey}-switched`;
      await screen.rerender(timeline());
      await vi.waitFor(() => expect(viewport.scrollHeight).toBeGreaterThan(3000));
      await act(() => viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -1 })));
    }
    if (mode.startsWith("grouped-")) {
      await act(() => {
        void props.listRef.current!.scrollToIndex({ index: 6, animated: false });
      });
      await vi.waitFor(() =>
        expect(
          screen.container.querySelector('[data-timeline-row-kind="work-toggle"] button'),
        ).not.toBeNull(),
      );
      const group = () =>
        screen.container.querySelector<HTMLElement>(
          '[data-timeline-row-kind="work-toggle"] button',
        )!;
      await click(group());
      await vi.waitFor(() =>
        expect(
          screen.container.querySelector('[data-work-entry-id="tool-near-composer"]'),
        ).not.toBeNull(),
      );
      if (mode === "grouped-delayed") {
        await click(
          screen.container.querySelector<HTMLElement>('[data-work-entry-id="tool-near-composer"]')!,
        );
        await vi.waitFor(() => expect(screen.text()).toContain("Loading output"));
        await click(group());
      }
    }
    const header = () => {
      if (mode === "grouped-end")
        return screen.container.querySelector<HTMLElement>(
          '[data-work-entry-id="tool-near-composer"]',
        )!;
      if (mode === "grouped-delayed")
        return screen.container.querySelector<HTMLElement>(
          '[data-timeline-row-kind="work-toggle"] button',
        )!;
      const rows = screen.container.querySelectorAll<HTMLElement>(
        '[data-timeline-row-kind="work"] [role="button"]',
      );
      if (!rows[0]) throw new Error(screen.text());
      return rows[0];
    };
    const visibleBottom = () => viewport.getBoundingClientRect().bottom - composerOverlayHeight;
    await act(() => {
      void props.listRef.current!.scrollToIndex({ index: 6, animated: false });
    });
    if (mode === "at-end") {
      await act(() => {
        void props.listRef.current!.scrollToEnd({ animated: false });
      });
      await vi.waitFor(() =>
        expect(resolveTimelineIsAtEnd(props.listRef.current!.getState())).toBe(true),
      );
    } else {
      await vi.waitFor(async () => {
        await act(() => {
          viewport.scrollTop += header().getBoundingClientRect().bottom - (visibleBottom() - 8);
          viewport.dispatchEvent(new Event("scroll"));
        });
        expect(resolveTimelineIsAtEnd(props.listRef.current!.getState())).toBe(false);
        expect(header().getBoundingClientRect().bottom).toBeLessThanOrEqual(visibleBottom());
        expect(header().getBoundingClientRect().top).toBeGreaterThan(
          viewport.getBoundingClientRect().top,
        );
      });
    }

    const collapsedScrollTop = viewport.scrollTop;
    using scrollBy = vi.spyOn(viewport, "scrollBy");
    // The nested row can measure before the outer scroller gains its new range.
    if (mode === "grouped-delayed") scrollBy.mockImplementationOnce(() => {});
    await click(header());
    if (mode === "grouped-delayed") {
      await vi.waitFor(() => expect(scrollBy).toHaveBeenCalled());
      outerGrowth = true;
      await screen.rerender(timeline());
      await vi.waitFor(() => expect(viewport.scrollTop).toBeGreaterThan(collapsedScrollTop));
    }
    if (!inline && mode !== "grouped-end") {
      await vi.waitFor(() =>
        expect(header().getBoundingClientRect().bottom).toBeLessThanOrEqual(visibleBottom() + 1),
      );
      await vi.waitFor(() => expect(screen.text()).toContain("Loading output"));
      environmentQuery.data = {
        output: { text: `${"output line\n".repeat(20)}TOOL_INPUT_END`, truncated: false },
        running: false,
      };
      await screen.rerender(timeline());
    }
    const inputEnd = () =>
      Array.from(screen.container.querySelectorAll<HTMLElement>("*")).findLast((element) =>
        element.textContent?.includes("TOOL_INPUT_END"),
      )!;
    await vi.waitFor(() =>
      expect(inputEnd().getBoundingClientRect().bottom).toBeLessThanOrEqual(visibleBottom() + 1),
    );
    await vi.waitFor(() =>
      expect(header().getBoundingClientRect().top).toBeGreaterThanOrEqual(
        viewport.getBoundingClientRect().top,
      ),
    );
  });
});

describe("MessagesTimeline attachments", () => {
  const withAttachment = (attachment: Record<string, unknown>) =>
    message("Read the report.", {
      attachments: [
        {
          type: "file",
          name: "report.pdf",
          mimeType: "application/pdf",
          sizeBytes: 42,
          ...attachment,
        },
      ] as never,
    });

  it("offers preview and download actions for PDF attachments", async () => {
    await using screen = await renderTimeline([
      withAttachment({
        id: "attachment-report-pdf",
        previewUrl: "https://environment.test/api/assets/report.pdf",
      }),
    ]);
    expect(screen.buttons("Preview report.pdf")).toHaveLength(1);
    expect(screen.buttons("Download report.pdf")).toHaveLength(1);
    expect(screen.container.querySelector('img[alt="report.pdf"]')).toBeNull();
  });

  it("does not create a download URL before the download is requested", async () => {
    await using screen = await renderTimeline([withAttachment({ id: "attachment-report-pdf" })]);
    expect(screen.buttons("Download report.pdf")).toHaveLength(1);
    expect(screen.container.querySelector("a[href]")).toBeNull();
  });

  it("does not download an optimistic file before the server supplies its attachment ID", async () => {
    await using screen = await renderTimeline([
      withAttachment({ id: "composer-local-report", downloadable: false }),
    ]);
    expect(screen.text()).toContain("report.pdf");
    expect(screen.buttons("Download report.pdf")).toHaveLength(0);
  });

  it("renders unknown attachment types as inert rows instead of crashing", async () => {
    await using screen = await renderTimeline([
      withAttachment({
        type: "recording",
        id: "attachment-voice-memo",
        name: "voice-memo.ogg",
        mimeType: "audio/ogg",
      }),
    ]);
    expect(screen.text()).toContain("voice-memo.ogg");
    expect(screen.buttons("Download voice-memo.ogg")).toHaveLength(0);
    expect(screen.container.querySelector("a[href], img")).toBeNull();
  });

  it("shows SnapShot window details only after the preview resolves", async () => {
    const snapShot = (previewUrl?: string) =>
      message("First prompt.", {
        attachments: [
          {
            type: "image",
            id: "attachment-1",
            name: "screenshot.png",
            mimeType: "image/png",
            sizeBytes: 1,
            ...(previewUrl ? { previewUrl } : {}),
            source: {
              kind: "snap-shot",
              capturedAt: CREATED_AT,
              appName: "Terminal",
              windowTitle: "t3code — Tests",
              appIconDataUrl: "data:image/png;base64,aWNvbg==",
            },
          },
        ] as never,
      });
    await using screen = await renderTimeline([snapShot()]);
    expect(screen.text()).toContain("screenshot.png");
    expect(screen.text()).not.toContain("t3code — Tests");
    await screen.rerenderTimeline([snapShot("data:image/png;base64,iVBORw0KGgo=")]);
    expect(screen.text()).toContain("Terminal");
    expect(screen.text()).toContain("t3code — Tests");
  });
});

describe("MessagesTimeline history and thread links", () => {
  it.each([
    ["imported runless", null],
    ["standard", RunId.make("citation-run")],
  ] as const)("reveals a cited response inside a folded %s turn", async (_label, runId) => {
    const quote = "The imported response contains this cited detail.";
    const props = {
      ...baseProps(),
      timelineEntries: [
        message("Investigate the issue.", { runId }, "citation-prompt"),
        message(quote, { role: "assistant", runId }, "citation-source"),
        message("Investigation complete.", { role: "assistant", runId }, "citation-answer"),
      ],
    };
    await using screen = await renderElement(<MessagesTimeline {...props} />);
    const source = () =>
      screen.container.querySelector<HTMLElement>(
        '[data-assistant-citation-source="citation-source"]',
      );
    await vi.waitFor(() => expect(screen.text()).toContain("Investigation complete."));
    expect(screen.buttons(/^Worked/)).toHaveLength(1);
    expect(source()).toBeNull();

    await act(async () =>
      screen.rerender(
        <MessagesTimeline
          {...props}
          citationRequest={{
            key: "open-citation",
            citation: {
              version: 1,
              environmentId: ENVIRONMENT_ID,
              threadId: ThreadId.make(props.routeThreadKey.split(":").slice(1).join(":")),
              messageId: MessageId.make("citation-source"),
              text: quote,
              start: 0,
              end: quote.length,
              prefix: "",
              suffix: "",
            },
          }}
        />,
      ),
    );

    await vi.waitFor(() => {
      expect(source()?.textContent ?? "").toContain(quote);
      const highlight = CSS.highlights.get("t3-assistant-citation");
      expect(highlight).toBeDefined();
      const range = [...highlight!][0] as Range;
      expect(range.toString()).toBe(quote);
      const viewport = screen.container.querySelector<HTMLElement>(
        "[data-assistant-citation-viewport]",
      )!;
      const bounds = range.getBoundingClientRect();
      expect(bounds.height).toBeGreaterThan(0);
      expect(bounds.top).toBeGreaterThanOrEqual(viewport.getBoundingClientRect().top);
      expect(bounds.bottom).toBeLessThanOrEqual(viewport.getBoundingClientRect().bottom);
    });
  });

  it("loads earlier turns from a control ahead of the bounded timeline", async () => {
    const onLoadEarlier = vi.fn();
    await using screen = await renderTimeline([message("Recent activity")], {
      historyControls: {
        hasMoreHistory: true,
        loading: false,
        error: "Earlier activity could not be loaded.",
        onLoadEarlier,
      },
    });
    expect(screen.text()).toContain("Earlier activity could not be loaded.");
    expect(screen.text().indexOf("Load earlier turns")).toBeLessThan(
      screen.text().indexOf("Recent activity"),
    );
    await click(screen.button("Load earlier turns"));
    expect(onLoadEarlier).toHaveBeenCalledOnce();
  });

  it("keeps an empty bounded timeline busy while earlier history loads", async () => {
    await using screen = await renderTimeline([], {
      historyControls: {
        hasMoreHistory: true,
        loading: true,
        error: null,
        onLoadEarlier: () => {},
      },
    });
    expect(screen.text()).toContain("Loading earlier turns…");
    expect(screen.button("Load earlier turns")).toHaveProperty("disabled", true);
    expect(screen.text()).not.toContain("Send a message to start the conversation.");
  });

  it("opens the parent thread from the top of an empty subagent timeline", async () => {
    const onOpenThread = vi.fn();
    await using screen = await renderTimeline([], {
      onOpenThread,
      parentThreadLink: {
        title: "Architecture audit",
        open: () => onOpenThread(ThreadId.make("thread-parent")),
      },
    });
    expect(screen.text()).toContain("Subagent of");
    expect(screen.text()).toContain("Architecture audit");
    expect(screen.text()).not.toContain("Send a message to start the conversation");
    await click(screen.button("Open parent thread"));
    expect(onOpenThread).toHaveBeenCalledWith("thread-parent");
  });

  it("opens a thread at its newest message after an empty pane and restores it on return", async () => {
    const props = baseProps();
    function FollowedTimeline(props: TimelineProps) {
      const composerRef = useRef(null);
      const [anchor, setAnchor] = useState<{
        threadKey: string | null;
        messageId: MessageId | null;
      }>({ threadKey: null, messageId: null });
      const follow = useTimelineFollow({
        legendListRef: props.listRef,
        composerRef,
        composerTimelineInset: 0,
        routeThreadKey: props.routeThreadKey,
        activeThreadKey: props.routeThreadKey,
        isServerThread: false,
        serverProjection: null,
        threadStatus: "live",
        activeActivityRun: null,
        activeRunningTurnId: null,
        timelineEntries: props.timelineEntries,
        timelineAnchorMessageId: anchor.messageId,
        setTimelineAnchor: setAnchor,
      });
      return (
        <MessagesTimeline
          {...props}
          liveFollowEnabled={props.liveFollowEnabled && follow.timelineLiveFollowEnabled}
          onViewportAttach={follow.attachTimelineViewport}
          onIsAtEndChange={follow.onIsAtEndChangeStable}
        />
      );
    }
    const entries = Array.from({ length: 12 }, (_, index) =>
      message(
        Array.from({ length: 60 }, (_, line) => `Paragraph ${index}.${line}`).join("\n\n"),
        { role: "assistant" },
        `message-${index}`,
      ),
    );
    await using screen = await renderElement(
      <FollowedTimeline
        {...props}
        timelineEntries={[]}
        routeThreadKey={`${props.routeThreadKey}-loading`}
        hideEmptyPlaceholder
      />,
    );

    // Each row is much taller than LegendList's estimate.
    await act(async () =>
      screen.rerender(<FollowedTimeline {...props} timelineEntries={entries} />),
    );
    const viewport = props.listRef.current!.getScrollableNode();
    if (viewport === null) throw new Error("Timeline viewport is not mounted");
    await vi.waitFor(() => {
      expect(viewport.scrollHeight).toBeGreaterThan(viewport.clientHeight);
      expect(screen.text()).toContain("Paragraph 11.59");
      expect(
        viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
      ).toBeLessThanOrEqual(1);
    });

    const otherThreadKey = `${props.routeThreadKey}-other`;
    await act(async () =>
      screen.rerender(
        <FollowedTimeline
          {...props}
          routeThreadKey={otherThreadKey}
          timelineEntries={entries}
          liveFollowEnabled={false}
        />,
      ),
    );
    await vi.waitFor(() =>
      expect(
        viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
      ).toBeLessThanOrEqual(1),
    );
    // Move beyond LegendList's one-viewport follow threshold so it cannot mask restoration.
    await userEvent.wheel(viewport, { delta: { y: -2000 } });
    await vi.waitFor(() => {
      expect(readTimelinePosition(otherThreadKey)?.atEnd).toBe(false);
      expect(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop).toBeGreaterThan(
        viewport.clientHeight,
      );
    });

    await act(async () =>
      screen.rerender(<FollowedTimeline {...props} timelineEntries={entries} />),
    );
    await vi.waitFor(() => {
      expect(screen.text()).toContain("Paragraph 11.59");
      expect(
        viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
      ).toBeLessThanOrEqual(1);
    });
  });

  it("does not render the transient V2 interruption request", async () => {
    await using screen = await renderTimeline([
      {
        id: "interrupt-request",
        kind: "event",
        createdAt: CREATED_AT,
        projectedItem: v2Item("run_interrupt_request", {
          id: "interrupt-request",
          message: "Waiting for the provider to stop.",
        }),
      } as Entry,
    ]);
    expect(screen.text()).not.toContain("Interrupt requested");
    expect(screen.text()).not.toContain("Waiting for the provider to stop.");
  });

  it("opens created threads from a lean row", async () => {
    const onOpenThread = vi.fn();
    await using screen = await renderTimeline(
      [
        {
          id: "thread-created",
          kind: "event",
          createdAt: CREATED_AT,
          projectedItem: v2Item("thread_created", {
            id: "thread-created",
            nodeId: "node-1",
            ordinal: 1,
            title: "Claude research thread",
            targetThreadId: "thread-2",
            targetRunId: "run-2",
            targetProviderInstanceId: "claude-default",
            targetModel: "claude-sonnet-4-6",
          }),
        } as Entry,
      ],
      { onOpenThread },
    );
    expect(screen.text()).toContain("Claude research thread");
    expect(screen.text()).not.toContain("Work Log");
    await click(screen.button("Open Claude research thread"));
    expect(onOpenThread).toHaveBeenCalledWith("thread-2");
  });

  it("renders context handoffs as from → to model endpoints instead of the summary", async () => {
    const provider = (instanceId: string, driver: string, slug: string, name: string) => ({
      instanceId,
      driver,
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: {},
      checkedAt: CREATED_AT,
      models: [{ slug, name, isCustom: false, capabilities: null }],
      slashCommands: [],
      skills: [],
    });
    const providers = [
      provider("codex_personal", "codex", "gpt-5.6-sol", "GPT 5.6 Sol"),
      provider("claudeAgent", "claudeAgent", "claude-fable-5", "Claude Fable 5"),
    ] as never;
    const handoff = (fields: Record<string, unknown>) =>
      ({
        id: "handoff-1",
        kind: "event",
        createdAt: CREATED_AT,
        projectedItem: v2Item("handoff", {
          id: "handoff-1",
          runId: "run-2",
          title: "Provider handoff",
          contextHandoffId: "handoff-1",
          fromProviderThreadIds: ["provider-thread-1"],
          toProviderThreadId: "provider-thread-2",
          strategy: "full_thread_summary",
          summary: "Full conversation context for provider handoff.",
          fromProviderInstanceIds: ["codex_personal"],
          toProviderInstanceId: "claudeAgent",
          ...fields,
        }),
      }) as Entry;
    const show = (entry: Entry, props: Partial<TimelineProps> = {}) => (
      <RegistryProvider
        initialValues={[[serverEnvironment.providersValueAtom(ENVIRONMENT_ID), providers]]}
      >
        <MessagesTimeline {...baseProps()} timelineEntries={[entry]} {...props} />
      </RegistryProvider>
    );
    await using screen = await renderElement(
      show(
        handoff({
          fromModelSelections: [{ instanceId: "codex_personal", model: "gpt-5.6-sol" }],
          toModel: "claude-fable-5",
        }),
      ),
    );
    expect(screen.text()).toContain("Context handoff");
    expect(screen.text()).toContain("5.6 Sol");
    expect(screen.text()).toContain("Fable 5");
    expect(screen.text()).not.toContain("Full conversation context");

    await screen.rerender(
      show(handoff({}), {
        runs: [
          {
            id: "run-1",
            ordinal: 1,
            providerInstanceId: "codex_personal",
            modelSelection: { instanceId: "codex_personal", model: "gpt-5.6-sol" },
          },
          {
            id: "run-2",
            ordinal: 2,
            providerInstanceId: "claudeAgent",
            modelSelection: { instanceId: "claudeAgent", model: "claude-fable-5" },
          },
        ] as never,
      }),
    );
    expect(screen.text()).toContain("5.6 Sol");
    expect(screen.text()).toContain("Fable 5");

    await screen.rerender(show(handoff({})));
    expect(screen.text()).toContain("Codex Personal");
    expect(screen.text()).not.toContain("Full conversation context");
  });
});

describe("MessagesTimeline subagents", () => {
  it.each(
    (
      [
        {
          status: "running",
          progress: "Reading src/index.ts",
          result: null,
          preview: "Reading src/index.ts",
        },
        {
          status: "completed",
          progress: "Reading src/index.ts",
          result: "Tests should be isolated.",
          preview: "Tests should be isolated.",
        },
        {
          status: "running",
          progress: "Reading src/index.ts",
          result: "Partial streamed answer",
          preview: "Reading src/index.ts",
        },
        {
          status: "running",
          progress: undefined,
          result: "Streaming answer so far",
          preview: "Streaming answer so far",
        },
        {
          status: "cancelled",
          progress: "Reading src/index.ts",
          result: "Partial output before cancel",
          preview: "Partial output before cancel",
        },
        {
          status: "completed",
          progress: "Audited 12 packages",
          result: "  \n\t  ",
          preview: "Audited 12 packages",
        },
      ] as const
    ).flatMap((scenario) => [1, 2].map((count) => ({ ...scenario, count }))),
  )(
    "shows $count $status subagents with '$preview', grouping only multiple agents",
    async ({ status, progress, result, preview, count }) => {
      const onOpenThread = vi.fn();
      await using screen = await renderTimeline(
        Array.from(
          { length: count },
          (_, index) =>
            ({
              id: `subagent-progress-${index}`,
              kind: "event",
              createdAt: CREATED_AT,
              projectedItem: v2Item("subagent", {
                id: `subagent-progress-${index}`,
                nodeId: `node-subagent-${index}`,
                providerThreadId: "provider-thread-1",
                providerTurnId: "provider-turn-1",
                ordinal: 1,
                status,
                title: "Package audit",
                subagentId: `node-subagent-${index}`,
                origin: "provider_native",
                driver: "claudeAgent",
                providerInstanceId: "claudeAgent",
                childThreadId: "thread-subagent-1",
                prompt: "Inspect the package",
                progress,
                result,
              }),
            }) as Entry,
        ),
        { onOpenThread },
      );
      const children = () => screen.buttons("Open Package audit");
      // A settled run folds its work behind a "Worked for" summary.
      const fold = screen.buttons(/^Worked for/)[0];
      if (fold) await click(fold);
      if (count > 1) {
        expect(children()).toHaveLength(0);
        await click(screen.button(`${count} subagents`));
      } else {
        expect(screen.buttons(`${count} subagents`)).toHaveLength(0);
      }
      expect(children()).toHaveLength(count);
      expect(screen.text()).toContain(preview);
      expect(screen.text()).not.toContain("Inspect the package");
      if (result?.trim() && result !== preview) expect(screen.text()).not.toContain(result);
      if (progress && progress !== preview) expect(screen.text()).not.toContain(progress);
      await click(children()[0]!);
      expect(onOpenThread).toHaveBeenCalledWith("thread-subagent-1");
      if (count > 1) {
        await click(screen.button(`${count} subagents`));
        await vi.waitFor(() => expect(children()).toHaveLength(0));
      }
    },
  );
});

describe("timeline tooltip scroll dismissal", () => {
  const openPopup = () =>
    document.querySelector('[data-slot="tooltip-popup"][data-open]')?.textContent ?? null;

  async function renderTooltip(pullRequest: boolean, outside: boolean) {
    environmentQuery.data = null;
    environmentQuery.error = "Pull request not found";
    const tooltip = pullRequest ? (
      <PullRequestLinkPreview
        link={<button>message link</button>}
        originalUrl="https://example.com"
        target={{
          environmentId: ENVIRONMENT_ID,
          input: { projectId: "project-1" as never, repository: "pingdotgg/t3code", number: 1 },
        }}
      />
    ) : (
      <Tooltip>
        <TooltipTrigger delay={50}>message link</TooltipTrigger>
        <TooltipPopup>https://example.com</TooltipPopup>
      </Tooltip>
    );
    const screen = await renderElement(
      <>
        <TooltipScrollDismissArea>
          <div data-testid="scrollable" className="h-[100px] overflow-auto">
            {outside ? null : tooltip}
            <div className="h-[1000px]" />
          </div>
        </TooltipScrollDismissArea>
        {outside ? tooltip : null}
      </>,
    );
    return Object.assign(screen, {
      trigger: screen.container.querySelector<HTMLButtonElement>("button")!,
      scrollable: screen.container.querySelector<HTMLElement>('[data-testid="scrollable"]')!,
    });
  }

  async function scroll(scrollable: HTMLElement) {
    await act(async () => {
      scrollable.scrollTop += 50;
      scrollable.dispatchEvent(new Event("scroll"));
    });
  }

  it.each([false, true])(
    "closes a hovered tooltip on scroll but keeps a focused one (pull request=%s)",
    async (pullRequest) => {
      await using screen = await renderTooltip(pullRequest, false);
      const { trigger, scrollable } = screen;
      await userEvent.hover(trigger);
      await vi.waitFor(() => expect(openPopup()).toBe("https://example.com"));
      await scroll(scrollable);
      await vi.waitFor(() => expect(openPopup()).toBeNull());

      await userEvent.unhover(trigger);
      await userEvent.keyboard("{Tab}");
      expect(document.activeElement).toBe(trigger);
      await vi.waitFor(() => expect(openPopup()).toBe("https://example.com"));
      await scroll(scrollable);
      expect(openPopup()).toBe("https://example.com");
      expect(document.activeElement).toBe(trigger);
    },
  );

  it("leaves tooltips outside the timeline open when it scrolls", async () => {
    await using screen = await renderTooltip(false, true);
    const { trigger, scrollable } = screen;
    await userEvent.hover(trigger);
    await vi.waitFor(() => expect(openPopup()).toBe("https://example.com"));
    await scroll(scrollable);
    expect(openPopup()).toBe("https://example.com");
  });

  it("keeps a hovered tooltip open on a wheel that does not scroll", async () => {
    await using screen = await renderTooltip(false, false);
    const { trigger, scrollable } = screen;
    await userEvent.hover(trigger);
    await vi.waitFor(() => expect(openPopup()).toBe("https://example.com"));
    await act(async () => {
      scrollable.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 100 }));
    });
    expect(openPopup()).toBe("https://example.com");
  });
});

describe("MessagesTimeline scroll position", () => {
  const tall = (index: number) =>
    message(
      `Message ${index}\n\n${"Long paragraph. ".repeat(80)}`,
      { role: "assistant" },
      `message-${index}`,
    );
  const tallEntries = Array.from({ length: 12 }, (_, index) => tall(index));

  async function waitForList(props: ReturnType<typeof baseProps>) {
    await vi.waitFor(() => {
      const viewport = props.listRef.current?.getScrollableNode();
      expect(viewport?.scrollHeight ?? 0).toBeGreaterThan(viewport?.clientHeight ?? 0);
    });
    return props.listRef.current!.getScrollableNode()!;
  }

  it.each([80, 800])(
    "settles when %i earlier short replies load above long ones",
    async (historySize) => {
      // Loading earlier history follows manual navigation, which releases live-end following.
      const props = { ...baseProps(), liveFollowEnabled: false };
      const short = Array.from({ length: historySize }, (_, index) =>
        message(`Short reply ${index}`, { role: "assistant" }, `short-${index}`),
      );
      const long = Array.from({ length: 4 }, (_, index) =>
        message(
          `${"Long handbook paragraph. ".repeat(40)}\n\n`.repeat(60),
          { role: "assistant" },
          `long-${index}`,
        ),
      );
      let commits = 0;
      let nestedCommits = 0;
      let maxNestedCommits = 0;
      const onRender = (_id: string, phase: string) => {
        commits += 1;
        nestedCommits = phase === "nested-update" ? nestedCommits + 1 : 0;
        maxNestedCommits = Math.max(maxNestedCommits, nestedCommits);
      };
      const timeline = (entries: Entry[]) => (
        <Profiler id="timeline" onRender={onRender}>
          <MessagesTimeline {...props} timelineEntries={entries} />
        </Profiler>
      );
      await using screen = await renderElement(timeline(long));
      const viewport = await waitForList(props);
      await act(async () => {
        viewport.scrollTop = 0;
        viewport.dispatchEvent(new Event("scroll"));
      });

      // Observe a quiet layout boundary instead of counting initial placement as prepend work.
      const waitForSettledLayout = () =>
        vi.waitFor(async () => {
          const before = commits;
          await act(async () => {
            await new Promise<void>((resolve) =>
              // oxlint-disable-next-line t3code/no-frame-waits-in-browser-tests -- The profiler budget measures real layout convergence; retry until two frames contain no commits.
              requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
            );
          });
          expect(commits).toBe(before);
        });
      await waitForSettledLayout();

      // Measure this prepend independently of the initial long-message layout chain.
      nestedCommits = 0;
      maxNestedCommits = 0;
      await act(async () => screen.rerender(timeline([...short, ...long])));
      await vi.waitFor(async () => {
        await act(async () => {
          viewport.scrollTop = 0;
          viewport.dispatchEvent(new Event("scroll"));
        });
        expect(screen.text()).toContain("Short reply 0");
      });
      await waitForSettledLayout();
      // LegendList 3.7 converges in at most eight passes, independent of history size.
      expect(maxNestedCommits).toBeLessThanOrEqual(8);
    },
  );

  it("restores a manual reading position after reopening and switching threads", async () => {
    const props = baseProps();
    function Chat() {
      const [liveFollowEnabled, setLiveFollowEnabled] = useState(true);
      // The chat view stops following the live edge when the reader scrolls.
      return (
        <div
          className="contents"
          onWheelCapture={() => flushSync(() => setLiveFollowEnabled(false))}
        >
          <MessagesTimeline
            {...props}
            timelineEntries={tallEntries}
            liveFollowEnabled={liveFollowEnabled}
          />
        </div>
      );
    }
    await using screen = await renderElement(<Chat />);
    const viewport = await waitForList(props);
    await vi.waitFor(() => expect(readTimelinePosition(props.routeThreadKey)?.atEnd).toBe(true));

    await userEvent.wheel(viewport, { delta: { y: -600 } });
    await vi.waitFor(() => expect(readTimelinePosition(props.routeThreadKey)?.atEnd).toBe(false));
    const offset = viewport.scrollTop;
    await screen.unmount();
    expect(readTimelinePosition(props.routeThreadKey)).toMatchObject({
      atEnd: false,
      scrollOffset: offset,
    });

    const timeline = (routeThreadKey: string) => (
      <MessagesTimeline {...props} routeThreadKey={routeThreadKey} timelineEntries={tallEntries} />
    );
    await using reopened = await renderElement(timeline(props.routeThreadKey));
    const reopenedViewport = await waitForList(props);
    await vi.waitFor(() =>
      expect(Math.abs(reopenedViewport.scrollTop - offset)).toBeLessThanOrEqual(1),
    );

    await act(async () => reopened.rerender(timeline(`${props.routeThreadKey}-other`)));
    await vi.waitFor(() =>
      expect(
        reopenedViewport.scrollHeight - reopenedViewport.clientHeight - reopenedViewport.scrollTop,
      ).toBeLessThanOrEqual(1),
    );
    await act(async () => reopened.rerender(timeline(props.routeThreadKey)));
    await vi.waitFor(() =>
      expect(Math.abs(reopenedViewport.scrollTop - offset)).toBeLessThanOrEqual(1),
    );
  });

  it("restores the composer after closing tool output only at the end", async () => {
    await commands.setCpuThrottling(6);
    onTestFinished(() => commands.setCpuThrottling(1));
    const props = baseProps();
    function Thread() {
      const composer = useComposerFocusState();
      const [liveFollowEnabled, setLiveFollowEnabled] = useState(true);
      // Production follow is an external store: its release commits before the native scroll.
      return (
        <div
          className="contents"
          onWheelCapture={() => flushSync(() => setLiveFollowEnabled(false))}
        >
          <button onClick={() => composer.setIsComposerScrollCollapsed(true)}>Collapse</button>
          <output>{composer.isComposerScrollCollapsed ? "collapsed" : "resting"}</output>
          <MessagesTimeline
            {...props}
            liveFollowEnabled={liveFollowEnabled}
            onToolOutputCollapsedAtEnd={composer.restoreAfterTimelineReachedEnd}
            timelineEntries={[
              ...tallEntries,
              work("tool", {
                label: "Run command",
                tone: "tool",
                toolLifecycleStatus: "completed",
                detail: "Command output",
              }),
            ]}
          />
        </div>
      );
    }
    await using screen = await renderElement(<Thread />);
    const composerState = () => screen.container.querySelector("output")!.textContent;
    const viewport = await waitForList(props);
    await vi.waitFor(() => {
      expect(
        viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
      ).toBeLessThanOrEqual(1);
      expect(props.listRef.current!.getState().isAtEnd).toBe(true);
    });
    await click(screen.button("Collapse"));
    const toggle = () => screen.button("Command output");
    await click(toggle());
    await click(toggle());
    await vi.waitFor(() => expect(composerState()).toBe("resting"));

    await click(screen.button("Collapse"));
    await userEvent.wheel(viewport, { delta: { y: -2000 } });
    await vi.waitFor(() => expect(readTimelinePosition(props.routeThreadKey)?.atEnd).toBe(false));
    await click(toggle());
    await click(toggle());
    await vi.waitFor(() => {
      expect(readTimelinePosition(props.routeThreadKey)?.atEnd).toBe(false);
      expect(composerState()).toBe("collapsed");
    });
    await userEvent.wheel(viewport, { delta: { y: 2000 } });
    await vi.waitFor(() => expect(composerState()).toBe("resting"));
  });
});

describe("MessagesTimeline send anchor", () => {
  it("reports the anchored sent message once it is laid out", async () => {
    const onAnchorReady = vi.fn();
    const sent = message("Newest prompt.", {}, "message-2");
    await using screen = await renderTimeline(
      [message("Earlier reply.", { role: "assistant" }), sent],
      {
        anchorMessageId: MessageId.make("message-2"),
        onAnchorReady,
        contentInsetEndAdjustment: 144,
      },
    );
    await vi.waitFor(() => {
      expect(screen.text()).toContain("Newest prompt.");
      expect(onAnchorReady).toHaveBeenCalledWith(MessageId.make("message-2"), 1);
    });
  });

  it("does not anchor a follow-up user message that is not the newest turn", async () => {
    const onAnchorReady = vi.fn();
    await using screen = await renderTimeline(
      [message("First prompt."), message("Newest prompt.", {}, "message-2")],
      {
        anchorMessageId: MessageId.make("message-2"),
        onAnchorReady,
      },
    );
    await vi.waitFor(() => {
      expect(screen.text()).toContain("Newest prompt.");
      expect(
        screen.container.querySelector('[data-message-id="message-2"]')?.getBoundingClientRect()
          .height ?? 0,
      ).toBeGreaterThan(0);
    });
    expect(onAnchorReady).not.toHaveBeenCalled();
  });
});

function usageLimitEntries(resetAt: string) {
  const threadId = ThreadId.make("usage-limit-thread");
  const at = DateTime.makeUnsafe(CREATED_AT);
  return deriveTimelineEntriesFromVisibleTurnItems({
    visibleTurnItems: [
      {
        position: 0,
        visibility: "local",
        sourceThreadId: threadId,
        sourceItemId: TurnItemId.make("usage-limit"),
        item: {
          id: TurnItemId.make("usage-limit"),
          threadId,
          runId: RunId.make("usage-limit-run"),
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 0,
          title: null,
          startedAt: at,
          completedAt: at,
          updatedAt: at,
          type: "error",
          status: "failed",
          failure: {
            class: "usage_limit",
            message: "You've hit your usage limit.",
            code: null,
            retryable: true,
            resetAt,
          },
        },
      },
    ],
    optimisticMessages: [],
  });
}

describe("MessagesTimeline usage limit notice", () => {
  it("labels the retry time with the viewer's timezone", async () => {
    await using screen = await renderTimeline(usageLimitEntries("2026-03-17T19:30:00.000Z"));
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(screen.text()).toMatch(/Usage limit reached\. Retry after .+\./);
    expect(screen.text()).toContain(`(${timeZone})`);
  });

  it("keeps the retry time in the named zone after the viewer's timezone changes", async () => {
    const resetAt = "2026-07-01T19:30:00.000Z";
    const session = cdp();
    await session.send("Emulation.setTimezoneOverride", { timezoneId: "Europe/Madrid" });
    try {
      {
        await using _madrid = await renderTimeline(usageLimitEntries(resetAt));
      }
      await session.send("Emulation.setTimezoneOverride", { timezoneId: "America/New_York" });
      await using screen = await renderTimeline(usageLimitEntries(resetAt));
      const newYorkTime = new Date(resetAt).toLocaleTimeString(undefined, {
        hour: "numeric",
        minute: "2-digit",
        timeZone: "America/New_York",
      });
      expect(screen.text()).toContain(`${newYorkTime} (America/New_York)`);
    } finally {
      await session.send("Emulation.setTimezoneOverride", { timezoneId: "" });
    }
  });
});

const CITATION_REQUEST = {
  key: "activation-1",
  citation: {
    version: 1,
    environmentId: ENVIRONMENT_ID,
    threadId: ThreadId.make("thread-cited"),
    messageId: MessageId.make("cited"),
    text: "the cited answer",
    start: 0,
    end: 16,
    prefix: "",
    suffix: "",
  },
} satisfies NonNullable<TimelineProps["citationRequest"]>;

describe("MessagesTimeline citations", () => {
  it("lands a citation present at mount under StrictMode", async () => {
    await using _screen = await renderElement(
      <StrictMode>
        <MessagesTimeline
          {...baseProps()}
          timelineEntries={[
            message("A question", {}, "question"),
            message("the cited answer", { role: "assistant" }, "cited"),
          ]}
          citationRequest={CITATION_REQUEST}
          citationHistory={{ _tag: "found" }}
        />
      </StrictMode>,
      // The test router mounts route content without StrictMode's effect replay.
      { router: false },
    );
    // StrictMode replays effect cleanups on mount; the activation must survive them.
    await vi.waitFor(() =>
      expect(document.querySelector("[data-citation-highlighted]")?.textContent).toContain(
        "the cited answer",
      ),
    );
  });

  it("opens the superseded attempt that folds the cited response", async () => {
    const runId = RunId.make("run-steered");
    const attempt = (id: string, ordinal: number, status: "superseded" | "running") => ({
      id: RunAttemptId.make(id),
      runId,
      attemptOrdinal: ordinal,
      rootNodeId: `node-${id}` as never,
      status,
      completedAt: null,
    });
    const superseded = attempt("attempt-1", 1, "superseded");
    const active = attempt("attempt-2", 2, "running");
    const inAttempt = (entry: Entry, entryAttempt: typeof superseded): Entry => ({
      ...entry,
      attempt: entryAttempt,
    });
    await using _screen = await renderTimeline(
      [
        inAttempt(message("Build it", { runId }, "question"), superseded),
        inAttempt(message("the cited answer", { role: "assistant", runId }, "cited"), superseded),
        inAttempt(message("Change direction", { runId }, "steer"), active),
        inAttempt(message("Current response", { role: "assistant", runId }, "current"), active),
      ],
      {
        latestRun: { runId, status: "running", startedAt: CREATED_AT, completedAt: null },
        citationRequest: CITATION_REQUEST,
        citationHistory: { _tag: "found" },
      },
    );
    await vi.waitFor(() =>
      expect(document.querySelector("[data-citation-highlighted]")?.textContent).toContain(
        "the cited answer",
      ),
    );
  });

  it("waits for cited history to load before giving up on a response outside the window", async () => {
    using toast = vi.spyOn(toastManager, "add");
    const props = baseProps();
    const citationRequest = CITATION_REQUEST;
    const recent = message("A recent question", {}, "recent");
    const timeline = (entries: Entry[], citationHistory: CitedHistory) => (
      <MessagesTimeline
        {...props}
        timelineEntries={entries}
        citationRequest={citationRequest}
        citationHistory={citationHistory}
      />
    );
    await using screen = await renderElement(timeline([recent], { _tag: "loading" }));
    await expect.element(screen.getByText("A recent question")).toBeVisible();

    await screen.rerender(
      timeline([message("the cited answer", { role: "assistant" }, "cited"), recent], {
        _tag: "found",
      }),
    );
    await expect.element(screen.getByText("the cited answer")).toBeVisible();
    expect(toast).not.toHaveBeenCalled();
  });
});

describe("MessagesTimeline automation prompts", () => {
  it("folds an automation prompt into a bubble titled by its task", async () => {
    setup({ scheduledTasks: [{ id: TASK_ID, title: "Nightly triage" }] });
    await using screen = await renderTimeline([
      message(AUTOMATION_PROMPT, { scheduledTaskId: TASK_ID }),
    ]);
    const row = screen.button(/^Automation/);
    expect(row.textContent).toContain("Nightly triage");
    expect(row.getAttribute("aria-expanded")).toBe("false");
    expect(screen.text()).not.toContain("close duplicates");

    await click(row);
    expect(screen.text()).toContain("Label every new issue and close duplicates.");
    const link = [...screen.container.querySelectorAll("a")].find(
      (anchor) => anchor.textContent === "Open automation",
    );
    expect(link?.getAttribute("href")).toContain(`taskId=${TASK_ID}`);
    expect(screen.buttons(/copy/i)).not.toHaveLength(0);
  });

  it("falls back to the prompt's first line without a task title", async () => {
    setup();
    await using screen = await renderTimeline([
      message(AUTOMATION_PROMPT, { scheduledTaskId: TASK_ID }),
    ]);
    expect(screen.button(/^Automation/).textContent).toContain("Triage the inbox");
  });

  it("leaves ordinary user messages as full bubbles", async () => {
    setup();
    await using screen = await renderTimeline([message(AUTOMATION_PROMPT)]);
    expect(screen.buttons(/^Automation/)).toHaveLength(0);
    expect(screen.text()).toContain("Label every new issue and close duplicates.");
  });

  it("reveals a find match beyond the folded automation prompt's initial viewport", async () => {
    setup();
    const prompt = `${"Inspect the next item.\n\n".repeat(16)}Close duplicates.`;
    await using screen = await renderTimeline([message(prompt, { scheduledTaskId: TASK_ID })], {
      findExpanded: true,
      findQuery: "duplicates",
      activeFindMatch: { entryId: "entry-message-1", runId: null, occurrence: 0 },
    });
    await vi.waitFor(() =>
      expect(screen.button(/^Automation/).getAttribute("aria-expanded")).toBe("true"),
    );
    const { range } = collectThreadFindRanges(screen.container, "duplicates")[0]!;
    const details = screen.container.querySelector("[data-thread-find-text]")!;
    expect(range.getBoundingClientRect().top - details.getBoundingClientRect().top).toBeGreaterThan(
      384,
    );
    expect(range.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      details.getBoundingClientRect().bottom,
    );
  });

  it("shows edit-from-here once an automation prompt is expanded", async () => {
    setup();
    const runId = RunId.make("run-1");
    await using screen = await renderTimeline(
      [
        message(
          AUTOMATION_PROMPT,
          { scheduledTaskId: TASK_ID, runId, inputIntent: "turn_start" },
          "user-1",
        ),
        message("Done", { role: "assistant", runId }, "assistant-1"),
      ],
      {
        supportsConversationRollback: true,
        threadStartCheckpointAvailable: true,
        turnDiffSummaries: [
          {
            runId,
            checkpointTurnCount: 1,
            checkpointRef: "checkpoint-1" as never,
            status: "ready",
            files: [],
            assistantMessageId: MessageId.make("assistant-1"),
            completedAt: CREATED_AT,
          },
        ],
      },
    );
    expect(screen.buttons("Edit from here")).toHaveLength(0);
    await click(screen.button(/^Automation/));
    expect(screen.buttons("Edit from here")).toHaveLength(1);
  });
});

const SENDER_THREAD_ID = ThreadId.make("thread-sender");
const AGENT_MESSAGE = "Review finished\n\nThe migration drops the index before backfilling it.";

describe("MessagesTimeline agent messages", () => {
  it("folds a message from another agent into a one-line preview", async () => {
    setup();
    const onOpenThread = vi.fn();
    await using screen = await renderTimeline(
      [
        message(AGENT_MESSAGE, { createdBy: "agent", senderThreadId: SENDER_THREAD_ID }),
        // Sent from a linked environment this client does not reach.
        message(
          "Linked review finished",
          {
            createdBy: "agent",
            linkedSender: {
              environmentId: EnvironmentId.make("environment-linked"),
              threadId: SENDER_THREAD_ID,
              title: "Release lead",
            },
          },
          "message-linked",
        ),
      ],
      { onOpenThread },
    );
    const row = screen.button(/^Agent/);
    expect(row.textContent).toContain("Review finished");
    expect(row.getAttribute("aria-expanded")).toBe("false");
    expect(screen.text()).not.toContain("drops the index");
    expect(screen.buttons("Open thread")).toHaveLength(0);

    await click(row);
    expect(screen.text()).toContain("The migration drops the index before backfilling it.");
    await click(screen.button("Open thread"));
    expect(onOpenThread).toHaveBeenCalledWith(SENDER_THREAD_ID, ENVIRONMENT_ID);

    await click(screen.button(/^Agent/));
    expect(screen.text()).not.toContain("drops the index");

    // The linked sender shows the title it sent, and its thread cannot be opened from here.
    await click(screen.button(/^Release lead/));
    expect(screen.buttons("Open thread")).toHaveLength(0);
  });

  it("leaves messages sent by T3 Code as full bubbles", async () => {
    setup();
    await using screen = await renderTimeline([
      message(AGENT_MESSAGE, { createdBy: "agent", creationSource: "server" }),
    ]);
    expect(screen.buttons(/^Agent/)).toHaveLength(0);
    expect(screen.text()).toContain("drops the index");
  });

  it("reveals a find match inside a folded agent message", async () => {
    setup();
    const text = `${"Checked the next file.\n\n".repeat(16)}The migration drops the index.`;
    await using screen = await renderTimeline(
      [message(text, { createdBy: "agent", senderThreadId: SENDER_THREAD_ID })],
      {
        findExpanded: true,
        findQuery: "drops the index",
        activeFindMatch: { entryId: "entry-message-1", runId: null, occurrence: 0 },
      },
    );
    await vi.waitFor(() =>
      expect(screen.button(/^Agent/).getAttribute("aria-expanded")).toBe("true"),
    );
    const { range } = collectThreadFindRanges(screen.container, "drops the index")[0]!;
    const body = screen.container.querySelector("[data-user-message-body]")!;
    expect(range.getBoundingClientRect().height).toBeGreaterThan(0);
    expect(range.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      body.getBoundingClientRect().bottom,
    );
  });
});

describe("MessagesTimeline attachments", () => {
  it.each(["image", "file"] as const)(
    "copies only matching context records for a wordless %s attachment",
    async (kind) => {
      const attachment = {
        type: kind,
        id: "media",
        name: kind === "image" ? "photo.png" : "clip.mp4",
        mimeType: kind === "image" ? "image/png" : "video/mp4",
        sizeBytes: 100,
        downloadable: false,
      };
      const record = {
        version: 1 as const,
        ...(kind === "image" ? { kind: "image" as const } : { kind: "file" as const }),
        contextId: ComposerContextId.make("media-context"),
        label: attachment.name,
        attachmentId: attachment.id,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
      };
      await using screen = await renderTimeline([message("", { attachments: [attachment] })]);
      expect(screen.buttons("Copy message")).toHaveLength(0);
      await screen.rerender(
        <MessagesTimeline
          {...baseProps()}
          timelineEntries={[
            message("", {
              attachments: [attachment],
              context: { version: 1, records: [{ ...record, attachmentId: "other" }] },
            }),
          ]}
        />,
      );
      expect(screen.buttons("Copy message")).toHaveLength(0);
      await screen.rerender(
        <MessagesTimeline
          {...baseProps()}
          timelineEntries={[
            message("", {
              attachments: [attachment],
              context: {
                version: 1,
                records: [
                  record,
                  {
                    ...record,
                    contextId: ComposerContextId.make("other-context"),
                    attachmentId: "other",
                  },
                ],
              },
            }),
          ]}
        />,
      );
      using write = vi.spyOn(navigator.clipboard, "write").mockResolvedValue();
      await click(screen.button("Copy message"));
      await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
      const [item] = write.mock.calls[0]![0];
      const text = await (await item!.getType("text/plain")).text();
      const fragment = await (await item!.getType(COMPOSER_CONTEXT_CLIPBOARD_MIME)).text();
      expect(
        collectComposerContextReferences(text).map((reference) => reference.contextId),
      ).toEqual([record.contextId]);
      expect(decodeComposerContextFragment(fragment)?.records).toEqual([record]);
    },
  );

  it.each(["loadedmetadata", "loadeddata", "canplay"])(
    "plays audio with unknown duration after %s and updates the total later",
    async (readyEvent) => {
      const onOpen = vi.fn();
      const preview = (failed = false) => (
        <AudioPreview
          compact
          src="data:audio/webm;base64,"
          name="recording.webm"
          failed={failed}
          onOpen={onOpen}
        />
      );
      await using screen = await renderElement(<div dir="rtl">{preview()}</div>);
      const audio = screen.container.querySelector("audio")!;
      const duration = vi.spyOn(audio, "duration", "get").mockReturnValue(Infinity);
      const play = vi.spyOn(audio, "play").mockResolvedValue();
      expect(screen.button("Loading recording.webm")).toHaveProperty("disabled", true);
      await act(() => audio.dispatchEvent(new Event(readyEvent)));
      expect(screen.button("Play recording.webm")).toHaveProperty("disabled", false);
      expect(screen.text()).toContain("0:00");
      expect(screen.text()).not.toContain("/");
      await click(screen.button("Play recording.webm"));
      expect(play).toHaveBeenCalledOnce();
      await act(() => {
        vi.spyOn(audio, "currentTime", "get").mockReturnValue(3);
        audio.dispatchEvent(new Event("play"));
        audio.dispatchEvent(new Event("timeupdate"));
      });
      expect(screen.button("Pause recording.webm")).toHaveProperty("disabled", false);
      expect(screen.text()).toContain("0:03");
      const progress = screen.container.querySelector<HTMLElement>("span[aria-hidden]")!;
      expect(progress.style.width).toBe("0%");
      await act(() => {
        duration.mockReturnValue(10);
        audio.dispatchEvent(new Event("durationchange"));
      });
      expect(screen.text()).toContain("0:03 / 0:10");
      expect(
        getComputedStyle(screen.container.querySelector("audio")!.previousElementSibling!)
          .direction,
      ).toBe("ltr");
      expect(progress.style.width).toBe("30%");
      await act(() => {
        duration.mockReturnValue(NaN);
        audio.dispatchEvent(new Event("durationchange"));
      });
      expect(screen.text()).not.toContain("/");
      expect(progress.style.width).toBe("0%");
      expect(screen.button("Pause recording.webm")).toHaveProperty("disabled", false);
      await screen.rerender(preview(true));
      expect(screen.text()).toContain("Unavailable");
      await click(screen.button("Audio unavailable. Open recording.webm"));
      expect(onOpen).toHaveBeenCalledOnce();
    },
  );

  it.each(["pause", "error"])("unpins audio after %s", async (event) => {
    const NativeObserver = IntersectionObserver;
    using _observer = stubGlobal(
      "IntersectionObserver",
      class extends NativeObserver {
        constructor(
          private readonly notify: IntersectionObserverCallback,
          options?: IntersectionObserverInit,
        ) {
          super(notify, options);
        }
        override observe(target: Element) {
          this.notify([{ target, isIntersecting: true } as IntersectionObserverEntry], this);
        }
      },
    );
    const src =
      "data:audio/wav;base64,UklGRiUAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQEAAACA";
    stubbedAsset.url = src;
    onTestFinished(() => {
      stubbedAsset.url = "";
    });
    const props = baseProps();
    await using screen = await renderTimeline(
      [
        // The first message row is always mounted, so the recordings go in the second.
        message("Start of the thread.", { role: "user" }, "opening"),
        message(
          "Two recordings.",
          {
            attachments: ["one", "two"].map((name) => ({
              type: "file",
              id: `attachment-${name}`,
              name: `${name}.wav`,
              mimeType: "audio/wav",
              sizeBytes: 45,
              previewUrl: src,
            })),
          },
          "audio",
        ),
        ...Array.from({ length: 40 }, (_, index) =>
          message("Conversation history. ".repeat(40), { role: "user" }, `history-${index}`),
        ),
      ],
      props,
    );
    screen.container.style.height = "600px";
    screen.container.scrollIntoView({ block: "start" });
    await vi.waitFor(
      async () => {
        await act(() => {
          void props.listRef.current?.scrollToIndex({ index: 1, animated: false });
        });
        expect(screen.container.querySelectorAll("audio")).toHaveLength(2);
      },
      { timeout: 5000 },
    );
    const [one, two] = [...screen.container.querySelectorAll("audio")];
    await act(async () => {
      vi.spyOn(one!, "paused", "get").mockReturnValue(false);
      vi.spyOn(two!, "paused", "get").mockReturnValue(false);
      one!.dispatchEvent(new Event("play"));
      two!.dispatchEvent(new Event("play"));
    });
    await vi.waitFor(async () => {
      await act(() => {
        void props.listRef.current!.scrollToEnd({ animated: false });
      });
      const scroll = props.listRef.current!.getScrollableNode()!;
      expect(scroll.scrollTop).toBeGreaterThan(5000);
    });
    expect(one!.isConnected).toBe(true);
    expect(two!.isConnected).toBe(true);
    await act(async () => {
      vi.spyOn(one!, "paused", "get").mockReturnValue(true);
      one!.dispatchEvent(new Event("pause"));
    });
    expect(two!.isConnected).toBe(true);
    await act(async () => {
      if (event === "pause") vi.spyOn(two!, "paused", "get").mockReturnValue(true);
      two!.dispatchEvent(new Event(event));
    });
    await act(() => {
      void props.listRef.current!.scrollToIndex({ index: 20, animated: false });
    });
    await vi.waitFor(() => expect(one!.isConnected).toBe(false));
  });

  it("opens a viewed image as a gallery of the images beside it", async () => {
    stubbedAsset.url =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
    onTestFinished(() => {
      stubbedAsset.url = "";
    });
    const onImageExpand = vi.fn<ComponentProps<typeof MessagesTimeline>["onImageExpand"]>();
    await using screen = await renderElement(
      <TimelineRowCtx
        value={
          {
            threadRef: { environmentId: ENVIRONMENT_ID, threadId: ThreadId.make("thread-1") },
            workspaceRoot: "/repo",
            onImageExpand,
          } as never
        }
      >
        <ViewedImagesTimelineRow
          row={{
            kind: "viewed-images",
            id: "viewed",
            createdAt: CREATED_AT,
            paths: ["/repo/first.png", "/repo/second.png", "/repo/third.png"],
          }}
        />
      </TimelineRowCtx>,
    );
    await screen.getByRole("button", { name: "Preview second.png" }).click();
    expect(onImageExpand).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        index: 1,
        images: ["first.png", "second.png", "third.png"].map((name) =>
          expect.objectContaining({ name }),
        ),
      }),
    );
  });
});

describe("MessagesTimeline thread find", () => {
  // Opening find is navigation; on a list already showing the thread the open
  // action navigates, so the list itself releases follow only when it starts
  // showing a thread whose find is already open.
  function renderObserved() {
    const navigations: TimelineNavigation[] = [];
    const base = baseProps();
    const element = (next: Partial<TimelineProps>) => (
      <MessagesTimeline
        {...base}
        timelineEntries={[message("Where is the sidebar fix?")]}
        onViewportAttach={(viewport) =>
          viewport.subscribe((navigation) => navigations.push(navigation))
        }
        {...next}
      />
    );
    return { navigations, element };
  }
  const released = { source: "command", releasesFollow: true };

  it("releases follow once when it starts showing a thread whose find is open", async () => {
    setup();
    const { navigations, element } = renderObserved();
    await using screen = await renderElement(element({}));
    expect(navigations).toEqual([]);

    const other = "environment-local:thread-find-open";
    await screen.rerender(element({ routeThreadKey: other, findOpen: true }));
    expect(navigations).toEqual([released]);
    await screen.rerender(element({ routeThreadKey: other, findOpen: false }));
    await screen.rerender(element({ routeThreadKey: other, findOpen: true }));
    expect(navigations).toEqual([released]);
  });

  it("releases follow once when it mounts on a thread whose find is open", async () => {
    setup();
    const { navigations, element } = renderObserved();
    await using screen = await renderElement(element({ findOpen: true }));
    await screen.rerender(element({ findOpen: true }));
    expect(navigations).toEqual([released]);
  });

  it("still restores the position of a thread it switches to whose find is open", async () => {
    setup();
    const base = baseProps();
    const other = "environment-local:thread-find-open-positioned";
    const replies = Array.from({ length: 40 }, (_, index) =>
      message(`Reply ${index}\n\n${"line\n\n".repeat(8)}`, { role: "assistant" }, `r-${index}`),
    );
    rememberTimelinePosition(
      other,
      { rowId: "entry-r-20", offsetWithinRow: 0, scrollOffset: 0, atEnd: false },
      false,
    );
    await using screen = await renderElement(
      <MessagesTimeline {...base} timelineEntries={[message("Short thread")]} />,
    );
    await screen.rerender(
      <MessagesTimeline
        {...base}
        routeThreadKey={other}
        timelineEntries={replies}
        liveFollowEnabled={false}
        findOpen
      />,
    );
    const viewport = base.listRef.current!.getScrollableNode()!;
    await vi.waitFor(() => {
      const row = screen.container.querySelector('[data-timeline-row-id="entry-r-20"]');
      expect(row).not.toBeNull();
      expect(
        Math.abs(row!.getBoundingClientRect().top - viewport.getBoundingClientRect().top),
      ).toBeLessThanOrEqual(2);
    });
  });
  it("reveals find's match, not the remembered row, on a thread it switches to", async () => {
    setup();
    const base = baseProps();
    const other = "environment-local:thread-find-open-match";
    const replies = Array.from({ length: 40 }, (_, index) =>
      message(
        `${index === 5 ? "Needle here" : `Reply ${index}`}\n\n${"line\n\n".repeat(8)}`,
        { role: "assistant" },
        `r-${index}`,
      ),
    );
    rememberTimelinePosition(
      other,
      { rowId: "entry-r-20", offsetWithinRow: 0, scrollOffset: 0, atEnd: false },
      false,
    );
    await using screen = await renderElement(
      <MessagesTimeline {...base} timelineEntries={[message("Short thread")]} />,
    );
    await screen.rerender(
      <MessagesTimeline
        {...base}
        routeThreadKey={other}
        timelineEntries={replies}
        liveFollowEnabled={false}
        findOpen
        findExpanded
        findQuery="Needle"
        activeFindMatch={{ entryId: "entry-r-5", runId: null, occurrence: 0 }}
      />,
    );
    const viewport = base.listRef.current!.getScrollableNode()!;
    await vi.waitFor(() => {
      const row = screen.container.querySelector('[data-timeline-row-id="entry-r-5"]');
      expect(row).not.toBeNull();
      const bounds = viewport.getBoundingClientRect();
      const top = row!.getBoundingClientRect().top;
      expect(top).toBeGreaterThanOrEqual(bounds.top);
      expect(top).toBeLessThan(bounds.bottom);
    });
  });
});

describe("compact reasoning math", () => {
  it.each([
    [
      "## Reasoning\n\nUse **norm** $|x|$ and \\[x^2\\]",
      [
        ["text", "Reasoning Use norm "],
        ["inlineMath", "|x|"],
        ["text", " and "],
        ["inlineMath", "x^2"],
      ],
    ],
    [
      "  Lead   **bold**\n\n   *em*  `code`  \n\n- one\n-   two\n\n> quote\n> more\n\ntrail   ",
      [["text", "Lead bold em code one two quote more trail"]],
    ],
    [
      "$a$ starts, ends with $b$",
      [
        ["inlineMath", "a"],
        ["text", " starts, ends with "],
        ["inlineMath", "b"],
      ],
    ],
    [
      "before   $x$\n\n$$\ny\n$$\n\n   after",
      [
        ["text", "before "],
        ["inlineMath", "x"],
        ["text", " "],
        ["inlineMath", "y"],
        ["text", " after"],
      ],
    ],
    [
      "a *b*$c$**d** e",
      [
        ["text", "a b"],
        ["inlineMath", "c"],
        ["text", "d e"],
      ],
    ],
    [
      "$a$![](x.png)$b$",
      [
        ["inlineMath", "a"],
        ["text", ""],
        ["inlineMath", "b"],
      ],
    ],
    [
      "| a | b |\n| - | - |\n| $x$ | y  z |",
      [
        ["text", "a b "],
        ["inlineMath", "x"],
        ["text", " y z"],
      ],
    ],
    [
      'See [a  link](https://example.com "t") ![alt   text](img.png) <b>bold</b> <!-- c -->\n\n[ref]: https://example.com\n\n:::note\nbody\n:::',
      [["text", "See a link alt text bold :::note body :::"]],
    ],
    [
      "line one\r\nline two\r\n\r\nnext  nbsp　wide 😀𝑥 end",
      [["text", "line one line two next nbsp wide 😀𝑥 end"]],
    ],
    [
      `${"x".repeat(THOUGHT_PREVIEW_MAX_LENGTH - 1)}😀 tail`,
      [["text", "x".repeat(THOUGHT_PREVIEW_MAX_LENGTH - 1)]],
    ],
    ["\\$5 and \\$6, \\*not em\\*", [["text", "$5 and $6, *not em*"]]],
    ["hard  \nbreak\\\nagain", [["text", "hard break again"]]],
    ["<div>only html</div>", [["text", "Reasoning"]]],
  ])("keeps formulas while flattening compact reasoning previews: %j", (source, expected) => {
    const tree = parseMarkdownWithMath(source);
    remarkThoughtPreview("Reasoning")(tree);
    expect(tree.children.map((node) => [node.type, "value" in node ? node.value : null])).toEqual(
      expected,
    );
  });

  it("stops reading the tree once the preview is full", () => {
    const beyondCap = (): string => {
      throw new Error("read beyond cap");
    };
    const head = "x".repeat(THOUGHT_PREVIEW_MAX_LENGTH - 2);
    const tree: Root = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            { type: "text", value: head },
            { type: "strong", children: [{ type: "text", value: "yz beyond" }] },
            {
              type: "inlineMath",
              get value() {
                return beyondCap();
              },
            },
          ],
        },
        {
          type: "paragraph",
          children: [
            {
              type: "text",
              get value() {
                return beyondCap();
              },
            },
          ],
        },
      ],
    };
    remarkThoughtPreview("Reasoning")(tree);
    expect(tree.children).toEqual([{ type: "text", value: `${head}yz` }]);
  });
});

it("renders automatic compaction as one live divider that finishes with its reason and token delta", async () => {
  setup();
  const fixture = makeStreamingTimelineFixture();
  const prompt = fixture.visibleTurnItems[3]!;
  const assistant = fixture.visibleTurnItems[5]!;
  if (prompt.item.type !== "user_message" || assistant.item.type !== "assistant_message") {
    throw new Error("Expected streaming fixture messages");
  }
  const promptItem = prompt.item;
  const compaction = {
    ...assistant,
    item: {
      ...assistant.item,
      type: "compaction" as const,
      driver: null,
      beforeTokenCount: 899_000,
    },
  };
  const entries = (completed: boolean) =>
    deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: [
        {
          ...prompt,
          item: { ...promptItem, text: "/compact", idleCompaction: "beforeCacheExpires" },
        },
        {
          ...compaction,
          item: {
            ...compaction.item,
            status: completed ? "completed" : "running",
            afterTokenCount: completed ? 19_000 : undefined,
          },
        },
      ],
      optimisticMessages: [],
    });
  const props = baseProps();
  const ui = (completed: boolean) => (
    <MessagesTimeline
      {...props}
      timelineEntries={entries(completed)}
      isWorking={!completed}
      isCompacting={!completed}
      activeTurnStartedAt={fixture.time(5)}
      latestRun={{
        runId: fixture.runId,
        status: completed ? "completed" : "running",
        startedAt: fixture.time(5),
        completedAt: completed ? fixture.time(9) : null,
      }}
    />
  );
  const container = document.createElement("div");
  container.style.cssText = "height: 1200px; width: 900px; display: flex; flex-direction: column;";
  await using screen = await render(ui(false), { container });
  await expect
    .element(screen.getByRole("separator", { name: "Compacting before the cache expires…" }))
    .toBeVisible();
  expect(container.textContent).not.toContain("/compact");
  expect(container.textContent).not.toContain("Thinking");
  expect(container.textContent).not.toContain("Working");
  expect(container.querySelectorAll('[role="separator"]')).toHaveLength(1);
  await screen.rerender(ui(true));
  await expect
    .element(
      screen.getByRole("separator", {
        name: "Context automatically compacted before cache expiry 899K → 19K tokens",
      }),
    )
    .toBeVisible();
  expect(container.querySelectorAll('[role="separator"]')).toHaveLength(1);
  expect(container.textContent).not.toContain("Compacting before");
});

function TimelineChangedFilesCard() {
  const [expanded, setExpanded] = useState(true);
  return (
    <ChangedFilesCard
      runId={RunId.make("run-1")}
      files={["src/a.ts", "src/b.ts", "src/c.ts"].map((path) => ({
        path,
        kind: "modified",
        additions: 1,
        deletions: 0,
      }))}
      totals={{ count: 3, additions: 3, deletions: 0 }}
      allDirectoriesExpanded={expanded}
      resolvedTheme="light"
      onToggleAllDirectories={() => setExpanded((value) => !value)}
      onOpenTurnDiff={() => {}}
    />
  );
}

function ChangedFilesTimeline() {
  return (
    <LegendList
      data={["files", "after"]}
      keyExtractor={(item) => item}
      estimatedItemSize={100}
      recycleItems={false}
      className="h-[600px]"
      renderItem={({ item }) =>
        item === "files" ? <TimelineChangedFilesCard /> : <div data-testid="after">After</div>
      }
    />
  );
}

describe("ChangedFilesCard", () => {
  it.each(["folder", "all folders"])(
    "measures %s collapse and expansion in the same commit",
    async (toggle) => {
      await using screen = await render(<ChangedFilesTimeline />);
      const after = () =>
        screen.container.querySelector('[data-testid="after"]')!.getBoundingClientRect().top;
      const cardBottom = () =>
        screen.container.querySelector("[data-changed-files-state]")!.getBoundingClientRect()
          .bottom;
      await vi.waitFor(() => expect(after()).toBe(cardBottom()));
      const topBefore = after();
      const button = () =>
        screen.container.querySelector<HTMLButtonElement>(
          toggle === "folder"
            ? '[data-changed-file-row="src"] button'
            : 'button[aria-label$="all folders"]',
        )!;
      await act(() => {
        flushSync(() => button().click());
        expect(screen.container.textContent).not.toContain("a.ts");
        expect(after()).toBe(topBefore - 3 * 28);
      });
      await act(() => {
        flushSync(() => button().click());
        expect(screen.container.textContent).toContain("a.ts");
        expect(after()).toBe(topBefore);
      });
    },
  );
});

it("keeps concurrent approvals actionable outside collapsed work and restores settled rows", async () => {
  setup();
  const fixture = makeStreamingTimelineFixture();
  const source = fixture.visibleTurnItems[4]!;
  if (source.item.type !== "dynamic_tool") throw new Error("Expected fixture tool");
  const sourceItem = source.item;
  const commandRequest = RuntimeRequestId.make("command-approval");
  const appRequest = RuntimeRequestId.make("app-approval");
  const approvals: PendingApproval[] = [
    {
      requestId: commandRequest,
      requestKind: "command",
      createdAt: fixture.time(6),
      detail: "printf '" + "long-command ".repeat(80) + "'",
      reason: "Needs permission to run the command",
      fullAccessOverride: "ask_rule",
      responseCapability: "live",
    },
    {
      requestId: appRequest,
      requestKind: "permission",
      createdAt: fixture.time(6),
      detail: "Open the current tab",
      appName: "Safari",
      options: [
        { decision: "decline", label: "Deny" },
        { decision: "accept", label: "Allow once" },
        {
          decision: "acceptAlways",
          label: "Always allow Safari",
          warning: "Applies to future requests",
        },
      ],
      responseCapability: "live",
    },
  ];
  const entries = (completed = false) =>
    deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: [
        { ...source, item: { ...sourceItem, status: completed ? "completed" : sourceItem.status } },
        ...approvals.map((approval, index) => ({
          ...source,
          position: source.position + index + 1,
          sourceItemId: TurnItemId.make(`approval-${index}`),
          item: {
            ...sourceItem,
            id: TurnItemId.make(`approval-${index}`),
            type: "approval_request" as const,
            status: completed ? ("completed" as const) : ("waiting" as const),
            requestId: approval.requestId,
            requestKind: approval.requestKind,
            prompt: approval.detail,
          },
        })),
      ],
      optimisticMessages: [],
    });
  const props = baseProps();
  const onRespondToApproval = vi.fn(async () => {});
  const ui = (overrides: Partial<TimelineProps> = {}) => (
    <MessagesTimeline
      {...props}
      timelineEntries={entries()}
      pendingApprovals={approvals}
      canOperateThread
      onRespondToApproval={onRespondToApproval}
      isWorking
      runningRunId={fixture.runId}
      {...overrides}
    />
  );
  await using screen = await renderElement(ui());
  await expect.element(screen.getByRole("group", { name: "Command approval" })).toBeVisible();
  await expect
    .element(screen.getByRole("group", { name: "App permission approval" }))
    .toBeVisible();
  await expect.element(screen.getByText(approvals[0]!.detail!, { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Needs permission to run the command")).toBeVisible();
  await vi.waitFor(() => {
    expect(
      getComputedStyle(screen.getByLabelText("Command", { exact: true }).element()).userSelect,
    ).toBe("text");
    expect(
      getComputedStyle(screen.getByText("Needs permission to run the command").element())
        .userSelect,
    ).toBe("text");
  });
  await expect.element(screen.getByText("Safari", { exact: true })).toBeVisible();
  await click(screen.button("Why am I being asked this?"));
  await expect.element(page.getByText(/an ask rule in the agent's own settings/)).toBeVisible();
  await click(screen.button("Why am I being asked this?"));
  await click(screen.buttons("More approval options")[1]!);
  await expect.element(page.getByRole("menuitem", { name: "Always allow Safari" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Always allow Safari" }).click();
  expect(onRespondToApproval).toHaveBeenLastCalledWith(appRequest, "acceptAlways");
  await click(screen.buttons("More approval options")[0]!);
  await expect.element(page.getByRole("menuitem", { name: "Cancel", exact: true })).toBeVisible();
  await page.getByRole("menuitem", { name: "Always allow this session" }).click();
  expect(onRespondToApproval).toHaveBeenLastCalledWith(commandRequest, "acceptForSession");
  await click(screen.button("Decline"));
  expect(onRespondToApproval).toHaveBeenLastCalledWith(commandRequest, "decline");
  await click(screen.button("Allow once"));
  expect(onRespondToApproval).toHaveBeenLastCalledWith(appRequest, "accept");
  for (const timelineEntries of [entries(), []]) {
    await screen.rerender(
      ui({ timelineEntries, heldApprovalRequestIds: new Set([commandRequest]) }),
    );
    await expect
      .element(screen.getByRole("group", { name: "Command approval" }))
      .not.toBeInTheDocument();
    await vi.waitFor(() => expect(screen.buttons("Approve")).toHaveLength(0));
    await expect
      .element(screen.getByRole("button", { name: "Allow once", exact: true }))
      .toBeVisible();
    await screen.rerender(ui({ timelineEntries }));
    await expect.element(screen.getByRole("group", { name: "Command approval" })).toBeVisible();
    await vi.waitFor(() => expect(screen.buttons("Approve")).toHaveLength(1));
  }
  await screen.rerender(ui({ timelineEntries: [], isWorking: false }));
  await expect.element(screen.getByRole("group", { name: "Command approval" })).toBeVisible();
  await click(screen.button("Approve"));
  expect(onRespondToApproval).toHaveBeenLastCalledWith(commandRequest, "accept");
  await click(screen.button("Deny"));
  expect(onRespondToApproval).toHaveBeenLastCalledWith(appRequest, "decline");
  await screen.rerender(
    ui({
      timelineEntries: [],
      isWorking: false,
      pendingApprovals: [{ ...approvals[0]!, detail: "" }],
    }),
  );
  await expect
    .element(screen.getByLabelText("Command", { exact: true }))
    .toHaveTextContent("Command approval");
  await screen.rerender(ui({ canOperateThread: false }));
  await expect.element(screen.getByRole("button", { name: "Approve", exact: true })).toBeDisabled();
  await vi.waitFor(() =>
    expect(
      screen.buttons("More approval options").every((button) => button.hasAttribute("disabled")),
    ).toBe(true),
  );
  await screen.rerender(ui({ respondingRequestIds: [commandRequest] }));
  await expect.element(screen.getByRole("button", { name: "Approve", exact: true })).toBeDisabled();
  await expect
    .element(screen.getByRole("button", { name: "Allow once", exact: true }))
    .toBeEnabled();
  await screen.rerender(
    ui({ pendingApprovals: [{ ...approvals[0]!, responseCapability: "not_resumable" }] }),
  );
  await expect
    .element(screen.getByText("Provider process is gone. Interrupt or restart the run to respond."))
    .toBeVisible();
  await vi.waitFor(() => expect(screen.buttons("Approve")).toHaveLength(0));
  await screen.rerender(
    ui({ pendingApprovals: [], timelineEntries: entries(true), isWorking: false }),
  );
  await expect
    .element(screen.getByRole("group", { name: "Command approval" }))
    .not.toBeInTheDocument();
  await vi.waitFor(() => expect(screen.text()).not.toContain("Waiting for approval"));
  await screen.getByRole("button", { expanded: false }).click();
  await expect
    .element(screen.getByRole("button", { name: approvals[0]!.detail!, exact: true }))
    .toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Open the current tab", exact: true }))
    .toBeVisible();
});
