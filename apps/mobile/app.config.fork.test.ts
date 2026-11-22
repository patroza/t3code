import { afterEach, expect, it, vi } from "vite-plus/test";

vi.mock("../../scripts/lib/public-config.ts", () => ({
  loadRepoEnv: () => ({ APP_VARIANT: process.env.APP_VARIANT }),
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

const forkIdentity = {
  T3CODE_MOBILE_IOS_BUNDLE_IDENTIFIER: "dev.example.t3code",
  T3CODE_MOBILE_IOS_TEAM_ID: "TEAM123456",
  T3CODE_MOBILE_EXPO_OWNER: "example",
  T3CODE_MOBILE_EAS_PROJECT_ID: "00000000-0000-4000-8000-000000000000",
};

async function loadConfig(variant: string, env: Record<string, string>) {
  vi.resetModules();
  vi.stubEnv("APP_VARIANT", variant);
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  return (await import("./app.config.ts")).default;
}

it("leaves upstream's config alone without a fork identity", async () => {
  const config = await loadConfig("production", {});
  expect(config.ios?.bundleIdentifier).toBe("com.t3tools.t3code");
  expect(config.owner).not.toBe("example");
});

it.each(["development", "production"])(
  "moves every iOS identifier to the fork bundle for %s but keeps the Android package",
  async (variant) => {
    const upstream = await loadConfig(variant, {});
    const config = await loadConfig(variant, forkIdentity);
    const iosSurface = JSON.stringify({ ios: config.ios, plugins: config.plugins });
    expect(iosSurface).not.toMatch(/com\.t3tools\.t3code(?![\w-])/);
    expect(config.ios?.bundleIdentifier).toBe(
      upstream.ios?.bundleIdentifier?.replace("com.t3tools.t3code", "dev.example.t3code"),
    );
    expect(iosSurface).toContain(`group.${config.ios?.bundleIdentifier}`);
    expect(config.android?.package).toBe(upstream.android?.package);
    expect(config.ios?.appleTeamId).toBe("TEAM123456");
    expect(config.owner).toBe("example");
    expect(config.extra?.eas?.projectId).toBe(forkIdentity.T3CODE_MOBILE_EAS_PROJECT_ID);
    expect(config.updates?.url).toBe(
      `https://u.expo.dev/${forkIdentity.T3CODE_MOBILE_EAS_PROJECT_ID}`,
    );
  },
);

it("disables OTA for a fork owner without its own EAS project", async () => {
  const config = await loadConfig("production", { T3CODE_MOBILE_EXPO_OWNER: "example" });
  expect(config.updates).toEqual({ enabled: false });
  expect(config.extra?.eas).toBeUndefined();
});

it("pins an explicit runtime version", async () => {
  const config = await loadConfig("production", { MOBILE_RUNTIME_VERSION_OVERRIDE: "abc123" });
  expect(config.runtimeVersion).toBe("abc123");
});
