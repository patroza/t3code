import type { BrowserWindowConstructorOptions, Session, WebPreferences } from "electron";
import * as Effect from "effect/Effect";

export interface WebAuthnAuthenticators {
  /** A passkey backend serves guest ceremonies (the macOS bridge; a future Linux backend). */
  readonly bridgeEnabled: boolean;
  readonly platform: NodeJS.Platform;
  readonly touchIdConfigured: boolean;
}

/** Whether a preview guest can complete a WebAuthn ceremony. Chromium delegates to Windows Hello. */
const webAuthnAvailable = (authenticators: WebAuthnAuthenticators) =>
  authenticators.bridgeEnabled ||
  authenticators.platform === "win32" ||
  authenticators.touchIdConfigured;

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

interface Policy {
  readonly available: () => boolean;
  readonly sessions: WeakSet<Session>;
}

// Keyed by the PreviewPasskeys service, so test doubles that never register keep upstream behavior.
const policies = new WeakMap<object, Policy>();

const deniesWebAuthn = (passkeys: object) => policies.get(passkeys)?.available() === false;

export const makePreviewWebAuthnPolicy = (
  authenticators: Omit<WebAuthnAuthenticators, "touchIdConfigured">,
) => {
  let touchIdConfigured = false;
  const policy: Policy = {
    available: () => webAuthnAvailable({ ...authenticators, touchIdConfigured }),
    sessions: new WeakSet(),
  };
  return {
    markTouchIdConfigured: () =>
      Effect.sync(() => {
        touchIdConfigured = true;
      }),
    register: <S extends object>(passkeys: S): S => {
      policies.set(passkeys, policy);
      return passkeys;
    },
  };
};

export const installWebAuthnSessionPolicy = (passkeys: object, session: Session) => {
  const policy = policies.get(passkeys);
  if (!policy || policy.available() || policy.sessions.has(session)) return;
  policy.sessions.add(session);
  session.webRequest.onHeadersReceived((details, callback) => {
    const document = details.resourceType === "mainFrame" || details.resourceType === "subFrame";
    callback(
      document && !policy.available()
        ? { responseHeaders: denyWebAuthnRequests(details.responseHeaders) }
        : {},
    );
  });
};

export const applyGuestWebAuthnPolicy = (passkeys: object, webPreferences: WebPreferences) => {
  if (deniesWebAuthn(passkeys)) disableWebAuthn(webPreferences);
};

export const previewPopupWindowOptions = <O extends BrowserWindowConstructorOptions>(
  passkeys: object,
  options: O,
): O => {
  if (!deniesWebAuthn(passkeys)) return options;
  const webPreferences = { ...options.webPreferences };
  disableWebAuthn(webPreferences);
  return { ...options, webPreferences };
};
