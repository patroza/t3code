import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { useWorktreeSetup } from "./useWorktreeSetup";

const state = vi.hoisted(() => ({ query: { data: null }, command: vi.fn() }));
vi.mock(import("../../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => state.query) as never,
}));
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => state.command) as never,
}));
let root: Root;
let container: HTMLDivElement;
function Probe({
  routeThreadRef,
  preparing = false,
}: {
  routeThreadRef: ScopedThreadRef;
  preparing?: boolean;
}) {
  const setup = useWorktreeSetup({
    routeThreadRef,
    ownerKey: "draft",
    activeThread: undefined,
    threadRef: null,
    serverProjection: null,
    activityRun: null,
    localPreparing: preparing,
    sendQueuesBehindSetup: false,
    followUpSent: false,
  });
  return <output>{setup.blocksSend ? "Preparing" : "Ready"}</output>;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  vi.unstubAllGlobals();
});
it("accepts recreated references for the same route while preparation state changes", async () => {
  const reference = () => ({
    environmentId: EnvironmentId.make("environment"),
    threadId: ThreadId.make("thread"),
  });
  for (let render = 0; render < 3; render += 1) {
    await act(() => root.render(<Probe routeThreadRef={reference()} />));
    expect(container.textContent).toBe("Ready");
  }
  await act(() => root.render(<Probe routeThreadRef={reference()} preparing />));
  expect(container.textContent).toBe("Preparing");
});
