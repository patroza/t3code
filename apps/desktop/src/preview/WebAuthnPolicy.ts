import type { WebPreferences } from "electron";

/** Hide unsupported authenticators before scripts select a sign-in method, including in frames. */
export function disableWebAuthn(webPreferences: WebPreferences): void {
  const features = new Set(
    (webPreferences.disableBlinkFeatures ?? "")
      .split(",")
      .map((feature) => feature.trim())
      .filter(Boolean),
  );
  features.add("WebAuth");
  webPreferences.disableBlinkFeatures = [...features].join(",");
}

/** WebAuth hides the constructor but does not settle every direct credential request. */
export function denyWebAuthnRequests(responseHeaders: Record<string, string[]> = {}) {
  const policy = Object.entries(responseHeaders)
    .filter(([name]) => name.toLowerCase() === "permissions-policy")
    .flatMap(([, values]) => values);
  // Chromium uses the last value of a repeated directive; a site cannot re-enable these.
  return {
    ...Object.fromEntries(
      Object.entries(responseHeaders).filter(
        ([name]) => name.toLowerCase() !== "permissions-policy",
      ),
    ),
    "Permissions-Policy": [
      ...policy,
      "publickey-credentials-get=(), publickey-credentials-create=()",
    ],
  };
}
