// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  SCANNER_GROUP_CHAT_PROJECT,
  botWasAdded,
  groupChatMirrorsFile,
  groupChatSourceKey,
  groupChatSpeaksInTeams,
  readGroupChatMirror,
  rememberGroupChatMirror,
  SCANNER_GROUP_CHAT_MIRROR,
  teamsChannelThreadId,
  loadGroupChatRulesFromFileSync,
  planTeamsGroupChat,
  type GroupChatRule,
} from "./groupChats.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => NodeFSP.rm(dir, { recursive: true, force: true })),
  );
});

const base = {
  tenantId: "tenant",
  conversationId: "19:chat@thread.v2;messageid=1",
  conversationType: "groupChat",
  rules: [] as ReadonlyArray<GroupChatRule>,
  event: "message" as const,
  fromBot: false,
  knownUser: false,
  mentionedBot: false,
  text: "Die Buchung geht nicht durch, Fehler im Scanner.",
  author: "Frerk",
  messageId: "m1",
};

describe("scanner group chat names", () => {
  it.each([
    "MAKO Scanner",
    "Easy Life Scanning App",
    "Empasa/EasyLife Scanner - ABAS",
    "Empasa Scanning App",
  ])("maps %s to the scanner project", (title) => {
    const plan = planTeamsGroupChat({ ...base, title });
    expect(plan.kind).toBe("turn");
    if (plan.kind !== "turn") return;
    expect(plan.chat.projectShortName).toBe(SCANNER_GROUP_CHAT_PROJECT);
    expect(plan.chat.passive).toBe(true);
    expect(plan.chat.title).toBe(title);
    expect(plan.wake).toBe("observe");
    expect(plan.sourceKey).toBe("native/tenant/group/19:chat@thread.v2");
  });

  it("leaves Alfa Omega Configurator unmapped", () => {
    expect(planTeamsGroupChat({ ...base, title: "Alfa Omega Configurator" }).kind).toBe("unmapped");
  });

  it("does not map a company name that is not a scanner chat", () => {
    expect(planTeamsGroupChat({ ...base, title: "MAKO" }).kind).toBe("unmapped");
    expect(planTeamsGroupChat({ ...base, title: "Empasa" }).kind).toBe("unmapped");
  });
});

describe("planTeamsGroupChat", () => {
  it("ignores personal chats and team channels", () => {
    expect(
      planTeamsGroupChat({ ...base, title: "MAKO Scanner", conversationType: "personal" }).kind,
    ).toBe("not-group");
    expect(
      planTeamsGroupChat({
        ...base,
        title: "MAKO Scanner",
        conversationType: undefined,
        teamId: "team",
      }).kind,
    ).toBe("not-group");
  });

  it("stays silent in the Teams chat", () => {
    expect(groupChatSpeaksInTeams()).toBe(false);
    const plan = planTeamsGroupChat({ ...base, title: "MAKO Scanner" });
    expect(plan.kind).toBe("turn");
    if (plan.kind !== "turn") return;
    expect(plan.prompt).toContain("Do not send a message in the Teams chat.");
    expect(plan.prompt).toContain("If this reports an issue, investigate it");
    expect(plan.prompt).toContain("If it continues an earlier conversation");
  });

  it("treats a greeting as chatter and a known-user mention as an instruction", () => {
    expect(
      planTeamsGroupChat({ ...base, title: "Empasa Scanning App", text: "Guten Morgen" }).kind,
    ).toBe("ignore");
    const instruction = planTeamsGroupChat({
      ...base,
      title: "Empasa Scanning App",
      text: "look at the GLS label",
      knownUser: true,
      mentionedBot: true,
    });
    expect(instruction.kind).toBe("turn");
    if (instruction.kind !== "turn") return;
    expect(instruction.wake).toBe("instruction");
    expect(instruction.prompt).toContain("A known user addressed you");
  });

  it("keeps a known user's chat message as an observation until they address the bot", () => {
    const plan = planTeamsGroupChat({
      ...base,
      title: "MAKO Scanner",
      knownUser: true,
      mentionedBot: false,
    });
    expect(plan.kind).toBe("turn");
    if (plan.kind !== "turn") return;
    expect(plan.wake).toBe("observe");
  });

  it("runs stop, approve, and answer from a known user without opening an investigation", () => {
    expect(
      planTeamsGroupChat({ ...base, title: "MAKO Scanner", knownUser: true, text: "stop" }).kind,
    ).toBe("command");
    expect(
      planTeamsGroupChat({
        ...base,
        title: "MAKO Scanner",
        knownUser: false,
        text: "stop",
      }).kind,
    ).toBe("ignore");
    const mention = planTeamsGroupChat({
      ...base,
      title: "MAKO Scanner",
      knownUser: true,
      mentionedBot: true,
      text: "",
    });
    expect(mention.kind).toBe("turn");
    if (mention.kind === "turn") expect(mention.wake).toBe("instruction");
    const answer = planTeamsGroupChat({
      ...base,
      title: "MAKO Scanner",
      knownUser: true,
      text: 'answer req-1 {"note":"ok"}',
    });
    expect(answer.kind).toBe("command");
    if (answer.kind !== "command" || answer.command.kind !== "answer") return;
    expect(answer.command.requestId).toBe("req-1");
  });

  it("opens one joined thread for a mapped chat and skips the bot's own messages", () => {
    const joined = planTeamsGroupChat({
      ...base,
      event: "join",
      title: "Easy Life Scanning App",
      text: "",
    });
    expect(joined.kind).toBe("turn");
    if (joined.kind !== "turn") return;
    expect(joined.wake).toBe("joined");
    expect(joined.prompt).toContain("Do not investigate");
    expect(planTeamsGroupChat({ ...base, title: "MAKO Scanner", fromBot: true }).kind).toBe("skip");
  });

  it("lets a conversation id rule override the title", () => {
    const plan = planTeamsGroupChat({
      ...base,
      conversationId: "19:pinned@thread.v2",
      title: "Alfa Omega Configurator",
      rules: [{ conversationId: "19:pinned@thread.v2", projectShortName: "macs-scanner" }],
    });
    expect(plan.kind).toBe("turn");
    if (plan.kind !== "turn") return;
    expect(plan.chat.projectShortName).toBe("macs-scanner");
    expect(plan.chat.title).toBe("Alfa Omega Configurator");
    expect(plan.chat.mirror).toEqual(SCANNER_GROUP_CHAT_MIRROR);
  });

  it("copies scanner chats into the Scanner channel and lets a rule choose another", () => {
    const builtin = planTeamsGroupChat({ ...base, title: "MAKO Scanner" });
    expect(builtin.kind).toBe("turn");
    if (builtin.kind !== "turn") return;
    expect(builtin.chat.mirror).toEqual(SCANNER_GROUP_CHAT_MIRROR);
    const other = {
      tenantId: "11111111-1111-4111-8111-111111111111",
      teamId: "22222222-2222-4222-8222-222222222222",
      channelId: "19:other@thread.tacv2",
    };
    const pinned = planTeamsGroupChat({
      ...base,
      title: "MAKO Scanner",
      rules: [{ titleIncludes: "MAKO Scanner", projectShortName: "macs-scanner", mirror: other }],
    });
    expect(pinned.kind).toBe("turn");
    if (pinned.kind !== "turn") return;
    expect(pinned.chat.mirror).toEqual(other);
    expect(teamsChannelThreadId(other, { id: other.channelId, activityId: "root" })).toBe(
      `${other.channelId};messageid=root`,
    );
  });

  it("keeps one source key per chat", () => {
    expect(groupChatSourceKey("tenant", "19:chat@thread.v2;messageid=9")).toBe(
      groupChatSourceKey("tenant", "19:chat@thread.v2"),
    );
  });

  it("recognises when the bot itself was added", () => {
    expect(botWasAdded({ recipientId: "28:bot", memberIds: ["28:bot", "29:user"] })).toBe(true);
    expect(botWasAdded({ recipientId: "28:bot", memberIds: ["29:user"] })).toBe(false);
  });
});

