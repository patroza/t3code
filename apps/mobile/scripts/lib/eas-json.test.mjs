import { describe, expect, it } from "vitest";
import {
  extractJson,
  pickFingerprintHash,
  pickLatestFinishedRuntime,
  pickUsableBuildId,
} from "./eas-json.mjs";

// The exact stdout line that failed every production deploy from 2026-07-31 on.
const ENV_NOTICE =
  'No environment variables with visibility "Plain text" and "Sensitive" found for the "production" environment on EAS.\n';

describe("extractJson", () => {
  it("parses clean JSON", () => {
    expect(extractJson('{"hash":"abc"}')).toEqual({ hash: "abc" });
  });

  it("skips a leading human-readable notice", () => {
    expect(extractJson(`${ENV_NOTICE}{"hash":"abc"}\n`)).toEqual({ hash: "abc" });
  });

  it("skips trailing output after the JSON value", () => {
    expect(extractJson('[{"id":"b1"}]\nDone.\n')).toEqual([{ id: "b1" }]);
  });

  it("ignores braces that belong to prose", () => {
    expect(extractJson('warning: unresolved {placeholder} in config\n{"hash":"abc"}')).toEqual({
      hash: "abc",
    });
  });

  it("does not stop at a brace inside a JSON string", () => {
    expect(extractJson(`${ENV_NOTICE}{"hash":"a}b","extra":1}`)).toEqual({
      hash: "a}b",
      extra: 1,
    });
  });

  it("returns undefined when there is no JSON at all", () => {
    expect(extractJson(ENV_NOTICE)).toBeUndefined();
    expect(extractJson("")).toBeUndefined();
    expect(extractJson(undefined)).toBeUndefined();
  });
});

describe("pickFingerprintHash", () => {
  it("reads hash past the environment notice", () => {
    expect(pickFingerprintHash(`${ENV_NOTICE}{"hash":"deadbeef","sources":[]}`)).toBe("deadbeef");
  });

  it("accepts the fingerprintHash alias", () => {
    expect(pickFingerprintHash('{"fingerprintHash":"cafe"}')).toBe("cafe");
  });

  it("returns undefined when the payload carries no hash", () => {
    expect(pickFingerprintHash('{"sources":[]}')).toBeUndefined();
    expect(pickFingerprintHash(ENV_NOTICE)).toBeUndefined();
  });
});

describe("pickUsableBuildId", () => {
  it("returns the first build that can still serve an OTA", () => {
    const raw = `${ENV_NOTICE}[{"id":"b0","status":"errored"},{"id":"b1","status":"in-queue"}]`;
    expect(pickUsableBuildId(raw)).toBe("b1");
  });

  it("normalizes dashed and lowercase statuses", () => {
    expect(pickUsableBuildId('[{"id":"b1","status":"in-progress"}]')).toBe("b1");
    expect(pickUsableBuildId('[{"id":"b1","status":"FINISHED"}]')).toBe("b1");
  });

  it("returns undefined for empty, absent, or unusable lists", () => {
    expect(pickUsableBuildId("[]")).toBeUndefined();
    expect(pickUsableBuildId("")).toBeUndefined();
    expect(pickUsableBuildId('[{"id":"b1","status":"canceled"}]')).toBeUndefined();
  });
});

describe("pickLatestFinishedRuntime", () => {
  it("reads the newest build's runtime version past a notice", () => {
    const raw = `${ENV_NOTICE}[{"id":"b1","runtimeVersion":"a79f66c8"}]`;
    expect(pickLatestFinishedRuntime(raw)).toBe("a79f66c8");
  });

  it("returns undefined when no build is listed", () => {
    expect(pickLatestFinishedRuntime("[]")).toBeUndefined();
    expect(pickLatestFinishedRuntime("")).toBeUndefined();
  });
});
