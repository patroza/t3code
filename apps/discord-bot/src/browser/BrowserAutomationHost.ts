import * as NodeTimersPromises from "node:timers/promises";

import {
  type EnvironmentId,
  type PreviewAutomationHost,
  type PreviewAutomationHostFocus,
  type PreviewAutomationResponse,
  type PreviewAutomationStreamEvent,
  type ThreadId,
} from "@t3tools/contracts";

import type { DiscordBotConfig } from "../config.ts";
import { BrowserRuntime } from "./BrowserRuntime.ts";

const SUPPORTED_OPERATIONS = [
  "status",
  "open",
  "navigate",
  "snapshot",
  "click",
  "type",
  "press",
  "scroll",
  "evaluate",
  "waitFor",
  "recordingStart",
  "recordingStop",
] as const;

const MAX_RESPONSE_RESERVE_MS = 1_000;
const RESPONSE_RESERVE_RATIO = 0.1;

export class BrowserOperationTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Browser automation host timed out after ${timeoutMs}ms.`);
    this.name = "BrowserOperationTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export function browserOperationDeadlineMs(timeoutMs: number): number {
  const reserve = Math.min(
    MAX_RESPONSE_RESERVE_MS,
    Math.max(1, timeoutMs * RESPONSE_RESERVE_RATIO),
  );
  return Math.max(1, Math.floor(timeoutMs - reserve));
}

export function withBrowserOperationDeadline<A>(
  operation: Promise<A>,
  timeoutMs: number,
  onTimeout: () => void = () => {},
): Promise<A> {
  const deadlineMs = browserOperationDeadlineMs(timeoutMs);
  const controller = new AbortController();
  const timeout = NodeTimersPromises.setTimeout(deadlineMs, undefined, {
    signal: controller.signal,
    ref: false,
  }).then(() => {
    onTimeout();
    throw new BrowserOperationTimeoutError(deadlineMs);
  });
  return Promise.race([operation, timeout]).finally(() => controller.abort());
}

export class BrowserAutomationHost {
  readonly #runtime: BrowserRuntime;
  readonly #clientId: string;
  readonly #environmentId: EnvironmentId;
  #connectionId: PreviewAutomationHostFocus["connectionId"] | null = null;

  private constructor(runtime: BrowserRuntime, profile: string, environmentId: EnvironmentId) {
    this.#runtime = runtime;
    this.#clientId = `discord-browser-${profile}`;
    this.#environmentId = environmentId;
  }

  static async launch(
    config: DiscordBotConfig,
    environmentId: EnvironmentId,
  ): Promise<BrowserAutomationHost> {
    if (!config.browserExecutablePath) {
      throw new Error(
        "T3_DISCORD_BROWSER_EXECUTABLE_PATH is required when browser automation is enabled.",
      );
    }
    if (config.browserAllowedOrigins.length === 0) {
      throw new Error(
        "T3_DISCORD_BROWSER_ALLOWED_ORIGINS is required when browser automation is enabled.",
      );
    }
    const runtime = await BrowserRuntime.launch({
      dataDir: config.dataDir,
      profile: config.browserProfile,
      executablePath: config.browserExecutablePath,
      ffmpegPath: config.browserFfmpegPath,
      allowedOrigins: config.browserAllowedOrigins,
      headless: true,
    });
    return new BrowserAutomationHost(runtime, config.browserProfile, environmentId);
  }

  registration(): PreviewAutomationHost {
    return {
      clientId: this.#clientId,
      environmentId: this.#environmentId,
      supportedOperations: [...SUPPORTED_OPERATIONS],
    };
  }

  async consume(event: PreviewAutomationStreamEvent): Promise<PreviewAutomationResponse | null> {
    if (event.type === "connected") {
      this.#connectionId = event.connectionId;
      return null;
    }
    const responseBase = {
      clientId: this.#clientId,
      connectionId: event.connectionId,
      requestId: event.request.requestId,
    } as const;
    let response: PreviewAutomationResponse;
    try {
      const result = await withBrowserOperationDeadline(
        this.#runtime.handle(event.request),
        event.request.timeoutMs,
        () => this.#runtime.interrupt(event.request),
      );
      response = { ...responseBase, ok: true, ...(result === undefined ? {} : { result }) };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Browser automation failed.";
      response = {
        ...responseBase,
        ok: false,
        error: {
          _tag:
            cause instanceof BrowserOperationTimeoutError
              ? "PreviewAutomationTimeoutError"
              : "PreviewAutomationExecutionError",
          message,
        },
      };
    }
    return response;
  }

  claim(threadId: ThreadId): PreviewAutomationHostFocus | null {
    if (this.#connectionId === null) return null;
    return {
      clientId: this.#clientId,
      environmentId: this.#environmentId,
      connectionId: this.#connectionId,
      focused: true,
      threadId,
    };
  }

  close(): Promise<void> {
    return this.#runtime.close();
  }
}
