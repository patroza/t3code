// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import {
  clearPersistedBearerSession,
  parsePersistedBearerSession,
  persistedBearerExpiresAtIso,
  readPersistedBearerSession,
  shouldReusePersistedBearer,
  writePersistedBearerSession,
} from "./PersistedBearer.ts";

describe("shouldReusePersistedBearer", () => {
  const nowMs = Date.parse("2026-08-20T06:00:00.000Z");
  const record = {
    accessToken: "tok",
    expiresAt: "2026-09-19T06:00:00.000Z",
    httpBaseUrl: "http://127.0.0.1:3773/",
  };

  it("reuses a same-host token with more than an hour remaining", () => {
    expect(
      shouldReusePersistedBearer({
        record,
        nowMs,
        httpBaseUrl: "http://127.0.0.1:3773",
      }),
    ).toBe(true);
  });

  it("rejects a token for a different T3 host", () => {
    expect(
      shouldReusePersistedBearer({
        record,
        nowMs,
        httpBaseUrl: "http://127.0.0.1:9999",
      }),
    ).toBe(false);
  });

  it("rejects a token inside the remaining-time floor", () => {
    expect(
      shouldReusePersistedBearer({
        record: { ...record, expiresAt: "2026-08-20T06:30:00.000Z" },
        nowMs,
        httpBaseUrl: record.httpBaseUrl,
      }),
    ).toBe(false);
  });

  it("rejects an empty token", () => {
    expect(
      shouldReusePersistedBearer({
        record: { ...record, accessToken: "  " },
        nowMs,
        httpBaseUrl: record.httpBaseUrl,
      }),
    ).toBe(false);
  });
});

describe("parsePersistedBearerSession", () => {
  it("accepts a well-formed document", () => {
    expect(
      parsePersistedBearerSession({
        accessToken: "tok",
        expiresAt: "2026-09-19T06:00:00.000Z",
        httpBaseUrl: "http://127.0.0.1:3773/",
      }),
    ).toEqual({
      accessToken: "tok",
      expiresAt: "2026-09-19T06:00:00.000Z",
      httpBaseUrl: "http://127.0.0.1:3773/",
    });
  });

  it("rejects missing fields and bad expiry", () => {
    expect(parsePersistedBearerSession({ accessToken: "tok" })).toBeNull();
    expect(
      parsePersistedBearerSession({
        accessToken: "tok",
        expiresAt: "not-a-date",
        httpBaseUrl: "http://127.0.0.1:3773/",
      }),
    ).toBeNull();
    expect(parsePersistedBearerSession("tok")).toBeNull();
  });
});

describe("persisted bearer file", () => {
  it("round-trips and clears a session on disk", () => {
    const dataDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-discord-bearer-"));
    try {
      expect(readPersistedBearerSession(dataDir)).toBeNull();
      writePersistedBearerSession(dataDir, {
        accessToken: "tok-1",
        expiresAt: persistedBearerExpiresAtIso(Date.parse("2026-08-20T06:00:00.000Z"), 3600),
        httpBaseUrl: "http://127.0.0.1:3773/",
      });
      expect(readPersistedBearerSession(dataDir)).toEqual({
        accessToken: "tok-1",
        expiresAt: "2026-08-20T07:00:00.000Z",
        httpBaseUrl: "http://127.0.0.1:3773/",
      });
      clearPersistedBearerSession(dataDir);
      expect(readPersistedBearerSession(dataDir)).toBeNull();
    } finally {
      NodeFS.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
