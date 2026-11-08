import { describe, expect, it } from "@effect/vitest";

import {
  appendAdfSection,
  confluenceBrowseUrl,
  confluenceHeadingAnchor,
  confluenceLinksUrl,
  confluencePageForProject,
  confluenceRestBase,
  jiraAttachmentBrowseUrl,
  jiraAttachmentFilename,
  jiraResponseStamp,
  parseJiraConfluencePages,
  readConfluenceAtlasDoc,
} from "./JiraCommentPublish.ts";
import {
  JIRA_COMMENT_ADF_BUDGET,
  jiraOverflowNotice,
  markdownToAdf,
  partitionJiraComment,
  type JiraAdfNode,
} from "./JiraMarkdown.ts";

function walk(nodes: ReadonlyArray<JiraAdfNode>): JiraAdfNode[] {
  const all: JiraAdfNode[] = [];
  for (const node of nodes) {
    all.push(node);
    if (node.content !== undefined) all.push(...walk(node.content));
  }
  return all;
}

describe("Jira markdown", () => {
  it("renders a link and a gherkin fence as document nodes", () => {
    const doc = markdownToAdf(
      [
        "The review draft is on [SA-516 — Bauhaus Export](https://macs-holding.atlassian.net/wiki/spaces/SA/pages/746258433/Bauhaus).",
        "",
        "```gherkin",
        "Feature: Ship before pickup",
        "  Scenario: early ship",
        "    @green",
        "```",
      ].join("\n"),
      {
        mention: {
          accountId: "accountid:712020:187d3a46-cef9-4fcd-881b-b66f1a7e56ab",
          displayName: "Patrick Roza",
        },
      },
    );
    const nodes = walk(doc.content);
    expect(nodes.find((node) => node.type === "mention")).toMatchObject({
      attrs: {
        id: "712020:187d3a46-cef9-4fcd-881b-b66f1a7e56ab",
        text: "@Patrick Roza",
        accessLevel: "",
      },
    });
    expect(nodes.find((node) => node.marks?.some((mark) => mark.type === "link"))).toMatchObject({
      type: "text",
      text: "SA-516 — Bauhaus Export",
      marks: [
        {
          type: "link",
          attrs: {
            href: "https://macs-holding.atlassian.net/wiki/spaces/SA/pages/746258433/Bauhaus",
          },
        },
      ],
    });
    const code = nodes.find((node) => node.type === "codeBlock");
    expect(code).toMatchObject({
      attrs: { language: "gherkin", wrap: true },
    });
    expect(code?.content?.[0]?.text).toContain("Feature: Ship before pickup");
    expect(code?.content?.[0]?.text).toContain("@green");
    expect(code?.content?.[0]?.text).not.toContain("```");
    expect(JSON.stringify(doc)).not.toContain("```gherkin");
  });

  it("mentions several Jira accounts at the start of the comment", () => {
    const doc = markdownToAdf("Analysis is ready.", {
      mentions: [
        { accountId: "aaa", displayName: "Andrea" },
        { accountId: "accountid:bbb", displayName: "@Patrick" },
        { accountId: "aaa", displayName: "Duplicate" },
      ],
    });
    expect(doc.content[0]?.content?.slice(0, 5)).toEqual([
      { type: "mention", attrs: { id: "aaa", text: "@Andrea", accessLevel: "" } },
      { type: "text", text: " " },
      { type: "mention", attrs: { id: "bbb", text: "@Patrick", accessLevel: "" } },
      { type: "text", text: " " },
      { type: "text", text: "Analysis is ready." },
    ]);
  });

  it("renders the inline marks agents write", () => {
    const doc = markdownToAdf(
      [
        "# Heading",
        "",
        "Use **bold**, *italic*, ~~gone~~, and `code`. snake_case stays plain.",
        "See https://example.com/docs.",
        "",
        "- one",
        "- two",
        "",
        "1. first",
        "2. second",
        "",
        "> quoted",
        "",
        "---",
        "",
        "| A | B |",
        "| --- | --- |",
        "| 1 | 2 |",
        "",
        "line one  ",
        "line two",
      ].join("\n"),
    );
    const nodes = walk(doc.content);
    expect(nodes.find((node) => node.type === "heading")).toMatchObject({
      attrs: { level: 1 },
    });
    expect(nodes.some((node) => node.marks?.some((mark) => mark.type === "strong"))).toBe(true);
    expect(nodes.some((node) => node.marks?.some((mark) => mark.type === "em"))).toBe(true);
    expect(nodes.some((node) => node.marks?.some((mark) => mark.type === "strike"))).toBe(true);
    expect(nodes.some((node) => node.marks?.some((mark) => mark.type === "code"))).toBe(true);
    const plain = nodes.find((node) => node.text?.includes("snake_case"));
    expect(plain?.text).toContain("snake_case");
    expect(plain?.marks?.some((mark) => mark.type === "em")).toBeFalsy();
    expect(nodes.find((node) => node.text === "https://example.com/docs")).toMatchObject({
      marks: [{ type: "link", attrs: { href: "https://example.com/docs" } }],
    });
    const pull = markdownToAdf("Shipped in https://github.com/macs-holding/scanner/pull/2458.");
    expect(walk(pull.content).find((node) => node.text === "scanner#2458")).toMatchObject({
      marks: [
        {
          type: "link",
          attrs: { href: "https://github.com/macs-holding/scanner/pull/2458" },
        },
      ],
    });
    const issue = markdownToAdf("https://macs-holding.atlassian.net/browse/SA-510");
    expect(walk(issue.content).find((node) => node.text === "SA-510")).toMatchObject({
      marks: [
        {
          type: "link",
          attrs: { href: "https://macs-holding.atlassian.net/browse/SA-510" },
        },
      ],
    });
    const labeled = markdownToAdf("[notes](https://github.com/macs-holding/scanner/issues/12)");
    expect(
      walk(labeled.content).find((node) => node.marks?.some((mark) => mark.type === "link")),
    ).toMatchObject({ text: "notes" });
    const self = markdownToAdf(
      "[https://github.com/macs-holding/scanner/pull/2458](https://github.com/macs-holding/scanner/pull/2458)",
    );
    expect(walk(self.content).find((node) => node.text === "scanner#2458")).toMatchObject({
      marks: [
        {
          type: "link",
          attrs: { href: "https://github.com/macs-holding/scanner/pull/2458" },
        },
      ],
    });
    expect(nodes.some((node) => node.type === "bulletList")).toBe(true);
    expect(nodes.some((node) => node.type === "orderedList")).toBe(true);
    expect(nodes.some((node) => node.type === "blockquote")).toBe(true);
    expect(nodes.some((node) => node.type === "rule")).toBe(true);
    expect(nodes.some((node) => node.type === "table")).toBe(true);
    expect(nodes.some((node) => node.type === "hardBreak")).toBe(true);
  });

  it("omits the Jira wrap attribute on Confluence pages", () => {
    const doc = markdownToAdf("```ts\nconst n = 1;\n```", { platform: "confluence" });
    const code = walk(doc.content).find((node) => node.type === "codeBlock");
    expect(code?.attrs).toEqual({ language: "ts" });
  });

  it("keeps a comment under the ADF budget and leaves a whole fence behind", () => {
    expect(partitionJiraComment("  hello  ")).toEqual({ inline: "hello", overflow: null });
    const pieces: string[] = [];
    while (JSON.stringify(markdownToAdf(pieces.join("\n\n"))).length < JIRA_COMMENT_ADF_BUDGET) {
      pieces.push(`Paragraph ${pieces.length} ${"alpha ".repeat(80)}`);
    }
    const source = [...pieces, "```ts", "const whole = true;", "```"].join("\n\n");
    const parted = partitionJiraComment(source);
    expect(parted.overflow).not.toBeNull();
    expect(parted.inline.length).toBeGreaterThan(0);
    expect(parted.inline.includes("```")).toBe(false);
    expect(parted.overflow).toContain("```ts");
    expect(parted.overflow).toContain("const whole = true;");
    expect(JSON.stringify(markdownToAdf(parted.inline)).length).toBeLessThanOrEqual(
      JIRA_COMMENT_ADF_BUDGET,
    );
  });

  it("sends a single oversized block entirely to overflow", () => {
    const source = ["```", "x".repeat(JIRA_COMMENT_ADF_BUDGET), "```"].join("\n");
    expect(partitionJiraComment(source)).toEqual({ inline: "", overflow: source });
  });

  it("describes where the rest of the answer went", () => {
    expect(jiraOverflowNotice(null)).toContain("storing it failed");
    expect(
      jiraOverflowNotice({
        kind: "confluence",
        label: "SA-516",
        url: "https://example.atlassian.net/wiki/spaces/SA/pages/1/SA-516#response",
      }),
    ).toBe(
      "The rest of this answer is on [SA-516](https://example.atlassian.net/wiki/spaces/SA/pages/1/SA-516#response).",
    );
    expect(
      jiraOverflowNotice({
        kind: "attachment",
        label: "SA-516-response.md",
        url: "https://example/file",
      }),
    ).toBe("The rest of this answer is attached: [SA-516-response.md](https://example/file).");
  });
});

