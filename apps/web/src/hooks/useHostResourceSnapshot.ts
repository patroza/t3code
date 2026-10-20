import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect } from "react";

import { serverEnvironment } from "../state/server";
import { useEnvironmentQuery } from "../state/query";

const HOST_RESOURCE_POLL_INTERVAL_MS = 10_000;

export function useHostResourceSnapshot(environmentId: EnvironmentId, connected: boolean) {
  const query = useEnvironmentQuery(
    connected ? serverEnvironment.hostResourceSnapshot({ environmentId, input: {} }) : null,
  );

  const { refresh } = query;
  useEffect(() => {
    if (!connected) return;
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, HOST_RESOURCE_POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [connected, refresh]);

  return query;
}
