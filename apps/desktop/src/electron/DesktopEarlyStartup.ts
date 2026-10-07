export interface DesktopEarlyStartupApp {
  readonly exit: (exitCode?: number) => void;
  readonly getVersion: () => string;
}

export interface ConfigureDesktopEarlyStartupOptions {
  readonly app: DesktopEarlyStartupApp;
  readonly argv: ReadonlyArray<string>;
  readonly writeStdout: (value: string) => unknown;
}

/**
 * Applies command-line behavior that Electron must receive before `app.whenReady()`.
 */
export function configureDesktopEarlyStartup({
  app,
  argv,
  writeStdout,
}: ConfigureDesktopEarlyStartupOptions): void {
  if (argv.includes("--version") || argv.includes("-v")) {
    try {
      writeStdout(`${app.getVersion()}\n`);
    } finally {
      app.exit(0);
    }
  }
}
