import { describe, expect, it, vi } from "vite-plus/test";
import { channelTopicOptsIntoInProgressStream } from "../presentation/attachments.ts";
import { topicDefaultModel, topicRequestsFastMode } from "../presentation/fastMode.ts";
import {
  makeTeamsChannelDescriptionReader,
  teamsDescriptionProject,
} from "./channelDescription.ts";

const policy = {
  useChannelDescription: true,
  descriptionProjectShortNames: ["t3code", "macs-scanner"],
  projectShortName: "t3code",
};
const location = {
  tenantId: "tenant-a",
  teamId: "team-a",
  channelId: "channel-a",
  assertActive: () => {},
};
const token = () => Response.json({ access_token: "test-token", expires_in: 3600 });

describe("Teams description tags", () => {
  it("uses the same Discord parsers for all preferences", () => {
    const description =
      "Scanner\nomegent-link-macs-scanner omegent-default-model-grok-4.7 omegent-fast-mode omegent-ips";
    expect(teamsDescriptionProject(description, policy)).toBe("macs-scanner");
    expect(topicDefaultModel(description)).toBe("grok-4.7");
    expect(topicRequestsFastMode(description)).toBe(true);
    expect(channelTopicOptsIntoInProgressStream(description)).toBe(true);
    expect(teamsDescriptionProject("ordinary description", policy)).toBe("t3code");
    expect(channelTopicOptsIntoInProgressStream("ordinary description")).toBe(false);
  });

  it("does not widen approved aliases, accepts legacy links, and rejects malformed links", () => {
    expect(() => teamsDescriptionProject("omegent-link-other-workspace", policy)).toThrow(
      "not approved",
    );
    expect(() => teamsDescriptionProject("omegent-link-", policy)).toThrow("invalid");
    expect(teamsDescriptionProject("t3-macs-scanner t3-ips", policy)).toBe("macs-scanner");
    expect(
      teamsDescriptionProject("omegent-link-macs-scanner", { projectShortName: "t3code" }),
    ).toBe("t3code");
    expect(() =>
      teamsDescriptionProject("", { ...policy, descriptionProjectShortNames: [] }),
    ).toThrow("explicit approved");
  });

  it("caches descriptions for 30 seconds but refreshes edits with a cached token", async () => {
    let now = 0;
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(Response.json({ id: "channel-a", description: "omegent-link-t3code" }))
      .mockResolvedValueOnce(
        Response.json({ id: "channel-a", description: "omegent-link-macs-scanner" }),
      );
    const read = makeTeamsChannelDescriptionReader({
      clientId: "bot",
      clientSecret: "test-secret",
      fetch: request,
      now: () => now,
    });
    expect(await read(location)).toBe("omegent-link-t3code");
    expect(await read(location)).toBe("omegent-link-t3code");
    expect(request).toHaveBeenCalledTimes(2);
    now = 30_001;
    expect(await read(location)).toBe("omegent-link-macs-scanner");
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[1]?.[0]).toContain(
      "/teams/team-a/channels/channel-a?$select=id,description",
    );
    expect(request.mock.calls[1]?.[1]?.headers).toEqual({ Authorization: "Bearer test-token" });
  });

  it("isolates cache entries by tenant, team and channel", async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      if (String(url).includes("oauth2")) return token();
      return Response.json({
        id: String(url).includes("channel-b") ? "channel-b" : "channel-a",
        description: String(url),
      });
    });
    const read = makeTeamsChannelDescriptionReader({
      clientId: "bot",
      clientSecret: "test-secret",
      fetch: request,
    });
    await read(location);
    await read({ ...location, teamId: "team-b" });
    await read({ ...location, channelId: "channel-b" });
    await read({ ...location, tenantId: "tenant-b" });
    expect(request).toHaveBeenCalledTimes(6); // Two tenant tokens, four metadata requests.
  });

  it("fails closed on missing consent and never caches that failure", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(new Response("", { status: 403 }))
      .mockResolvedValueOnce(Response.json({ id: "channel-a", description: null }));
    const read = makeTeamsChannelDescriptionReader({
      clientId: "bot",
      clientSecret: "test-secret",
      fetch: request,
    });
    await expect(read(location)).rejects.toThrow("ChannelSettings.Read.Group");
    expect(await read(location)).toBe("");
  });

  it("checks revoked authorization even for a cache hit", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(Response.json({ id: "channel-a", description: "" }));
    const read = makeTeamsChannelDescriptionReader({
      clientId: "bot",
      clientSecret: "test-secret",
      fetch: request,
    });
    await read(location);
    await expect(
      read({
        ...location,
        assertActive: () => {
          throw new Error("revoked");
        },
      }),
    ).rejects.toThrow("revoked");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("rejects metadata for a different channel", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(
        Response.json({ id: "channel-b", description: "omegent-link-t3code" }),
      );
    const read = makeTeamsChannelDescriptionReader({
      clientId: "bot",
      clientSecret: "test-secret",
      fetch: request,
    });
    await expect(read(location)).rejects.toThrow("identity mismatch");
  });
});
