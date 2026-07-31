import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopConnectionCatalogStore from "./DesktopConnectionCatalogStore.ts";
import * as DesktopDeepLinks from "./DesktopDeepLinks.ts";

const THREAD_ID = ThreadId.make("ebf3a84d-7f60-4809-a5e0-bbd574275463");
const ENVIRONMENT_ID = EnvironmentId.make("db6d1813-ace4-42bd-9bce-e04ee27e97ff");
const VALID_DEEP_LINK =
  "t3code://open/thread?connection=t3vm&thread=ebf3a84d-7f60-4809-a5e0-bbd574275463";

function catalogJson(targets: readonly { label: string; environmentId: string }[]): string {
  return JSON.stringify({
    schemaVersion: 1,
    targets: targets.map((target) => ({
      _tag: "BearerConnectionTarget",
      environmentId: target.environmentId,
      label: target.label,
      connectionId: `bearer:${target.environmentId}`,
    })),
    profiles: [],
    credentials: [],
    remoteDpopTokens: [],
  });
}

describe("DesktopDeepLinks parsing", () => {
  it("parses a valid thread deep link from mixed argv", () => {
    const parsed = DesktopDeepLinks.findDesktopThreadDeepLinkInArgv([
      "/usr/bin/t3code",
      "--enable-features=Foo",
      VALID_DEEP_LINK,
      "--some-flag",
    ]);
    assert.isTrue(Option.isSome(parsed));
    assert.equal(parsed._tag === "Some" ? parsed.value.connectionLabel : null, "t3vm");
    assert.equal(
      parsed._tag === "Some" ? parsed.value.threadId : null,
      "ebf3a84d-7f60-4809-a5e0-bbd574275463",
    );
  });

  it("percent-decodes the connection label exactly once", () => {
    const parsed = DesktopDeepLinks.parseDesktopThreadDeepLink(
      "t3code://open/thread?connection=t3%2Fvm&thread=ebf3a84d-7f60-4809-a5e0-bbd574275463",
    );
    assert.isTrue(Option.isSome(parsed));
    assert.equal(parsed._tag === "Some" ? parsed.value.connectionLabel : null, "t3/vm");
  });

  it("parses project jumps with short or full repository names", () => {
    const latest = DesktopDeepLinks.parseDesktopProjectDeepLink(
      "t3code://open/project?project=macs-holding%2Fscanner&action=latest",
    );
    assert.deepEqual(Option.getOrNull(latest), {
      project: "macs-holding/scanner",
      action: "latest",
    });
    const reveal = DesktopDeepLinks.parseDesktopProjectDeepLink(
      "t3code://open/project?project=scanner",
    );
    assert.deepEqual(Option.getOrNull(reveal), { project: "scanner", action: "reveal" });
  });

  it("rejects invalid project jump actions and duplicate project values", () => {
    assert.isTrue(
      Option.isNone(
        DesktopDeepLinks.parseDesktopProjectDeepLink(
          "t3code://open/project?project=scanner&action=remove",
        ),
      ),
    );
    assert.isTrue(
      Option.isNone(
        DesktopDeepLinks.parseDesktopProjectDeepLink(
          "t3code://open/project?project=scanner&project=configurator",
        ),
      ),
    );
  });

  it("parses URL-like environment hosts in short and FQDN forms", () => {
    for (const [raw, expectedLabel] of [
      ["t3code://t3vm?thread=ebf3a84d-7f60-4809-a5e0-bbd574275463", "t3vm"],
      ["t3code://t3vm.long.host?thread=ebf3a84d-7f60-4809-a5e0-bbd574275463", "t3vm.long.host"],
    ] as const) {
      const parsed = DesktopDeepLinks.parseDesktopThreadDeepLink(raw);
      assert.isTrue(Option.isSome(parsed));
      assert.equal(parsed._tag === "Some" ? parsed.value.connectionLabel : null, expectedLabel);
    }
  });

  it("rejects wrong schemes, hosts, paths, missing/duplicate values, controls, and oversized values", () => {
    const rejects = [
      "https://open/thread?connection=t3vm&thread=ebf3a84d-7f60-4809-a5e0-bbd574275463",
      "t3code://close/thread?connection=t3vm&thread=ebf3a84d-7f60-4809-a5e0-bbd574275463",
      "t3code://open/settings?connection=t3vm&thread=ebf3a84d-7f60-4809-a5e0-bbd574275463",
      "t3code://open/thread?thread=ebf3a84d-7f60-4809-a5e0-bbd574275463",
      "t3code://open/thread?connection=t3vm",
      "t3code://open/thread?connection=t3vm&connection=other&thread=ebf3a84d-7f60-4809-a5e0-bbd574275463",
      "t3code://open/thread?connection=t3vm&thread=a&thread=b",
      "t3code://t3vm?connection=other&thread=ebf3a84d-7f60-4809-a5e0-bbd574275463",
      "t3code://t3vm/path?thread=ebf3a84d-7f60-4809-a5e0-bbd574275463",
      "t3code://open/thread?connection=t3vm&thread=ebf3a84d-7f60-4809-a5e0-bbd574275463\u0000",
      `t3code://open/thread?connection=${"x".repeat(300)}&thread=ebf3a84d-7f60-4809-a5e0-bbd574275463`,
      "not-a-url",
      "t3code://app/",
    ];
    for (const raw of rejects) {
      assert.isTrue(
        Option.isNone(DesktopDeepLinks.parseDesktopThreadDeepLink(raw)),
        `expected rejection for ${JSON.stringify(raw)}`,
      );
    }
  });

  it("builds a hash-history navigation URL on the desktop origin", () => {
    assert.equal(
      DesktopDeepLinks.buildDesktopThreadNavigationUrl({
        isDevelopment: false,
        environmentId: ENVIRONMENT_ID,
        threadId: THREAD_ID,
      }),
      "t3code://app/#/db6d1813-ace4-42bd-9bce-e04ee27e97ff/ebf3a84d-7f60-4809-a5e0-bbd574275463",
    );
    assert.equal(
      DesktopDeepLinks.buildDesktopThreadNavigationUrl({
        isDevelopment: true,
        environmentId: ENVIRONMENT_ID,
        threadId: THREAD_ID,
      }),
      "t3code-dev://app/#/db6d1813-ace4-42bd-9bce-e04ee27e97ff/ebf3a84d-7f60-4809-a5e0-bbd574275463",
    );
  });
});

