import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { derivePendingInteractions } from "./pendingInteractions.ts";

const activity = (kind: string, payload: unknown, sequence: number): OrchestrationThreadActivity =>
  ({
    id: `activity-${sequence}`,
    kind,
    payload,
    sequence,
    tone: "approval",
    summary: kind,
    turnId: null,
    createdAt: `2026-07-10T00:00:0${sequence}.000Z`,
  }) as OrchestrationThreadActivity;

describe("derivePendingInteractions", () => {
  it("keeps unresolved approvals and removes resolved ones", () => {
    expect(
      derivePendingInteractions([
        activity("approval.requested", { requestId: "one", requestKind: "command" }, 1),
        activity("approval.requested", { requestId: "two", requestType: "file_read_approval" }, 2),
        activity("approval.resolved", { requestId: "one" }, 3),
      ]),
    ).toEqual([
      expect.objectContaining({ requestId: "two", requestKind: "file-read", kind: "approval" }),
    ]);
  });

  it("preserves structured user-input questions", () => {
    const [pending] = derivePendingInteractions([
      activity(
        "user-input.requested",
        {
          requestId: "question",
          questions: [
            {
              id: "choice",
              header: "Choice",
              question: "Which one?",
              options: [{ label: "First", description: "Use the first option." }],
              multiSelect: false,
            },
          ],
        },
        1,
      ),
    ]);
    expect(pending).toMatchObject({ kind: "user-input", requestId: "question" });
  });
});
