import { describe, expect, it } from "vite-plus/test";

import { buildFirstTurnPrompt } from "./threadContext.ts";
import {
  applyMonitorEveryoneMention,
  isSentryMonitorPost,
  MONITOR_TOPIC_TAG,
  monitorSeverity,
  SENTRY_MONITOR_PROMPT,
  sentryMonitorThreadTitle,
  topicRequestsMonitor,
} from "./monitor.ts";

const sentryMessage = {
  author: { username: "Sentry", bot: true },
  content: "",
  embeds: [
    {
      title: "T3 did not become ready after a server restart",
      url: "https://macs-scanner.sentry.io/issues/7506163172/",
      footer: { text: "SCANNER-313" },
    },
  ],
};

describe("topicRequestsMonitor", () => {
  it("matches the topic tag and ignores lookalikes", () => {
    expect(MONITOR_TOPIC_TAG).toBe("omegent-monitor");
    expect(topicRequestsMonitor("omegent-link-scanner omegent-monitor")).toBe(true);
    expect(topicRequestsMonitor("t3-macs-scanner\nOMEGENT-MONITOR")).toBe(true);
    expect(topicRequestsMonitor("see omegent-monitor.")).toBe(true);
    expect(topicRequestsMonitor("omegent-link-scanner")).toBe(false);
    expect(topicRequestsMonitor("omegent-monitor-extra")).toBe(false);
    expect(topicRequestsMonitor("omegent-link-monitor")).toBe(false);
    expect(topicRequestsMonitor(null)).toBe(false);
    expect(topicRequestsMonitor("")).toBe(false);
  });
});

describe("isSentryMonitorPost", () => {
  it("accepts a Sentry bot or webhook post and skips people and this bot", () => {
    expect(
      isSentryMonitorPost({
        authorId: "sentry-bot",
        authorBot: true,
        botUserId: "omegent",
        message: sentryMessage,
      }),
    ).toBe(true);
    expect(
      isSentryMonitorPost({
        authorId: "webhook-user",
        authorBot: false,
        webhookId: "hook-1",
        botUserId: "omegent",
        message: sentryMessage,
      }),
    ).toBe(true);
    expect(
      isSentryMonitorPost({
        authorId: "95218063095377920",
        authorBot: false,
        botUserId: "omegent",
        message: {
          author: { username: "patroza" },
          content: "https://macs-scanner.sentry.io/issues/SCANNER-313",
        },
      }),
    ).toBe(false);
    expect(
      isSentryMonitorPost({
        authorId: "omegent",
        authorBot: true,
        botUserId: "omegent",
        message: sentryMessage,
      }),
    ).toBe(false);
    expect(
      isSentryMonitorPost({
        authorId: "other-bot",
        authorBot: true,
        botUserId: "omegent",
        message: { author: { username: "Reminders", bot: true }, content: "standup" },
      }),
    ).toBe(false);
  });
});

describe("sentry monitor prompt", () => {
  it("names the embed in the thread title and asks for one severity", () => {
    expect(sentryMonitorThreadTitle(sentryMessage)).toBe(
      "T3 did not become ready after a server restart",
    );
    expect(sentryMonitorThreadTitle({ content: "" })).toBe("Sentry alert");
    expect(SENTRY_MONITOR_PROMPT).toContain("severity: bug");
    expect(SENTRY_MONITOR_PROMPT).toContain("severity: transient");
    expect(SENTRY_MONITOR_PROMPT).toContain("@everyone");
    expect(SENTRY_MONITOR_PROMPT).toContain("open a pull request");
  });

  it("keeps the Sentry bootstrap around the monitor request", () => {
    const prompt = buildFirstTurnPrompt({
      projectShortName: "example-project",
      workspaceRoot: "/tmp/example",
      mentionPrompt: SENTRY_MONITOR_PROMPT,
      honeycombTraceUrlTemplate: undefined,
      starter: {
        id: "alert-1",
        author: { username: "Sentry", bot: true },
        content: "",
        embeds: sentryMessage.embeds,
      },
    });
    expect(prompt).toContain("Discord investigation bootstrap");
    expect(prompt).toContain("T3 did not become ready after a server restart");
    expect(prompt).toContain("severity: transient");
    expect(prompt).toContain("mention @everyone");
  });
});

describe("monitor severity mention", () => {
  const topic = "omegent-link-scanner omegent-monitor";

  it("reads the first severity line", () => {
    expect(monitorSeverity("severity: transient\n\nDeploy blip.")).toBe("transient");
    expect(monitorSeverity("**severity:** bug\n\nFixing.")).toBe("bug");
    expect(monitorSeverity("severity: bug\nseverity: transient")).toBe("bug");
    expect(monitorSeverity("this looks transient")).toBeNull();
  });

  it("mentions everyone only for a transient alert on a monitor channel", () => {
    const transient = "severity: transient\n\nThe error stopped after the deploy.";
    expect(applyMonitorEveryoneMention(transient, topic)).toBe(`${transient}\n\n@everyone`);
    expect(applyMonitorEveryoneMention(`${transient}\n@everyone`, topic)).toBe(
      `${transient}\n@everyone`,
    );
    expect(applyMonitorEveryoneMention("severity: bug\n\nOpening a fix.", topic)).toBe(
      "severity: bug\n\nOpening a fix.",
    );
    expect(applyMonitorEveryoneMention(transient, "omegent-link-scanner")).toBe(transient);
    expect(applyMonitorEveryoneMention(transient, null)).toBe(transient);
  });
});
