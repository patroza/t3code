import { beforeEach } from "vite-plus/test";
import { commands } from "vite-plus/test/browser";

import { initializeI18n } from "../src/i18n/initializeI18n";

declare module "vite-plus/test/browser" {
  interface BrowserCommands {
    /** Defined in vite.config.ts. Moves Playwright's mouse off the page. */
    resetPointer: () => Promise<void>;
    /** Keep startup-scroll races reproducible on fast developer machines. */
    setCpuThrottling: (rate: number) => Promise<void>;
  }
}

// GuestPage mounts the connection graph at import. The vitest iframe is still at `/`
// then, so that import opens the page-origin environment before the test reaches visit("/guest").
if (window.location.search.includes("GuestPage.browser.test")) {
  window.history.replaceState(window.history.state, "", "/guest?share=share-1");
}

// Playwright's mouse outlives each test and each file, so whatever the next test mounts
// under its last position starts hovered. Registered here rather than in render() so tests
// that mount without it are covered too. Before each test, not after: a timed-out test keeps
// running and can move the mouse after its own afterEach.
beforeEach(async () => {
  await commands.resetPointer();
});

// The app initializes GT at startup; components using its hooks need the same here.
initializeI18n(() => {});
