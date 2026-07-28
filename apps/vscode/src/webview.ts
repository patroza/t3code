/* oxlint-disable unicorn/require-post-message-target-origin -- VS Code's postMessage API has no targetOrigin argument. */
// @effect-diagnostics globalDate:off globalTimers:off
import DOMPurify from "dompurify";
import { marked } from "marked";
import type {
  AiUsageSnapshot,
  AiUsageWindow,
  ServerHostResourceSnapshot,
} from "@t3tools/contracts";
import {
  formatHostResourceBytes,
  formatHostResourcePercent,
  getHostResourceMetrics,
  getHostResourceRatioPressure,
} from "@t3tools/client-runtime/state/hostResourcePresentation";
import {
  EMPTY_COMPOSER_INPUT_HISTORY,
  navigateComposerInputHistory,
  pushComposerInputHistory,
  recallComposerInputHistory,
  resolveComposerInputHistoryKeyAction,
  seedComposerInputHistoryFromConversation,
  type ComposerInputHistoryState,
} from "@t3tools/shared/composerInputHistory";
import type { ChangeRequestIndicator } from "@t3tools/shared/sourceControl";

import { conversationRenderRevision } from "./conversationRevision.ts";
import { splitEditorContext } from "./editorContext.ts";
import { compareModelUsage, usageForModel } from "./usagePresentation.ts";
import { renderProviderIcon } from "./providerIcon.ts";

interface VsCodeApi {
  readonly postMessage: (message: unknown) => void;
}

declare function acquireVsCodeApi(): VsCodeApi;

interface ViewThread {
  readonly id: string;
  readonly title: string;
  readonly model: string;
  readonly status: ThreadDisplayStatus;
}

interface ThreadDisplayStatus {
  readonly kind:
    | "working"
    | "completed"
    | "needs-wake-up"
    | "connecting"
    | "needs-attention"
    | "plan-ready"
    | "error"
    | "ready";
  readonly label: string;
}

interface ViewProposedPlan {
  readonly id: string;
  readonly planMarkdown: string;
  readonly createdAt: string;
  readonly implementedAt: string | null;
}

interface ViewActiveProposedPlan {
  readonly id: string;
  readonly planMarkdown: string;
  readonly title: string;
  readonly createdAt: string;
}

interface ViewQueuedMessage {
  readonly messageId: string;
  readonly text: string;
  readonly attachmentCount: number;
  readonly queuedAt: string;
}

interface ViewMessage {
  readonly id: string;
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
  readonly streaming: boolean;
  readonly createdAt: string;
  readonly attachments: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly mimeType: string;
    readonly previewUrl: string | null;
  }>;
}

interface ViewToolCall {
  readonly id: string;
  readonly createdAt: string;
  readonly title: string;
  readonly itemType: string | null;
  readonly status: "running" | "completed" | "failed" | "stopped";
  readonly preview: string | null;
  readonly detail: string | null;
  readonly changedFiles: ReadonlyArray<string>;
}

interface ViewResolvedUserInput {
  readonly activityId: string;
  readonly createdAt: string;
  readonly answers: ReadonlyArray<{
    readonly header: string;
    readonly question: string;
    readonly answer: string;
  }>;
}

interface ViewPendingApproval {
  readonly kind: "approval";
  readonly requestId: string;
  readonly requestKind: "command" | "file-read" | "file-change";
  readonly detail: string | null;
}

interface ViewPendingUserInput {
  readonly kind: "user-input";
  readonly requestId: string;
  readonly questions: ReadonlyArray<{
    readonly id: string;
    readonly header: string;
    readonly question: string;
    readonly multiSelect?: boolean;
    readonly options: ReadonlyArray<{ readonly label: string; readonly description: string }>;
  }>;
}

interface ViewState {
  readonly busy: boolean;
  readonly error: string | null;
  readonly connected: boolean;
  readonly environmentLabel: string;
  readonly changeRequest: ChangeRequestIndicator | null;
  readonly threads: ReadonlyArray<ViewThread>;
  readonly activeThread: null | {
    readonly id: string;
    readonly instanceId: string;
    readonly model: string;
    readonly options?: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }>;
    readonly interactionMode: "default" | "plan";
    readonly status: ThreadDisplayStatus;
    readonly turnStartedAt: string | null;
    readonly contextWindow: null | {
      readonly usedTokens: number;
      readonly maxTokens: number | null;
      readonly usedPercentage: number | null;
      readonly totalProcessedTokens: number | null;
      readonly compactsAutomatically: boolean;
    };
    readonly messages: ReadonlyArray<ViewMessage>;
    readonly toolCalls: ReadonlyArray<ViewToolCall>;
    readonly resolvedUserInputs: ReadonlyArray<ViewResolvedUserInput>;
    readonly pendingInteractions: ReadonlyArray<ViewPendingApproval | ViewPendingUserInput>;
    readonly showPlanFollowUp: boolean;
    readonly activeProposedPlan: ViewActiveProposedPlan | null;
    readonly queuedMessages: ReadonlyArray<ViewQueuedMessage>;
    readonly proposedPlans: ReadonlyArray<ViewProposedPlan>;
    readonly tasks: null | {
      readonly explanation: string | null;
      readonly createdAt: string;
      readonly tasks: ReadonlyArray<{
        readonly step: string;
        readonly status: "pending" | "inProgress" | "completed";
      }>;
    };
  };
  readonly models: ReadonlyArray<{
    readonly instanceId: string;
    readonly model: string;
    readonly driver: string;
    readonly providerLabel: string;
    readonly modelLabel: string;
    readonly optionDescriptors: ReadonlyArray<
      | {
          readonly id: string;
          readonly label: string;
          readonly type: "select";
          readonly currentValue?: string;
          readonly options: ReadonlyArray<{
            readonly id: string;
            readonly label: string;
            readonly isDefault?: boolean;
          }>;
        }
      | {
          readonly id: string;
          readonly label: string;
          readonly type: "boolean";
          readonly currentValue?: boolean;
        }
    >;
  }>;
  readonly aiUsage: AiUsageSnapshot | null;
  readonly favoriteProviderIds: ReadonlyArray<string>;
  readonly favoriteModelKeys: ReadonlyArray<string>;
  readonly contextEnabled: boolean;
  readonly editorContext: null | {
    readonly path: string;
    readonly startLine: number;
    readonly endLine: number;
    readonly kind: "selection" | "cursor-line" | "reference";
  };
}

const vscode = acquireVsCodeApi();
const threads = requiredElement<HTMLSelectElement>("threads");
const messages = requiredElement<HTMLElement>("messages");
const newActivity = requiredElement<HTMLButtonElement>("new-activity");
const newActivityDot = requiredElement<HTMLElement>("new-activity-dot");
const newActivityLabel = requiredElement<HTMLElement>("new-activity-label");
const threadActions = requiredElement<HTMLDetailsElement>("thread-actions");
const archiveThread = requiredElement<HTMLButtonElement>("archive-thread");
const visitT3 = requiredElement<HTMLButtonElement>("visit-t3");
const status = requiredElement<HTMLElement>("status");
const queuedMessages = requiredElement<HTMLElement>("queued-messages");
const prompt = requiredElement<HTMLTextAreaElement>("prompt");
const slashCommands = requiredElement<HTMLElement>("slash-commands");
const send = requiredElement<HTMLButtonElement>("send");
const pendingAttachments = requiredElement<HTMLElement>("pending-attachments");
const pendingInteractions = requiredElement<HTMLElement>("pending-interactions");
const stashControl = requiredElement<HTMLDetailsElement>("stash-control");
const stashNow = requiredElement<HTMLButtonElement>("stash-now");
const stashPopup = requiredElement<HTMLElement>("stash-popup");
const stashCount = requiredElement<HTMLElement>("stash-count");
const planReady = requiredElement<HTMLElement>("plan-ready");
const interactionModeSelect = requiredElement<HTMLSelectElement>("interaction-mode");
const contextButton = requiredElement<HTMLButtonElement>("context");
const contextLabel = requiredElement<HTMLElement>("context-label");
const contextWindowMeter = requiredElement<HTMLButtonElement>("context-window");
const contextWindowLabel = requiredElement<HTMLElement>("context-window-label");
const changeRequest = requiredElement<HTMLButtonElement>("change-request");
const changeRequestLabel = requiredElement<HTMLElement>("change-request-label");
const hostResourcesControl = requiredElement<HTMLElement>("host-resources-control");
const hostResourcesToggle = requiredElement<HTMLButtonElement>("host-resources-toggle");
const hostResourcesDetails = requiredElement<HTMLElement>("host-resources-details");
const provider = requiredElement<HTMLSelectElement>("provider");
const providerIcon = requiredElement<HTMLElement>("provider-icon");
const favoriteProvider = requiredElement<HTMLButtonElement>("favorite-provider");
const model = requiredElement<HTMLSelectElement>("model");
const favoriteModel = requiredElement<HTMLButtonElement>("favorite-model");
const modelOptions = requiredElement<HTMLElement>("model-options");
const usageDetails = requiredElement<HTMLElement>("usage-details");
const tasksDetails = requiredElement<HTMLElement>("tasks-details");
const tasksLabel = requiredElement<HTMLElement>("tasks-label");
let currentState: ViewState | null = null;
let promptFocusToRestore: { readonly start: number; readonly end: number } | null = null;
let composerInteractionMode: "default" | "plan" = "default";
let draftSelection: null | {
  instanceId: string;
  model: string;
  options: Array<{ id: string; value: string | boolean }>;
} = null;
interface PendingImage {
  readonly key: string;
  readonly type: "image";
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly dataUrl: string;
}
let pendingImages: PendingImage[] = [];
let usageExpanded = false;
let tasksExpanded = false;
let hasUnreadActivity = false;
let renderedConversationRevision: string | null = null;
let followEndAfterSubmit = false;
let selectedSlashCommand = 0;
/** Prompt history keyed by active thread id (or draft key). Not shared across threads. */
const inputHistoryByScopeKey = new Map<string, ComposerInputHistoryState>();
let inputHistoryScopeKey = "__none__";
let inputHistory: ComposerInputHistoryState = EMPTY_COMPOSER_INPUT_HISTORY;
let editingQueuedMessage: { readonly messageId: string; readonly previousDraft: string } | null =
  null;
