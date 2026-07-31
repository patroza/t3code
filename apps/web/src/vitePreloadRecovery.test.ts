import { describe, expect, it, vi } from "vite-plus/test";

import {
  installVitePreloadRecovery,
  shouldReloadForPreloadError,
  VITE_PRELOAD_RELOAD_COOLDOWN_MS,
  VITE_PRELOAD_RELOAD_STORAGE_KEY,
} from "./vitePreloadRecovery";

describe("shouldReloadForPreloadError", () => {
  it("allows the first reload", () => {
    expect(shouldReloadForPreloadError(1_000, null)).toBe(true);
  });

  it("blocks reloads inside the cooldown window", () => {
    const last = 10_000;
    expect(shouldReloadForPreloadError(last + VITE_PRELOAD_RELOAD_COOLDOWN_MS - 1, last)).toBe(
      false,
    );
  });

  it("allows another reload after the cooldown", () => {
    const last = 10_000;
    expect(shouldReloadForPreloadError(last + VITE_PRELOAD_RELOAD_COOLDOWN_MS, last)).toBe(true);
  });
});

describe("installVitePreloadRecovery", () => {
  it("reloads once and records the attempt", () => {
    const storage = new Map<string, string>();
    const reload = vi.fn();
    const listeners = new Map<string, EventListener>();
    let now = 50_000;

    const dispose = installVitePreloadRecovery({
      storage: {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => {
          storage.set(key, value);
        },
      },
      reload,
      now: () => now,
      addEventListener: ((type: string, listener: EventListener) => {
        listeners.set(type, listener);
      }) as typeof window.addEventListener,
      removeEventListener: ((type: string) => {
        listeners.delete(type);
      }) as typeof window.removeEventListener,
    });

    const event = {
      preventDefault: vi.fn(),
    } as unknown as Event;

    listeners.get("vite:preloadError")?.(event);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(reload).toHaveBeenCalledOnce();
    expect(storage.get(VITE_PRELOAD_RELOAD_STORAGE_KEY)).toBe(String(now));

    // Same moment: cooldown blocks a second reload.
    listeners.get("vite:preloadError")?.(event);
    expect(reload).toHaveBeenCalledOnce();

    now += VITE_PRELOAD_RELOAD_COOLDOWN_MS;
    listeners.get("vite:preloadError")?.(event);
    expect(reload).toHaveBeenCalledTimes(2);

    dispose();
    expect(listeners.has("vite:preloadError")).toBe(false);
  });
});
