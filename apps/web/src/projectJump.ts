import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";

export type ProjectJumpAction = "reveal" | "latest" | "new";

export interface ProjectJumpTarget {
  readonly project: EnvironmentProject;
  readonly latestThread: EnvironmentThreadShell | null;
}

function normalizeProjectName(value: string): string {
  return decodeURIComponent(value)
    .trim()
    .replace(/\\/gu, "/")
    .replace(/\/+$/gu, "")
    .replace(/\.git$/iu, "")
    .toLocaleLowerCase();
}

function projectNames(project: EnvironmentProject): ReadonlySet<string> {
  const identity = project.repositoryIdentity;
  const names = [
    project.title,
    project.workspaceRoot.split(/[\\/]/u).filter(Boolean).at(-1),
    identity?.canonicalKey,
    identity?.displayName,
    identity?.name,
    identity?.owner && identity.name ? `${identity.owner}/${identity.name}` : undefined,
    ...(identity?.remotes?.flatMap((remote) => [
      remote.canonicalKey,
      remote.name,
      remote.owner && remote.name ? `${remote.owner}/${remote.name}` : undefined,
    ]) ?? []),
  ];

  return new Set(names.flatMap((name) => (name ? [normalizeProjectName(name)] : [])));
}

function latestThreadForProject(
  project: EnvironmentProject,
  threads: readonly EnvironmentThreadShell[],
): EnvironmentThreadShell | null {
  return (
    threads
      .filter(
        (thread) =>
          thread.environmentId === project.environmentId &&
          thread.projectId === project.id &&
          thread.archivedAt === null,
      )
      .toSorted((left, right) => {
        const timestampDifference = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
        return timestampDifference !== 0 ? timestampDifference : right.id.localeCompare(left.id);
      })[0] ?? null
  );
}

export function parseProjectJumpAction(value: unknown): ProjectJumpAction {
  return value === "latest" || value === "new" ? value : "reveal";
}

export function resolveProjectJumpTarget(
  rawProjectName: string,
  projects: readonly EnvironmentProject[],
  threads: readonly EnvironmentThreadShell[],
): ProjectJumpTarget | null {
  const projectName = normalizeProjectName(rawProjectName);
  if (!projectName) return null;

  const matches = projects
    .filter((project) => projectNames(project).has(projectName))
    .map((project) => ({
      project,
      latestThread: latestThreadForProject(project, threads),
    }));

  return (
    matches.toSorted((left, right) => {
      const leftTimestamp = Date.parse(left.latestThread?.updatedAt ?? left.project.updatedAt);
      const rightTimestamp = Date.parse(right.latestThread?.updatedAt ?? right.project.updatedAt);
      return rightTimestamp - leftTimestamp;
    })[0] ?? null
  );
}

const PROJECT_REVEAL_EVENT = "t3code:reveal-project";
type ProjectRevealDetail = { readonly environmentId: string; readonly projectId: string };
let pendingProjectReveal: ProjectRevealDetail | null = null;

export function revealProjectInSidebar(project: EnvironmentProject): void {
  pendingProjectReveal = { environmentId: project.environmentId, projectId: project.id };
  window.dispatchEvent(
    new CustomEvent(PROJECT_REVEAL_EVENT, {
      detail: pendingProjectReveal,
    }),
  );
}

export function subscribeToProjectReveal(
  listener: (detail: ProjectRevealDetail) => void,
): () => void {
  const handleEvent = (event: Event) => {
    if (!(event instanceof CustomEvent)) return;
    const detail = event.detail as { environmentId?: unknown; projectId?: unknown };
    if (typeof detail.environmentId !== "string" || typeof detail.projectId !== "string") return;
    pendingProjectReveal = null;
    listener({ environmentId: detail.environmentId, projectId: detail.projectId });
  };
  window.addEventListener(PROJECT_REVEAL_EVENT, handleEvent);
  if (pendingProjectReveal !== null) {
    const detail = pendingProjectReveal;
    pendingProjectReveal = null;
    listener(detail);
  }
  return () => window.removeEventListener(PROJECT_REVEAL_EVENT, handleEvent);
}
