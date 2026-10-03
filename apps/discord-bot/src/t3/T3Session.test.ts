// @effect-diagnostics nodeBuiltinImport:off - existence contract reads T3Session source on disk.
import * as NodeFS from "node:fs";
import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  isT3InvalidCredentialError,
  isT3TransportError,
  shouldContinueWaitingForT3Ready,
  shouldPersistThreadModelSelectionForNextTurn,
  T3_STILL_CONNECTING_MESSAGE,
} from "./T3Session.ts";

const t3SessionSource = NodeFS.readFileSync(new URL("./T3Session.ts", import.meta.url), "utf8");

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

describe("isT3InvalidCredentialError", () => {
  it("matches bootstrap/bearer rejection copy", () => {
    expect(
      isT3InvalidCredentialError(
        new Error(
          "Bootstrap failed: The environment rejected this client's credentials (invalid_credential).",
        ),
      ),
    ).toBe(true);
    expect(isT3InvalidCredentialError(new Error('reason: "invalid_credential"'))).toBe(true);
  });

  it("does not match transport or timeout copy", () => {
    expect(isT3InvalidCredentialError(new Error("SocketCloseError: 1005"))).toBe(false);
    expect(isT3InvalidCredentialError(new Error(T3_STILL_CONNECTING_MESSAGE))).toBe(false);
  });
});

describe("persisted T3 bearer", () => {
  it("reuses a stored bearer on connect and falls back to bootstrap when rejected", () => {
    expect(t3SessionSource).toContain("readPersistedBearerSession(botConfig.dataDir)");
    expect(t3SessionSource).toContain("shouldReusePersistedBearer({");
    expect(t3SessionSource).toContain("writePersistedBearerSession(botConfig.dataDir");
    expect(t3SessionSource).toContain("Persisted T3 bearer rejected; falling back to bootstrap");
    expect(t3SessionSource).toContain("clearPersistedBearerSession(botConfig.dataDir)");
  });
});

describe("shouldContinueWaitingForT3Ready", () => {
  it("returns ready as soon as the shell is live", () => {
    expect(shouldContinueWaitingForT3Ready({ ready: true, elapsedMs: 0, timeoutMs: 1_000 })).toBe(
      "ready",
    );
    expect(
      shouldContinueWaitingForT3Ready({ ready: true, elapsedMs: 5_000, timeoutMs: 1_000 }),
    ).toBe("ready");
  });

  it("keeps waiting until the timeout elapses", () => {
    expect(shouldContinueWaitingForT3Ready({ ready: false, elapsedMs: 0, timeoutMs: 1_000 })).toBe(
      "wait",
    );
    expect(
      shouldContinueWaitingForT3Ready({ ready: false, elapsedMs: 999, timeoutMs: 1_000 }),
    ).toBe("wait");
  });

  it("times out once elapsed reaches the deadline", () => {
    expect(
      shouldContinueWaitingForT3Ready({ ready: false, elapsedMs: 1_000, timeoutMs: 1_000 }),
    ).toBe("timeout");
    expect(
      shouldContinueWaitingForT3Ready({ ready: false, elapsedMs: 5_000, timeoutMs: 1_000 }),
    ).toBe("timeout");
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
