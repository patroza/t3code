/**
 * Streamed headless tabs have no authenticator or device-security UI bridge.
 * Advertise that before a site's scripts choose a sign-in method, and settle
 * explicit WebAuthn requests instead of waiting for an invisible system prompt.
 * Native desktop tabs keep their own passkey support.
 */
export const SERVER_BROWSER_AUTHENTICATION_SCRIPT = `(() => {
  if (typeof PublicKeyCredential === "undefined" || typeof CredentialsContainer === "undefined") return;
  const container = CredentialsContainer.prototype;
  for (const method of ["get", "create"]) {
    const native = container[method];
    Object.defineProperty(container, method, {
      configurable: true,
      writable: true,
      value: function(options) {
        if (!options?.publicKey) return Reflect.apply(native, this, [options]);
        return Promise.reject(options.signal?.aborted
          ? options.signal.reason
          : new DOMException("This streamed browser has no authenticator available.", "NotAllowedError"));
      },
    });
  }
  Reflect.deleteProperty(globalThis, "PublicKeyCredential");
})();`;