interface PromptStashEntry {
  readonly id: string;
  readonly createdAt: string;
  readonly prompt: string;
  readonly images: ReadonlyArray<Omit<PendingImage, "key">>;
  readonly droppedImageNames: ReadonlyArray<string>;
  readonly providerInstanceId: string | null;
  readonly modelSelection: null | {
    readonly instanceId: string;
    readonly model: string;
    readonly options?: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }>;
  };
  readonly interactionMode: "default" | "plan";
}
let promptStash: ReadonlyArray<PromptStashEntry> = [];
let pendingStash: { readonly prompt: string; readonly imageKeys: ReadonlyArray<string> } | null =
  null;

function restoreDraftAfterQueuedEdit(): void {
  if (editingQueuedMessage === null) return;
  prompt.value = editingQueuedMessage.previousDraft;
  editingQueuedMessage = null;
  inputHistory = {
    entries: inputHistory.entries,
    browsingIndex: null,
    stashedDraft: "",
  };
  persistInputHistory(inputHistoryScopeKey, inputHistory);
  renderComposerAction();
}

function editQueuedMessage(messageId: string, text: string): void {
  const previousDraft = editingQueuedMessage?.previousDraft ?? prompt.value;
  editingQueuedMessage = { messageId, previousDraft };
  inputHistory = recallComposerInputHistory(inputHistory, text, previousDraft);
  persistInputHistory(inputHistoryScopeKey, inputHistory);
  prompt.value = text;
  prompt.focus();
  prompt.setSelectionRange(text.length, text.length);
  renderComposerAction();
}

function inputHistoryKeyForState(state: ViewState | null): string {
  if (state?.activeThread?.id) {
    return `thread:${state.activeThread.id}`;
  }
  if (draftSelection !== null) {
    return `draft:${draftSelection.instanceId}:${draftSelection.model}`;
  }
  return "__none__";
}

function persistInputHistory(scopeKey: string, history: ComposerInputHistoryState): void {
  if (
    history.entries.length === 0 &&
    history.browsingIndex === null &&
    history.stashedDraft.length === 0
  ) {
    inputHistoryByScopeKey.delete(scopeKey);
    return;
  }
  inputHistoryByScopeKey.set(scopeKey, history);
}

function switchInputHistoryScope(nextKey: string): void {
  if (nextKey === inputHistoryScopeKey) return;
  if (inputHistory.browsingIndex !== null) {
    // Restore temporary draft for the thread we're leaving so it is never lost.
    prompt.value = inputHistory.stashedDraft;
    inputHistory = {
      entries: inputHistory.entries,
      browsingIndex: null,
      stashedDraft: "",
    };
  }
  persistInputHistory(inputHistoryScopeKey, inputHistory);
  inputHistoryScopeKey = nextKey;
  inputHistory = inputHistoryByScopeKey.get(nextKey) ?? EMPTY_COMPOSER_INPUT_HISTORY;
}

const pendingAnswers = new Map<string, Record<string, string | string[]>>();
const submittedAnswers = new Map<
  string,
  Readonly<Record<string, string | ReadonlyArray<string>>>
>();
const submittedApprovals = new Map<string, string>();

const COMMANDS = [
  { name: "/new", description: "Start a new synchronized thread" },
  { name: "/threads", description: "Choose a worktree thread" },
  { name: "/model", description: "Choose the active model" },
  { name: "/plan", description: "Switch to plan mode" },
  { name: "/default", description: "Switch to build mode" },
  { name: "/context", description: "Include or exclude editor context" },
  { name: "/stop", description: "Stop the active turn" },
] as const;

marked.setOptions({
  gfm: true,
  breaks: false,
});

function requiredElement<A extends HTMLElement>(id: string): A {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`Missing webview element #${id}.`);
  return element as A;
}

function post(message: unknown): void {
  vscode.postMessage(message);
}

function stashProviderInstanceId(): string | null {
  return currentState === null ? null : (currentSelection(currentState)?.instanceId ?? null);
}

function requestPromptStash(): void {
  post({ type: "listPromptStash", providerInstanceId: stashProviderInstanceId() });
}

function renderPromptStash(): void {
  stashCount.textContent = String(promptStash.length);
  stashPopup.replaceChildren();
  if (promptStash.length === 0) {
    const empty = document.createElement("div");
    empty.className = "stash-empty";
    empty.textContent = "No stashed prompts for this provider.";
    stashPopup.append(empty);
    return;
  }
  for (const entry of promptStash) {
    const row = document.createElement("div");
    row.className = "stash-entry";
    const restore = document.createElement("button");
    restore.className = "stash-restore";
    restore.title = "Restore and remove from stash";
    const preview = document.createElement("span");
    preview.className = "stash-preview";
    preview.textContent = entry.prompt.trim() || `${entry.images.length} image(s)`;
    const meta = document.createElement("span");
    meta.className = "stash-meta";
    const dropped =
      entry.droppedImageNames.length === 0
        ? ""
        : ` · ${entry.droppedImageNames.length} image(s) omitted`;
    meta.textContent = `${new Date(entry.createdAt).toLocaleString()}${dropped}`;
    restore.append(preview, meta);
    restore.addEventListener("click", () => post({ type: "restorePromptStash", id: entry.id }));
    const remove = document.createElement("button");
    remove.className = "stash-remove";
    remove.textContent = "×";
    remove.title = "Delete stashed prompt";
    remove.addEventListener("click", () =>
      post({
        type: "removePromptStash",
        id: entry.id,
        providerInstanceId: stashProviderInstanceId(),
      }),
    );
    row.append(restore, remove);
    stashPopup.append(row);
  }
}

function stashCurrentPrompt(): void {
  if (editingQueuedMessage !== null || !hasComposerInput() || currentState === null) return;
  const selection = currentSelection(currentState);
  const images = uploadImages();
  pendingStash = { prompt: prompt.value, imageKeys: pendingImages.map((image) => image.key) };
  post({
    type: "stashPrompt",
    prompt: prompt.value,
    images,
    providerInstanceId: selection?.instanceId ?? null,
    modelSelection: selection,
    interactionMode: composerInteractionMode,
  });
}

function emptyMessage(text: string): HTMLElement {
  const element = document.createElement("div");
  element.className = "empty";
  element.textContent = text;
  return element;
}

