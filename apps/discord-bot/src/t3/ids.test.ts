import { describe, expect, it } from "vite-plus/test";
import { newChatWorktreeBranch } from "./ids.ts";

describe("chat worktree names", () => {
  it("uses the Teams namespace for new Teams conversations", () => {
    expect(newChatWorktreeBranch("teams")).toMatch(/^t3-teams\/[0-9a-f]{8}$/u);
  });
  it("preserves the Discord namespace for Discord and legacy launches", () => {
    expect(newChatWorktreeBranch("discord")).toMatch(/^t3-discord\/[0-9a-f]{8}$/u);
    expect(newChatWorktreeBranch()).toMatch(/^t3-discord\/[0-9a-f]{8}$/u);
  });
  it("gives independent conversations distinct branch names", () => {
    expect(newChatWorktreeBranch("teams")).not.toBe(newChatWorktreeBranch("teams"));
  });
});
