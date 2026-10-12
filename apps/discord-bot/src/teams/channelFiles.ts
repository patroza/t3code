// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalPromise:off
import * as NodeBuffer from "node:buffer";
import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";
import type { BotUploadFile } from "../features/BotResponseTransport.ts";

/** A reviewed destination in the channel's SharePoint document library. */
export const TeamsFileDestination = Schema.Struct({
  driveId: Schema.String,
  folderId: Schema.String,
  siteUrl: Schema.String,
});
export type TeamsFileDestination = typeof TeamsFileDestination.Type;

const decodeItem = Schema.decodeUnknownSync(
  Schema.Struct({ id: Schema.String, name: Schema.String, webUrl: Schema.String }),
);
export type UploadedTeamsFile = ReturnType<typeof decodeItem>;

export function validateTeamsFileDestination(destination: TeamsFileDestination): void {
  const site = new URL(destination.siteUrl);
  if (
    !destination.driveId.trim() ||
    !destination.folderId.trim() ||
    site.protocol !== "https:" ||
    !site.hostname.endsWith(".sharepoint.com") ||
    site.port ||
    site.username ||
    site.password
  )
    throw new Error("Teams files require a configured SharePoint destination");
}

export function teamsUploadName(file: BotUploadFile): string {
  const name = file.name
    .replace(/[\\/:*?"<>|#%\u0000-\u001f]/gu, "_")
    .replace(/[. ]+$/u, "")
    .slice(-120);
  if (!name || name === "." || name === "..") throw new Error("Teams file name is empty");
  const digest = NodeCrypto.createHash("sha256").update(file.data).digest("hex").slice(0, 20);
  // Stable content-addressed names make retrying an accepted PUT safe and avoid replacing user files.
  return `omegent-${digest}-${name}`;
}

export async function uploadTeamsChannelFiles(input: {
  destination: TeamsFileDestination;
  files: ReadonlyArray<BotUploadFile>;
  getAccessToken: () => Promise<string>;
  assertActive: () => void;
  fetch?: typeof globalThis.fetch;
}): Promise<Array<UploadedTeamsFile>> {
  validateTeamsFileDestination(input.destination);
  const fetch = input.fetch ?? globalThis.fetch;
  const files: Array<UploadedTeamsFile> = [];
  for (const file of input.files) {
    if (file.data.byteLength > 4_000_000)
      throw new Error("Teams file exceeds the 4 MB upload limit");
    input.assertActive();
    const name = teamsUploadName(file);
    const target = input.destination;
    const url = `https://graph.microsoft.com/v1.0/drives/${encodeURIComponent(target.driveId)}/items/${encodeURIComponent(target.folderId)}:/${encodeURIComponent(name)}:/content`;
    const token = await input.getAccessToken();
    input.assertActive();
    const response = await fetch(url, {
      method: "PUT",
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": file.mimeType },
      body: NodeBuffer.Buffer.from(file.data),
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403)
        throw new Error("Omegent needs write access to this channel's SharePoint files");
      throw new Error(`Teams file upload failed (${response.status})`);
    }
    const uploaded = decodeItem(await response.json());
    const link = new URL(uploaded.webUrl);
    if (
      link.protocol !== "https:" ||
      link.origin !== new URL(target.siteUrl).origin ||
      link.username ||
      link.password
    )
      throw new Error("Teams upload returned a file link outside its configured SharePoint site");
    files.push(uploaded);
  }
  return files;
}
