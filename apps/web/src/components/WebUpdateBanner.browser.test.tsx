import { RegistryContext } from "@effect/atom-react";
import { Atom, AtomRegistry } from "effect/reactivity";
import { StrictMode } from "react";
import { act, render } from "../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock(import("../state/server"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  return {
    ...(await original()),
    primaryServerWebVersionAtom: Atom.make<string | null>(null),
  };
});

import { primaryServerWebVersionAtom } from "../state/server";
import { WebUpdateBanner } from "./WebUpdateBanner";

const versionAtom = primaryServerWebVersionAtom as Atom.Writable<string | null>;
function setup(version: string | null) {
  const registry = AtomRegistry.make();
  registry.set(versionAtom, version);
  return {
    registry,
    reportVersion: (next: string | null) => act(() => registry.set(versionAtom, next)),
    [Symbol.dispose]() {
      registry.dispose();
    },
  };
}

function renderBanner(registry: AtomRegistry.AtomRegistry) {
  return render(
    <RegistryContext.Provider value={registry}>
      <StrictMode>
        <WebUpdateBanner />
      </StrictMode>
    </RegistryContext.Provider>,
  );
}

describe("WebUpdateBanner version changes", () => {
  it("remembers the first server version and offers reload only after it changes", async () => {
    using fixture = setup("v1");
    const { reportVersion } = fixture;
    await using screen = await renderBanner(fixture.registry);
    const { container } = screen;
    const banner = () => container.querySelector('[role="status"]');
    expect(banner()).toBeNull();

    await reportVersion("v2");
    expect(banner()?.textContent).toContain("A new version of T3 Code is available.");
    expect(container.querySelector("button")?.textContent).toBe("Reload");

    await reportVersion(null);
    expect(banner()).toBeNull();

    await reportVersion("v2");
    expect(banner()).not.toBeNull();
    await reportVersion("v1");
    expect(banner()).toBeNull();
  });

  it("waits for the first known version when the tab starts without one", async () => {
    using fixture = setup(null);
    const { reportVersion } = fixture;
    await using screen = await renderBanner(fixture.registry);
    const { container } = screen;
    const banner = () => container.querySelector('[role="status"]');
    expect(banner()).toBeNull();

    await reportVersion("v1");
    expect(banner()).toBeNull();
    await reportVersion(null);
    expect(banner()).toBeNull();
    await reportVersion("v1");
    expect(banner()).toBeNull();

    await reportVersion("v2");
    expect(banner()).not.toBeNull();
  });
});