function formatTokens(value: number | null): string {
  if (value === null) return "?";
  if (value < 1_000) return `${Math.round(value)}`;
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/u, "")}m`;
}

function formatReset(resetsAt: number | null | undefined): string {
  if (typeof resetsAt !== "number") return "";
  const remainingMinutes = Math.max(0, Math.round((resetsAt * 1_000 - Date.now()) / 60_000));
  if (remainingMinutes === 0) return "resetting";
  const days = Math.floor(remainingMinutes / 1_440);
  const hours = Math.floor((remainingMinutes % 1_440) / 60);
  const minutes = remainingMinutes % 60;
  if (days > 0) return `resets in ${days}d ${hours}h`;
  if (hours > 0) return `resets in ${hours}h ${minutes}m`;
  return `resets in ${minutes}m`;
}

function usageWindowValue(window: AiUsageWindow): string {
  if (typeof window.percent === "number") return `${Math.round(window.percent)}%`;
  if (typeof window.used === "number") {
    return window.unit === "$" ? `$${window.used.toFixed(2)}` : `${window.used}`;
  }
  return "—";
}

function modelFavoriteKey(instanceId: string, modelSlug: string): string {
  return `${instanceId}:${modelSlug}`;
}

function favoritesFirst<A>(items: ReadonlyArray<A>, isFavorite: (item: A) => boolean): A[] {
  return items
    .map((item, index) => ({ item, index, favorite: isFavorite(item) }))
    .toSorted(
      (left, right) => Number(right.favorite) - Number(left.favorite) || left.index - right.index,
    )
    .map(({ item }) => item);
}

function formatElapsed(startedAt: string, nowMs: number): string | null {
  const startMs = Date.parse(startedAt);
  if (!Number.isFinite(startMs)) return null;
  const totalSeconds = Math.max(0, Math.floor((nowMs - startMs) / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function renderMarkdown(text: string): HTMLElement {
  const content = document.createElement("div");
  content.className = "content markdown-body";
  const parsed = marked.parse(text, { async: false });
  content.innerHTML = DOMPurify.sanitize(parsed, {
    USE_PROFILES: { html: true },
    ADD_ATTR: ["target", "rel"],
  });

  for (const anchor of content.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    anchor.rel = "noreferrer noopener";
    anchor.addEventListener("click", (event) => {
      event.preventDefault();
      post({ type: "openLink", href: anchor.getAttribute("href") ?? "" });
    });
  }

  for (const code of content.querySelectorAll<HTMLElement>("code:not(pre code)")) {
    const href = code.textContent?.trim() ?? "";
    if (!/^https?:\/\/\S+$/iu.test(href)) continue;
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.rel = "noreferrer noopener";
    anchor.className = "inline-code-link";
    anchor.addEventListener("click", (event) => {
      event.preventDefault();
      post({ type: "openLink", href });
    });
    code.before(anchor);
    anchor.append(code);
  }

  for (const pre of content.querySelectorAll<HTMLPreElement>("pre")) {
    const code = pre.querySelector("code");
    if (code === null) continue;
    const wrapper = document.createElement("div");
    wrapper.className = "code-block";
    const header = document.createElement("div");
    header.className = "code-header";
    const language = [...code.classList]
      .find((name) => name.startsWith("language-"))
      ?.slice("language-".length);
    const label = document.createElement("span");
    label.textContent = language ?? "code";
    const copy = document.createElement("button");
    copy.className = "copy-code";
    copy.textContent = "Copy";
    copy.title = "Copy code";
    copy.addEventListener("click", () => {
      post({ type: "copyText", text: code.textContent ?? "" });
      copy.textContent = "Copied";
      globalThis.setTimeout(() => {
        copy.textContent = "Copy";
      }, 1_200);
    });
    header.append(label, copy);
    pre.before(wrapper);
    wrapper.append(header, pre);
  }

  for (const table of content.querySelectorAll<HTMLTableElement>("table")) {
    const wrapper = document.createElement("div");
    wrapper.className = "table-scroll";
    table.before(wrapper);
    wrapper.append(table);
  }
  return content;
}

function renderMessage(message: ViewMessage): HTMLElement {
  const wrapper = document.createElement("article");
  wrapper.className = `message ${message.role}`;
  wrapper.setAttribute("aria-label", `${message.role} message`);
  const parsedContext = splitEditorContext(message.text);
  const attachmentOnlyText = parsedContext.text.startsWith(
    "[User attached one or more images without additional text.",
  );
  const content = renderMarkdown(
    attachmentOnlyText && message.attachments.length > 0 ? "" : parsedContext.text,
  );
  if (message.streaming) content.classList.add("streaming");
  wrapper.append(content);
  if (parsedContext.references.length > 0) {
    const references = document.createElement("div");
    references.className = "context-references";
    for (const reference of parsedContext.references) {
      const chip = document.createElement("button");
      chip.className = "context-reference";
      chip.textContent = `▱ ${reference.path} · ${reference.detail}`;
      chip.title = `Open ${reference.path}`;
      chip.addEventListener("click", () =>
        post({ type: "openEditorContext", path: reference.path, detail: reference.detail }),
      );
      references.append(chip);
    }
    wrapper.append(references);
  }
  if (message.attachments.length > 0) {
    const attachments = document.createElement("div");
    attachments.className = "attachments";
    for (const attachment of message.attachments) {
      const link = document.createElement("a");
      link.className = "attachment";
      link.title = attachment.name;
      if (attachment.previewUrl !== null) {
        link.href = attachment.previewUrl;
        link.addEventListener("click", (event) => {
          event.preventDefault();
          post({ type: "openLink", href: attachment.previewUrl });
        });
        const image = document.createElement("img");
        image.src = attachment.previewUrl;
        image.alt = attachment.name;
        image.loading = "lazy";
        link.append(image);
      }
      const name = document.createElement("span");
      name.className = "attachment-name";
      name.textContent =
        attachment.previewUrl === null ? `Loading ${attachment.name}…` : attachment.name;
      link.append(name);
      attachments.append(link);
    }
    wrapper.append(attachments);
  }
  return wrapper;
}

function toolIcon(itemType: string | null): string {
  if (itemType === "command_execution") return ">_";
  if (itemType === "file_change") return "±";
  if (itemType === "web_search") return "⌕";
  if (itemType === "image_view") return "◉";
  return "⌘";
}

function renderToolCall(tool: ViewToolCall): HTMLElement {
  const wrapper = document.createElement("details");
  wrapper.className = `tool-call ${tool.status}`;
  wrapper.open = false;
  const summary = document.createElement("summary");
  const icon = document.createElement("span");
  icon.className = "tool-call-icon";
  icon.textContent = toolIcon(tool.itemType);
  const title = document.createElement("span");
  title.className = "tool-call-title";
  title.textContent = tool.title;
  const preview = document.createElement("span");
  preview.className = "tool-call-preview";
  preview.textContent = tool.preview === null ? "" : ` · ${tool.preview.replace(/\s+/gu, " ")}`;
  const state = document.createElement("span");
  state.className = "tool-call-state";
  state.textContent =
    tool.status === "completed"
      ? "✓"
      : tool.status === "running"
        ? "●"
        : tool.status === "stopped"
          ? "■"
          : "×";
  summary.append(icon, title, preview, state);
  wrapper.append(summary);
  if (tool.detail !== null) {
    const detail = document.createElement("pre");
    detail.className = "tool-call-detail";
    detail.textContent = tool.detail;
    wrapper.append(detail);
  }
  if (tool.changedFiles.length > 0) {
    const files = document.createElement("div");
    files.className = "tool-changed-files";
    for (const path of tool.changedFiles) {
      const button = document.createElement("button");
      button.className = "tool-changed-file";
      button.title = `Open ${path}`;
      button.textContent = path;
      button.addEventListener("click", () =>
        post({ type: "openEditorContext", path, detail: "changed file" }),
      );
      files.append(button);
    }
    wrapper.append(files);
  }
  if (tool.detail === null && tool.changedFiles.length === 0) {
    wrapper.classList.add("not-expandable");
    summary.addEventListener("click", (event) => event.preventDefault());
  }
  return wrapper;
}

function renderToolCallGroup(tools: ReadonlyArray<ViewToolCall>): HTMLElement {
  if (tools.length === 1) return renderToolCall(tools[0]!);
  const group = document.createElement("details");
  group.className = "tool-call-group";
  // Tool output is intentionally opt-in. Live status updates rebuild the
  // timeline, so never infer expansion from running state or viewport entry.
  group.open = false;
  const summary = document.createElement("summary");
  const running = tools.filter((tool) => tool.status === "running").length;
  const failed = tools.filter((tool) => tool.status === "failed").length;
  const state = running > 0 ? `${running} running` : failed > 0 ? `${failed} failed` : "Completed";
  summary.textContent = `${tools.length} tool calls · ${state}`;
  const body = document.createElement("div");
  body.className = "tool-call-group-body";
  body.append(...tools.map(renderToolCall));
  group.append(summary, body);
  return group;
}

function renderResolvedUserInput(input: ViewResolvedUserInput): HTMLElement {
  const wrapper = document.createElement("section");
  wrapper.className = "message user user-input-response";
  wrapper.setAttribute("aria-label", "Your answers");

  for (const entry of input.answers) {
    const answer = document.createElement("div");
    answer.className = "user-input-response-item";
    const question = document.createElement("div");
    question.className = "user-input-response-question";
    question.textContent = entry.question;
    const value = document.createElement("div");
    value.className = "user-input-response-answer";
    value.textContent = entry.answer;
    answer.append(question, value);
    wrapper.append(answer);
  }
  return wrapper;
}

function approvalLabel(kind: ViewPendingApproval["requestKind"]): string {
  if (kind === "command") return "Command approval";
  if (kind === "file-read") return "File-read approval";
  return "File-change approval";
}

function renderApproval(interaction: ViewPendingApproval): HTMLElement {
  const card = document.createElement("section");
  card.className = "interaction-card approval-card";
  const heading = document.createElement("div");
  heading.className = "interaction-heading";
  heading.textContent = approvalLabel(interaction.requestKind);
  card.append(heading);
  const submitted = submittedApprovals.get(interaction.requestId);
  if (submitted !== undefined) {
    heading.textContent = "Approval response submitted";
    const detail = document.createElement("div");
    detail.className = "interaction-detail";
    detail.textContent = submitted;
    card.append(detail);
    return card;
  }
  if (interaction.detail !== null) {
    const detail = document.createElement("div");
    detail.className = "interaction-detail";
    detail.textContent = interaction.detail;
    card.append(detail);
  }
  const actions = document.createElement("div");
  actions.className = "interaction-actions";
  for (const [label, decision, className] of [
    ["Deny", "decline", ""],
    ["Allow for session", "acceptForSession", ""],
    ["Allow", "accept", "allow"],
  ] as const) {
    const button = document.createElement("button");
    button.textContent = label;
    button.className = className;
    button.addEventListener("click", () => {
      submittedApprovals.set(interaction.requestId, label);
      if (currentState !== null) renderPendingInteractions(currentState);
      post({ type: "approvalResponse", requestId: interaction.requestId, decision });
    });
    actions.append(button);
  }
  card.append(actions);
  return card;
}

function renderUserInput(interaction: ViewPendingUserInput): HTMLElement {
  const card = document.createElement("section");
  card.className = "interaction-card user-input-card";
  const heading = document.createElement("div");
  heading.className = "interaction-heading";
  heading.textContent = "Input requested";
  card.append(heading);
  const submitted = submittedAnswers.get(interaction.requestId);
  if (submitted !== undefined) {
    heading.textContent = "Input submitted";
    for (const question of interaction.questions) {
      const answer = submitted[question.id];
      const row = document.createElement("div");
      row.className = "interaction-detail";
      row.textContent = `${question.header}: ${Array.isArray(answer) ? answer.join(", ") : String(answer ?? "")}`;
      card.append(row);
    }
    return card;
  }
  const answers = pendingAnswers.get(interaction.requestId) ?? {};
  pendingAnswers.set(interaction.requestId, answers);
  for (const question of interaction.questions) {
    const group = document.createElement("fieldset");
    group.className = "interaction-question-group";
    const legend = document.createElement("legend");
    legend.textContent = question.header;
    const questionText = document.createElement("div");
    questionText.className = "interaction-question";
    questionText.textContent = question.question;
    group.append(legend, questionText);
    for (const option of question.options) {
      const label = document.createElement("label");
      label.className = "interaction-option";
      const input = document.createElement("input");
      input.type = question.multiSelect === true ? "checkbox" : "radio";
      input.name = `${interaction.requestId}:${question.id}`;
      const current = answers[question.id];
      input.checked = Array.isArray(current)
        ? current.includes(option.label)
        : current === option.label;
      input.addEventListener("change", () => {
        if (question.multiSelect === true) {
          const selected = Array.isArray(answers[question.id])
            ? [...(answers[question.id] as string[])]
            : [];
          answers[question.id] = input.checked
            ? [...new Set([...selected, option.label])]
            : selected.filter((value) => value !== option.label);
        } else if (input.checked) {
          answers[question.id] = option.label;
        }
      });
      const copy = document.createElement("span");
      copy.textContent = option.label;
      const description = document.createElement("small");
      description.textContent = option.description;
      copy.append(description);
      label.append(input, copy);
      group.append(label);
    }
    const custom = document.createElement("input");
    custom.className = "interaction-custom";
    custom.placeholder = "Other…";
    custom.value =
      typeof answers[question.id] === "string" &&
      !question.options.some((option) => option.label === answers[question.id])
        ? (answers[question.id] as string)
        : "";
    custom.addEventListener("input", () => {
      if (custom.value.trim() !== "") answers[question.id] = custom.value.trim();
      else delete answers[question.id];
    });
    group.append(custom);
    card.append(group);
  }
  const actions = document.createElement("div");
  actions.className = "interaction-actions";
  const submit = document.createElement("button");
  submit.className = "allow";
  submit.textContent = "Submit";
  submit.addEventListener("click", () => {
    const complete = interaction.questions.every((question) => {
      const answer = answers[question.id];
      return typeof answer === "string" ? answer.trim() !== "" : (answer?.length ?? 0) > 0;
    });
    if (!complete) return;
    submittedAnswers.set(interaction.requestId, { ...answers });
    if (currentState !== null) renderPendingInteractions(currentState);
    post({ type: "userInputResponse", requestId: interaction.requestId, answers });
  });
  actions.append(submit);
  card.append(actions);
  return card;
}

function renderPendingInteractions(state: ViewState): void {
  const activeIds = new Set(
    (state.activeThread?.pendingInteractions ?? []).map((interaction) => interaction.requestId),
  );
  for (const requestId of submittedAnswers.keys()) {
    if (!activeIds.has(requestId)) submittedAnswers.delete(requestId);
  }
  for (const requestId of submittedApprovals.keys()) {
    if (!activeIds.has(requestId)) submittedApprovals.delete(requestId);
  }
  pendingInteractions.replaceChildren(
    ...(state.activeThread?.pendingInteractions ?? []).map((interaction) =>
      interaction.kind === "approval" ? renderApproval(interaction) : renderUserInput(interaction),
    ),
  );
}

function renderTasks(state: ViewState): void {
  const presented = state.activeThread?.tasks ?? null;
  tasksDetails.replaceChildren();
  if (presented === null) {
    tasksLabel.textContent = "Tasks";
    const empty = document.createElement("div");
    empty.className = "tasks-empty";
    empty.textContent = "No task list for this thread yet.";
    tasksDetails.append(empty);
    return;
  }
  const completed = presented.tasks.filter((task) => task.status === "completed").length;
  tasksLabel.textContent = `Tasks ${completed}/${presented.tasks.length}`;
  if (presented.explanation !== null) {
    const explanation = document.createElement("div");
    explanation.className = "tasks-explanation";
    explanation.textContent = presented.explanation;
    tasksDetails.append(explanation);
  }
  const list = document.createElement("ol");
  list.className = "tasks-list";
  for (const task of presented.tasks) {
    const item = document.createElement("li");
    item.className = `task-item ${task.status}`;
    const icon = document.createElement("span");
    icon.className = "task-icon";
    icon.textContent = task.status === "completed" ? "✓" : task.status === "inProgress" ? "◔" : "·";
    const text = document.createElement("span");
    text.textContent = task.step;
    item.append(icon, text);
    list.append(item);
  }
  tasksDetails.append(list);
}

function isMessagesAtEnd(): boolean {
  return messages.scrollHeight - messages.scrollTop - messages.clientHeight <= 1;
}

function activityRevision(thread: ViewState["activeThread"]): string {
  if (thread === null) return "";
  const lastMessage = thread.messages.at(-1);
  return JSON.stringify({
    messageCount: thread.messages.length,
    lastMessage: lastMessage
      ? { id: lastMessage.id, text: lastMessage.text, streaming: lastMessage.streaming }
      : null,
    toolCalls: thread.toolCalls.map(({ id, status, preview, detail, changedFiles }) => ({
      id,
      status,
      preview,
      detail,
      changedFiles,
    })),
    resolvedUserInputCount: thread.resolvedUserInputs.length,
    lastResolvedUserInput: thread.resolvedUserInputs.at(-1) ?? null,
    proposedPlanCount: thread.proposedPlans.length,
    lastProposedPlan: thread.proposedPlans.at(-1) ?? null,
    queuedMessages: thread.queuedMessages,
  });
}

function conversationRevision(state: ViewState): string {
  return conversationRenderRevision({
    draft: draftSelection !== null,
    thread:
      state.activeThread === null
        ? null
        : {
            id: state.activeThread.id,
            messages: state.activeThread.messages,
            toolCalls: state.activeThread.toolCalls,
            resolvedUserInputs: state.activeThread.resolvedUserInputs,
            proposedPlans: state.activeThread.proposedPlans,
          },
  });
}

function syncNewActivityButton(): void {
  const atEnd = isMessagesAtEnd();
  if (atEnd) hasUnreadActivity = false;
  newActivity.hidden = atEnd;
  newActivityDot.hidden = !hasUnreadActivity;
  newActivityLabel.textContent = hasUnreadActivity ? "New activity" : "Scroll to latest";
  newActivity.setAttribute(
    "aria-label",
    hasUnreadActivity ? "New activity. Scroll to latest" : "Scroll to latest",
  );
}

function render(next: ViewState): void {
  const previous = currentState;
  const previousThreadId = previous?.activeThread?.id ?? null;
  const nextThreadId = next.activeThread?.id ?? null;
  const threadChanged = previousThreadId !== nextThreadId;
  const nextConversationRevision = conversationRevision(next);
  const conversationChanged = renderedConversationRevision !== nextConversationRevision;
  renderedConversationRevision = nextConversationRevision;
  const shouldFollowEnd = followEndAfterSubmit || threadChanged || isMessagesAtEnd();
  followEndAfterSubmit = false;
  const previousScrollTop = messages.scrollTop;
  if (
    !threadChanged &&
    !shouldFollowEnd &&
    activityRevision(previous?.activeThread ?? null) !== activityRevision(next.activeThread)
  ) {
    hasUnreadActivity = true;
  }
  if (threadChanged) hasUnreadActivity = false;
  currentState = next;
  threads.replaceChildren();
  if (draftSelection !== null) {
    const draft = document.createElement("option");
    draft.textContent = "New thread";
    draft.value = "__draft__";
    draft.selected = true;
    threads.append(draft);
    for (const thread of next.threads) {
      const option = document.createElement("option");
      option.value = thread.id;
      option.textContent = `${thread.title} · ${thread.status.label}`;
      threads.append(option);
    }
  } else if (next.threads.length === 0) {
    const option = document.createElement("option");
    option.textContent = "No threads for this worktree";
    option.value = "";
    threads.append(option);
  } else {
    for (const thread of next.threads) {
      const option = document.createElement("option");
      option.value = thread.id;
      option.textContent = `${thread.title} · ${thread.status.label}`;
      option.selected = thread.id === next.activeThread?.id;
      threads.append(option);
    }
  }
  threads.disabled = next.busy;
  if (next.activeThread !== null) {
    composerInteractionMode = next.activeThread.interactionMode;
  }
  switchInputHistoryScope(inputHistoryKeyForState(next));
  renderActiveStatus(next);
  renderPlanReady(next);
  renderPendingInteractions(next);
  renderTasks(next);
  renderComposerAction();

  if (conversationChanged) {
    messages.replaceChildren();
    if (draftSelection !== null) {
      messages.append(emptyMessage("Choose a provider and model, then send your first message."));
    } else if (
      next.activeThread === null ||
      (next.activeThread.messages.length === 0 &&
        next.activeThread.toolCalls.length === 0 &&
        next.activeThread.resolvedUserInputs.length === 0 &&
        next.activeThread.proposedPlans.length === 0)
    ) {
      messages.append(
        emptyMessage(
          next.activeThread === null
            ? "Create or select a thread for this worktree."
            : "Start a conversation in this synchronized thread.",
        ),
      );
    } else {
      const timeline = [
        ...next.activeThread.messages.map((message) => ({
          kind: "message" as const,
          createdAt: message.createdAt,
          order: 0,
          element: renderMessage(message),
        })),
        ...next.activeThread.toolCalls.map((tool) => ({
          kind: "tool" as const,
          createdAt: tool.createdAt,
          order: 1,
          tool,
        })),
        ...next.activeThread.resolvedUserInputs.map((input) => ({
          kind: "input" as const,
          createdAt: input.createdAt,
          order: 2,
          element: renderResolvedUserInput(input),
        })),
        ...next.activeThread.proposedPlans.map((plan) => ({
          kind: "plan" as const,
          createdAt: plan.createdAt,
          order: 1.5,
          element: renderProposedPlan(plan),
        })),
      ].toSorted(
        (left, right) => left.createdAt.localeCompare(right.createdAt) || left.order - right.order,
      );
      const elements: HTMLElement[] = [];
      for (let index = 0; index < timeline.length; index += 1) {
        const item = timeline[index]!;
        if (item.kind !== "tool") {
          elements.push(item.element);
          continue;
        }
        const tools = [item.tool];
        while (timeline[index + 1]?.kind === "tool") {
          index += 1;
          tools.push(
            (timeline[index] as Extract<(typeof timeline)[number], { kind: "tool" }>).tool,
          );
        }
        elements.push(renderToolCallGroup(tools));
      }
      messages.append(...elements);
    }
    messages.scrollTop = shouldFollowEnd ? messages.scrollHeight : previousScrollTop;
  }
  syncNewActivityButton();

  const editorContext = next.editorContext;
  contextButton.classList.toggle("excluded", !next.contextEnabled);
  contextButton.title = next.contextEnabled
    ? "Exclude active editor context"
    : "Include active editor context";
  contextButton.setAttribute("aria-pressed", String(next.contextEnabled));
  const contextDescription =
    editorContext === null
      ? "No active editor"
      : editorContext.kind === "selection"
        ? `${editorContext.endLine - editorContext.startLine + 1} lines selected`
        : `${editorContext.path}:${editorContext.startLine}`;
  contextLabel.textContent = next.contextEnabled
    ? contextDescription
    : `Excluded · ${contextDescription}`;
  renderContextWindow(next);
  renderChangeRequest(next);
  const selection = currentSelection(next);
  provider.replaceChildren();
  model.replaceChildren();
  if (selection === null) {
    const providerOption = document.createElement("option");
    providerOption.textContent = next.environmentLabel;
    providerOption.value = "";
    provider.append(providerOption);
    const modelOption = document.createElement("option");
    modelOption.textContent = "Select a thread";
    modelOption.value = "";
    model.append(modelOption);
  } else {
    const providers = new Map<string, (typeof next.models)[number]>();
    for (const candidate of next.models) {
      if (!providers.has(candidate.instanceId)) providers.set(candidate.instanceId, candidate);
    }
    const favoriteProviderIds = new Set(next.favoriteProviderIds);
    for (const [instanceId, candidate] of favoritesFirst([...providers.entries()], ([instanceId]) =>
      favoriteProviderIds.has(instanceId),
    )) {
      const option = document.createElement("option");
      option.value = instanceId;
      const instanceModels = next.models.filter((model) => model.instanceId === instanceId);
      const comparedUsage = compareModelUsage(next.aiUsage, instanceModels);
      const usage =
        draftSelection === null
          ? ""
          : comparedUsage.varies
            ? "Limits vary by model"
            : (comparedUsage.commonSummary ?? "");
      option.textContent = `${candidate.providerLabel}${usage === "" ? "" : ` · ${usage}`}`;
      option.selected = instanceId === selection.instanceId;
      provider.append(option);
    }
    const favoriteModelKeys = new Set(next.favoriteModelKeys);
    const selectedProviderModels = favoritesFirst(
      next.models.filter((candidate) => candidate.instanceId === selection.instanceId),
      (candidate) => favoriteModelKeys.has(modelFavoriteKey(candidate.instanceId, candidate.model)),
    );
    const comparedUsage = compareModelUsage(next.aiUsage, selectedProviderModels);
    for (const [index, candidate] of selectedProviderModels.entries()) {
      const option = document.createElement("option");
      option.value = candidate.model;
      const modelUsage = comparedUsage.varies
        ? (comparedUsage.summaries[index] ?? "Usage unavailable")
        : "";
      option.textContent = `${candidate.modelLabel}${modelUsage === "" ? "" : ` · ${modelUsage}`}`;
      option.selected = candidate.model === selection.model;
      model.append(option);
    }
  }
  renderModelOptions(next);
  renderUsageDetails(next);
  renderProviderIdentity(next);
  renderFavoriteControls(next);
  provider.disabled = selection === null || draftSelection === null || next.busy;
  model.disabled = selection === null || next.busy;
  send.disabled = next.busy;
  archiveThread.disabled =
    next.busy || next.activeThread === null || next.activeThread.status.kind === "working";
  visitT3.disabled = !next.connected || next.activeThread === null;
  syncPromptDisabled(next.busy);
  renderComposerAction();
  renderQueuedMessages(next);
}

function renderQueuedMessages(state: ViewState): void {
  queuedMessages.replaceChildren();
  for (const message of state.activeThread?.queuedMessages ?? []) {
    const row = document.createElement("div");
    row.className = "queued-message";
    row.title = message.text;

    const icon = document.createElement("span");
    icon.className = "queued-message-icon";
    icon.textContent = "↳";

    const text = document.createElement("span");
    text.className = "queued-message-text";
    text.textContent =
      message.text.trim() ||
      `${message.attachmentCount} attachment${message.attachmentCount === 1 ? "" : "s"}`;

    const steer = document.createElement("button");
    steer.type = "button";
    steer.textContent = "Steer";
    steer.title = "Send now, interrupting the current step";
    steer.ariaLabel = "Steer queued message";
    steer.disabled = state.busy;
    steer.addEventListener("click", () =>
      post({ type: "steerQueuedMessage", messageId: message.messageId }),
    );

    const edit = document.createElement("button");
    edit.type = "button";
    edit.textContent = "Edit";
    edit.title = "Edit or recall queued message";
    edit.ariaLabel = "Edit queued message";
    edit.disabled = state.busy;
    edit.addEventListener("click", () => editQueuedMessage(message.messageId, message.text));

    row.append(icon, text, steer, edit);
    queuedMessages.append(row);
  }
}

/**
 * Disabling a focused element blurs it, and the browser never gives that focus
 * back. Every `#run` on the extension side publishes `busy: true` and then
 * `busy: false` a moment later, so without this a background action silently
 * drops the caret mid-sentence and keystrokes go nowhere — a disabled textarea
 * looks identical to an enabled one.
 */
