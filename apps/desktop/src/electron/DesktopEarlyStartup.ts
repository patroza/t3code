export interface DesktopEarlyStartupApp {
  readonly commandLine: {
    readonly appendSwitch: (switchName: string, value?: string) => void;
  };
  readonly exit: (exitCode?: number) => void;
  readonly getVersion: () => string;
}

export interface ConfigureDesktopEarlyStartupOptions {
  readonly app: DesktopEarlyStartupApp;
  readonly argv: ReadonlyArray<string>;
  readonly platform: NodeJS.Platform;
  readonly writeStdout: (value: string) => unknown;
}

/**
 * Applies command-line behavior that Electron must receive before `app.whenReady()`.
 *
 * Keep this explicit: Electron's automatic password-store selection is unreliable
 * in Linux desktop sessions such as Niri/UWSM, where Secret Service is available
 * but Chromium can otherwise select an unusable backend.
 */
export function configureDesktopEarlyStartup({
  app,
  argv,
  platform,
  writeStdout,
}: ConfigureDesktopEarlyStartupOptions): void {
  if (argv.includes("--version") || argv.includes("-v")) {
    try {
      writeStdout(`${app.getVersion()}\n`);
    } finally {
      app.exit(0);
    }
  }

  if (platform === "linux") {
    app.commandLine.appendSwitch("password-store", "gnome-libsecret");
  }
}
