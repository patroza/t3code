import type { ExpoConfig } from "expo/config";

// Fork-only. Points upstream's app config at the fork's Expo project and Apple team when the
// T3CODE_MOBILE_* identity is set (fork mobile workflows set it from eas.fork.json via
// scripts/apply-fork-eas-overlay.mjs). With none of it set the config is returned unchanged.
const UPSTREAM_IOS_BUNDLE_IDENTIFIER = /com\.t3tools\.t3code(?=$|\.)/g;

type ForkMobileEnv = Readonly<Record<string, string | undefined>>;

const replaceStrings = <T>(value: T, replace: (text: string) => string): T => {
  if (typeof value === "string") return replace(value) as T;
  if (Array.isArray(value)) return value.map((item) => replaceStrings(item, replace)) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, replaceStrings(item, replace)]),
    ) as T;
  }
  return value;
};

export function applyForkMobileConfig(
  config: ExpoConfig,
  env: ForkMobileEnv = process.env,
): ExpoConfig {
  const read = (name: string) => env[name]?.trim() || undefined;
  const bundleIdentifier = read("T3CODE_MOBILE_IOS_BUNDLE_IDENTIFIER");
  const teamId = read("T3CODE_MOBILE_IOS_TEAM_ID");
  const owner = read("T3CODE_MOBILE_EXPO_OWNER");
  const projectId = read("T3CODE_MOBILE_EAS_PROJECT_ID");
  const runtimeVersion = read("MOBILE_RUNTIME_VERSION_OVERRIDE");

  let next = config;
  if (bundleIdentifier) {
    // iOS identifiers only: the Android package and the widget/sharing plugins' Android
    // settings keep upstream's names. Personal Team builds never carry the upstream id.
    const rebrand = (text: string) =>
      text.replace(UPSTREAM_IOS_BUNDLE_IDENTIFIER, bundleIdentifier);
    next = {
      ...next,
      ios: replaceStrings(next.ios, rebrand),
      plugins: replaceStrings(next.plugins, rebrand),
    };
  }
  if (teamId && next.ios?.appleTeamId)
    next = { ...next, ios: { ...next.ios, appleTeamId: teamId } };
  if (owner) next = { ...next, owner };
  if (projectId) {
    next = {
      ...next,
      updates: { ...next.updates, url: `https://u.expo.dev/${projectId}` },
      extra: { ...next.extra, eas: { ...next.extra?.eas, projectId } },
    };
  } else if (owner) {
    // Upstream's EAS project belongs to its owner; a fork owner without a project gets no OTA.
    const { eas: _eas, ...extra } = next.extra ?? {};
    next = { ...next, updates: { enabled: false }, extra };
  }
  if (runtimeVersion) next = { ...next, runtimeVersion };
  return next;
}
