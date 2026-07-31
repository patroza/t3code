// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  PreviewTabId,
  type PreviewAutomationClickInput,
  type PreviewAutomationEvaluateInput,
  type PreviewAutomationNavigateInput,
  type PreviewAutomationOpenInput,
  type PreviewAutomationPressInput,
  type PreviewAutomationRequest,
  type PreviewAutomationScrollInput,
  type PreviewAutomationSnapshot,
  type PreviewAutomationTypeInput,
  type PreviewAutomationWaitForInput,
} from "@t3tools/contracts";
import { chromium, type BrowserContext, type Page } from "playwright-core";

import { BrowserRecording } from "./BrowserRecording.ts";
import { acquireProfileLock, profilePaths, readProfileMetadata } from "./ProfileStore.ts";

const MAX_VISIBLE_TEXT = 50_000;
const MAX_INTERACTIVE_ELEMENTS = 200;
const MAX_SCREENSHOT_WIDTH = 1_600;
export const MAX_RETAINED_BROWSER_TABS_PER_THREAD = 4;
export const MAX_RETAINED_BROWSER_TABS_TOTAL = 12;

type SnapshotPageState = Pick<
  PreviewAutomationSnapshot,
  "url" | "title" | "loading" | "visibleText" | "interactiveElements"
>;

// Keep this as browser-native source. Runtime transpilers otherwise inject
// helpers into nested callbacks that are unavailable in the page context.
const SNAPSHOT_PAGE_STATE_EXPRESSION = `(() => {
  const maxText = ${MAX_VISIBLE_TEXT};
  const maxElements = ${MAX_INTERACTIVE_ELEMENTS};
  const visible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== "hidden" &&
      style.display !== "none" &&
      rect.width > 0 &&
      rect.height > 0;
  };
  const selectorFor = (element) => {
    if (element.id) return "#" + CSS.escape(element.id);
    for (const attribute of ["data-testid", "name"]) {
      const value = element.getAttribute(attribute);
      if (value) {
        return element.tagName.toLowerCase() +
          "[" + attribute + "=" + JSON.stringify(value) + "]";
      }
    }
    const parts = [];
    let current = element;
    while (current && parts.length < 8) {
      const siblings = current.parentElement
        ? Array.from(current.parentElement.children).filter(
            (sibling) => sibling.tagName === current.tagName,
          )
        : [];
      const base = current.tagName.toLowerCase();
      parts.unshift(
        siblings.length > 1
          ? base + ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")"
          : base,
      );
      current = current.parentElement;
    }
    return parts.join(" > ");
  };
  const elements = Array.from(document.querySelectorAll(
    "a[href],button,input,textarea,select,[role],[tabindex]",
  ))
    .filter(visible)
    .slice(0, maxElements)
    .map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute("role"),
        name: element.getAttribute("aria-label") ||
          element.innerText ||
          element.getAttribute("name") ||
          "",
        selector: selectorFor(element),
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      };
    });
  return {
    url: location.href,
    title: document.title,
    loading: document.readyState !== "complete",
    visibleText: (document.body?.innerText || "").slice(0, maxText),
    interactiveElements: elements,
  };
})()`;

export async function readSnapshotPageState(page: Page): Promise<SnapshotPageState> {
  return (await page.evaluate(SNAPSHOT_PAGE_STATE_EXPRESSION)) as SnapshotPageState;
}

export async function captureScreenshotWithCdp(page: Page): Promise<string> {
  const session = await page.context().newCDPSession(page);
  try {
    const result = await session.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
    });
    return result.data;
  } finally {
    await session.detach().catch(() => {});
  }
}

export async function saveScreenshotArtifact(dataDir: string, source: string): Promise<string> {
  const artifactsDirectory = NodePath.join(dataDir, "browser", "artifacts");
  const outputPath = NodePath.join(artifactsDirectory, `snapshot-${NodeCrypto.randomUUID()}.png`);
  await NodeFSP.mkdir(artifactsDirectory, { recursive: true, mode: 0o700 });
  await NodeFSP.writeFile(outputPath, source, { encoding: "base64", mode: 0o600 });
  return outputPath;
}

export async function browserStatusForPage(
  tabId: string | null,
  page: Page | undefined,
): Promise<unknown> {
  const available = page !== undefined && !page.isClosed();
  const viewport = available ? page.viewportSize() : null;
  return {
    available,
    visible: false,
    tabId: available ? PreviewTabId.make(tabId!) : null,
    url: available ? page.url() : null,
    title: available ? await page.title() : null,
    loading: false,
    ...(viewport === null ? {} : { viewport }),
  };
}