function syncPromptDisabled(busy: boolean): void {
  if (prompt.disabled === busy) return;
  if (busy) {
    promptFocusToRestore =
      document.activeElement === prompt
        ? { start: prompt.selectionStart, end: prompt.selectionEnd }
        : null;
    prompt.disabled = true;
    return;
  }
  prompt.disabled = false;
  if (promptFocusToRestore === null) return;
  const { start, end } = promptFocusToRestore;
  promptFocusToRestore = null;
  prompt.focus();
  prompt.setSelectionRange(start, end);
}

messages.addEventListener("scroll", syncNewActivityButton, { passive: true });
newActivity.addEventListener("click", () => {
  hasUnreadActivity = false;
  messages.scrollTo({ top: messages.scrollHeight, behavior: "smooth" });
  syncNewActivityButton();
});

function renderFavoriteControls(state: ViewState): void {
  const selection = currentSelection(state);
  favoriteProvider.disabled = selection === null;
  favoriteModel.disabled = selection === null;
  const providerActive =
    selection !== null && state.favoriteProviderIds.includes(selection.instanceId);
  const modelActive =
    selection !== null &&
    state.favoriteModelKeys.includes(modelFavoriteKey(selection.instanceId, selection.model));
  for (const [button, active, noun] of [
    [favoriteProvider, providerActive, "provider"],
    [favoriteModel, modelActive, "model"],
  ] as const) {
    button.textContent = active ? "★" : "☆";
    button.classList.toggle("active", active);
    button.title = `${active ? "Remove" : "Add"} ${noun} ${active ? "from" : "to"} favorites`;
    button.setAttribute("aria-label", button.title);
  }
}

