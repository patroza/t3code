import { EnvironmentId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  buildOwnershipPredicate,
  ownershipFilterStore,
  type OwnershipFilterableThread,
} from "./ownershipFilter";

const environmentId = EnvironmentId.make("environment-local");
const me = "person-me";
const them = "person-them";
const claims: ReadonlyMap<string, string | null | undefined> = new Map([[environmentId, me]]);

function thread(
  originPersonId: string | null,
  participantPersonIds: readonly string[] = [],
): OwnershipFilterableThread {
  return {
    environmentId,
    originSource: { personId: originPersonId },
    participantSummaries: participantPersonIds.map((personId) => ({ personId })),
  };
}

describe("buildOwnershipPredicate", () => {
  it("keeps only my threads under mine", () => {
    const predicate = buildOwnershipPredicate({
      claimPersonIdByEnvironment: claims,
      mode: "mine",
      relation: "both",
    });

    expect(predicate(thread(me))).toBe(true);
    expect(predicate(thread(them, [me]))).toBe(true);
    expect(predicate(thread(them))).toBe(false);
  });

  it("keeps only other people's threads under theirs", () => {
    const predicate = buildOwnershipPredicate({
      claimPersonIdByEnvironment: claims,
      mode: "theirs",
      relation: "both",
    });

    expect(predicate(thread(them))).toBe(true);
    expect(predicate(thread(me))).toBe(false);
  });

  it("keeps everything under any", () => {
    const predicate = buildOwnershipPredicate({
      claimPersonIdByEnvironment: claims,
      mode: "any",
      relation: "both",
    });

    expect(predicate(thread(me))).toBe(true);
    expect(predicate(thread(them))).toBe(true);
  });

  it("honours the created-only relation", () => {
    const predicate = buildOwnershipPredicate({
      claimPersonIdByEnvironment: claims,
      mode: "mine",
      relation: "created",
    });

    expect(predicate(thread(me))).toBe(true);
    // Participating is not creating.
    expect(predicate(thread(them, [me]))).toBe(false);
  });

  it("reads attributed work as someone else's when the environment has no claim", () => {
    // An environment with no identity claim (smart has no map while t3vm does)
    // cannot match anyone, so attributed threads fall to Theirs.
    const mine = buildOwnershipPredicate({
      claimPersonIdByEnvironment: undefined,
      mode: "mine",
      relation: "both",
    });
    const theirs = buildOwnershipPredicate({
      claimPersonIdByEnvironment: undefined,
      mode: "theirs",
      relation: "both",
    });

    expect(mine(thread(them))).toBe(false);
    expect(theirs(thread(them))).toBe(true);
  });

  it("keeps fully unattributed threads under mine", () => {
    // Local work carries no person at all; hiding it under the default filter
    // would empty the board for anyone not using identity claims.
    const predicate = buildOwnershipPredicate({
      claimPersonIdByEnvironment: claims,
      mode: "mine",
      relation: "both",
    });

    expect(predicate(thread(null))).toBe(true);
  });
});

function createLocalStorageStub(overrides: Partial<Storage> = {}): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    removeItem: (key) => void store.delete(key),
    setItem: (key, value) => void store.set(key, value),
    ...overrides,
  };
}

/** A window stub with a real event target, so notifications actually travel. */
function stubWindow(storage: Storage) {
  const target = new EventTarget();
  vi.stubGlobal("window", {
    localStorage: storage,
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
  });
}

describe("ownershipFilterStore", () => {
  let storage: Storage;

  beforeEach(() => {
    storage = createLocalStorageStub();
    stubWindow(storage);
    ownershipFilterStore.resetSessionValues();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("notifies every subscriber on a write, so surfaces move together", () => {
    // The bug this fixes: the sidebar held the selection in its own state, so
    // a Board mounted beside it never learned the filter had changed.
    const seen: string[] = [];
    const unsubscribeA = ownershipFilterStore.subscribeToMode(() =>
      seen.push(`a:${ownershipFilterStore.readMode()}`),
    );
    const unsubscribeB = ownershipFilterStore.subscribeToMode(() =>
      seen.push(`b:${ownershipFilterStore.readMode()}`),
    );

    ownershipFilterStore.setMode("theirs");

    expect(seen).toEqual(["a:theirs", "b:theirs"]);
    unsubscribeA();
    unsubscribeB();
  });

  it("stops notifying after unsubscribe", () => {
    let calls = 0;
    const unsubscribe = ownershipFilterStore.subscribeToMode(() => {
      calls += 1;
    });
    unsubscribe();

    ownershipFilterStore.setMode("any");

    expect(calls).toBe(0);
  });

  it("persists bare strings, not JSON, so existing selections keep loading", () => {
    ownershipFilterStore.setMode("theirs");
    ownershipFilterStore.setRelation("created");

    // A JSON codec would have written `"theirs"` with quotes and read every
    // pre-existing value back as invalid, resetting it to the default.
    expect(storage.getItem("t3.sidebar.ownershipFilter")).toBe("theirs");
    expect(storage.getItem("t3.sidebar.ownershipRelation")).toBe("created");
  });

  it("reads a value written before this fix shipped", () => {
    storage.setItem("t3.sidebar.ownershipFilter", "any");
    ownershipFilterStore.resetSessionValues();

    expect(ownershipFilterStore.readMode()).toBe("any");
  });

  it("keeps the selection for the session when storage cannot be written", () => {
    stubWindow(
      createLocalStorageStub({
        setItem: () => {
          throw new Error("quota exceeded");
        },
      }),
    );
    let notified = 0;
    const unsubscribe = ownershipFilterStore.subscribeToMode(() => {
      notified += 1;
    });

    ownershipFilterStore.setMode("theirs");

    // Each surface used to keep its own React state, so a blocked write still
    // applied for the session. Reading straight back out of storage would make
    // the click do nothing at all.
    expect(notified).toBe(1);
    expect(ownershipFilterStore.readMode()).toBe("theirs");
    unsubscribe();
  });
});
