/**
 * Upload oversized Discord attachments to a private Azure Blob container and
 * return short-lived SAS read URLs.
 *
 * Security model:
 * - Container is private (not listable / not anonymously enumerable)
 * - Blob names are hard to guess (random UUID + random postfix on the filename)
 * - Access is via a read-only HTTPS SAS link that expires after 3 days
 */
// @effect-diagnostics preferSchemaOverJson:off globalDate:off cryptoRandomUUID:off globalErrorInEffectCatch:off globalErrorInEffectFailure:off

import {
  BlobSASPermissions,
  BlobServiceClient,
  generateBlobSASQueryParameters,
  SASProtocol,
  StorageSharedKeyCredential,
} from "@azure/storage-blob";

/** Discord free-tier conservative limit; over this we offload to Azure. */
export const DISCORD_CONSERVATIVE_UPLOAD_LIMIT_BYTES = 10_000_000;

/** Public download links expire after three days. */
export const AZURE_BLOB_LINK_TTL_MS = 3 * 24 * 60 * 60 * 1000;

/** Default private container for bot attachment offload. */
export const DEFAULT_AZURE_BLOB_CONTAINER = "discord-bot-attachments";

export interface AzureBlobUploadConfig {
  /** Full connection string (`AccountName=…;AccountKey=…;…`). Preferred. */
  readonly connectionString: string | undefined;
  /** Account name when not using a connection string. */
  readonly accountName: string | undefined;
  /** Account key when not using a connection string. */
  readonly accountKey: string | undefined;
  /** Private container name (must already exist, public access off). */
  readonly containerName: string;
}

export interface AzureBlobUploadFile {
  readonly name: string;
  readonly mimeType: string;
  readonly data: Uint8Array;
}

export interface UploadedAzureBlobLink {
  readonly fileName: string;
  readonly blobName: string;
  readonly url: string;
  readonly expiresAt: Date;
  readonly sizeBytes: number;
}

export class AzureBlobUploadError extends Error {
  readonly uploadCause: unknown | undefined;

  constructor(message: string, uploadCause?: unknown) {
    super(message);
    this.name = "AzureBlobUploadError";
    this.uploadCause = uploadCause;
  }
}

export function isAzureBlobUploadConfigured(
  config: AzureBlobUploadConfig | null | undefined,
): boolean {
  if (config === null || config === undefined) return false;
  const connection = config.connectionString?.trim() ?? "";
  if (connection !== "") return true;
  const account = config.accountName?.trim() ?? "";
  const key = config.accountKey?.trim() ?? "";
  return account !== "" && key !== "";
}

/**
 * Sanitize a user/agent filename for blob path use while preserving the extension.
 */
export function sanitizeBlobFileName(fileName: string): { stem: string; extension: string } {
  const trimmed = fileName.trim() || "attachment.bin";
  const lastDot = trimmed.lastIndexOf(".");
  const hasExt = lastDot > 0 && lastDot < trimmed.length - 1;
  const rawStem = hasExt ? trimmed.slice(0, lastDot) : trimmed;
  const rawExt = hasExt ? trimmed.slice(lastDot) : "";
  const stem =
    rawStem
      .replace(/[^A-Za-z0-9._-]+/gu, "-")
      .replace(/-+/gu, "-")
      .replace(/^[.-]+|[.-]+$/gu, "")
      .slice(0, 80) || "attachment";
  const extension = rawExt.replace(/[^A-Za-z0-9.]/gu, "").slice(0, 16);
  return { stem, extension };
}

/**
 * Opaque blob path: `yyyy/mm/dd/{uuid}/{stem}-{randomHex}{ext}`.
 * Random UUID directory + random filename postfix make enumeration impractical
 * even if someone somehow listed the container.
 */
