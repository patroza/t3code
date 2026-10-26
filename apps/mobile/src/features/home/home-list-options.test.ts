import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  DEFAULT_SIDEBAR_PROJECT_SORT_ORDER,
  DEFAULT_SIDEBAR_THREAD_SORT_ORDER,
} from "@t3tools/contracts";
import { AtomRegistry } from "effect/reactivity";
import { act, createElement, useLayoutEffect, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const saved = vi.hoisted(() => [] as unknown[]);
vi.mock("../../state/preferences", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    updateMobilePreferencesAtom: Atom.writable(
      () => null,
      (_ctx, patch: unknown) => {
        saved.push(patch);
      },
    ),
  };
});

import type { ThreadListFilters } from "../../persistence/mobile-preferences";
import {
  HomeListOptionsProvider,
  useHomeListOptions,
  DEFAULT_OWNERSHIP_FILTER,
  hasCustomHomeListOptions,
  type HomeListOptions,
} from "./home-list-options";

describe("home list options across layout changes", () => {
  const environmentId = EnvironmentId.make("environment-1");
  const secondEnvironmentId = EnvironmentId.make("environment-2");
  const availableEnvironmentIds = new Set([environmentId, secondEnvironmentId]);
  let root: Root;
  let latest: ReturnType<typeof useHomeListOptions>;

  function ThreadList() {
    const state = useHomeListOptions(availableEnvironmentIds);
    useLayoutEffect(() => {
      latest = state;
    });
    return null;
  }

  const registry = AtomRegistry.make();

  async function showLayout(
    layout: "compact" | "sidebar",
    savedFilters?: ThreadListFilters,
    stored: Partial<ComponentProps<typeof HomeListOptionsProvider>> = {},
  ) {
    await act(() => {
      root.render(
        createElement(
          RegistryContext,
          { value: registry },
          createElement(
            HomeListOptionsProvider,
            { projectGroupingMode: "repository", savedFilters, ...stored },
            createElement(ThreadList, { key: layout }),
          ),
        ),
      );
    });
  }

  beforeEach(() => {
    const document = {
      nodeType: 9,
      addEventListener() {},
      removeEventListener() {},
    };
    const container = {
      nodeType: 1,
      tagName: "DIV",
      namespaceURI: "http://www.w3.org/1999/xhtml",
      ownerDocument: document,
      addEventListener() {},
      removeEventListener() {},
    };
    vi.stubGlobal("document", document);
    vi.stubGlobal("window", { document, HTMLIFrameElement: EventTarget });
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    root = createRoot(container as unknown as HTMLElement);
    saved.length = 0;
  });

  afterEach(async () => {
    await act(() => root.unmount());
    vi.unstubAllGlobals();
  });

  it.each([
    ["compact", "sidebar"],
    ["sidebar", "compact"],
  ] as const)(
    "retains filters through repeated %s → %s round trips and keeps clears",
    async (initialLayout, otherLayout) => {
      await showLayout(initialLayout);

      for (const [selectedEnvironmentId, selectedProjectKey] of [
        [environmentId, "repository:one"],
        [environmentId, "repository:two"],
        [environmentId, null],
        [null, null],
        [null, "repository:one"],
      ] as const) {
        await act(() => {
          latest.setSelectedEnvironmentId(selectedEnvironmentId);
          latest.setSelectedProjectKey(selectedProjectKey);
        });
        for (let cycle = 0; cycle < 3; cycle += 1) {
          for (const layout of [otherLayout, initialLayout]) {
            await showLayout(layout);
            expect(latest.options).toMatchObject({
              selectedEnvironmentId,
              selectedProjectKey,
              projectGroupingMode: "repository",
            });
          }
        }
        await showLayout(otherLayout);
      }
    },
  );

  it("keeps multiple environments and the project filter through layout changes", async () => {
    await showLayout("compact");
    await act(() => {
      latest.toggleSelectedEnvironmentId(environmentId);
      latest.toggleSelectedEnvironmentId(secondEnvironmentId);
      latest.setSelectedProjectKey("repository:one");
    });
    await showLayout("sidebar");
    expect(latest.options.selectedEnvironmentIds).toEqual([environmentId, secondEnvironmentId]);
    expect(latest.options.selectedProjectKey).toBe("repository:one");
    await act(() => latest.clearSelectedEnvironments());
    await showLayout("compact");
    expect(latest.options.selectedEnvironmentIds).toEqual([]);
    expect(latest.options.selectedProjectKey).toBe("repository:one");
  });

  it("hydrates late device preferences before persisting and keeps subsequent edits", async () => {
    const onStoreEnvironmentIds = vi.fn();
    const onStoreThreadGrouping = vi.fn();
    const onStoreOwnershipFilter = vi.fn();
    const onStoreOwnershipRelation = vi.fn();
    const callbacks = {
      onStoreEnvironmentIds,
      onStoreThreadGrouping,
      onStoreOwnershipFilter,
      onStoreOwnershipRelation,
    };
    await showLayout("compact", undefined, callbacks);
    const stored = {
      ...callbacks,
      storedEnvironmentIds: [environmentId],
      storedThreadGrouping: "recency" as const,
      storedOwnershipFilter: "mine" as const,
      storedOwnershipRelation: "participated" as const,
    };
    await showLayout("sidebar", undefined, stored);
    expect(latest.options).toMatchObject({
      selectedEnvironmentIds: [environmentId],
      threadGrouping: "recency",
      ownershipFilter: "mine",
      ownershipRelation: "participated",
    });
    for (const callback of Object.values(callbacks)) expect(callback).not.toHaveBeenCalled();
    await act(() => {
      latest.toggleSelectedEnvironmentId(secondEnvironmentId);
      latest.setThreadGrouping("project");
      latest.setOwnershipFilter("theirs");
      latest.setOwnershipRelation("created");
    });
    expect(onStoreEnvironmentIds).toHaveBeenCalledExactlyOnceWith([
      environmentId,
      secondEnvironmentId,
    ]);
    expect(onStoreThreadGrouping).toHaveBeenCalledExactlyOnceWith("project");
    expect(onStoreOwnershipFilter).toHaveBeenCalledExactlyOnceWith("theirs");
    expect(onStoreOwnershipRelation).toHaveBeenCalledExactlyOnceWith("created");
    await showLayout("compact", undefined, stored);
    expect(latest.options).toMatchObject({
      selectedEnvironmentIds: [environmentId, secondEnvironmentId],
      threadGrouping: "project",
      ownershipFilter: "theirs",
      ownershipRelation: "created",
    });
  });

  it("restores saved filters on launch and saves only real changes", async () => {
    await showLayout("compact", { environmentId, projectKey: "repository:one" });
    expect(latest.options).toMatchObject({
      selectedEnvironmentId: environmentId,
      selectedProjectKey: "repository:one",
    });
    expect(saved).toEqual([]);

    await act(() => latest.setSelectedProjectKey(null));
    expect(saved).toEqual([{ threadListFilters: { environmentId, projectKey: null } }]);
  });
});