export function browserTabsToEvict(
  tabsByLeastRecentUse: ReadonlyArray<{ readonly tabId: string; readonly threadId: string }>,
  protectedTabIds: ReadonlySet<string>,
  maximumTabsPerThread = MAX_RETAINED_BROWSER_TABS_PER_THREAD,
  maximumTabsTotal = MAX_RETAINED_BROWSER_TABS_TOTAL,
): ReadonlyArray<string> {
  const evictions = new Set<string>();
  const threadIds = new Set(tabsByLeastRecentUse.map((tab) => tab.threadId));
  for (const threadId of threadIds) {
    const threadTabs = tabsByLeastRecentUse.filter((tab) => tab.threadId === threadId);
    let excess = Math.max(0, threadTabs.length - maximumTabsPerThread);
    for (const { tabId } of threadTabs) {
      if (excess === 0) break;
      if (protectedTabIds.has(tabId)) continue;
      evictions.add(tabId);
      excess -= 1;
    }
  }
  let totalExcess = Math.max(0, tabsByLeastRecentUse.length - evictions.size - maximumTabsTotal);
  for (const { tabId } of tabsByLeastRecentUse) {
    if (totalExcess === 0) break;
    if (evictions.has(tabId) || protectedTabIds.has(tabId)) continue;
    evictions.add(tabId);
    totalExcess -= 1;
  }
  return [...evictions];
}

export interface BrowserRuntimeOptions {
  readonly dataDir: string;
  readonly profile: string;
  readonly executablePath: string;
  readonly ffmpegPath: string;
  readonly allowedOrigins: ReadonlyArray<string>;
  readonly headless: boolean;
}

export class BrowserRuntimeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "BrowserRuntimeError";
  }
}

export function normalizeBrowserUrl(input: string): URL {
  const trimmed = input.trim();
  const candidate = /^[a-z][a-z\d+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch (cause) {
    throw new BrowserRuntimeError(`Invalid browser URL: ${trimmed}`, { cause });
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new BrowserRuntimeError(`Browser navigation only supports HTTP(S), not ${url.protocol}`);
  }
  return url;
}

function wildcardPattern(pattern: string): RegExp {
  return new RegExp(
    `^${pattern.replace(/[|\\{}()[\]^$+?.]/g, "\\$&").replaceAll("*", ".*")}$`,
    "i",
  );
}

export function matchesExpectedUrl(actual: string, expected: string): boolean {
  return wildcardPattern(expected).test(actual);
}

export function assertUrlAllowed(url: URL, allowedOrigins: ReadonlyArray<string>): void {
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol === "http:" && !loopback) {
    throw new BrowserRuntimeError("Plain HTTP browser navigation is restricted to loopback hosts.");
  }
  if (allowedOrigins.length === 0) return;
  if (!allowedOrigins.some((pattern) => wildcardPattern(pattern).test(url.origin))) {
    throw new BrowserRuntimeError(`Browser navigation to origin ${url.origin} is not allowed.`);
  }
}

function requestUrl(input: PreviewAutomationNavigateInput): string {
  if (input.target?.kind === "environment-port") {
    throw new BrowserRuntimeError(
      "Project-server navigation is not supported by the Discord browser host yet; pass a URL.",
    );
  }
  const url = input.target?.kind === "url" ? input.target.url : input.url;
  if (url === undefined) throw new BrowserRuntimeError("Navigate requires a URL.");
  return url;
}

function locatorFor(
  page: Page,
  input: { selector?: string | undefined; locator?: string | undefined },
) {
  if (input.locator !== undefined) return page.locator(input.locator);
  if (input.selector !== undefined) return page.locator(input.selector);
  return null;
}

export class BrowserRuntime {
  readonly #context: BrowserContext;
  readonly #releaseLock: () => Promise<void>;
  readonly #allowedOrigins: ReadonlyArray<string>;
  readonly #dataDir: string;
  readonly #ffmpegPath: string;
  readonly #pages = new Map<string, Page>();
  readonly #tabThreads = new Map<string, string>();
  readonly #busyTabs = new Map<string, number>();
  #recording: BrowserRecording | null = null;
  #activeTabId: string | null = null;
  #closed = false;

