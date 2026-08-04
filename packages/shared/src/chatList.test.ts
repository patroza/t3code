import { describe, expect, it } from "vite-plus/test";

import {
  CHAT_LIST_ANCHOR_OFFSET,
  resolveChatListAnchoredEndSpace,
  sendEntersSteeringQueue,
} from "./chatList.js";

interface Row {
  readonly id: string;
  readonly anchorable: boolean;
}

const rows: ReadonlyArray<Row> = [
  { id: "first", anchorable: true },
  { id: "ignored", anchorable: false },
  { id: "latest", anchorable: true },
];

const getAnchorId = (row: Row) => (row.anchorable ? row.id : null);

describe("resolveChatListAnchoredEndSpace", () => {
  it("anchors the matching row using its measured height", () => {
    expect(resolveChatListAnchoredEndSpace(rows, "latest", getAnchorId)).toEqual({
      anchorIndex: 2,
      anchorOffset: CHAT_LIST_ANCHOR_OFFSET,
    });
  });

  it("allows a surface to keep the anchor below its own header", () => {
    expect(
      resolveChatListAnchoredEndSpace(rows, "latest", getAnchorId, {
        anchorOffset: 132,
      }),
    ).toEqual({
      anchorIndex: 2,
      anchorOffset: 132,
    });
  });

  it("ignores ineligible rows and missing anchors", () => {
    expect(resolveChatListAnchoredEndSpace(rows, "ignored", getAnchorId)).toBeUndefined();
    expect(resolveChatListAnchoredEndSpace(rows, "missing", getAnchorId)).toBeUndefined();
    expect(resolveChatListAnchoredEndSpace(rows, null, getAnchorId)).toBeUndefined();
  });
});

describe("sendEntersSteeringQueue", () => {
  it("queues a follow-up sent while a turn is running or starting", () => {
    for (const sessionStatus of ["running", "starting"]) {
      expect(
        sendEntersSteeringQueue({
          hasBootstrap: false,
          sessionStatus,
          hasPendingTurnStart: false,
        }),
      ).toBe(true);
    }
  });

  it("queues a follow-up sent in the dispatched-but-unreported turn-start gap", () => {
    expect(
      sendEntersSteeringQueue({
        hasBootstrap: false,
        sessionStatus: "ready",
        hasPendingTurnStart: true,
      }),
    ).toBe(true);
  });

  it("does not queue an idle send, so it keeps its chat-list anchoring", () => {
    expect(
      sendEntersSteeringQueue({
        hasBootstrap: false,
        sessionStatus: "ready",
        hasPendingTurnStart: false,
      }),
    ).toBe(false);
    expect(
      sendEntersSteeringQueue({
        hasBootstrap: false,
        sessionStatus: null,
        hasPendingTurnStart: false,
      }),
    ).toBe(false);
  });

  it("exempts bootstrap sends, which create their thread in the same dispatch", () => {
    expect(
      sendEntersSteeringQueue({
        hasBootstrap: true,
        sessionStatus: "running",
        hasPendingTurnStart: true,
      }),
    ).toBe(false);
  });
});
