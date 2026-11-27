import { EnvironmentId } from "@t3tools/contracts";
import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import "../../index.css";
import { render } from "../../../test/render";

const updateSettings = vi.hoisted(() => vi.fn());
let currentEnabled = true;

vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentSettings: ((
    _envId: unknown,
    selector: (s: { antigravityUsageLimitsEnabled: boolean }) => unknown,
  ) => selector({ antigravityUsageLimitsEnabled: currentEnabled })) as never,
  useUpdateEnvironmentSettings: (() => updateSettings) as never,
}));

import { AntigravityUsageLimitsSetting } from "./AntigravityUsageLimitsSettingFork";

describe("AntigravityUsageLimitsSetting", () => {
  it("renders the opt-out toggle and updates antigravityUsageLimitsEnabled", async () => {
    updateSettings.mockClear();
    currentEnabled = true;
    await using _screen = await render(
      <AntigravityUsageLimitsSetting
        environmentId={EnvironmentId.make("local")}
        readOnly={false}
      />,
    );

    const toggle = page.getByTestId("antigravity-usage-limits-toggle");
    await expect.element(toggle).toBeVisible();
    await userEvent.click(toggle);

    expect(updateSettings).toHaveBeenCalledOnce();
    expect(updateSettings).toHaveBeenCalledWith({ antigravityUsageLimitsEnabled: false });
  });
});
