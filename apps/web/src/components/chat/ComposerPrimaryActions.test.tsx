import { describe, expect, it } from "vite-plus/test";
import { shouldDisableCollapsedComposerSubmitAction } from "./ComposerPrimaryActions";

describe("shouldDisableCollapsedComposerSubmitAction", () => {
  it("keeps the collapsed mobile submit button disabled while a turn is running", () => {
    expect(
      shouldDisableCollapsedComposerSubmitAction({
        isRunning: true,
        isSendBusy: false,
        isConnecting: false,
        hasSendableContent: true,
      }),
    ).toBe(true);
  });

  it("enables the collapsed mobile submit button once the thread is idle", () => {
    expect(
      shouldDisableCollapsedComposerSubmitAction({
        isRunning: false,
        isSendBusy: false,
        isConnecting: false,
        hasSendableContent: true,
      }),
    ).toBe(false);
  });
});
