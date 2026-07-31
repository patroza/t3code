// @effect-diagnostics globalDate:off nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type {
  PreviewAutomationRecordingArtifact,
  PreviewAutomationRecordingStatus,
  PreviewTabId,
} from "@t3tools/contracts";
import type { CDPSession, Page } from "playwright-core";

import { expandHome } from "./ProfileStore.ts";

const RECORDING_FRAME_RATE = 15;
const MAX_RECORDING_FRAMES = RECORDING_FRAME_RATE * 60 * 10;
const MAX_FFMPEG_ERROR_BYTES = 8_192;

interface ScreencastFrame {
  readonly data: string;
  readonly sessionId: number;
  readonly metadata?: {
    readonly timestamp?: number;
  };
}

export class BrowserRecordingError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "BrowserRecordingError";
  }
}

export function ffmpegRecordingArguments(input: {
  readonly framesDirectory: string;
  readonly outputPath: string;
}): ReadonlyArray<string> {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-framerate",
    String(RECORDING_FRAME_RATE),
    "-start_number",
    "1",
    "-i",
    NodePath.join(input.framesDirectory, "frame-%08d.jpg"),
    "-vf",
    "scale=in_range=pc:out_range=tv,pad=ceil(iw/2)*2:ceil(ih/2)*2",
    "-an",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    input.outputPath,
  ];
}

export async function encodeBrowserRecordingFrames(
  executablePath: string,
  framesDirectory: string,
  outputPath: string,
): Promise<void> {
  const args = ffmpegRecordingArguments({ framesDirectory, outputPath });
  await new Promise<void>((resolve, reject) => {
    const child = NodeChildProcess.spawn(executablePath, args, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let errorOutput = "";
    child.stderr.on("data", (chunk: Buffer) => {
      if (errorOutput.length < MAX_FFMPEG_ERROR_BYTES) {
        errorOutput += chunk.toString("utf8").slice(0, MAX_FFMPEG_ERROR_BYTES - errorOutput.length);
      }
    });
    child.once("error", (cause) => {
      reject(
        new BrowserRecordingError(
          `Could not start ffmpeg at ${executablePath}; configure T3_DISCORD_BROWSER_FFMPEG_PATH.`,
          { cause },
        ),
      );
    });
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else {
        reject(
          new BrowserRecordingError(
            `ffmpeg failed (${signal ?? `exit ${code ?? "unknown"}`}): ${errorOutput.trim() || "no diagnostics"}`,
          ),
        );
      }
    });
  });
}

export class BrowserRecording {
  readonly #tabId: PreviewTabId;
  readonly #id: string;
  readonly #startedAt: string;
  readonly #session: CDPSession;
  readonly #framesDirectory: string;
  readonly #outputPath: string;
  readonly #ffmpegPath: string;
  readonly #onFrame: (frame: ScreencastFrame) => void;
  #frameCount = 0;
  #writeChain = Promise.resolve();
  #writeError: unknown = null;
  #lastFrameTimestamp: number | null = null;
  #finished = false;

  private constructor(input: {
    tabId: PreviewTabId;
    id: string;
    startedAt: string;
    session: CDPSession;
    framesDirectory: string;
    outputPath: string;
    ffmpegPath: string;
  }) {
    this.#tabId = input.tabId;
    this.#id = input.id;
    this.#startedAt = input.startedAt;
    this.#session = input.session;
    this.#framesDirectory = input.framesDirectory;
    this.#outputPath = input.outputPath;
    this.#ffmpegPath = input.ffmpegPath;
    this.#onFrame = (frame) => {
      void this.#session
        .send("Page.screencastFrameAck", { sessionId: frame.sessionId })
        .catch(() => {});
      if (this.#frameCount >= MAX_RECORDING_FRAMES || this.#finished) return;
      const timestamp = frame.metadata?.timestamp;
      if (
        timestamp !== undefined &&
        this.#lastFrameTimestamp !== null &&
        timestamp - this.#lastFrameTimestamp < 1 / RECORDING_FRAME_RATE
      ) {
        return;
      }
      if (timestamp !== undefined) this.#lastFrameTimestamp = timestamp;
      this.#frameCount += 1;
      const framePath = NodePath.join(
        this.#framesDirectory,
        `frame-${String(this.#frameCount).padStart(8, "0")}.jpg`,
      );
      this.#writeChain = this.#writeChain
        .then(() =>
          NodeFSP.writeFile(framePath, Buffer.from(frame.data, "base64"), { mode: 0o600 }),
        )
        .catch((cause) => {
          this.#writeError ??= cause;
        });
    };
  }

