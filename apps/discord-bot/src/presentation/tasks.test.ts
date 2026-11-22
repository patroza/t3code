import { describe, expect, it } from "vite-plus/test";

import { formatTasksForDiscord } from "./tasks.ts";

describe("formatTasksForDiscord", () => {
  it("renders a compact progress summary", () => {
    const rendered = formatTasksForDiscord({
      contextKey: "turn-2",
      createdAt: "2026-07-16T00:00:01.000Z",
      explanation: "Keep one task message updated",
      tasks: [
        { step: "Ship task", status: "inProgress" },
        { step: "Verify", status: "completed" },
      ],
    });

    expect(rendered).toContain("**Tasks 1/2**");
    expect(rendered).toContain("_Keep one task message updated_");
    expect(rendered).toContain("◐ Ship task");
    expect(rendered).toContain("✅ Verify");
  });
});
