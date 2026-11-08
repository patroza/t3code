import type { T3Highlights } from "@t3tools/mobile-highlights-native";
import { NitroModules } from "react-native-nitro-modules";

// Evaluating this module installs Nitro. Callers load it with a dynamic import
// so a failed install rejects a promise instead of aborting app startup.
export function createNativeHighlights(): T3Highlights | undefined {
  if (!NitroModules.hasHybridObject("T3Highlights")) return undefined;
  return NitroModules.createHybridObject<T3Highlights>("T3Highlights");
}