export function buildOpaqueBlobName(
  fileName: string,
  options?: {
    readonly now?: Date;
    readonly randomUuid?: string;
    readonly randomPostfix?: string;
  },
): string {
  const now = options?.now ?? new Date();
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const uuid = options?.randomUuid ?? globalThis.crypto.randomUUID();
  const postfix =
    options?.randomPostfix ??
    Array.from(globalThis.crypto.getRandomValues(new Uint8Array(8)), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  const { stem, extension } = sanitizeBlobFileName(fileName);
  return `${yyyy}/${mm}/${dd}/${uuid}/${stem}-${postfix}${extension}`;
}

function parseConnectionString(connectionString: string): {
  accountName: string;
  accountKey: string;
  blobEndpoint: string | undefined;
} {
  const parts = new Map<string, string>();
  for (const segment of connectionString.split(";")) {
    const trimmed = segment.trim();
    if (trimmed === "") continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    parts.set(trimmed.slice(0, eq).toLowerCase(), trimmed.slice(eq + 1));
  }
  const accountName = parts.get("accountname") ?? "";
  const accountKey = parts.get("accountkey") ?? "";
  const blobEndpoint = parts.get("blobendpoint");
  if (accountName === "" || accountKey === "") {
    throw new AzureBlobUploadError(
      "Azure connection string must include AccountName and AccountKey",
    );
  }
  return {
    accountName,
    accountKey,
    blobEndpoint: blobEndpoint && blobEndpoint !== "" ? blobEndpoint : undefined,
  };
}

function resolveCredentials(config: AzureBlobUploadConfig): {
  accountName: string;
  credential: StorageSharedKeyCredential;
  serviceUrl: string;
} {
  const connection = config.connectionString?.trim() ?? "";
  if (connection !== "") {
    const parsed = parseConnectionString(connection);
    const credential = new StorageSharedKeyCredential(parsed.accountName, parsed.accountKey);
    const serviceUrl =
      parsed.blobEndpoint?.replace(/\/+$/u, "") ??
      `https://${parsed.accountName}.blob.core.windows.net`;
    return { accountName: parsed.accountName, credential, serviceUrl };
  }

  const accountName = config.accountName?.trim() ?? "";
  const accountKey = config.accountKey?.trim() ?? "";
  if (accountName === "" || accountKey === "") {
    throw new AzureBlobUploadError(
      "Azure blob upload requires AZURE_STORAGE_CONNECTION_STRING or account name+key",
    );
  }
  return {
    accountName,
    credential: new StorageSharedKeyCredential(accountName, accountKey),
    serviceUrl: `https://${accountName}.blob.core.windows.net`,
  };
}

function buildReadSasUrl(input: {
  readonly accountName: string;
  readonly credential: StorageSharedKeyCredential;
  readonly containerName: string;
  readonly blobName: string;
  readonly serviceUrl: string;
  readonly expiresAt: Date;
  readonly startsOn: Date;
}): string {
  const sas = generateBlobSASQueryParameters(
    {
      containerName: input.containerName,
      blobName: input.blobName,
      permissions: BlobSASPermissions.parse("r"),
      startsOn: input.startsOn,
      expiresOn: input.expiresAt,
      protocol: SASProtocol.Https,
    },
    input.credential,
  ).toString();

  const base = `${input.serviceUrl.replace(/\/+$/u, "")}/${encodeURIComponent(input.containerName).replace(/%2F/giu, "/")}/${input.blobName
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")}`;
  return `${base}?${sas}`;
}

/**
 * Upload one file to the private container and return a 3-day read-only SAS URL.
 */
export async function uploadFileToAzureBlob(input: {
  readonly config: AzureBlobUploadConfig;
  readonly file: AzureBlobUploadFile;
  readonly now?: Date;
  readonly ttlMs?: number;
}): Promise<UploadedAzureBlobLink> {
  if (!isAzureBlobUploadConfigured(input.config)) {
    throw new AzureBlobUploadError("Azure blob upload is not configured");
  }

  const containerName = input.config.containerName.trim() || DEFAULT_AZURE_BLOB_CONTAINER;
  const now = input.now ?? new Date();
  const ttlMs = input.ttlMs ?? AZURE_BLOB_LINK_TTL_MS;
  const expiresAt = new Date(now.getTime() + ttlMs);
  // Allow small clock skew on the consumer side.
  const startsOn = new Date(now.getTime() - 5 * 60 * 1000);
  const blobName = buildOpaqueBlobName(input.file.name, { now });

  try {
    const { accountName, credential, serviceUrl } = resolveCredentials(input.config);
    const service = new BlobServiceClient(serviceUrl, credential);
    const container = service.getContainerClient(containerName);
    const blockBlob = container.getBlockBlobClient(blobName);

    const body = Buffer.from(
      input.file.data.buffer,
      input.file.data.byteOffset,
      input.file.data.byteLength,
    );
    const safeName = sanitizeBlobFileName(input.file.name);
    await blockBlob.upload(body, body.byteLength, {
      blobHTTPHeaders: {
        blobContentType: input.file.mimeType || "application/octet-stream",
        // Encourage download with the original filename in browsers.
        blobContentDisposition: `attachment; filename="${safeName.stem}${safeName.extension}"`,
      },
    });

    const url = buildReadSasUrl({
      accountName,
      credential,
      containerName,
      blobName,
      serviceUrl,
      expiresAt,
      startsOn,
    });

    return {
      fileName: input.file.name,
      blobName,
      url,
      expiresAt,
      sizeBytes: input.file.data.byteLength,
    };
  } catch (cause) {
    if (cause instanceof AzureBlobUploadError) throw cause;
    throw new AzureBlobUploadError(
      `Azure blob upload failed for ${input.file.name}: ${cause instanceof Error ? cause.message : String(cause)}`,
      cause,
    );
  }
}

/**
 * Upload many oversized files. Failures are isolated per file so one bad upload
 * does not block the rest.
 */
export async function uploadOversizedFilesToAzureBlob(input: {
  readonly config: AzureBlobUploadConfig;
  readonly files: ReadonlyArray<AzureBlobUploadFile>;
  readonly now?: Date;
  readonly ttlMs?: number;
}): Promise<{
  readonly uploaded: ReadonlyArray<UploadedAzureBlobLink>;
  readonly failed: ReadonlyArray<{ readonly fileName: string; readonly error: string }>;
}> {
  const uploaded: UploadedAzureBlobLink[] = [];
  const failed: Array<{ fileName: string; error: string }> = [];

  for (const file of input.files) {
    try {
      uploaded.push(
        await uploadFileToAzureBlob({
          config: input.config,
          file,
          ...(input.now === undefined ? {} : { now: input.now }),
          ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
        }),
      );
    } catch (cause) {
      failed.push({
        fileName: file.name,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  return { uploaded, failed };
}

/** Discord note for files that could not fit Discord's attachment limit. */
export function formatOversizedAttachmentNote(input: {
  readonly uploaded: ReadonlyArray<UploadedAzureBlobLink>;
  readonly failed: ReadonlyArray<{ readonly fileName: string; readonly sizeBytes?: number }>;
  readonly unconfigured?: ReadonlyArray<{ readonly fileName: string; readonly sizeBytes: number }>;
}): string | null {
  const sections: string[] = [];

  if (input.uploaded.length > 0) {
    sections.push(
      [
        "**Files too large for Discord — temporary download links (expire in 3 days):**",
        ...input.uploaded.map((entry) => {
          const mb = Math.max(1, Math.ceil(entry.sizeBytes / 1_000_000));
          return `- [\`${entry.fileName}\`](${entry.url}) (${mb} MB)`;
        }),
      ].join("\n"),
    );
  }

  const failed = [
    ...input.failed.map((entry) => {
      const size =
        entry.sizeBytes === undefined
          ? ""
          : ` (${Math.max(1, Math.ceil(entry.sizeBytes / 1_000_000))} MB)`;
      return `- \`${entry.fileName}\`${size}`;
    }),
    ...(input.unconfigured ?? []).map((entry) => {
      const mb = Math.max(1, Math.ceil(entry.sizeBytes / 1_000_000));
      return `- \`${entry.fileName}\` (${mb} MB)`;
    }),
  ];
  if (failed.length > 0) {
    sections.push(
      [
        input.uploaded.length > 0
          ? "**Could not offload these files:**"
          : "**Some files could not be attached due to Discord upload limits:**",
        ...failed,
      ].join("\n"),
    );
  }

  if (sections.length === 0) return null;
  return sections.join("\n\n");
}
