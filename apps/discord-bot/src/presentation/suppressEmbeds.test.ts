import { Discord } from "dfx";
import { describe, expect, it } from "vite-plus/test";

import {
  interactionMessageFlags,
  SUPPRESS_EMBEDS_FLAG,
  withSuppressEmbeds,
} from "./suppressEmbeds.ts";

describe("withSuppressEmbeds", () => {
  it("sets SuppressEmbeds when no flags are present", () => {
    expect(withSuppressEmbeds({ content: "hi" })).toEqual({
      content: "hi",
      flags: Discord.MessageFlags.SuppressEmbeds,
    });
    expect(SUPPRESS_EMBEDS_FLAG).toBe(Discord.MessageFlags.SuppressEmbeds);
  });

  it("ORs SuppressEmbeds onto existing flags (e.g. Ephemeral)", () => {
    expect(
      withSuppressEmbeds({ content: "secret", flags: Discord.MessageFlags.Ephemeral }),
    ).toEqual({
      content: "secret",
      flags: Discord.MessageFlags.Ephemeral | Discord.MessageFlags.SuppressEmbeds,
    });
  });

  it("treats null/undefined flags as unset", () => {
    expect(withSuppressEmbeds({ content: "x", flags: null as number | null }).flags).toBe(
      Discord.MessageFlags.SuppressEmbeds,
    );
    expect(withSuppressEmbeds({ content: "y" }).flags).toBe(Discord.MessageFlags.SuppressEmbeds);
  });
});

describe("interactionMessageFlags", () => {
  it("always includes SuppressEmbeds", () => {
    expect(interactionMessageFlags()).toBe(Discord.MessageFlags.SuppressEmbeds);
    expect(interactionMessageFlags({ ephemeral: false })).toBe(Discord.MessageFlags.SuppressEmbeds);
  });

  it("combines Ephemeral with SuppressEmbeds", () => {
    expect(interactionMessageFlags({ ephemeral: true })).toBe(
      Discord.MessageFlags.Ephemeral | Discord.MessageFlags.SuppressEmbeds,
    );
  });
});