  private constructor(input: {
    context: BrowserContext;
    releaseLock: () => Promise<void>;
    allowedOrigins: ReadonlyArray<string>;
    dataDir: string;
    ffmpegPath: string;
  }) {
    this.#context = input.context;
    this.#releaseLock = input.releaseLock;
    this.#allowedOrigins = input.allowedOrigins;
    this.#dataDir = input.dataDir;
    this.#ffmpegPath = input.ffmpegPath;
  }

  static async launch(options: BrowserRuntimeOptions): Promise<BrowserRuntime> {
    const paths = profilePaths(options.dataDir, options.profile);
    const metadata = await readProfileMetadata(paths);
    if (metadata.browserExecutablePath !== options.executablePath) {
      throw new BrowserRuntimeError(
        `Profile ${options.profile} was created with ${metadata.browserExecutablePath}; use the same browser executable.`,
      );
    }
    const releaseLock = await acquireProfileLock(paths);
    let context: BrowserContext | null = null;
    try {
      context = await chromium.launchPersistentContext(paths.userDataDir, {
        executablePath: options.executablePath,
        headless: options.headless,
        viewport: { width: 1_440, height: 900 },
      });
      if (!metadata.verifyUrl || !metadata.expectUrl) {
        await context.close();
        throw new BrowserRuntimeError(
          `Profile ${options.profile} is unverified; rerun headed setup with --verify-url and --expect-url.`,
        );
      }
      const verificationUrl = normalizeBrowserUrl(metadata.verifyUrl);
      assertUrlAllowed(verificationUrl, options.allowedOrigins);
      const verificationPage = context.pages()[0] ?? (await context.newPage());
      await verificationPage.goto(verificationUrl.toString(), {
        waitUntil: "domcontentloaded",
        timeout: 15_000,
      });
      if (!matchesExpectedUrl(verificationPage.url(), metadata.expectUrl)) {
        await context.close();
        throw new BrowserRuntimeError(
          `Profile ${options.profile} is no longer authenticated; rerun headed setup.`,
        );
      }
      await verificationPage.close();
      return new BrowserRuntime({
        context,
        releaseLock,
        allowedOrigins: options.allowedOrigins,
        dataDir: options.dataDir,
        ffmpegPath: options.ffmpegPath,
      });
    } catch (cause) {
      await context?.close().catch(() => {});
      await releaseLock();
      if (cause instanceof BrowserRuntimeError) throw cause;
      throw new BrowserRuntimeError(`Could not launch browser profile ${options.profile}.`, {
        cause,
      });
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      await this.#recording?.abort().catch(() => {});
      this.#recording = null;
      await this.#context.close();
    } finally {
      this.#pages.clear();
      this.#tabThreads.clear();
      this.#busyTabs.clear();
      await this.#releaseLock();
    }
  }

  interrupt(request: PreviewAutomationRequest): void {
    const tabId = request.tabId ?? this.#activeTabId;
    if (tabId === null) return;
    const page = this.#pages.get(tabId);
    this.#pages.delete(tabId);
    this.#tabThreads.delete(tabId);
    if (this.#activeTabId === tabId) this.#activeTabId = null;
    if (this.#recording?.isForTab(tabId)) {
      const recording = this.#recording;
      this.#recording = null;
      void recording.abort().catch(() => {});
    }
    // Closing the target interrupts pending CDP and Playwright commands. Do
    // not await it here: the timeout response must still beat the broker.
    void page?.close({ runBeforeUnload: false }).catch(() => {});
  }

  #touchTab(tabId: string, page: Page): void {
    this.#pages.delete(tabId);
    this.#pages.set(tabId, page);
  }

