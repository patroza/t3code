// @effect-diagnostics globalDate:off - bootstrap diagnostics must run before the Effect runtime loads.
import * as vscode from "vscode";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const remote = vscode.env.remoteName !== undefined;
  const output = vscode.window.createOutputChannel(remote ? "T3 Code (Remote)" : "T3 Code");
  context.subscriptions.push(output);

  const log = (message: string): void => {
    const line = `${new Date().toISOString()} ${message}`;
    output.appendLine(line);
  };

  const startedAt = Date.now();
  log(
    `bootstrap start version=${String(context.extension.packageJSON.version)} remote=${vscode.env.remoteName ?? "local"}`,
  );

  try {
    const extension = await import("./extension.ts");
    log(`runtime loaded in ${Date.now() - startedAt}ms`);
    extension.activateExtension(context, output, log);
    log(`activate returned in ${Date.now() - startedAt}ms`);
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    log(`activation failed after ${Date.now() - startedAt}ms: ${message}`);
    output.show(true);
    throw error;
  }
}

export function deactivate(): void {}
