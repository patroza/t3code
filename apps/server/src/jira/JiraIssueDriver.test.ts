import { describe, expect, it } from "@effect/vitest";
import * as IssueTrackerHost from "@t3tools/source-control-core/server/IssueTrackerHost";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as JiraIssueDriver from "./JiraIssueDriver.ts";

const SITE = "https://acme.atlassian.net";

const ISSUE = {
  key: "SA-12",
  fields: {
    summary: "Packing fails",
    description: {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "First line" }] },
        { type: "paragraph", content: [{ type: "text", text: "Second line" }] },
      ],
    },
    status: { name: "Done", statusCategory: { key: "done" } },
    assignee: { accountId: "acc-theo", displayName: "Theo" },
    reporter: { accountId: "acc-julius", displayName: "Julius" },
    created: "2026-07-01T10:00:00.000+0000",
    updated: "2026-07-02T10:00:00.000+0200",
    resolutiondate: "2026-07-02T10:00:00.000+0000",
    labels: ["scanner"],
    comment: {
      startAt: 0,
      maxResults: 1,
      total: 2,
      comments: [
        {
          id: "100",
          author: { accountId: "acc-theo", displayName: "Theo" },
          body: {
            type: "doc",
            content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }],
          },
          created: "2026-07-01T11:00:00.000+0000",
        },
      ],
    },
  },
};

const withTracker = <A, E>(
  options: { readonly env: Record<string, string>; readonly stored?: string },
  use: (
    trackers: Effect.Success<typeof JiraIssueDriver.trackers>,
    requests: Array<{ url: string; authorization: string | undefined }>,
  ) => Effect.Effect<A, E>,
) => {
  const requests: Array<{ url: string; authorization: string | undefined }> = [];
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push({ url: request.url, authorization: request.headers["authorization"] });
      const body = request.url.includes("/myself")
        ? { accountId: "acc-viewer", displayName: "Viewer" }
        : ISSUE;
      return HttpClientResponse.fromWeb(request, Response.json(body));
    }),
  );
  return JiraIssueDriver.trackers.pipe(
    Effect.flatMap((trackers) => use(trackers, requests)),
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(HttpClient.HttpClient, client),
        Layer.succeed(
          IssueTrackerHost.IssueTrackerHost,
          IssueTrackerHost.IssueTrackerHost.of({
            credentials: { get: () => Effect.succeed(Option.fromNullishOr(options.stored)) },
          }),
        ),
        ConfigProvider.layer(ConfigProvider.fromEnv({ env: options.env })),
      ),
    ),
  );
};

describe("JiraIssueDriver", () => {
  it.effect("registers nothing without a Jira site URL", () =>
    withTracker({ env: {} }, (trackers) => Effect.sync(() => expect(trackers).toEqual([]))),
  );

  it.effect("reads an issue with the stored credential and maps it to the tracker shape", () =>
    withTracker(
      { env: { T3CODE_JIRA_URL: `${SITE}/` }, stored: "me@acme.test:secret" },
      (trackers, requests) =>
        Effect.gen(function* () {
          const [tracker] = trackers;
          expect(tracker?.standalone.host).toBe("acme.atlassian.net");
          const detail = yield* tracker!.getIssue({
            cwd: "/",
            host: "acme.atlassian.net",
            scope: "SA",
            key: "SA-12",
          });
          expect(detail).toMatchObject({
            key: "SA-12",
            title: "Packing fails",
            url: `${SITE}/browse/SA-12`,
            body: "First line\nSecond line",
            state: { category: "closed", name: "Done" },
            closedAt: "2026-07-02T10:00:00.000Z",
            updatedAt: "2026-07-02T08:00:00.000Z",
            author: { login: "acc-julius", name: "Julius" },
            assignees: [{ login: "acc-theo" }],
            labels: [{ name: "scanner" }],
            commentCount: 2,
            commentsCursor: "1",
            viewer: "acc-viewer",
          });
          expect(detail.comments).toEqual([
            expect.objectContaining({
              id: "100",
              body: "hi",
              createdAt: "2026-07-01T11:00:00.000Z",
            }),
          ]);
          const basic = `Basic ${Buffer.from("me@acme.test:secret").toString("base64")}`;
          expect(requests.every((request) => request.authorization === basic)).toBe(true);
        }),
    ),
  );

  it.effect("falls back to the server's Jira app account without a stored credential", () =>
    withTracker(
      {
        env: {
          JIRA_URL: SITE,
          T3CODE_JIRA_USERNAME: "bot@acme.test",
          T3CODE_JIRA_API_TOKEN: "app-token",
        },
      },
      (trackers, requests) =>
        Effect.gen(function* () {
          expect(yield* trackers[0]!.getViewer({ cwd: "/", host: "acme.atlassian.net" })).toBe(
            "acc-viewer",
          );
          expect(requests[0]?.authorization).toBe(
            `Basic ${Buffer.from("bot@acme.test:app-token").toString("base64")}`,
          );
        }),
    ),
  );
});

describe("Jira tracker helpers", () => {
  it("builds JQL for scope, state, involvement, search and labels", () => {
    expect(
      JiraIssueDriver.jiraJql({
        scope: "sa",
        state: "open",
        involvement: "assigned",
        query: 'say "hi"',
        labels: ["scanner"],
        sort: "created",
      }),
    ).toBe(
      'project = "SA" AND statusCategory != Done AND assignee = currentUser() AND text ~ "say \\"hi\\"" AND labels = "scanner" ORDER BY created DESC',
    );
    expect(
      JiraIssueDriver.jiraJql({
        scope: "SA",
        state: "all",
        involvement: "all",
        query: "sa-12",
        sort: "updated",
      }),
    ).toBe('project = "SA" AND (key = "SA-12" OR text ~ "sa-12") ORDER BY updated DESC');
  });

  it("parses browse links on the configured site only", () => {
    const host = "acme.atlassian.net";
    expect(JiraIssueDriver.parseJiraIssueUrl(host, new URL(`${SITE}/browse/SA-12`))).toEqual({
      host,
      workspace: host,
      scope: "SA",
      key: "SA-12",
    });
    expect(
      JiraIssueDriver.parseJiraIssueUrl(host, new URL("https://other.atlassian.net/browse/SA-12")),
    ).toBeNull();
    expect(JiraIssueDriver.parseJiraIssueUrl(host, new URL(`${SITE}/jira/software`))).toBeNull();
  });

  it("reads a stored credential as email:token, or a bare token", () => {
    expect(
      JiraIssueDriver.jiraAuthorizationFor({
        credential: " me@acme.test:tok ",
        username: undefined,
        authMode: "basic",
      }),
    ).toEqual({ _tag: "basic", username: "me@acme.test", token: "tok" });
    expect(
      JiraIssueDriver.jiraAuthorizationFor({
        credential: "tok",
        username: "bot",
        authMode: "basic",
      }),
    ).toEqual({ _tag: "basic", username: "bot", token: "tok" });
    expect(
      JiraIssueDriver.jiraAuthorizationFor({
        credential: "pat",
        username: "bot",
        authMode: "bearer",
      }),
    ).toEqual({ _tag: "bearer", token: "pat" });
  });
});
