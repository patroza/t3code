/** Recover stale Vite chunks after deploy, with a cooldown against offline/auth reload loops. */

export const VITE_PRELOAD_RELOAD_STORAGE_KEY = "t3:vite-preload-reload-at";
export const VITE_PRELOAD_RELOAD_COOLDOWN_MS = 10_000;

export type VitePreloadRecoveryStorage = Pick<Storage, "getItem" | "setItem">;

export function shouldReloadForPreloadError(
  nowMs: number,
  lastReloadAtMs: number | null,
  cooldownMs: number = VITE_PRELOAD_RELOAD_COOLDOWN_MS,
): boolean {
  if (lastReloadAtMs == null || !Number.isFinite(lastReloadAtMs)) {
    return true;
  }
  return nowMs - lastReloadAtMs >= cooldownMs;
}

function readLastReloadAt(storage: VitePreloadRecoveryStorage): number | null {
  const raw = storage.getItem(VITE_PRELOAD_RELOAD_STORAGE_KEY);
  if (raw == null || raw.length === 0) {
    return null;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

export function installVitePreloadRecovery(options?: {
  storage?: VitePreloadRecoveryStorage;
  reload?: () => void;
  now?: () => number;
  addEventListener?: typeof window.addEventListener;
  removeEventListener?: typeof window.removeEventListener;
  cooldownMs?: number;
}): () => void {
  if (typeof window === "undefined" && !options?.addEventListener) {
    return () => undefined;
  }

  const storage = options?.storage ?? window.sessionStorage;
  const reload = options?.reload ?? (() => window.location.reload());
  const now = options?.now ?? Date.now;
  const addEventListener = options?.addEventListener ?? window.addEventListener.bind(window);
  const removeEventListener =
    options?.removeEventListener ?? window.removeEventListener.bind(window);
  const cooldownMs = options?.cooldownMs ?? VITE_PRELOAD_RELOAD_COOLDOWN_MS;

  const onPreloadError = (event: Event) => {
    if (!shouldReloadForPreloadError(now(), readLastReloadAt(storage), cooldownMs)) {
      return;
    }

    // Prevent the default unhandled-rejection path so we own recovery.
    if ("preventDefault" in event && typeof event.preventDefault === "function") {
      event.preventDefault();
    }

    storage.setItem(VITE_PRELOAD_RELOAD_STORAGE_KEY, String(now()));
    reload();
  };

  addEventListener("vite:preloadError", onPreloadError);
  return () => {
    removeEventListener("vite:preloadError", onPreloadError);
  };
}
