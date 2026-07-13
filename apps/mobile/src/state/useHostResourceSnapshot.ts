import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect } from "react";

import { useEnvironmentQuery } from "./query";
import { serverEnvironment } from "./server";

const HOST_RESOURCE_POLL_INTERVAL_MS = 30_000;

export function useHostResourceSnapshot(environmentId: EnvironmentId, connected: boolean) {
  const query = useEnvironmentQuery(
    connected ? serverEnvironment.hostResourceSnapshot({ environmentId, input: {} }) : null,
  );

  useEffect(() => {
    if (!connected) return;
    const interval = setInterval(query.refresh, HOST_RESOURCE_POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [connected, query.refresh]);

  return query;
}
