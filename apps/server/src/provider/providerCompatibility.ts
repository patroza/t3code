import {
  ProviderDriverKind,
  TrimmedNonEmptyString,
  type ServerProvider,
  type ServerProviderCompatibilityAdvisory,
  type ServerProviderCompatibilityRange,
} from "@t3tools/contracts";
import { satisfiesSemverRange } from "@t3tools/shared/semver";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import bundledCompatibilityDocumentJson from "../../../../provider-compatibility.v1.json" with { type: "json" };
import packageJson from "../../package.json" with { type: "json" };

export interface ProviderCompatibilityPolicy {
  readonly t3CodeRange: string;
  readonly driver: ProviderDriverKind;
  readonly recommendedRange: string | null;
  readonly recommendedVersion?: string | null;
  readonly ranges: ReadonlyArray<ServerProviderCompatibilityRange>;
}

export interface ProviderCompatibilityDocument {
  readonly version: 1;
  readonly policies: ReadonlyArray<ProviderCompatibilityPolicy>;
}

interface RemoteCompatibilityCacheEntry {
  readonly expiresAt: number;
  readonly document: ProviderCompatibilityDocument | null;
}

type ProviderCompatibilitySnapshot = Pick<ServerProvider, "enabled" | "status" | "message"> & {
  readonly compatibilityAdvisory?: ServerProviderCompatibilityAdvisory | undefined;
};

const T3_CODE_VERSION = packageJson.version;
const REMOTE_COMPATIBILITY_CACHE_TTL_MS = 15 * 60 * 1_000;
const REMOTE_COMPATIBILITY_TIMEOUT_MS = 2_500;

export const DEFAULT_PROVIDER_COMPATIBILITY_MAP_URL =
  "https://t3.codes/provider-compatibility.v1.json";
export const GITHUB_PROVIDER_COMPATIBILITY_MAP_URL =
  "https://raw.githubusercontent.com/pingdotgg/t3code/main/provider-compatibility.v1.json";
export const DEFAULT_PROVIDER_COMPATIBILITY_MAP_URLS = [
  DEFAULT_PROVIDER_COMPATIBILITY_MAP_URL,
  GITHUB_PROVIDER_COMPATIBILITY_MAP_URL,
] as const;

const remoteCompatibilityCache = new Map<string, RemoteCompatibilityCacheEntry>();

const RemoteCompatibilityRange = Schema.Struct({
  status: Schema.Literals(["unknown", "supported", "graceful", "unsupported", "broken"]),
  range: TrimmedNonEmptyString,
  label: Schema.optional(TrimmedNonEmptyString),
});

const RemoteCompatibilityPolicy = Schema.Struct({
  t3CodeRange: TrimmedNonEmptyString,
  driver: TrimmedNonEmptyString,
  recommendedRange: Schema.NullOr(TrimmedNonEmptyString),
  recommendedVersion: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  ranges: Schema.Array(RemoteCompatibilityRange),
});

const RemoteCompatibilityDocument = Schema.Struct({
  version: Schema.Literal(1),
  policies: Schema.Array(RemoteCompatibilityPolicy),
});

function normalizeCompatibilityDocument(
  document: typeof RemoteCompatibilityDocument.Type,
): ProviderCompatibilityDocument {
  return {
    version: document.version,
    policies: document.policies.map((policy) => ({
      t3CodeRange: policy.t3CodeRange,
      driver: ProviderDriverKind.make(policy.driver),
      recommendedRange: policy.recommendedRange,
      ...(policy.recommendedVersion !== undefined
        ? { recommendedVersion: policy.recommendedVersion }
        : {}),
      ranges: policy.ranges.map((range) => ({
        status: range.status,
        range: range.range,
        ...(range.label !== undefined ? { label: range.label } : {}),
      })),
    })),
  };
}

const decodeRawCompatibilityDocument = Schema.decodeUnknownEffect(RemoteCompatibilityDocument);
const decodeCompatibilityDocument = (input: unknown) =>
  decodeRawCompatibilityDocument(input).pipe(Effect.map(normalizeCompatibilityDocument));

/**
 * Repo-root compatibility JSON bundled into the app. Used when the remote map
 * cannot be fetched or has no matching policy for the current provider/build.
 */
const bundledProviderCompatibilityDocument: ProviderCompatibilityDocument =
  normalizeCompatibilityDocument(
    bundledCompatibilityDocumentJson as typeof RemoteCompatibilityDocument.Type,
  );

export function clearProviderCompatibilityCacheForTests(): void {
  remoteCompatibilityCache.clear();
}

