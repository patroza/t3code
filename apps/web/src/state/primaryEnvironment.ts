import { Atom } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";

export const primaryEnvironmentIdAtom = Atom.make((get) => {
  for (const [environmentId, entry] of get(environmentCatalog.catalogValueAtom).entries) {
    if (entry.target._tag === "PrimaryConnectionTarget") {
      return environmentId;
    }
  }
  return null;
}).pipe(Atom.withLabel("web-primary-environment-id"));

export const primaryEnvironmentNativeBrowserAtom = Atom.make((get) => {
  for (const entry of get(environmentCatalog.catalogValueAtom).entries.values()) {
    if (entry.target._tag === "PrimaryConnectionTarget") {
      return entry.target.nativeServerBrowser === true;
    }
  }
  return false;
}).pipe(Atom.withLabel("web-primary-environment-native-browser"));