describe("DesktopDeepLinks catalog resolution", () => {
  it("resolves a unique connection label to its environment id", () => {
    const resolution = DesktopDeepLinks.resolveEnvironmentIdForConnectionLabel(
      catalogJson([
        { label: "t3vm", environmentId: "db6d1813-ace4-42bd-9bce-e04ee27e97ff" },
        { label: "other", environmentId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
      ]),
      "t3vm",
    );
    assert.equal(resolution._tag, "resolved");
    if (resolution._tag === "resolved") {
      assert.equal(resolution.environmentId, "db6d1813-ace4-42bd-9bce-e04ee27e97ff");
    }
  });

  it("resolves short and fully qualified host labels in either direction", () => {
    const fqdnTarget = DesktopDeepLinks.resolveEnvironmentIdForConnectionLabel(
      catalogJson([
        { label: "t3vm.long.host", environmentId: "db6d1813-ace4-42bd-9bce-e04ee27e97ff" },
      ]),
      "t3vm",
    );
    assert.equal(fqdnTarget._tag, "resolved");

    const shortTarget = DesktopDeepLinks.resolveEnvironmentIdForConnectionLabel(
      catalogJson([{ label: "t3vm", environmentId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }]),
      "t3vm.long.host",
    );
    assert.equal(shortTarget._tag, "resolved");
  });

  it("prefers an exact configured label over a short-host fallback", () => {
    const resolution = DesktopDeepLinks.resolveEnvironmentIdForConnectionLabel(
      catalogJson([
        { label: "t3vm.long.host", environmentId: "db6d1813-ace4-42bd-9bce-e04ee27e97ff" },
        { label: "t3vm", environmentId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
      ]),
      "t3vm",
    );
    assert.equal(resolution._tag, "resolved");
    if (resolution._tag === "resolved") {
      assert.equal(resolution.environmentId, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    }
  });

  it("keeps ambiguous short matches ambiguous and does not equate distinct FQDNs", () => {
    const catalog = catalogJson([
      { label: "t3vm.one.host", environmentId: "db6d1813-ace4-42bd-9bce-e04ee27e97ff" },
      { label: "t3vm.two.host", environmentId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
    ]);
    assert.equal(
      DesktopDeepLinks.resolveEnvironmentIdForConnectionLabel(catalog, "t3vm")._tag,
      "ambiguous",
    );
    assert.equal(
      DesktopDeepLinks.resolveEnvironmentIdForConnectionLabel(catalog, "t3vm.three.host")._tag,
      "missing",
    );
  });

  it("refuses missing and duplicate labels", () => {
    assert.equal(
      DesktopDeepLinks.resolveEnvironmentIdForConnectionLabel(
        catalogJson([{ label: "other", environmentId: "db6d1813-ace4-42bd-9bce-e04ee27e97ff" }]),
        "t3vm",
      )._tag,
      "missing",
    );
    assert.equal(
      DesktopDeepLinks.resolveEnvironmentIdForConnectionLabel(
        catalogJson([
          { label: "t3vm", environmentId: "db6d1813-ace4-42bd-9bce-e04ee27e97ff" },
          { label: "t3vm", environmentId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
        ]),
        "t3vm",
      )._tag,
      "ambiguous",
    );
  });
});

describe("DesktopDeepLinks service delivery", () => {
  const makeHarness = Effect.gen(function* () {
    const navigations = yield* Ref.make<Array<{ environmentId: string; threadId: string }>>([]);
    const projectNavigations = yield* Ref.make<
      Array<{ project: string; action: "reveal" | "latest" | "new" }>
    >([]);
    const activations = yield* Ref.make(0);
    const catalogJsonRef = yield* Ref.make(
      Option.some(
        catalogJson([
          {
            label: "t3vm",
            environmentId: "db6d1813-ace4-42bd-9bce-e04ee27e97ff",
          },
        ]),
      ),
    );

    const windowLayer = Layer.succeed(DesktopWindow.DesktopWindow, {
      createMain: Effect.die("unexpected createMain"),
      ensureMain: Effect.die("unexpected ensureMain"),
      revealOrCreateMain: Effect.die("unexpected revealOrCreateMain"),
      activate: Ref.update(activations, (count) => count + 1),
      createMainIfBackendReady: Effect.void,
      showConnectingSplash: Effect.void,
      handleBackendReady: () => Effect.void,
      handleBackendNotReady: Effect.void,
      flushMainWindowBounds: Effect.void,
      dispatchMenuAction: () => Effect.void,
      syncAppearance: Effect.void,
      navigateToThread: (input: { readonly environmentId: string; readonly threadId: string }) =>
        Ref.update(navigations, (items) => [
          ...items,
          { environmentId: input.environmentId, threadId: input.threadId },
        ]),
      navigateToProject: (input: {
        readonly project: string;
        readonly action: "reveal" | "latest" | "new";
      }) => Ref.update(projectNavigations, (items) => [...items, input]),
    } as unknown as DesktopWindow.DesktopWindow["Service"]);

    const catalogLayer = Layer.succeed(
      DesktopConnectionCatalogStore.DesktopConnectionCatalogStore,
      {
        get: Ref.get(catalogJsonRef),
        set: () => Effect.succeed(true),
        clear: Effect.void,
      } satisfies DesktopConnectionCatalogStore.DesktopConnectionCatalogStore["Service"],
    );

    const layer = DesktopDeepLinks.layer.pipe(
      Layer.provide(windowLayer),
      Layer.provide(catalogLayer),
    );

    return { layer, navigations, projectNavigations, activations, catalogJsonRef } as const;
  });

  it.effect("queues initial-launch delivery until start, then opens the thread", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const deepLinks = yield* DesktopDeepLinks.DesktopDeepLinks;
        yield* deepLinks.handleArgv(["t3code", VALID_DEEP_LINK]);
        assert.deepEqual(yield* Ref.get(harness.navigations), []);
        yield* deepLinks.start;
        assert.deepEqual(yield* Ref.get(harness.navigations), [
          {
            environmentId: "db6d1813-ace4-42bd-9bce-e04ee27e97ff",
            threadId: "ebf3a84d-7f60-4809-a5e0-bbd574275463",
          },
        ]);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("delivers running-instance deep links through handleArgv after start", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const deepLinks = yield* DesktopDeepLinks.DesktopDeepLinks;
        yield* deepLinks.start;
        yield* deepLinks.handleArgv([
          "t3code",
          "t3code://open/thread?connection=t3vm&thread=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        ]);
        assert.deepEqual(yield* Ref.get(harness.navigations), [
          {
            environmentId: "db6d1813-ace4-42bd-9bce-e04ee27e97ff",
            threadId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
          },
        ]);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("delivers a project jump without resolving an environment in Desktop", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const deepLinks = yield* DesktopDeepLinks.DesktopDeepLinks;
        yield* deepLinks.start;
        yield* deepLinks.handleUrl(
          "t3code://open/project?project=macs-holding%2Fscanner&action=new",
        );
        assert.deepEqual(yield* Ref.get(harness.projectNavigations), [
          { project: "macs-holding/scanner", action: "new" },
        ]);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("preserves reveal-only behavior for ordinary second launches", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const deepLinks = yield* DesktopDeepLinks.DesktopDeepLinks;
        yield* deepLinks.start;
        yield* deepLinks.handleArgv(["t3code"]);
        assert.equal(yield* Ref.get(harness.activations), 1);
        assert.deepEqual(yield* Ref.get(harness.navigations), []);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("reveals without navigating when the connection label is missing", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const deepLinks = yield* DesktopDeepLinks.DesktopDeepLinks;
        yield* deepLinks.start;
        yield* deepLinks.handleArgv([
          "t3code",
          "t3code://open/thread?connection=missing&thread=ebf3a84d-7f60-4809-a5e0-bbd574275463",
        ]);
        assert.equal(yield* Ref.get(harness.activations), 1);
        assert.deepEqual(yield* Ref.get(harness.navigations), []);
      }).pipe(Effect.provide(harness.layer));
    }),
  );
});
