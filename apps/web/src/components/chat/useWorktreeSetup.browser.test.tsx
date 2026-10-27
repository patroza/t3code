import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { render } from "../../../test/render";
import { expect, it, vi } from "vite-plus/test";
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
it("accepts recreated references for the same route while preparation state changes", async () => {
  const reference = () => ({
    environmentId: EnvironmentId.make("environment"),
    threadId: ThreadId.make("thread"),
  });
  state.query = { data: null };
  state.command.mockReset();
  await using screen = await render(<Probe routeThreadRef={reference()} />);
  const { container } = screen;
  for (let rerender = 0; rerender < 2; rerender += 1) {
    await screen.rerender(<Probe routeThreadRef={reference()} />);
    expect(container.textContent).toBe("Ready");
  }
  await screen.rerender(<Probe routeThreadRef={reference()} preparing />);
  expect(container.textContent).toBe("Preparing");
});