function remoteCompatibilityMapUrls(): ReadonlyArray<string> {
  const configured = process.env.T3_PROVIDER_COMPATIBILITY_MAP_URL?.trim();
  if (!configured) {
    return DEFAULT_PROVIDER_COMPATIBILITY_MAP_URLS;
  }
  const urls = configured
    .split(",")
    .map((url) => url.trim())
    .filter((url) => url.length > 0);
  return urls.length > 0 ? urls : DEFAULT_PROVIDER_COMPATIBILITY_MAP_URLS;
}

function policyMatches(input: {
  readonly policy: ProviderCompatibilityPolicy;
  readonly driver: ProviderDriverKind;
  readonly t3CodeVersion: string;
}): boolean {
  return (
    input.policy.driver === input.driver &&
    satisfiesSemverRange(input.t3CodeVersion, input.policy.t3CodeRange)
  );
}

function compatibilityPolicyForDriver(input: {
  readonly document: ProviderCompatibilityDocument;
  readonly driver: ProviderDriverKind;
  readonly t3CodeVersion?: string;
}): ProviderCompatibilityPolicy | null {
  const t3CodeVersion = input.t3CodeVersion ?? T3_CODE_VERSION;
  return (
    input.document.policies.find((policy) =>
      policyMatches({ policy, driver: input.driver, t3CodeVersion }),
    ) ?? null
  );
}

function severityForStatus(
  status: ServerProviderCompatibilityAdvisory["status"],
): ServerProviderCompatibilityAdvisory["severity"] {
  switch (status) {
    case "broken":
      return "error";
    case "unsupported":
    case "graceful":
      return "warning";
    case "supported":
    case "unknown":
      return "info";
  }
}

function messageForStatus(input: {
  readonly status: ServerProviderCompatibilityAdvisory["status"];
  readonly currentVersion: string | null;
  readonly recommendedRange: string | null;
  readonly recommendedVersion: string | null;
}) {
  const current = input.currentVersion ? ` ${input.currentVersion}` : "";
  const recommendedTarget = input.recommendedVersion ?? input.recommendedRange;
  const recommended = recommendedTarget ? ` Use ${recommendedTarget}.` : "";
  switch (input.status) {
    case "broken":
      return `This provider harness version${current} is known to be incompatible with this T3 Code release.${recommended}`;
    case "unsupported":
      return `This provider harness version${current} is outside the compatibility range for this T3 Code release.${recommended}`;
    case "graceful":
      return `This provider harness version${current} should still work, but updating is recommended.${recommended}`;
    case "unknown":
      return `T3 Code could not determine whether this provider harness version is compatible.${recommended}`;
    case "supported":
      return null;
  }
}

function createProviderCompatibilityAdvisoryFromDocument(input: {
  readonly document: ProviderCompatibilityDocument;
  readonly driver: ProviderDriverKind;
  readonly currentVersion: string | null;
  readonly t3CodeVersion?: string;
}): ServerProviderCompatibilityAdvisory | undefined {
  const policy = compatibilityPolicyForDriver({
    document: input.document,
    driver: input.driver,
    ...(input.t3CodeVersion ? { t3CodeVersion: input.t3CodeVersion } : {}),
  });
  if (!policy) {
    return undefined;
  }

  const currentVersion = input.currentVersion;
  const matchedRange =
    currentVersion === null
      ? undefined
      : policy.ranges.find((range) => satisfiesSemverRange(currentVersion, range.range));
  const status = matchedRange?.status ?? (currentVersion === null ? "unknown" : "unsupported");
  const recommendedVersion = policy.recommendedVersion ?? null;

  return {
    status,
    severity: severityForStatus(status),
    currentVersion: input.currentVersion,
    message: messageForStatus({
      status,
      currentVersion: input.currentVersion,
      recommendedRange: policy.recommendedRange,
      recommendedVersion,
    }),
    recommendedRange: policy.recommendedRange,
    recommendedVersion,
    ranges: [...policy.ranges],
  };
}

export function createProviderCompatibilityAdvisory(input: {
  readonly driver: ProviderDriverKind;
  readonly currentVersion: string | null;
  readonly document?: ProviderCompatibilityDocument;
  readonly t3CodeVersion?: string;
}): ServerProviderCompatibilityAdvisory | undefined {
  return createProviderCompatibilityAdvisoryFromDocument({
    document: input.document ?? bundledProviderCompatibilityDocument,
    driver: input.driver,
    currentVersion: input.currentVersion,
    ...(input.t3CodeVersion ? { t3CodeVersion: input.t3CodeVersion } : {}),
  });
}