  #markTabBusy(tabId: string): void {
    this.#busyTabs.set(tabId, (this.#busyTabs.get(tabId) ?? 0) + 1);
  }

  #releaseBusyTab(tabId: string): void {
    const remaining = (this.#busyTabs.get(tabId) ?? 1) - 1;
    if (remaining === 0) this.#busyTabs.delete(tabId);
    else this.#busyTabs.set(tabId, remaining);
  }

  async #enforceTabLimit(): Promise<void> {
    const protectedTabIds = new Set(this.#busyTabs.keys());
    for (const tabId of this.#pages.keys()) {
      if (this.#recording?.isForTab(tabId)) protectedTabIds.add(tabId);
    }
    const tabs = [...this.#pages.keys()].flatMap((tabId) => {
      const threadId = this.#tabThreads.get(tabId);
      return threadId === undefined ? [] : [{ tabId, threadId }];
    });
    const evictions = browserTabsToEvict(tabs, protectedTabIds);
    for (const tabId of evictions) {
      const page = this.#pages.get(tabId);
      this.#pages.delete(tabId);
      this.#tabThreads.delete(tabId);
      if (this.#activeTabId === tabId) this.#activeTabId = null;
      await page?.close({ runBeforeUnload: false }).catch(() => {});
    }
  }

  #page(tabId?: string): Page {
    const id = tabId ?? this.#activeTabId;
    const page = id === null ? undefined : this.#pages.get(id);
    if (id === null || page === undefined || page.isClosed()) {
      throw new BrowserRuntimeError(
        id === null ? "No browser tab is open." : `Browser tab ${id} was not found.`,
      );
    }
    this.#activeTabId = id;
    this.#touchTab(id, page);
    return page;
  }

  async #open(
    input: PreviewAutomationOpenInput,
    threadId: string,
    requestedTabId?: string,
  ): Promise<unknown> {
    const reusableId = requestedTabId ?? this.#activeTabId;
    let page = input.reuseExistingTab === false ? undefined : this.#pages.get(reusableId ?? "");
    let tabId = reusableId;
    if (page === undefined || page.isClosed()) {
      page = await this.#context.newPage();
      const createdTabId = PreviewTabId.make(`tab-discord-${NodeCrypto.randomUUID()}`);
      tabId = createdTabId;
      this.#pages.set(createdTabId, page);
      this.#tabThreads.set(createdTabId, threadId);
      page.once("close", () => {
        this.#pages.delete(createdTabId);
        this.#tabThreads.delete(createdTabId);
        if (this.#recording?.isForTab(createdTabId)) {
          const recording = this.#recording;
          this.#recording = null;
          void recording.abort().catch(() => {});
        }
      });
    }
    this.#tabThreads.set(tabId!, threadId);
    this.#activeTabId = tabId!;
    this.#touchTab(tabId!, page);
    this.#markTabBusy(tabId!);
    try {
      if (input.url !== undefined) await this.#navigate(page, input.url, "load", 15_000);
      return this.#status(tabId!);
    } finally {
      this.#releaseBusyTab(tabId!);
    }
  }

  async #navigate(
    page: Page,
    rawUrl: string,
    readiness: "load" | "domcontentloaded" | "networkidle" | "commit" = "load",
    timeout = 15_000,
  ): Promise<void> {
    const url = normalizeBrowserUrl(rawUrl);
    assertUrlAllowed(url, this.#allowedOrigins);
    await page.goto(url.toString(), { waitUntil: readiness, timeout });
  }

  async #status(tabId?: string): Promise<unknown> {
    const id = tabId ?? this.#activeTabId;
    const page = id === null ? undefined : this.#pages.get(id);
    if (id !== null && page !== undefined && !page.isClosed()) this.#touchTab(id, page);
    return browserStatusForPage(id, page);
  }

  async #snapshot(page: Page): Promise<PreviewAutomationSnapshot> {
    const pageState = await readSnapshotPageState(page);
    const accessibilityTree = await page
      .locator("body")
      .ariaSnapshot({ timeout: 5_000 })
      .catch(() => "");
    // Playwright's screenshot wrapper waits for document.fonts.ready. Some
    // authenticated apps leave that promise pending, so capture through CDP.
    const source = await captureScreenshotWithCdp(page);
    const artifactPath = await saveScreenshotArtifact(this.#dataDir, source);
    const viewport = page.viewportSize() ?? { width: 1_440, height: 900 };
    return {
      ...pageState,
      accessibilityTree,
      consoleEntries: [],
      networkEntries: [],
      actionTimeline: [],
      screenshot: {
        mimeType: "image/png",
        data: source,
        width: Math.min(viewport.width, MAX_SCREENSHOT_WIDTH),
        height: viewport.height,
        path: artifactPath,
      },
    };
  }

  async handle(request: PreviewAutomationRequest): Promise<unknown> {
    const busyTabId = request.operation === "open" ? null : (request.tabId ?? this.#activeTabId);
    if (busyTabId !== null) {
      if (this.#pages.has(busyTabId)) this.#tabThreads.set(busyTabId, request.threadId);
      this.#markTabBusy(busyTabId);
    }
    try {
      return await this.#handle(request);
    } finally {
      if (busyTabId !== null) {
        const page = this.#pages.get(busyTabId);
        if (page !== undefined && !page.isClosed()) this.#touchTab(busyTabId, page);
        this.#releaseBusyTab(busyTabId);
      }
      await this.#enforceTabLimit();
    }
  }

  async #handle(request: PreviewAutomationRequest): Promise<unknown> {
    const timeout = request.timeoutMs;
    switch (request.operation) {
      case "status":
        return this.#status(request.tabId);
      case "open":
        return this.#open(
          request.input as PreviewAutomationOpenInput,
          request.threadId,
          request.tabId,
        );
      case "navigate": {
        const input = request.input as PreviewAutomationNavigateInput;
        const page = this.#page(request.tabId);
        const readiness =
          input.readiness === "domContentLoaded"
            ? "domcontentloaded"
            : input.readiness === "none"
              ? "commit"
              : input.readiness;
        await this.#navigate(page, requestUrl(input), readiness, input.timeoutMs ?? timeout);
        return this.#status(request.tabId);
      }
      case "snapshot":
        return this.#snapshot(this.#page(request.tabId));
      case "click": {
        const input = request.input as PreviewAutomationClickInput;
        const page = this.#page(request.tabId);
        const locator = locatorFor(page, input);
        if (locator !== null) await locator.click({ timeout: input.timeoutMs ?? timeout });
        else await page.mouse.click(input.x!, input.y!);
        return { clicked: true };
      }
      case "type": {
        const input = request.input as PreviewAutomationTypeInput;
        const page = this.#page(request.tabId);
        const locator = locatorFor(page, input) ?? page.locator(":focus");
        if (input.clear) await locator.fill(input.text, { timeout: input.timeoutMs ?? timeout });
        else await locator.pressSequentially(input.text, { timeout: input.timeoutMs ?? timeout });
        return { typed: true };
      }
      case "press": {
        const input = request.input as PreviewAutomationPressInput;
        const key = [...(input.modifiers ?? []), input.key].join("+");
        await this.#page(request.tabId).keyboard.press(key);
        return { pressed: true };
      }
      case "scroll": {
        const input = request.input as PreviewAutomationScrollInput;
        const page = this.#page(request.tabId);
        const x = input.deltaX ?? 0;
        const y = input.deltaY ?? 0;
        const locator = locatorFor(page, input);
        if (locator === null) await page.mouse.wheel(x, y);
        else
          await locator.evaluate((element, delta) => element.scrollBy(delta.x, delta.y), { x, y });
        return { scrolled: true };
      }
      case "evaluate": {
        const input = request.input as PreviewAutomationEvaluateInput;
        return this.#page(request.tabId).evaluate(input.expression);
      }
      case "waitFor": {
        const input = request.input as PreviewAutomationWaitForInput;
        const page = this.#page(request.tabId);
        const waits: Array<Promise<unknown>> = [];
        const locator = locatorFor(page, input);
        if (locator !== null)
          waits.push(locator.waitFor({ state: "visible", timeout: input.timeoutMs ?? timeout }));
        if (input.text !== undefined)
          waits.push(
            page
              .getByText(input.text, { exact: false })
              .first()
              .waitFor({ timeout: input.timeoutMs ?? timeout }),
          );
        if (input.urlIncludes !== undefined)
          waits.push(
            page.waitForURL((url) => url.toString().includes(input.urlIncludes!), {
              timeout: input.timeoutMs ?? timeout,
            }),
          );
        await Promise.all(waits);
        return this.#status(request.tabId);
      }
      case "recordingStart":
        if (this.#recording !== null) {
          throw new BrowserRuntimeError("A browser recording is already active.");
        }
        {
          const tabId = request.tabId ?? this.#activeTabId;
          const page = this.#page(request.tabId);
          if (tabId === null) throw new BrowserRuntimeError("No browser tab is open.");
          this.#recording = await BrowserRecording.start({
            page,
            tabId: PreviewTabId.make(tabId),
            dataDir: this.#dataDir,
            ffmpegPath: this.#ffmpegPath,
          });
          return this.#recording.status();
        }
      case "recordingStop": {
        const recording = this.#recording;
        if (recording === null || !recording.isForTab(request.tabId)) {
          throw new BrowserRuntimeError("No browser recording is active for this tab.");
        }
        this.#recording = null;
        return recording.stop();
      }
      case "resize":
        throw new BrowserRuntimeError(
          `The Discord browser host does not support ${request.operation}.`,
        );
    }
  }
}
