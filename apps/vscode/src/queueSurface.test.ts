// @effect-diagnostics nodeBuiltinImport:off - existence contract reads extension source on disk.
import * as NodeFS from "node:fs";
import { describe, expect, it } from "vite-plus/test";

const webviewSource = NodeFS.readFileSync(new URL("./webview.ts", import.meta.url), "utf8");
const providerSource = NodeFS.readFileSync(
  new URL("./chatViewProvider.ts", import.meta.url),
  "utf8",
);
const clientSource = NodeFS.readFileSync(new URL("./t3Client.ts", import.meta.url), "utf8");

describe("VS Code queue / steer surface (align with web/mobile)", () => {
  it("labels send-now and dequeues before edit", () => {
    expect(webviewSource).toContain('textContent = "Send now"');
    expect(webviewSource).toContain('ariaLabel = "Send queued message now"');
    expect(webviewSource).toContain("Remove from queue and edit in composer");
    expect(webviewSource).toContain('post({ type: "removeQueuedMessage", messageId })');
    // Edit no longer persists via queue.update — resubmit is a normal send.
    expect(webviewSource).not.toContain('type: "updateQueuedMessage"');
  });

  it("optimistically steers and predicts queue-bound sends", () => {
    expect(webviewSource).toContain("sendEntersSteeringQueue");
    expect(webviewSource).toContain("steeringQueuedMessageIds");
    expect(webviewSource).toContain("optimisticSteeredMessages");
    expect(webviewSource).toContain("pendingQueuedMessages");
    expect(webviewSource).toContain("willSendEnterSteeringQueue");
    expect(providerSource).toContain("sessionStatus: thread.session?.status ?? null");
    expect(providerSource).toContain("hasPendingTurnStart: thread.pendingTurnStart !== null");
    expect(clientSource).toContain("input.messageId ?? newMessageId()");
  });
});
