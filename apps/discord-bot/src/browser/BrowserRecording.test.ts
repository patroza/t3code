// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { ffmpegRecordingArguments } from "./BrowserRecording.ts";

describe("browser recording", () => {
  it("builds a shell-free MP4 encoding command", () => {
    const args = ffmpegRecordingArguments({
      framesDirectory: "/tmp/browser frames",
      outputPath: "/tmp/artifacts/recording.mp4",
    });

    expect(args).toContain(NodePath.join("/tmp/browser frames", "frame-%08d.jpg"));
    expect(args).toContain("libx264");
    expect(args).toContain("yuv420p");
    expect(args.at(-1)).toBe("/tmp/artifacts/recording.mp4");
  });
});
