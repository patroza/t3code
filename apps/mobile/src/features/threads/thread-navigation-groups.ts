import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";

import { groupProjectsByRepository } from "../../lib/repositoryGroups";

export interface ThreadNavigationGroup {
  readonly key: string;
  readonly title: string;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
}

const threadActivityOrder = Order.mapInput(
  Order.Struct({
    activityAt: Order.flip(Order.Number),
    title: Order.String,
  }),
  (thread: EnvironmentThreadShell) => ({
    activityAt: new Date(thread.updatedAt ?? thread.createdAt).getTime(),
    title: thread.title,
  }),
);

export function buildThreadNavigationGroups(input: {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly searchQuery?: string;
  readonly environmentId?: EnvironmentId | null;
}): ReadonlyArray<ThreadNavigationGroup> {
  const query = input.searchQuery?.trim().toLocaleLowerCase() ?? "";
  const environmentId = input.environmentId ?? null;
  const activeThreads = input.threads.filter(
    (thread) =>
      thread.archivedAt === null &&
      (environmentId === null || thread.environmentId === environmentId),
  );
  const filteredProjects =
    environmentId === null
      ? input.projects
      : input.projects.filter((project) => project.environmentId === environmentId);

  return groupProjectsByRepository({ projects: filteredProjects, threads: activeThreads }).flatMap(
    (group) => {
      const threads = Arr.sort(
        group.projects.flatMap((projectGroup) => projectGroup.threads),
        threadActivityOrder,
      );
      const title = group.projects[0]?.project.title ?? group.title;
      const groupMatches =
        query.length === 0 ||
        title.toLocaleLowerCase().includes(query) ||
        group.title.toLocaleLowerCase().includes(query) ||
        group.projects.some((projectGroup) =>
          projectGroup.project.title.toLocaleLowerCase().includes(query),
        );
      const matchingThreads = groupMatches
        ? threads
        : threads.filter((thread) => thread.title.toLocaleLowerCase().includes(query));

      if (query.length > 0 && matchingThreads.length === 0) {
        return [];
      }

      return [
        {
          key: group.key,
          title,
          threads: matchingThreads,
        },
      ];
    },
  );
}
