import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as PrLookupFreeze from "./PrLookupFreeze.ts";

const TestLayer = PrLookupFreeze.layer.pipe(Layer.provideMerge(NodeServices.layer));

it.layer(TestLayer)("PrLookupFreeze", (it) => {
  it.effect("refcounts settled interest per worktree path", () =>
    Effect.gen(function* () {
      const freeze = yield* PrLookupFreeze.PrLookupFreeze;
      const cwd = process.cwd();

      assert.equal(yield* freeze.isWorktreeSettledFrozen(cwd), false);

      yield* freeze.noteWorktreeSettled(cwd);
      assert.equal(yield* freeze.isWorktreeSettledFrozen(cwd), true);

      yield* freeze.noteWorktreeSettled(cwd);
      assert.equal(yield* freeze.isWorktreeSettledFrozen(cwd), true);

      yield* freeze.noteWorktreeUnsettled(cwd);
      assert.equal(yield* freeze.isWorktreeSettledFrozen(cwd), true);

      yield* freeze.noteWorktreeUnsettled(cwd);
      assert.equal(yield* freeze.isWorktreeSettledFrozen(cwd), false);
    }),
  );

  it.effect("ignores null and empty worktree paths", () =>
    Effect.gen(function* () {
      const freeze = yield* PrLookupFreeze.PrLookupFreeze;
      yield* freeze.noteWorktreeSettled(null);
      yield* freeze.noteWorktreeSettled("   ");
      yield* freeze.noteWorktreeUnsettled(undefined);
      assert.equal(yield* freeze.isWorktreeSettledFrozen(process.cwd()), false);
    }),
  );
});