function renderActiveStatus(state: ViewState): void {
  const activeStatus = draftSelection === null ? state.activeThread?.status : undefined;
  status.className = state.error === null ? (activeStatus?.kind ?? "") : "error";
  if (state.error !== null) {
    status.textContent = state.error;
    return;
  }
  if (state.busy) {
    status.textContent = "Synchronizing…";
    return;
  }
  if (activeStatus === undefined) {
    status.textContent = "";
    return;
  }
  if (activeStatus.kind === "working") {
    const elapsed = state.activeThread?.turnStartedAt
      ? formatElapsed(state.activeThread.turnStartedAt, Date.now())
      : null;
    status.textContent = elapsed === null ? "Working…" : `Working for ${elapsed}`;
    return;
  }
  if (activeStatus.kind === "plan-ready") {
    status.textContent = "Plan Ready";
    return;
  }
  status.textContent = activeStatus.kind === "connecting" ? "Connecting…" : activeStatus.label;
}

function renderProviderIdentity(state: ViewState): void {
  const candidate = selectedModelCandidate(state);
  if (candidate === undefined) {
    providerIcon.replaceChildren();
    return;
  }
  renderProviderIcon(providerIcon, candidate.driver, candidate.providerLabel);
  providerIcon.title = candidate.providerLabel;
}

function renderContextWindow(state: ViewState): void {
  const usage = draftSelection === null ? state.activeThread?.contextWindow : null;
  if (usage == null) {
    contextWindowMeter.hidden = true;
    return;
  }
  contextWindowMeter.hidden = false;
  const percent = Math.max(0, Math.min(100, usage.usedPercentage ?? 0));
  contextWindowMeter.style.setProperty("--context-percent", `${percent * 3.6}deg`);
  contextWindowMeter.classList.toggle("critical", percent >= 90);
  contextWindowLabel.textContent =
    usage.usedPercentage === null ? formatTokens(usage.usedTokens) : `${Math.round(percent)}%`;
  const details = [
    `Context: ${formatTokens(usage.usedTokens)}${usage.maxTokens === null ? "" : ` / ${formatTokens(usage.maxTokens)}`}`,
  ];
  if (usage.totalProcessedTokens !== null) {
    details.push(`Total processed: ${formatTokens(usage.totalProcessedTokens)}`);
  }
  if (usage.compactsAutomatically) details.push("Automatic compaction enabled");
  contextWindowMeter.title = details.join("\n");
  contextWindowMeter.setAttribute("aria-label", details.join(". "));
}

function renderChangeRequest(state: ViewState): void {
  const indicator = state.changeRequest;
  changeRequest.hidden = indicator === null;
  if (indicator === null) return;
  changeRequest.className = indicator.state;
  changeRequest.title = `${indicator.tooltip}\nClick to open`;
  changeRequest.setAttribute("aria-label", changeRequest.title);
  changeRequestLabel.textContent = `#${indicator.number}`;
}

