# Goal 1 - Happy path testing

## Step 1 - it fetches and resolves the requested base ref

We test this indirectly via `processor.process(request, {projectId, baseRef: "branchname" })`.

For a new request, `process()` calls `createT3Thread`, which should:

1. fetch `branchname`
2. resolve `branchname` against the remote tracking branch
3. pass the resolved commit SHA into `createWorktree`

## Step 2 - it creates the isolated worktree

## Step 3 - dispatches `thread.create` and then `thread.turn.start`

## Step 4 - preserves the snapshot and attachments

## Step 5 - saves `thread.created` with generated thread and message IDs.

## Step 6 - runs the project setup script

## Step 7 - posts the acknowledgement

## Step 8 - does not duplicate work