describe("loadGroupChatRulesFromFileSync", () => {
  it("reads group chat rules and rejects a speaking binding", async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "teams-group-"));
    tempDirs.push(dir);
    const filePath = NodePath.join(dir, "teams.json");
    await NodeFSP.writeFile(
      filePath,
      JSON.stringify({
        channels: [],
        groupChats: [
          { titleIncludes: "MAKO Scanner", projectShortName: "MACS-SCANNER", passive: true },
        ],
      }),
      "utf8",
    );
    expect(loadGroupChatRulesFromFileSync(filePath)).toEqual([
      { titleIncludes: "MAKO Scanner", projectShortName: "macs-scanner" },
    ]);

    await NodeFSP.writeFile(
      filePath,
      JSON.stringify({
        groupChats: [
          { titleIncludes: "MAKO Scanner", projectShortName: "macs-scanner", passive: false },
        ],
      }),
      "utf8",
    );
    expect(() => loadGroupChatRulesFromFileSync(filePath)).toThrow(/passive: false/u);

    await NodeFSP.writeFile(
      filePath,
      JSON.stringify({
        groupChats: [
          {
            titleIncludes: "MAKO Scanner",
            projectShortName: "macs-scanner",
            mirrorTenantId: "77e3cbed-2705-4d62-8421-efde364a4eeb",
            mirrorTeamId: "1523eb08-b152-4a1d-91e1-8658cf950273",
            mirrorChannelId: "19:ff57061cd9894df08d0d0230c76947af@thread.tacv2",
          },
        ],
      }),
      "utf8",
    );
    expect(loadGroupChatRulesFromFileSync(filePath)[0]?.mirror).toEqual(SCANNER_GROUP_CHAT_MIRROR);
    const mirrors = groupChatMirrorsFile(dir);
    await rememberGroupChatMirror(
      mirrors,
      "native/tenant/group/19:chat@thread.v2",
      "19:channel;messageid=1",
    );
    expect(readGroupChatMirror(mirrors, "native/tenant/group/19:chat@thread.v2")).toBe(
      "19:channel;messageid=1",
    );
  });

  it("returns no extra rules for a channel array file", async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "teams-group-"));
    tempDirs.push(dir);
    const filePath = NodePath.join(dir, "teams.json");
    await NodeFSP.writeFile(filePath, "[]", "utf8");
    expect(loadGroupChatRulesFromFileSync(filePath)).toEqual([]);
  });
});