function hostResourceMetricElement(
  metric: ReturnType<typeof getHostResourceMetrics>[number],
): HTMLElement {
  const ratio = metric.ratio === null ? 0 : Math.min(1, Math.max(0, metric.ratio));
  const element = document.createElement("span");
  element.className = `host-metric ${getHostResourceRatioPressure(ratio)}`;
  element.setAttribute("aria-label", metric.description);
  const meter = document.createElement("span");
  meter.className = "host-metric-meter";
  const fill = document.createElement("span");
  fill.className = "host-metric-fill";
  fill.style.height = `${ratio * 100}%`;
  meter.append(fill);
  const label = document.createElement("span");
  label.textContent = metric.label;
  const value = document.createElement("span");
  value.textContent = metric.value;
  element.append(meter, label, value);
  return element;
}

function renderHostResources(snapshot: ServerHostResourceSnapshot | null): void {
  hostResourcesToggle.hidden = snapshot === null || snapshot.status === "unavailable";
  if (snapshot === null || snapshot.status === "unavailable") return;
  hostResourcesToggle.replaceChildren(
    ...getHostResourceMetrics(snapshot).map(hostResourceMetricElement),
  );
  hostResourcesToggle.title = "Host resources — hover for details";
  hostResourcesToggle.setAttribute("aria-label", hostResourcesToggle.title);
  const loadAverage = snapshot.loadAverage;
  const rows: ReadonlyArray<readonly [string, string]> = [
    ["Host", snapshot.hostname ?? currentState?.environmentLabel ?? "Host"],
    [
      "CPU",
      `${formatHostResourcePercent(snapshot.cpuPercent)} across ${snapshot.logicalCores ?? "—"} logical cores`,
    ],
    [
      "Memory",
      `${formatHostResourceBytes(snapshot.memoryUsedBytes)} / ${formatHostResourceBytes(snapshot.memoryTotalBytes)} used`,
    ],
    [
      "Load",
      loadAverage
        ? `${loadAverage.m1.toFixed(2)} / ${loadAverage.m5.toFixed(2)} / ${loadAverage.m15.toFixed(2)}`
        : "—",
    ],
    ["Updated", new Date(snapshot.checkedAt).toLocaleTimeString()],
  ];
  hostResourcesDetails.replaceChildren(
    ...rows.flatMap(([label, value]) => {
      const labelElement = document.createElement("span");
      labelElement.className = "host-resources-detail-label";
      labelElement.textContent = label;
      const valueElement = document.createElement("span");
      valueElement.className = "host-resources-detail-value";
      valueElement.textContent = value;
      return [labelElement, valueElement];
    }),
  );
}

function renderUsageDetails(state: ViewState): void {
  usageDetails.replaceChildren();
  const usageToggle = requiredElement<HTMLButtonElement>("usage-toggle");
  const usageLabel = requiredElement<HTMLElement>("usage-label");
  usageToggle.style.setProperty("--usage-primary", "0deg");
  usageToggle.style.setProperty("--usage-secondary", "0deg");
  usageToggle.className = "";
  usageToggle.hidden = true;
  usageLabel.textContent = "—";
  usageToggle.title = "Provider usage unavailable";
  usageToggle.setAttribute("aria-label", usageToggle.title);
  const candidate = selectedModelCandidate(state);
  if (candidate === undefined) return;
  const usage = usageForModel(state.aiUsage, candidate.driver, candidate.model);
  if (usage === null) return;
  usageToggle.hidden = false;
  usageToggle.title = "Provider usage — hover for details; click to pin";
  usageToggle.setAttribute("aria-label", usageToggle.title);
  if (!usage.ok) {
    const unavailable = document.createElement("div");
    unavailable.className = "usage-unavailable";
    unavailable.textContent = usage.error ?? "Usage unavailable";
    usageDetails.append(unavailable);
    return;
  }
  const percentages = usage.windows
    .map((window) => window.percent)
    .filter((percent): percent is number => typeof percent === "number");
  const primary = percentages[0] ?? 0;
  const secondary = percentages[1] ?? primary;
  const worst = percentages.length > 0 ? Math.max(...percentages) : null;
  usageToggle.style.setProperty(
    "--usage-primary",
    `${Math.max(0, Math.min(100, primary)) * 3.6}deg`,
  );
  usageToggle.style.setProperty(
    "--usage-secondary",
    `${Math.max(0, Math.min(100, secondary)) * 3.6}deg`,
  );
  usageToggle.classList.toggle("warning", worst !== null && worst >= 80 && worst < 100);
  usageToggle.classList.toggle("critical", worst !== null && worst >= 100);
  usageLabel.textContent = worst === null ? "—" : `${Math.round(worst)}%`;
  for (const window of usage.windows) {
    const row = document.createElement("div");
    row.className = "usage-window";
    const heading = document.createElement("div");
    heading.className = "usage-window-heading";
    const label = document.createElement("span");
    label.textContent = window.label;
    const value = document.createElement("span");
    value.textContent = usageWindowValue(window);
    heading.append(label, value);
    row.append(heading);
    if (typeof window.percent === "number") {
      const track = document.createElement("div");
      track.className = "usage-track";
      const fill = document.createElement("div");
      fill.className = `usage-fill${window.percent >= 100 ? " critical" : window.percent >= 80 ? " warning" : ""}`;
      fill.style.width = `${Math.max(0, Math.min(100, window.percent))}%`;
      track.append(fill);
      row.append(track);
    }
    const reset = formatReset(window.resets_at);
    if (reset !== "") {
      const resetLabel = document.createElement("div");
      resetLabel.className = "usage-reset";
      resetLabel.textContent = reset;
      row.append(resetLabel);
    }
    usageDetails.append(row);
  }
  if (usage.stale) {
    const stale = document.createElement("div");
    stale.className = "usage-unavailable";
    stale.textContent = "Showing last known usage";
    usageDetails.append(stale);
  }
}

function isRunning(): boolean {
  return draftSelection === null && currentState?.activeThread?.status.kind === "working";
}

function hasComposerInput(): boolean {
  return editingQueuedMessage !== null || prompt.value.trim() !== "" || pendingImages.length > 0;
}

function showPlanFollowUp(): boolean {
  return draftSelection === null && currentState?.activeThread?.showPlanFollowUp === true;
}

function renderComposerAction(): void {
  const planFollowUp = showPlanFollowUp();
  const stopping = isRunning() && !hasComposerInput() && !planFollowUp;
  stashNow.disabled = editingQueuedMessage !== null || !hasComposerInput();
  if (stopping) {
    send.textContent = "Stop";
    send.title = "Stop active turn";
  } else if (planFollowUp) {
    send.textContent = prompt.value.trim().length > 0 ? "Refine" : "Implement";
    send.title =
      prompt.value.trim().length > 0 ? "Send plan feedback" : "Implement the proposed plan";
  } else {
    send.textContent = isRunning() && hasComposerInput() ? "Queue" : "Send";
    send.title =
      isRunning() && hasComposerInput() ? "Queue message after the active turn" : "Send message";
  }
  send.classList.toggle("stop-action", stopping);
  prompt.placeholder = planFollowUp
    ? "Add feedback to refine the plan, or leave blank to implement"
    : "Ask T3 Code…";
  interactionModeSelect.value = composerInteractionMode;
}

function renderPlanReady(state: ViewState): void {
  planReady.replaceChildren();
  if (!state.activeThread?.showPlanFollowUp || state.activeThread.activeProposedPlan === null) {
    return;
  }
  const badge = document.createElement("span");
  badge.className = "plan-ready-badge";
  badge.textContent = "Plan Ready";
  const title = document.createElement("span");
  title.className = "plan-ready-title";
  title.textContent = state.activeThread.activeProposedPlan.title;
  planReady.append(badge, title);
}

function stripPlanDisplay(planMarkdown: string): string {
  const lines = planMarkdown.trimEnd().split(/\r?\n/);
  const sourceLines = lines[0] && /^\s{0,3}#{1,6}\s+/.test(lines[0]) ? lines.slice(1) : [...lines];
  while (sourceLines[0]?.trim().length === 0) sourceLines.shift();
  const firstHeadingMatch = sourceLines[0]?.match(/^\s{0,3}#{1,6}\s+(.+)$/);
  if (firstHeadingMatch?.[1]?.trim().toLowerCase() === "summary") {
    sourceLines.shift();
    while (sourceLines[0]?.trim().length === 0) sourceLines.shift();
  }
  return sourceLines.join("\n");
}

function renderProposedPlan(plan: ViewProposedPlan): HTMLElement {
  const card = document.createElement("div");
  card.className = "plan-card";
  const header = document.createElement("div");
  header.className = "plan-card-header";
  const badge = document.createElement("span");
  badge.className = "plan-card-badge";
  badge.textContent = "Plan";
  const title = document.createElement("span");
  title.className = "plan-card-title";
  title.textContent =
    plan.planMarkdown.match(/^\s{0,3}#{1,6}\s+(.+)$/m)?.[1]?.trim() ?? "Proposed plan";
  header.append(badge, title);
  card.append(header, renderMarkdown(stripPlanDisplay(plan.planMarkdown)));
  return card;
}

function setComposerInteractionMode(mode: "default" | "plan", persist: boolean): void {
  composerInteractionMode = mode;
  interactionModeSelect.value = mode;
  if (persist && draftSelection === null && currentState?.activeThread !== null) {
    post({ type: "setInteractionMode", interactionMode: mode });
  }
  renderComposerAction();
}

function uploadImages(): Array<{
  type: "image";
  name: string;
  mimeType: string;
  sizeBytes: number;
  dataUrl: string;
}> {
  return pendingImages.map(({ type, name, mimeType, sizeBytes, dataUrl }) => ({
    type,
    name,
    mimeType,
    sizeBytes,
    dataUrl,
  }));
}

function clearPendingImages(): void {
  pendingImages = [];
  renderPendingImages();
}

function renderPendingImages(): void {
  pendingAttachments.replaceChildren();
  for (const image of pendingImages) {
    const chip = document.createElement("div");
    chip.className = "pending-attachment";
    const thumbnail = document.createElement("img");
    thumbnail.src = image.dataUrl;
    thumbnail.alt = image.name;
    const label = document.createElement("span");
    label.textContent = image.name;
    const remove = document.createElement("button");
    remove.textContent = "×";
    remove.title = `Remove ${image.name}`;
    remove.addEventListener("click", () => {
      pendingImages = pendingImages.filter((candidate) => candidate.key !== image.key);
      renderPendingImages();
    });
    chip.append(thumbnail, label, remove);
    pendingAttachments.append(chip);
  }
  renderComposerAction();
}

function fileDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () =>
      typeof reader.result === "string"
        ? resolve(reader.result)
        : reject(new Error("Invalid image")),
    );
    reader.addEventListener("error", () =>
      reject(reader.error ?? new Error("Could not read image")),
    );
    reader.readAsDataURL(file);
  });
}