function fetchRemoteCompatibilityDocument(
  url: string,
): Effect.Effect<ProviderCompatibilityDocument | null, never, HttpClient.HttpClient> {
  return Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client
      .execute(
        HttpClientRequest.get(url).pipe(
          HttpClientRequest.setHeader("accept", "application/json"),
          HttpClientRequest.setHeader("user-agent", `t3code/${T3_CODE_VERSION}`),
        ),
      )
      .pipe(Effect.timeoutOption(REMOTE_COMPATIBILITY_TIMEOUT_MS));

    if (Option.isNone(response)) {
      return null;
    }

    const httpResponse = response.value;
    if (httpResponse.status < 200 || httpResponse.status >= 300) {
      return null;
    }

    const payload = yield* httpResponse.json.pipe(
      Effect.flatMap(decodeCompatibilityDocument),
      Effect.catch(() => Effect.succeed(null)),
    );
    return payload;
  }).pipe(
    Effect.tapError((cause) =>
      Effect.logWarning("provider compatibility map fetch failed", {
        cause,
        url,
      }),
    ),
    Effect.catch(() => Effect.succeed(null)),
  );
}

export const resolveRemoteProviderCompatibilityDocument = Effect.fn(
  "resolveRemoteProviderCompatibilityDocument",
)(function* () {
  const urls = remoteCompatibilityMapUrls();
  const now = DateTime.toEpochMillis(yield* DateTime.now);

  for (const url of urls) {
    const cached = remoteCompatibilityCache.get(url);
    if (cached && cached.expiresAt > now) {
      if (cached.document) {
        return cached.document;
      }
      continue;
    }

    const document = yield* fetchRemoteCompatibilityDocument(url);
    remoteCompatibilityCache.set(url, {
      expiresAt: now + REMOTE_COMPATIBILITY_CACHE_TTL_MS,
      document,
    });
    if (document) {
      return document;
    }
  }

  return null;
});

function applyCompatibilityAdvisory<Snapshot extends ProviderCompatibilitySnapshot>(
  snapshot: Snapshot,
  compatibilityAdvisory: ServerProviderCompatibilityAdvisory | undefined,
): Snapshot {
  const baseSnapshot = removeExistingCompatibilityAdvisory(snapshot);
  if (!compatibilityAdvisory) {
    return baseSnapshot;
  }

  const compatibilityMessage =
    compatibilityAdvisory.severity !== "info"
      ? (compatibilityAdvisory.message ?? undefined)
      : undefined;
  const status =
    snapshot.enabled && compatibilityAdvisory.severity === "error"
      ? "error"
      : snapshot.enabled &&
          compatibilityAdvisory.severity === "warning" &&
          baseSnapshot.status === "ready"
        ? "warning"
        : baseSnapshot.status;

  return {
    ...baseSnapshot,
    status,
    ...(compatibilityMessage || baseSnapshot.message
      ? { message: compatibilityMessage ?? baseSnapshot.message }
      : {}),
    compatibilityAdvisory,
  } as Snapshot;
}

function removeExistingCompatibilityAdvisory<Snapshot extends ProviderCompatibilitySnapshot>(
  snapshot: Snapshot,
): Snapshot {
  if (!snapshot.compatibilityAdvisory) {
    return snapshot;
  }

  const { compatibilityAdvisory: existingCompatibilityAdvisory, ...baseSnapshot } = snapshot;
  const compatibilityMessage =
    existingCompatibilityAdvisory.severity !== "info"
      ? (existingCompatibilityAdvisory.message ?? undefined)
      : undefined;
  if (compatibilityMessage && baseSnapshot.message === compatibilityMessage) {
    const { message: _message, ...snapshotWithoutCompatibilityMessage } = baseSnapshot;
    return {
      ...snapshotWithoutCompatibilityMessage,
      status: snapshot.enabled ? "ready" : "disabled",
    } as Snapshot;
  }
  return baseSnapshot as Snapshot;
}

export function applyBundledProviderCompatibilityAdvisory<
  Snapshot extends ProviderCompatibilitySnapshot,
>(input: {
  readonly snapshot: Snapshot;
  readonly driver: ProviderDriverKind;
  readonly currentVersion: string | null;
}): Snapshot {
  return applyCompatibilityAdvisory(
    input.snapshot,
    createProviderCompatibilityAdvisory({
      driver: input.driver,
      currentVersion: input.currentVersion,
    }),
  );
}

export const enrichProviderSnapshotWithCompatibilityAdvisory = Effect.fn(
  "enrichProviderSnapshotWithCompatibilityAdvisory",
)(function* (snapshot: ServerProvider) {
  const remoteDocument = yield* resolveRemoteProviderCompatibilityDocument();
  const remoteAdvisory = remoteDocument
    ? createProviderCompatibilityAdvisory({
        driver: snapshot.driver,
        currentVersion: snapshot.version,
        document: remoteDocument,
      })
    : undefined;
  const advisory =
    remoteAdvisory ??
    createProviderCompatibilityAdvisory({
      driver: snapshot.driver,
      currentVersion: snapshot.version,
    });

  return applyCompatibilityAdvisory(snapshot, advisory);
});
