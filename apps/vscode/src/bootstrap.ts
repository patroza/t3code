// @effect-diagnostics globalDate:off nodeBuiltinImport:off - bootstrap diagnostics must run before the Effect runtime loads.
import * as NodeFS from "node:fs";
import * as vscode from "vscode";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const remote = vscode.env.remoteName !== undefined;
  const output = vscode.window.createOutputChannel(remote ? "T3 Code (Remote)" : "T3 Code");
  context.subscriptions.push(output);
  const diagnosticsPath = vscode.Uri.joinPath(context.logUri, "diagnostics.log").fsPath;
  NodeFS.mkdirSync(context.logUri.fsPath, { recursive: true });
  NodeFS.writeFileSync(diagnosticsPath, "", "utf8");

  const log = (message: string): void => {
    const line = `${new Date().toISOString()} ${message}`;
    NodeFS.appendFileSync(diagnosticsPath, `${line}\n`, "utf8");
  };

  output.appendLine(`T3 Code diagnostics are written to ${diagnosticsPath}`);

  const showDiagnostics = async (): Promise<void> => {
    const document = await vscode.workspace.openTextDocument(diagnosticsPath);
    await vscode.window.showTextDocument(document, { preview: true, preserveFocus: true });
  };

  const startedAt = Date.now();
  log(
    `bootstrap start version=${String(context.extension.packageJSON.version)} remote=${vscode.env.remoteName ?? "local"}`,
  );

  try {
    const extension = await import("./extension.ts");
    log(`runtime loaded in ${Date.now() - startedAt}ms`);
    extension.activateExtension(context, showDiagnostics, log);
    log(`activate returned in ${Date.now() - startedAt}ms`);
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    log(`activation failed after ${Date.now() - startedAt}ms: ${message}`);
    await showDiagnostics();
    throw error;
  }
}

export function deactivate(): void {}