async function addClipboardImages(files: ReadonlyArray<File>): Promise<void> {
  for (const [index, file] of files.entries()) {
    if (!file.type.startsWith("image/")) continue;
    pendingImages.push({
      key: `${file.name}:${file.size}:${globalThis.performance.now()}:${index}`,
      type: "image",
      name: file.name || `pasted-image-${pendingImages.length + 1}.png`,
      mimeType: file.type || "image/png",
      sizeBytes: file.size,
      dataUrl: await fileDataUrl(file),
    });
  }
  renderPendingImages();
}

function currentSelection(state: ViewState) {
  if (draftSelection !== null) return draftSelection;
  const thread = state.activeThread;
  if (thread === null) return null;
  return {
    instanceId: thread.instanceId,
    model: thread.model,
    options: [...(thread.options ?? [])],
  };
}

function selectedModelCandidate(state: ViewState) {
  const selection = currentSelection(state);
  if (selection === null) return undefined;
  return state.models.find(
    (candidate) =>
      candidate.instanceId === selection.instanceId && candidate.model === selection.model,
  );
}

function selectedOptions(state: ViewState): Array<{ id: string; value: string | boolean }> {
  return [...(currentSelection(state)?.options ?? [])];
}

function sendModelSelection(
  state: ViewState,
  options: Array<{ id: string; value: string | boolean }>,
): void {
  const selection = currentSelection(state);
  if (selection === null) return;
  if (draftSelection !== null) {
    draftSelection = { ...draftSelection, options };
    renderModelOptions(state);
    return;
  }
  post({
    type: "selectModel",
    instanceId: selection.instanceId,
    model: selection.model,
    options,
  });
}

function renderModelOptions(state: ViewState): void {
  modelOptions.replaceChildren();
  const candidate = selectedModelCandidate(state);
  if (candidate === undefined || candidate.optionDescriptors.length === 0) return;
  const values = new Map(selectedOptions(state).map((option) => [option.id, option.value]));
  for (const descriptor of candidate.optionDescriptors) {
    const label = document.createElement("label");
    label.className = "model-option";
    const title = document.createElement("span");
    const optionIdentity = `${descriptor.id} ${descriptor.label}`.toLowerCase();
    const compactIcon =
      optionIdentity.includes("service") || optionIdentity.includes("tier") ? "ϟ" : null;
    const omitVisibleLabel = optionIdentity.includes("reason");
    title.textContent = compactIcon ?? (omitVisibleLabel ? "" : descriptor.label);
    title.hidden = omitVisibleLabel;
    title.className = compactIcon === null ? "" : "model-option-icon";
    title.title = descriptor.label;
    label.append(title);
    if (descriptor.type === "select") {
      const select = document.createElement("select");
      select.setAttribute("aria-label", descriptor.label);
      select.title = descriptor.label;
      for (const choice of descriptor.options) {
        const option = document.createElement("option");
        option.value = choice.id;
        option.textContent = choice.label;
        option.selected =
          choice.id ===
          (values.get(descriptor.id) ??
            descriptor.currentValue ??
            descriptor.options.find((entry) => entry.isDefault)?.id);
        select.append(option);
      }
      select.addEventListener("change", () => {
        const options = selectedOptions(state).filter((option) => option.id !== descriptor.id);
        options.push({ id: descriptor.id, value: select.value });
        sendModelSelection(state, options);
      });
      label.append(select);
    } else {
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.setAttribute("aria-label", descriptor.label);
      checkbox.checked = Boolean(values.get(descriptor.id) ?? descriptor.currentValue ?? false);
      checkbox.addEventListener("change", () => {
        const options = selectedOptions(state).filter((option) => option.id !== descriptor.id);
        options.push({ id: descriptor.id, value: checkbox.checked });
        sendModelSelection(state, options);
      });
      label.prepend(checkbox);
    }
    modelOptions.append(label);
  }
}

function submit(): void {
  if (editingQueuedMessage !== null) {
    const editing = editingQueuedMessage;
    const text = prompt.value.trim();
    if (text.length === 0) {
      post({ type: "removeQueuedMessage", messageId: editing.messageId });
    } else {
      post({ type: "updateQueuedMessage", messageId: editing.messageId, text });
    }
    restoreDraftAfterQueuedEdit();
    return;
  }
  const slash = prompt.value.trim();
  if (slash.startsWith("/") && executeSlashCommand(slash)) return;
  const planFollowUp = showPlanFollowUp();
  if (!hasComposerInput() && !planFollowUp) return;
  if (isRunning() && !hasComposerInput() && !planFollowUp) {
    post({ type: "stop" });
    return;
  }
  const images = uploadImages();
  // The host echoes the outgoing message asynchronously. Remember that this
  // render must follow the end even if the user submitted from older history.
  followEndAfterSubmit = true;
  hasUnreadActivity = false;
  messages.scrollTop = messages.scrollHeight;
  syncNewActivityButton();
  if (prompt.value.trim().length > 0) {
    inputHistory = pushComposerInputHistory(inputHistory, prompt.value);
    persistInputHistory(inputHistoryScopeKey, inputHistory);
  }
  if (draftSelection !== null) {
    post({
      type: "sendNewThread",
      text: prompt.value,
      instanceId: draftSelection.instanceId,
      model: draftSelection.model,
      options: draftSelection.options,
      images,
      interactionMode: composerInteractionMode,
    });
    return;
  }
  post({
    type: "send",
    text: prompt.value,
    images,
    interactionMode: composerInteractionMode,
  });
}

function beginNewThread(): void {
  if (currentState === null) return;
  const active = currentSelection(currentState);
  const fallback = currentState.models[0];
  if (active === null && fallback === undefined) return;
  draftSelection = active ?? {
    instanceId: fallback!.instanceId,
    model: fallback!.model,
    options: [],
  };
  prompt.value = "";
  slashCommands.hidden = true;
  render(currentState);
  prompt.focus();
}

function executeSlashCommand(value: string): boolean {
  const command = COMMANDS.find((candidate) => candidate.name === value.toLowerCase());
  if (command === undefined) return false;
  prompt.value = "";
  slashCommands.hidden = true;
  switch (command.name) {
    case "/new":
      beginNewThread();
      break;
    case "/threads":
      threads.focus();
      threads.click();
      break;
    case "/model":
      model.focus();
      model.click();
      break;
    case "/plan":
      setComposerInteractionMode("plan", true);
      break;
    case "/default":
      setComposerInteractionMode("default", true);
      break;
    case "/context":
      post({ type: "toggleContext" });
      break;
    case "/stop":
      post({ type: "stop" });
      break;
  }
  renderComposerAction();
  return true;
}

function matchingSlashCommands(): ReadonlyArray<(typeof COMMANDS)[number]> {
  const query = prompt.value.trim().toLowerCase();
  if (!query.startsWith("/") || query.includes(" ")) return [];
  return COMMANDS.filter((command) => command.name.startsWith(query));
}

function renderSlashCommands(): void {
  const matching = matchingSlashCommands();
  selectedSlashCommand = Math.min(selectedSlashCommand, Math.max(0, matching.length - 1));
  slashCommands.replaceChildren();
  slashCommands.hidden = matching.length === 0;
  for (const [index, command] of matching.entries()) {
    const button = document.createElement("button");
    button.className = `slash-command${index === selectedSlashCommand ? " selected" : ""}`;
    button.type = "button";
    const name = document.createElement("span");
    name.className = "slash-command-name";
    name.textContent = command.name;
    const description = document.createElement("span");
    description.className = "slash-command-description";
    description.textContent = command.description;
    button.append(name, description);
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => executeSlashCommand(command.name));
    slashCommands.append(button);
  }
}

/**
 * Anchors a fixed-position popover above its toggle, right-aligned and clamped to
 * the viewport. Composer popovers are fixed rather than absolute so they escape
 * the composer's overflow.
 */
function positionPopover(toggle: HTMLElement, panel: HTMLElement, maxWidth: number): void {
  const viewportPadding = 8;
  const width = Math.min(maxWidth, Math.max(0, globalThis.innerWidth - viewportPadding * 2));
  const toggleBounds = toggle.getBoundingClientRect();
  const left = Math.min(
    Math.max(viewportPadding, toggleBounds.right - width),
    Math.max(viewportPadding, globalThis.innerWidth - width - viewportPadding),
  );
  panel.style.width = `${width}px`;
  panel.style.left = `${left}px`;
  panel.style.bottom = `${Math.max(viewportPadding, globalThis.innerHeight - toggleBounds.top + 7)}px`;
}

function positionUsageDetails(): void {
  positionPopover(requiredElement("usage-toggle"), usageDetails, 270);
}

function positionTasksDetails(): void {
  positionPopover(requiredElement("tasks-toggle"), tasksDetails, 320);
}

