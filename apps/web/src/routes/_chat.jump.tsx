import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef } from "react";

import { Button } from "../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { SidebarInset } from "../components/ui/sidebar";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import {
  parseProjectJumpAction,
  resolveProjectJumpTarget,
  revealProjectInSidebar,
} from "../projectJump";
import {
  useAllEnvironmentShellsBootstrapped,
  useProjects,
  useThreadShells,
} from "../state/entities";
import { buildThreadRouteParams } from "../threadRoutes";

function ProjectJumpRoute() {
  const search = Route.useSearch();
  const projects = useProjects();
  const threads = useThreadShells();
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const handleNewThread = useNewThreadHandler();
  const navigate = useNavigate();
  const handledKeyRef = useRef<string | null>(null);
  const action = parseProjectJumpAction(search.action);
  const target = useMemo(
    () => resolveProjectJumpTarget(search.project ?? "", projects, threads),
    [projects, search.project, threads],
  );
  const handledKey = `${search.project ?? ""}:${action}`;

  useEffect(() => {
    if (!bootstrapped || target === null || handledKeyRef.current === handledKey) return;
    handledKeyRef.current = handledKey;

    if (action === "latest" && target.latestThread !== null) {
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams({
          environmentId: target.latestThread.environmentId,
          threadId: target.latestThread.id,
        }),
        replace: true,
      });
      return;
    }

    if (action === "new" || action === "latest") {
      void handleNewThread(scopeProjectRef(target.project.environmentId, target.project.id), {
        replace: true,
      });
      return;
    }

    revealProjectInSidebar(target.project);
  }, [action, bootstrapped, handleNewThread, handledKey, navigate, target]);

  if (!bootstrapped || target !== null) return null;

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background">
      <Empty className="flex-1">
        <EmptyHeader>
          <EmptyTitle>Project not found</EmptyTitle>
          <EmptyDescription>
            No project matches “{search.project || "(empty)"}” in a connected environment.
          </EmptyDescription>
          <Button size="sm" onClick={() => void navigate({ to: "/", replace: true })}>
            Go home
          </Button>
        </EmptyHeader>
      </Empty>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/jump")({
  validateSearch: (search: Record<string, unknown>) => ({
    project: typeof search.project === "string" ? search.project : undefined,
    action: typeof search.action === "string" ? search.action : undefined,
  }),
  component: ProjectJumpRoute,
});
