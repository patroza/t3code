import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  ProjectListEntriesResult,
  ProjectReadFileResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useEffect } from "react";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { projectEnvironment } from "~/state/projects";

const EMPTY_PROJECT_FILE_PATH = "";
interface OptimisticProjectFile {
  readonly data: ProjectReadFileResult;
  readonly confirmed: boolean;
}

const optimisticProjectFiles = new Map<string, OptimisticProjectFile>();

function fileKey(environmentId: EnvironmentId, cwd: string, relativePath: string): string {
  return [environmentId, cwd, relativePath].map(encodeURIComponent).join("|");
}

interface ProjectQueryState<A> {
  readonly data: A | null;
  readonly error: string | null;
  readonly isPending: boolean;
  readonly refresh: () => void;
}

export function getProjectEntriesQueryAtom(environmentId: EnvironmentId, cwd: string) {
  return projectEnvironment.listEntries({ environmentId, input: { cwd } });
}

export function getProjectFileQueryAtom(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string | null,
) {
  return projectEnvironment.readFile({
    environmentId,
    input: { cwd, relativePath: relativePath ?? EMPTY_PROJECT_FILE_PATH },
  });
}

export function setProjectFileQueryData(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
  contents: string,
): void {
  const key = fileKey(environmentId, cwd, relativePath);
  optimisticProjectFiles.set(key, {
    confirmed: false,
    data: {
      relativePath,
      contents,
      byteLength: new TextEncoder().encode(contents).byteLength,
      truncated: false,
    },
  });
}

export function getOptimisticProjectFileQueryData(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
): ProjectReadFileResult | null {
  return optimisticProjectFiles.get(fileKey(environmentId, cwd, relativePath))?.data ?? null;
}

export function confirmProjectFileQueryData(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
  contents: string,
): boolean {
  const key = fileKey(environmentId, cwd, relativePath);
  const optimisticFile = optimisticProjectFiles.get(key);
  if (optimisticFile?.data.contents !== contents) return false;

  optimisticProjectFiles.set(key, { ...optimisticFile, confirmed: true });
  appAtomRegistry.refresh(getProjectFileQueryAtom(environmentId, cwd, relativePath));
  return true;
}

export function resolveProjectFileQueryData(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string | null,
  data: ProjectReadFileResult | null,
): ProjectReadFileResult | null {
  if (relativePath === null) return data;
  return optimisticProjectFiles.get(fileKey(environmentId, cwd, relativePath))?.data ?? data;
}

export function __resetProjectFileQueryDataForTests(): void {
  optimisticProjectFiles.clear();
}

function errorMessage<A>(result: AsyncResult.AsyncResult<A, unknown>): string | null {
  if (result._tag !== "Failure") return null;
  const cause = Cause.squash(result.cause);
  return cause instanceof Error ? cause.message : "Workspace query failed.";
}

export function useProjectEntriesQuery(
  environmentId: EnvironmentId,
  cwd: string,
): ProjectQueryState<ProjectListEntriesResult> {
  const atom = getProjectEntriesQueryAtom(environmentId, cwd);
  const result = useAtomValue(atom);
  const refreshAtom = useAtomRefresh(atom);
  const refresh = useCallback(() => refreshAtom(), [refreshAtom]);
  return {
    data: Option.getOrNull(AsyncResult.value(result)),
    error: errorMessage(result),
    isPending: result.waiting,
    refresh,
  };
}

export function useProjectFileQuery(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string | null,
): ProjectQueryState<ProjectReadFileResult> {
  const atom = getProjectFileQueryAtom(environmentId, cwd, relativePath);
  const result = useAtomValue(atom);
  const refreshAtom = useAtomRefresh(atom);
  const refresh = useCallback(() => refreshAtom(), [refreshAtom]);
  const data = Option.getOrNull(AsyncResult.value(result));
  const optimisticFile =
    relativePath === null
      ? undefined
      : optimisticProjectFiles.get(fileKey(environmentId, cwd, relativePath));

  useEffect(() => {
    if (
      relativePath === null ||
      optimisticFile === undefined ||
      !optimisticFile.confirmed ||
      data?.contents !== optimisticFile.data.contents
    ) {
      return;
    }
    optimisticProjectFiles.delete(fileKey(environmentId, cwd, relativePath));
  }, [cwd, data?.contents, environmentId, optimisticFile, relativePath]);

  return {
    data: optimisticFile?.data ?? data,
    error: errorMessage(result),
    isPending: result.waiting,
    refresh,
  };
}