describe("Jira overflow targets", () => {
  it("parses an assigned Confluence location per Jira project", () => {
    const pages = parseJiraConfluencePages(
      "SA:sa/scanner/omegent, CFG:CFG/configurator/omegent, nope, :missing",
    );
    expect(pages.get("SA")).toEqual({ spaceKey: "SA", parentTitles: ["scanner", "omegent"] });
    expect(pages.get("CFG")).toEqual({
      spaceKey: "CFG",
      parentTitles: ["configurator", "omegent"],
    });
    expect(confluencePageForProject(parseJiraConfluencePages("SA:SA"), "sa")).toEqual({
      spaceKey: "SA",
      parentTitles: [],
    });
    expect(pages.size).toBe(2);
  });

  it("builds gateway, browse, and attachment links", () => {
    const cloud = "a6978c4b-b79e-4b1f-83ea-c537c2b19316";
    expect(confluenceRestBase(`https://api.atlassian.com/ex/jira/${cloud}`)).toBe(
      `https://api.atlassian.com/ex/confluence/${cloud}/wiki`,
    );
    expect(confluenceRestBase("https://macs-holding.atlassian.net")).toBeNull();
    const stamp = jiraResponseStamp("2026-10-13T07:45:00.123Z");
    expect(stamp).toBe("response-20261013t074500123z");
    expect(confluenceHeadingAnchor(stamp)).toBe(stamp);
    expect(
      confluenceBrowseUrl({
        siteBase: "https://macs-holding.atlassian.net/",
        spaceKey: "SA",
        pageId: "746258433",
        title: "SA-516",
        heading: stamp,
      }),
    ).toBe(`https://macs-holding.atlassian.net/wiki/spaces/SA/pages/746258433/SA-516#${stamp}`);
    expect(
      confluenceLinksUrl(
        {
          base: "https://macs-holding.atlassian.net/wiki",
          webui: "/spaces/SA/pages/746258433/SA-516",
        },
        stamp,
      ),
    ).toBe(`https://macs-holding.atlassian.net/wiki/spaces/SA/pages/746258433/SA-516#${stamp}`);
    expect(confluenceLinksUrl(null, stamp)).toBeNull();
    expect(jiraAttachmentFilename("SA-516", stamp)).toBe(`SA-516-${stamp}.md`);
    expect(jiraAttachmentFilename("../SA 516", "a b")).toBe("SA516-ab.md");
    expect(jiraAttachmentBrowseUrl("https://macs-holding.atlassian.net/", { id: "99" })).toBe(
      "https://macs-holding.atlassian.net/rest/api/3/attachment/content/99",
    );
    expect(jiraAttachmentBrowseUrl(null, { id: "99", content: "https://files.example/99" })).toBe(
      "https://files.example/99",
    );
  });

  it("appends a section without dropping the page that is already there", () => {
    const existing = {
      type: "doc",
      version: 1,
      content: [{ type: "paragraph", content: [{ type: "text", text: "earlier" }] }],
    };
    const next = appendAdfSection(existing, "response-1", markdownToAdf("later"));
    expect(next.content[0]).toMatchObject({ type: "paragraph" });
    expect(next.content[1]).toMatchObject({
      type: "heading",
      attrs: { level: 2 },
      content: [{ type: "text", text: "response-1" }],
    });
    expect(JSON.stringify(next)).toContain("later");
    expect(JSON.stringify(next)).toContain("earlier");
    expect(
      readConfluenceAtlasDoc({
        atlas_doc_format: { value: JSON.stringify(existing) },
      })?.content,
    ).toHaveLength(1);
    expect(readConfluenceAtlasDoc({ atlas_doc_format: { value: "nope" } })).toBeNull();
    expect(readConfluenceAtlasDoc({})).toBeNull();
    expect(readConfluenceAtlasDoc({ value: '{"type":"doc","version":1}' })).toBeNull();
  });
});
