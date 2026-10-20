// @effect-diagnostics nodeBuiltinImport:off globalPromise:off globalFetch:off
import * as NodeBuffer from "node:buffer";
import { describe, expect, it, vi } from "vite-plus/test";
import { teamsUploadName, uploadTeamsChannelFiles } from "./channelFiles.ts";

const destination = {
  driveId: "drive",
  folderId: "folder",
  siteUrl: "https://omega.sharepoint.com/sites/Omega",
};
const file = { name: "report.csv", mimeType: "text/csv", data: new Uint8Array([65, 66]) };

describe("Teams channel file uploads", () => {
  it("uploads bytes to the configured folder and returns an authenticated site link", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      Response.json({
        id: "uploaded",
        name: teamsUploadName(file),
        webUrl: destination.siteUrl + "/report.csv",
      }),
    );
    const result = await uploadTeamsChannelFiles({
      destination,
      files: [file],
      fetch,
      getAccessToken: async () => "token",
      assertActive: () => {},
    });
    expect(fetch.mock.calls[0]?.[0]).toBe(
      `https://graph.microsoft.com/v1.0/drives/drive/items/folder:/${teamsUploadName(file)}:/content`,
    );
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      method: "PUT",
      redirect: "error",
      body: NodeBuffer.Buffer.from(file.data),
      headers: { Authorization: "Bearer token", "Content-Type": "text/csv" },
    });
    expect(result[0]?.webUrl).toBe(destination.siteUrl + "/report.csv");
  });
  it("keeps retries on the same file path without replacing differently sized content", () => {
    expect(teamsUploadName(file)).toBe(teamsUploadName({ ...file }));
    expect(teamsUploadName(file)).not.toBe(
      teamsUploadName({ ...file, data: new Uint8Array([67]) }),
    );
    expect(teamsUploadName({ ...file, name: "../../report?.csv" })).not.toMatch(/[/?]/u);
  });
  it("rejects revoked access before obtaining a token or writing a file", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const getAccessToken = vi.fn(async () => "token");
    await expect(
      uploadTeamsChannelFiles({
        destination,
        files: [file],
        fetch,
        getAccessToken,
        assertActive: () => {
          throw new Error("revoked");
        },
      }),
    ).rejects.toThrow("revoked");
    expect(fetch).not.toHaveBeenCalled();
    expect(getAccessToken).not.toHaveBeenCalled();
  });
  it("reports missing SharePoint consent and rejects file links outside the configured site", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response("", { status: 403 }))
      .mockResolvedValueOnce(
        Response.json({
          id: "uploaded",
          name: "report.csv",
          webUrl: "https://other.sharepoint.com/report.csv",
        }),
      );
    const options = {
      destination,
      files: [file],
      fetch,
      getAccessToken: async () => "token",
      assertActive: () => {},
    };
    await expect(uploadTeamsChannelFiles(options)).rejects.toThrow("write access");
    await expect(uploadTeamsChannelFiles(options)).rejects.toThrow(
      "outside its configured SharePoint site",
    );
  });
});