  static async start(input: {
    readonly page: Page;
    readonly tabId: PreviewTabId;
    readonly dataDir: string;
    readonly ffmpegPath: string;
  }): Promise<BrowserRecording> {
    const id = `browser-recording-${NodeCrypto.randomUUID()}`;
    const browserRoot = NodePath.join(expandHome(input.dataDir), "browser");
    const framesDirectory = NodePath.join(browserRoot, "recordings", id);
    const artifactsDirectory = NodePath.join(browserRoot, "artifacts");
    const outputPath = NodePath.join(artifactsDirectory, `${id}.mp4`);
    await Promise.all([
      NodeFSP.mkdir(framesDirectory, { recursive: true, mode: 0o700 }),
      NodeFSP.mkdir(artifactsDirectory, { recursive: true, mode: 0o700 }),
    ]);
    let session: CDPSession;
    try {
      session = await input.page.context().newCDPSession(input.page);
    } catch (cause) {
      await NodeFSP.rm(framesDirectory, { recursive: true, force: true });
      throw new BrowserRecordingError("Could not attach to the browser tab for recording.", {
        cause,
      });
    }
    const recording = new BrowserRecording({
      tabId: input.tabId,
      id,
      startedAt: new Date().toISOString(),
      session,
      framesDirectory,
      outputPath,
      ffmpegPath: input.ffmpegPath,
    });
    session.on("Page.screencastFrame", recording.#onFrame);
    try {
      await session.send("Page.enable");
      await session.send("Page.startScreencast", {
        format: "jpeg",
        quality: 80,
        maxWidth: 1_600,
        maxHeight: 1_200,
        everyNthFrame: 1,
      });
      return recording;
    } catch (cause) {
      session.off("Page.screencastFrame", recording.#onFrame);
      await session.detach().catch(() => {});
      await NodeFSP.rm(framesDirectory, { recursive: true, force: true });
      throw new BrowserRecordingError("Could not start Chromium screencast recording.", { cause });
    }
  }

  status(): PreviewAutomationRecordingStatus {
    return {
      tabId: this.#tabId,
      recording: true,
      startedAt: this.#startedAt,
    };
  }

  async stop(): Promise<PreviewAutomationRecordingArtifact> {
    if (this.#finished) throw new BrowserRecordingError("Browser recording is already stopped.");
    this.#finished = true;
    this.#session.off("Page.screencastFrame", this.#onFrame);
    await this.#session.send("Page.stopScreencast").catch(() => {});
    await this.#session.detach().catch(() => {});
    await this.#writeChain;
    try {
      if (this.#writeError !== null) {
        throw new BrowserRecordingError("Could not write browser recording frames.", {
          cause: this.#writeError,
        });
      }
      if (this.#frameCount === 0) {
        throw new BrowserRecordingError("Browser recording captured no frames.");
      }
      await encodeBrowserRecordingFrames(this.#ffmpegPath, this.#framesDirectory, this.#outputPath);
      await NodeFSP.chmod(this.#outputPath, 0o600);
      const file = await NodeFSP.stat(this.#outputPath);
      return {
        id: this.#id,
        tabId: this.#tabId,
        path: this.#outputPath,
        mimeType: "video/mp4",
        sizeBytes: file.size,
        createdAt: new Date().toISOString(),
      };
    } finally {
      await NodeFSP.rm(this.#framesDirectory, { recursive: true, force: true });
    }
  }

  async abort(): Promise<void> {
    if (this.#finished) return;
    this.#finished = true;
    this.#session.off("Page.screencastFrame", this.#onFrame);
    await this.#session.send("Page.stopScreencast").catch(() => {});
    await this.#session.detach().catch(() => {});
    await this.#writeChain;
    await NodeFSP.rm(this.#framesDirectory, { recursive: true, force: true });
  }

  isForTab(tabId: string | undefined): boolean {
    return tabId === undefined || tabId === this.#tabId;
  }
}
