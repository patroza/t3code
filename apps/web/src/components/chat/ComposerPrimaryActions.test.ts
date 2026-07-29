import { describe, expect, it } from "vite-plus/test";

import {
  formatPendingPrimaryActionLabel,
  shouldDisableCollapsedComposerSubmitAction,
  shouldShowComposerInterruptAction,
} from "./ComposerPrimaryActions";

describe("shouldShowComposerInterruptAction", () => {
  it("shows interrupt while running with an empty composer", () => {
    expect(
      shouldShowComposerInterruptAction({
        isRunning: true,
        hasSendableContent: false,
        promptHasText: false,
      }),
    ).toBe(true);
  });

  it("shows submit while running once the composer has sendable content", () => {
    expect(
      shouldShowComposerInterruptAction({
        isRunning: true,
        hasSendableContent: true,
        promptHasText: false,
      }),
    ).toBe(false);
    expect(
      shouldShowComposerInterruptAction({
        isRunning: true,
        hasSendableContent: false,
        promptHasText: true,
      }),
    ).toBe(false);
  });
});

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

describe("formatPendingPrimaryActionLabel", () => {
  it("returns 'Submitting...' while responding", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: false,
        isLastQuestion: false,
        isResponding: true,
        questionIndex: 0,
      }),
    ).toBe("Submitting...");
  });

  it("returns 'Submitting...' while responding regardless of other flags", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: true,
        isLastQuestion: true,
        isResponding: true,
        questionIndex: 3,
      }),
    ).toBe("Submitting...");
  });

  it("returns 'Submit' in compact mode on the last question", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: true,
        isLastQuestion: true,
        isResponding: false,
        questionIndex: 0,
      }),
    ).toBe("Submit");
  });

  it("returns 'Next' in compact mode when not the last question", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: true,
        isLastQuestion: false,
        isResponding: false,
        questionIndex: 1,
      }),
    ).toBe("Next");
  });

  it("returns 'Next question' when not the last question", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: false,
        isLastQuestion: false,
        isResponding: false,
        questionIndex: 0,
      }),
    ).toBe("Next question");
  });

  it("returns singular 'Submit answer' on the last question when it is the only question", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: false,
        isLastQuestion: true,
        isResponding: false,
        questionIndex: 0,
      }),
    ).toBe("Submit answer");
  });

  it("returns plural 'Submit answers' on the last question when there are multiple questions", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: false,
        isLastQuestion: true,
        isResponding: false,
        questionIndex: 1,
      }),
    ).toBe("Submit answers");
  });

  it("returns plural 'Submit answers' for higher question indices", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: false,
        isLastQuestion: true,
        isResponding: false,
        questionIndex: 5,
      }),
    ).toBe("Submit answers");
  });
});
