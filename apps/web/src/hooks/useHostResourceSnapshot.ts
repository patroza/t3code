import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect } from "react";

import { serverEnvironment } from "../state/server";
import { useEnvironmentQuery } from "../state/query";

const HOST_RESOURCE_POLL_INTERVAL_MS = 30_000;

export function useHostResourceSnapshot(environmentId: EnvironmentId, connected: boolean) {
  const query = useEnvironmentQuery(
    connected ? serverEnvironment.hostResourceSnapshot({ environmentId, input: {} }) : null,
  );

  useEffect(() => {
    if (!connected) return;
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") query.refresh();
    }, HOST_RESOURCE_POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [connected, query.refresh]);

  return query;
}
