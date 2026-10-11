import { describe, expect, it, vi } from "vite-plus/test";
import { startTeamsResponse } from "./responseDelivery.ts";

describe("Teams response delivery", () => {
  it.each([true, false])(
    "updates the working message and includes a thread link only for a new conversation (%s)",
    async (isNew) => {
      const send = vi.fn(async (_activity: { type: "message"; text: string; id?: string }) => ({
        id: "working-id",
      }));
      const deliver = await startTeamsResponse({
        send,
        isNew,
        threadUrl: "https://t3.example/?thread=one",
        assertActive: () => {},
      });
      expect(send.mock.calls[0]![0]).toMatchObject({
        text: isNew ? "Working…\n\n[Open in T3 Code](https://t3.example/?thread=one)" : "Working…",
      });
      await deliver("It’s 13:00 UTC.");
      expect(send.mock.calls[1]![0]).toMatchObject({
        id: "working-id",
        text: isNew
          ? "It’s 13:00 UTC.\n\n[Open in T3 Code](https://t3.example/?thread=one)"
          : "It’s 13:00 UTC.",
      });
      await deliver("Additional response chunk");
      expect(send.mock.calls[2]![0]).toEqual({
        type: "message",
        text: "Additional response chunk",
      });
    },
  );

  it("does not deliver a completed answer after a binding is revoked", async () => {
    let active = true;
    const send = vi.fn(async (_activity: { type: "message"; text: string; id?: string }) => ({
      id: "working-id",
    }));
    const deliver = await startTeamsResponse({
      send,
      isNew: false,
      threadUrl: "https://t3.example",
      assertActive: () => {
        if (!active) throw new Error("revoked");
      },
    });
    active = false;
    await expect(deliver("Answer")).rejects.toThrow("revoked");
    expect(send).toHaveBeenCalledTimes(1);
  });
});
