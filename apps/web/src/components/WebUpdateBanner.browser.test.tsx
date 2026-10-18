import { RegistryContext } from "@effect/atom-react";
import { Atom, AtomRegistry } from "effect/reactivity";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

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
let registry: AtomRegistry.AtomRegistry;
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  registry = AtomRegistry.make();
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  registry.dispose();
  vi.unstubAllGlobals();
});

async function mount(version: string | null) {
  registry.set(versionAtom, version);
  await act(async () =>
    root.render(
      <RegistryContext.Provider value={registry}>
        <StrictMode>
          <WebUpdateBanner />
        </StrictMode>
      </RegistryContext.Provider>,
    ),
  );
}

const reportVersion = (version: string | null) =>
  act(async () => registry.set(versionAtom, version));
const banner = () => container.querySelector('[role="status"]');

describe("WebUpdateBanner version changes", () => {
  it("remembers the first server version and offers reload only after it changes", async () => {
    await mount("v1");
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
    await mount(null);
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
