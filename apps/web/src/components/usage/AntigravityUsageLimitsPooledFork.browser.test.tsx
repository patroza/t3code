import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "../../index.css";
import { render } from "../../../test/render";
import { UsageLimitsPooled } from "./UsageLimitsPooled";

const NOW = Date.parse("2026-11-27T12:00:00.000Z");

describe("UsageLimitsPooled Antigravity ordering", () => {
  it("renders Gemini 5-hour and Weekly before Claude/GPT scoped windows", async () => {
    const envId = EnvironmentId.make("local");
    const provider: ServerProvider = {
      instanceId: ProviderInstanceId.make("antigravity"),
      driver: ProviderDriverKind.make("antigravity"),
      displayName: "Antigravity",
      enabled: true,
      installed: true,
      version: "1.5.18",
      status: "ready",
      auth: { status: "authenticated", type: "oauth-personal", label: "Google account" },
      checkedAt: new Date(NOW).toISOString(),
      models: [],
      slashCommands: [],
      skills: [],
      usageLimits: {
        checkedAt: new Date(NOW).toISOString(),
        windows: [
          {
            id: "5h",
            kind: "session",
            label: "5-hour",
            usedPercent: 22.3,
            windowDurationMins: 300,
            resetsAt: new Date(NOW + (2 * 3600 + 41 * 60) * 1_000).toISOString(),
          },
          {
            id: "5h_claude_gpt",
            kind: "session",
            label: "5-hour · Claude/GPT",
            usedPercent: 0,
            windowDurationMins: 300,
          },
          {
            id: "weekly",
            kind: "weekly",
            label: "Weekly",
            usedPercent: 32.1,
            windowDurationMins: 10080,
            resetsAt: new Date(NOW + (5 * 86400 + 18 * 3600 + 27 * 60) * 1_000).toISOString(),
          },
          {
            id: "weekly_claude_gpt",
            kind: "weekly",
            label: "Weekly · Claude/GPT",
            usedPercent: 34.2,
            windowDurationMins: 10080,
            resetsAt: new Date(NOW + (4 * 86400 + 20 * 3600 + 17 * 60) * 1_000).toISOString(),
          },
        ],
      },
    };

    const presentations = new Map([
      [
        envId,
        {
          entry: { target: { label: "This host" } },
          serverConfig: { providers: [provider], usageLimitSources: [] },
        },
      ],
    ]) as unknown as Parameters<typeof UsageLimitsPooled>[0]["presentations"];

    await using screen = await render(
      <UsageLimitsPooled presentations={presentations} now={NOW} />,
    );

    const section = screen.container.querySelector("section");
    expect(section).not.toBeNull();
    const labels = [
      ...section!.querySelectorAll(":scope > div > div:first-child > span:first-child"),
    ].map((el) => el.textContent?.trim());
    expect(labels).toEqual(["5-hour", "Weekly", "5-hour · Claude/GPT", "Weekly · Claude/GPT"]);
    await expect.element(page.getByText("78%").first()).toBeVisible();
    await expect.element(page.getByText("68%").first()).toBeVisible();
    await expect.element(page.getByText("100%").first()).toBeVisible();
    await expect.element(page.getByText("66%").first()).toBeVisible();
    expect(
      section!.querySelectorAll('[role="img"][aria-label*="pace"]').length,
    ).toBeGreaterThanOrEqual(3);
  });
});
