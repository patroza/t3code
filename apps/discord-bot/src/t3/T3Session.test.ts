import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  isT3TransportError,
  shouldPersistThreadModelSelectionForNextTurn,
  T3_STILL_CONNECTING_MESSAGE,
} from "./T3Session.ts";

describe("isT3TransportError", () => {
  it("matches SocketCloseError and ConnectionTransientError", () => {
    expect(isT3TransportError(new Error("SocketCloseError: 1005"))).toBe(true);
    expect(isT3TransportError(new Error("ConnectionTransientError: closed"))).toBe(true);
    expect(isT3TransportError(new Error("SocketError: reset"))).toBe(true);
  });

  it("matches common network errno strings", () => {
    expect(isT3TransportError(new Error("connect ECONNREFUSED 127.0.0.1:3773"))).toBe(true);
    expect(isT3TransportError(new Error("read ECONNRESET"))).toBe(true);
  });

  it("does not match ordinary application errors", () => {
    expect(isT3TransportError(new Error("No T3 project registered at /tmp/x"))).toBe(false);
    expect(isT3TransportError(new Error(T3_STILL_CONNECTING_MESSAGE))).toBe(false);
  });
});

describe("shouldPersistThreadModelSelectionForNextTurn", () => {
  it("returns false when no explicit model selection is provided", () => {
    expect(
      shouldPersistThreadModelSelectionForNextTurn({
        currentModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
      }),
    ).toBe(false);
  });

  it("returns true when the model changes", () => {
    expect(
      shouldPersistThreadModelSelectionForNextTurn({
        currentModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        nextModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.5",
        },
      }),
    ).toBe(true);
  });

  it("returns false when the model selection is unchanged", () => {
    expect(
      shouldPersistThreadModelSelectionForNextTurn({
        currentModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.5",
        },
        nextModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.5",
        },
      }),
    ).toBe(false);
  });
});