function positionHostResourcesDetails(): void {
  positionPopover(hostResourcesToggle, hostResourcesDetails, 260);
}

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (typeof event.data !== "object" || event.data === null || !("type" in event.data)) return;
  if (event.data.type === "state" && "state" in event.data) render(event.data.state as ViewState);
  if (event.data.type === "hostResources" && "snapshot" in event.data) {
    renderHostResources(event.data.snapshot as ServerHostResourceSnapshot | null);
  }
  if (event.data.type === "promptStash" && "entries" in event.data) {
    promptStash = event.data.entries as ReadonlyArray<PromptStashEntry>;
    renderPromptStash();
    if ("stashed" in event.data && event.data.stashed === true && pendingStash !== null) {
      if (prompt.value === pendingStash.prompt) prompt.value = "";
      const stashedKeys = new Set(pendingStash.imageKeys);
      pendingImages = pendingImages.filter((image) => !stashedKeys.has(image.key));
      pendingStash = null;
      renderPendingImages();
      renderComposerAction();
    }
  }
  if (event.data.type === "restorePromptStash" && "entry" in event.data) {
    const entry = event.data.entry as PromptStashEntry;
    prompt.value = entry.prompt;
    pendingImages = entry.images.map((image, index) => ({
      ...image,
      key: `stash:${entry.id}:${index}`,
    }));
    setComposerInteractionMode(entry.interactionMode, false);
    if (entry.modelSelection !== null && currentState !== null) {
      const options = [...(entry.modelSelection.options ?? [])];
      if (draftSelection !== null) {
        draftSelection = { ...entry.modelSelection, options };
        render(currentState);
      } else {
        post({
          type: "selectModel",
          instanceId: entry.modelSelection.instanceId,
          model: entry.modelSelection.model,
          options,
        });
      }
    }
    renderPendingImages();
    renderComposerAction();
    stashControl.open = false;
    prompt.focus();
    prompt.setSelectionRange(prompt.value.length, prompt.value.length);
  }
  if (event.data.type === "sent") {
    prompt.value = "";
    clearPendingImages();
    prompt.focus();
  }
  if (event.data.type === "sentNewThread") {
    draftSelection = null;
    prompt.value = "";
    clearPendingImages();
    prompt.focus();
  }
  if (event.data.type === "focusComposer") prompt.focus();
});
threads.addEventListener("change", () => {
  if (threads.value !== "" && threads.value !== "__draft__") {
    draftSelection = null;
    post({ type: "selectThread", threadId: threads.value });
  }
});
interactionModeSelect.addEventListener("change", () => {
  const mode = interactionModeSelect.value === "plan" ? "plan" : "default";
  setComposerInteractionMode(mode, draftSelection === null);
});
prompt.addEventListener("input", () => {
  renderComposerAction();
});
provider.addEventListener("change", () => {
  if (draftSelection === null || currentState === null || provider.value === "") return;
  const firstModel = currentState.models.find(
    (candidate) => candidate.instanceId === provider.value,
  );
  if (firstModel === undefined) return;
  draftSelection = { instanceId: firstModel.instanceId, model: firstModel.model, options: [] };
  render(currentState);
  requestPromptStash();
});
stashControl.addEventListener("toggle", () => {
  if (stashControl.open) requestPromptStash();
});
stashNow.addEventListener("click", stashCurrentPrompt);
model.addEventListener("change", () => {
  if (model.value === "" || currentState === null) return;
  const selection = currentSelection(currentState);
  if (selection === null) return;
  if (draftSelection !== null) {
    draftSelection = { instanceId: selection.instanceId, model: model.value, options: [] };
    render(currentState);
    return;
  }
  post({ type: "selectModel", instanceId: selection.instanceId, model: model.value, options: [] });
});
favoriteProvider.addEventListener("click", () => {
  if (currentState === null) return;
  const selection = currentSelection(currentState);
  if (selection !== null)
    post({ type: "toggleProviderFavorite", instanceId: selection.instanceId });
});
favoriteModel.addEventListener("click", () => {
  if (currentState === null) return;
  const selection = currentSelection(currentState);
  if (selection !== null) {
    post({
      type: "toggleModelFavorite",
      modelKey: modelFavoriteKey(selection.instanceId, selection.model),
    });
  }
});
requiredElement("usage-toggle").addEventListener("click", () => {
  positionUsageDetails();
  usageExpanded = !usageExpanded;
  requiredElement("usage-control").classList.toggle("pinned", usageExpanded);
  if (usageExpanded) {
    tasksExpanded = false;
    requiredElement("tasks-control").classList.remove("pinned");
  }
});
requiredElement("usage-control").addEventListener("pointerenter", positionUsageDetails);
requiredElement("tasks-toggle").addEventListener("click", () => {
  positionTasksDetails();
  tasksExpanded = !tasksExpanded;
  requiredElement("tasks-control").classList.toggle("pinned", tasksExpanded);
  if (tasksExpanded) {
    usageExpanded = false;
    requiredElement("usage-control").classList.remove("pinned");
  }
});
requiredElement("tasks-control").addEventListener("pointerenter", positionTasksDetails);
changeRequest.addEventListener("click", () => {
  const url = currentState?.changeRequest?.url;
  if (url !== undefined) post({ type: "openLink", href: url });
});
// Hovering the gauge steps the host-metrics poll up to a live cadence, matching
// the web client; leaving drops it back to the idle heartbeat.
hostResourcesControl.addEventListener("pointerenter", () => {
  positionHostResourcesDetails();
  post({ type: "hostResourceLive", live: true });
});
hostResourcesControl.addEventListener("pointerleave", () => {
  post({ type: "hostResourceLive", live: false });
});
function closeComposerPopovers(): void {
  usageExpanded = false;
  tasksExpanded = false;
  for (const id of ["usage-control", "tasks-control"]) {
    const control = requiredElement(id);
    control.classList.remove("pinned");
    if (control.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
  }
}
document.addEventListener("pointerdown", (event) => {
  const target = event.target;
  if (!(target instanceof Node)) return;
  if (
    requiredElement("usage-control").contains(target) ||
    requiredElement("tasks-control").contains(target)
  )
    return;
  closeComposerPopovers();
});
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    if (hasComposerInput()) stashCurrentPrompt();
    else {
      stashControl.open = true;
      requestPromptStash();
    }
    return;
  }
  if (event.key === "Escape" && (usageExpanded || tasksExpanded)) {
    closeComposerPopovers();
    event.preventDefault();
  }
});
globalThis.addEventListener("resize", () => {
  positionUsageDetails();
  positionTasksDetails();
});
requiredElement("new").addEventListener("click", beginNewThread);
requiredElement("refresh").addEventListener("click", () => post({ type: "refresh" }));
visitT3.addEventListener("click", () => {
  threadActions.open = false;
  post({ type: "visitT3" });
});
archiveThread.addEventListener("click", () => {
  threadActions.open = false;
  post({ type: "archiveThread" });
});
contextButton.addEventListener("click", () => post({ type: "toggleContext" }));
send.addEventListener("click", () => {
  if (isRunning() && !hasComposerInput()) post({ type: "stop" });
  else submit();
});
prompt.addEventListener("input", () => {
  selectedSlashCommand = 0;
  renderSlashCommands();
  renderComposerAction();
});
prompt.addEventListener("paste", (event) => {
  const images = [...(event.clipboardData?.files ?? [])].filter((file) =>
    file.type.startsWith("image/"),
  );
  if (images.length === 0) return;
  event.preventDefault();
  void addClipboardImages(images);
});
prompt.addEventListener("keydown", (event) => {
  const matching = matchingSlashCommands();
  if (matching.length > 0 && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
    event.preventDefault();
    selectedSlashCommand =
      (selectedSlashCommand + (event.key === "ArrowDown" ? 1 : -1) + matching.length) %
      matching.length;
    renderSlashCommands();
    return;
  }
  if (event.key === "Escape" && !slashCommands.hidden) {
    event.preventDefault();
    slashCommands.hidden = true;
    return;
  }
  if (event.key === "ArrowUp" || event.key === "ArrowDown") {
    const direction = event.key === "ArrowUp" ? "up" : "down";
    const selectionStart = prompt.selectionStart;
    const selectionEnd = prompt.selectionEnd;
    const conversationUserTexts =
      currentState?.activeThread?.messages
        .filter((message) => message.role === "user")
        .map((message) => message.text) ?? [];
    const historyForNavigation = seedComposerInputHistoryFromConversation(
      inputHistory,
      conversationUserTexts,
    );
    const keyAction = resolveComposerInputHistoryKeyAction({
      direction,
      browsing: historyForNavigation.browsingIndex !== null,
      text: prompt.value,
      cursor: selectionStart,
      selectionEnd,
    });
    if (keyAction.action === "move-caret") {
      event.preventDefault();
      prompt.setSelectionRange(keyAction.cursor, keyAction.cursor);
      return;
    }
    if (keyAction.action === "history") {
      const navigation = navigateComposerInputHistory(
        historyForNavigation,
        direction,
        prompt.value,
      );
      if (navigation.handled) {
        event.preventDefault();
        inputHistory = navigation.state;
        persistInputHistory(inputHistoryScopeKey, inputHistory);
        prompt.value = navigation.value;
        if (editingQueuedMessage !== null && navigation.state.browsingIndex === null) {
          editingQueuedMessage = null;
        }
        const cursor = navigation.value.length;
        prompt.setSelectionRange(cursor, cursor);
        renderComposerAction();
        return;
      }
    }
  }
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    if (matching.length > 0) {
      executeSlashCommand(matching[selectedSlashCommand]!.name);
      return;
    }
    submit();
  }
});
post({ type: "ready" });

globalThis.setInterval(() => {
  if (currentState !== null) renderActiveStatus(currentState);
}, 1_000);
