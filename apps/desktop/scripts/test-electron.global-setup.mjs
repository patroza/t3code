import { ensureElectronRuntime } from "./ensure-electron-runtime.mjs";

// Electron 44 installs on first import. Prepare it in the coordinator before
// parallel workers can race while extracting the same runtime.
export default function setup() {
  ensureElectronRuntime();
}
