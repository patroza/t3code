/* oxlint-disable no-unsanitized/property, unicorn/require-post-message-target-origin -- Markdown is sanitized; VS Code's postMessage API has no targetOrigin argument. */
// @effect-diagnostics globalTimers:off
import DOMPurify from "dompurify";
import { marked } from "marked";

interface VsCodeApi {
  readonly postMessage: (message: unknown) => void;
}

declare function acquireVsCodeApi(): VsCodeApi;

interface ViewThread {
  readonly id: string;
  readonly title: string;
  readonly model: string;
  readonly state: string;
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
    readonly state: string;
    readonly messages: ReadonlyArray<ViewMessage>;
  };
  readonly models: ReadonlyArray<{
    readonly instanceId: string;
    readonly model: string;
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
  readonly contextEnabled: boolean;
  readonly editorContext: null | {
    readonly path: string;
    readonly startLine: number;
    readonly endLine: number;
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
const provider = requiredElement<HTMLSelectElement>("provider");
const model = requiredElement<HTMLSelectElement>("model");
const modelOptions = requiredElement<HTMLElement>("model-options");
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
  const attachmentOnlyText = message.text.startsWith(
    "[User attached one or more images without additional text.",
  );
  const content = renderMarkdown(
    attachmentOnlyText && message.attachments.length > 0 ? "" : message.text,
  );
  if (message.streaming) content.classList.add("streaming");
  wrapper.append(role, content);
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
      option.textContent = `${thread.title} · ${thread.state}`;
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
      option.textContent = `${thread.title} · ${thread.state}`;
      option.selected = thread.id === next.activeThread?.id;
      threads.append(option);
    }
  }
  threads.disabled = next.busy;
  status.className = next.error === null ? "" : "error";
  status.textContent = next.error ?? (next.busy ? "Synchronizing…" : "");

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
  contextButton.textContent = next.contextEnabled ? "◉ Context" : "○ Context";
  contextLabel.textContent =
    next.contextEnabled && editorContext !== null
      ? `${editorContext.path}:${editorContext.startLine}${editorContext.endLine === editorContext.startLine ? "" : `-${editorContext.endLine}`}`
      : next.contextEnabled
        ? "No active editor"
        : "Off";
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
    const providers = new Map<string, string>();
    for (const candidate of next.models) {
      providers.set(candidate.instanceId, candidate.providerLabel);
    }
    for (const [instanceId, label] of providers) {
      const option = document.createElement("option");
      option.value = instanceId;
      option.textContent = label;
      option.selected = instanceId === selection.instanceId;
      provider.append(option);
    }
    for (const candidate of next.models.filter(
      (candidate) => candidate.instanceId === selection.instanceId,
    )) {
      const option = document.createElement("option");
      option.value = candidate.model;
      option.textContent = candidate.modelLabel;
      option.selected = candidate.model === selection.model;
      model.append(option);
    }
  }
  renderModelOptions(next);
  const running = draftSelection === null && next.activeThread?.state === "running";
  provider.disabled = selection === null || draftSelection === null || next.busy;
  model.disabled = selection === null || running || next.busy;
  send.disabled = next.busy;
  prompt.disabled = next.busy;
  renderComposerAction();
}

function isRunning(): boolean {
  return draftSelection === null && currentState?.activeThread?.state === "running";
}

function hasComposerInput(): boolean {
  return prompt.value.trim() !== "" || pendingImages.length > 0;
}

function renderComposerAction(): void {
  const stopping = isRunning() && !hasComposerInput();
  send.textContent = stopping ? "Stop" : "Send";
  send.title = stopping ? "Stop active turn" : "Send message";
  send.classList.toggle("stop-action", stopping);
  const wasWorking = status.classList.contains("working");
  if (isRunning() && (status.textContent === "" || wasWorking)) {
    status.textContent = "Working";
    status.classList.add("working");
  } else {
    status.classList.remove("working");
    if (wasWorking && status.textContent === "Working") status.textContent = "";
  }
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
    title.textContent = descriptor.label;
    label.append(title);
    if (descriptor.type === "select") {
      const select = document.createElement("select");
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
