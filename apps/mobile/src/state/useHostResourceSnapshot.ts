import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect } from "react";

import { useEnvironmentQuery } from "./query";
import { serverEnvironment } from "./server";

const HOST_RESOURCE_POLL_INTERVAL_MS = 10_000;

export function useHostResourceSnapshot(environmentId: EnvironmentId, connected: boolean) {
  const query = useEnvironmentQuery(
    connected ? serverEnvironment.hostResourceSnapshot({ environmentId, input: {} }) : null,
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Poll host metrics while connected and release the interval when its destination changes.
  useEffect(() => {
    if (!connected) return;
    const interval = setInterval(query.refresh, HOST_RESOURCE_POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [connected, query.refresh]);

  return query;
}
