/* oxlint-disable no-unsanitized/property, unicorn/require-post-message-target-origin -- Markdown is sanitized; VS Code's postMessage API has no targetOrigin argument. */
// @effect-diagnostics globalDate:off globalTimers:off
import DOMPurify from "dompurify";
import { marked } from "marked";
import type { AiUsageSnapshot, AiUsageWindow } from "@t3tools/contracts";

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
    | "error"
    | "ready";
  readonly label: string;
}

interface ViewMessage {
  readonly id: string;
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
  readonly streaming: boolean;
  readonly attachments: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly mimeType: string;
    readonly previewUrl: string | null;
  }>;
}

interface ViewState {
  readonly busy: boolean;
  readonly error: string | null;
  readonly environmentLabel: string;
  readonly threads: ReadonlyArray<ViewThread>;
  readonly activeThread: null | {
    readonly id: string;
    readonly instanceId: string;
    readonly model: string;
    readonly options?: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }>;
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
const status = requiredElement<HTMLElement>("status");
const prompt = requiredElement<HTMLTextAreaElement>("prompt");
const send = requiredElement<HTMLButtonElement>("send");
const pendingAttachments = requiredElement<HTMLElement>("pending-attachments");
const contextButton = requiredElement<HTMLButtonElement>("context");
const contextLabel = requiredElement<HTMLElement>("context-label");
const contextWindowMeter = requiredElement<HTMLButtonElement>("context-window");
const contextWindowLabel = requiredElement<HTMLElement>("context-window-label");
const provider = requiredElement<HTMLSelectElement>("provider");
const providerIcon = requiredElement<HTMLElement>("provider-icon");
const favoriteProvider = requiredElement<HTMLButtonElement>("favorite-provider");
const model = requiredElement<HTMLSelectElement>("model");
const favoriteModel = requiredElement<HTMLButtonElement>("favorite-model");
const modelOptions = requiredElement<HTMLElement>("model-options");
const usageDetails = requiredElement<HTMLElement>("usage-details");
let currentState: ViewState | null = null;
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
  const role = document.createElement("div");
  role.className = "role";
  role.textContent = message.role === "assistant" ? "T3 Code" : message.role;
  const parsedContext = splitEditorContext(message.text);
  const attachmentOnlyText = parsedContext.text.startsWith(
    "[User attached one or more images without additional text.",
  );
  const content = renderMarkdown(
    attachmentOnlyText && message.attachments.length > 0 ? "" : parsedContext.text,
  );
  if (message.streaming) content.classList.add("streaming");
  wrapper.append(role, content);
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

function render(next: ViewState): void {
  currentState = next;
  const wasNearBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 80;
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
  renderActiveStatus(next);

  messages.replaceChildren();
  if (draftSelection !== null) {
    messages.append(emptyMessage("Choose a provider and model, then send your first message."));
  } else if (next.activeThread === null || next.activeThread.messages.length === 0) {
    messages.append(
      emptyMessage(
        next.activeThread === null
          ? "Create or select a thread for this worktree."
          : "Start a conversation in this synchronized thread.",
      ),
    );
  } else {
    messages.append(...next.activeThread.messages.map(renderMessage));
    if (wasNearBottom) messages.scrollTop = messages.scrollHeight;
  }

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
  prompt.disabled = next.busy;
  renderComposerAction();
}

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
  return prompt.value.trim() !== "" || pendingImages.length > 0;
}

function renderComposerAction(): void {
  const stopping = isRunning() && !hasComposerInput();
  send.textContent = stopping ? "Stop" : "Send";
  send.title = stopping ? "Stop active turn" : "Send message";
  send.classList.toggle("stop-action", stopping);
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
  if (!hasComposerInput()) return;
  const images = uploadImages();
  if (draftSelection !== null) {
    post({
      type: "sendNewThread",
      text: prompt.value,
      instanceId: draftSelection.instanceId,
      model: draftSelection.model,
      options: draftSelection.options,
      images,
    });
    return;
  }
  post({ type: "send", text: prompt.value, images });
}

function positionUsageDetails(): void {
  const toggle = requiredElement<HTMLElement>("usage-toggle");
  const viewportPadding = 8;
  const width = Math.min(270, Math.max(0, globalThis.innerWidth - viewportPadding * 2));
  const toggleBounds = toggle.getBoundingClientRect();
  const left = Math.min(
    Math.max(viewportPadding, toggleBounds.right - width),
    Math.max(viewportPadding, globalThis.innerWidth - width - viewportPadding),
  );
  usageDetails.style.width = `${width}px`;
  usageDetails.style.left = `${left}px`;
  usageDetails.style.bottom = `${Math.max(viewportPadding, globalThis.innerHeight - toggleBounds.top + 7)}px`;
}

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (typeof event.data !== "object" || event.data === null || !("type" in event.data)) return;
  if (event.data.type === "state" && "state" in event.data) render(event.data.state as ViewState);
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
provider.addEventListener("change", () => {
  if (draftSelection === null || currentState === null || provider.value === "") return;
  const firstModel = currentState.models.find(
    (candidate) => candidate.instanceId === provider.value,
  );
  if (firstModel === undefined) return;
  draftSelection = { instanceId: firstModel.instanceId, model: firstModel.model, options: [] };
  render(currentState);
});
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
});
requiredElement("usage-control").addEventListener("pointerenter", positionUsageDetails);
globalThis.addEventListener("resize", positionUsageDetails);
requiredElement("new").addEventListener("click", () => {
  if (currentState === null) return;
  const active = currentSelection(currentState);
  const fallback = currentState.models[0];
  if (active === null && fallback === undefined) return;
  draftSelection = active ?? {
    instanceId: fallback!.instanceId,
    model: fallback!.model,
    options: [],
  };
  render(currentState);
  prompt.focus();
});
requiredElement("refresh").addEventListener("click", () => post({ type: "refresh" }));
contextButton.addEventListener("click", () => post({ type: "toggleContext" }));
send.addEventListener("click", () => {
  if (isRunning() && !hasComposerInput()) post({ type: "stop" });
  else submit();
});
prompt.addEventListener("input", renderComposerAction);
prompt.addEventListener("paste", (event) => {
  const images = [...(event.clipboardData?.files ?? [])].filter((file) =>
    file.type.startsWith("image/"),
  );
  if (images.length === 0) return;
  event.preventDefault();
  void addClipboardImages(images);
});
prompt.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    submit();
  }
});
post({ type: "ready" });

globalThis.setInterval(() => {
  if (currentState !== null) renderActiveStatus(currentState);
}, 1_000);