const defaults: HomeListOptions = {
  selectedEnvironmentIds: [],
  selectedProjectKey: null,
  ownershipFilter: DEFAULT_OWNERSHIP_FILTER,
  ownershipRelation: "both",
  listMode: "threads",
  threadGrouping: "project",
  projectSortOrder:
    DEFAULT_SIDEBAR_PROJECT_SORT_ORDER === "manual"
      ? "updated_at"
      : DEFAULT_SIDEBAR_PROJECT_SORT_ORDER,
  threadSortOrder: DEFAULT_SIDEBAR_THREAD_SORT_ORDER,
};

describe("home list options", () => {
  it("recognizes default options", () => {
    expect(hasCustomHomeListOptions(defaults)).toBe(false);
  });

  it("marks environment filters as customized", () => {
    expect(
      hasCustomHomeListOptions({
        ...defaults,
        selectedEnvironmentIds: ["environment-1" as never],
      }),
    ).toBe(true);
    expect(
      hasCustomHomeListOptions({ ...defaults, selectedProjectKey: "environment-1:project-1" }),
    ).toBe(true);
  });

  it("marks ownership filters as customized", () => {
    expect(hasCustomHomeListOptions({ ...defaults, ownershipFilter: "any" })).toBe(true);
    expect(hasCustomHomeListOptions({ ...defaults, ownershipFilter: "theirs" })).toBe(true);
    expect(hasCustomHomeListOptions({ ...defaults, ownershipRelation: "created" })).toBe(true);
  });

  it("marks non-default thread grouping as customized", () => {
    expect(hasCustomHomeListOptions({ ...defaults, threadGrouping: "recency" })).toBe(true);
    expect(hasCustomHomeListOptions({ ...defaults, threadGrouping: "none" })).toBe(true);
    expect(hasCustomHomeListOptions({ ...defaults, threadGrouping: "project" })).toBe(false);
  });
});
