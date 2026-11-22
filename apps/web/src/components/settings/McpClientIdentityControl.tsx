import { IdentityUsername } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { useState } from "react";

import type { ServerClientSessionRecord } from "~/environments/primary";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { identityEnvironment } from "~/state/identity";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

const MCP_CLIENT_SUBJECT = "mcp-client";
const EMPTY_INPUT = {} as const;

/**
 * Who an MCP OAuth client acts as. Only MCP client sessions can carry an assigned person;
 * the control appears only while the environment has an identity map.
 */
export function McpClientIdentityControl(props: {
  readonly clientSession: Pick<ServerClientSessionRecord, "sessionId" | "subject">;
  readonly clientLabel: string;
  readonly canAssign: boolean;
}) {
  if (props.clientSession.subject !== MCP_CLIENT_SUBJECT) return null;
  return (
    <McpClientIdentitySelect
      sessionId={props.clientSession.sessionId}
      clientLabel={props.clientLabel}
      canAssign={props.canAssign}
    />
  );
}

function McpClientIdentitySelect(props: {
  readonly sessionId: ServerClientSessionRecord["sessionId"];
  readonly clientLabel: string;
  readonly canAssign: boolean;
}) {
  const gt = useGT();
  const environmentId = usePrimaryEnvironmentId();
  const target = environmentId === null ? null : { environmentId, input: EMPTY_INPUT };
  const snapshotQuery = useEnvironmentQuery(
    target === null ? null : identityEnvironment.snapshot(target),
  );
  const claimsQuery = useEnvironmentQuery(
    target === null ? null : identityEnvironment.clientClaims(target),
  );
  const setClaim = useAtomCommand(identityEnvironment.setClientClaim, {
    label: "identity-set-client-claim",
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const snapshot = snapshotQuery.data;
  if (snapshot == null || !snapshot.enabled) return null;

  const people = snapshot.people.toSorted((left, right) =>
    (left.name ?? left.username).localeCompare(right.name ?? right.username),
  );
  const claimed =
    claimsQuery.data?.claims.find((claim) => claim.sessionId === props.sessionId)?.username ?? "";

  return (
    <label className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
      <span className="shrink-0">
        <T>Identity</T>
      </span>
      <select
        aria-label={gt("Identity for {client}", { client: props.clientLabel })}
        className="h-7 max-w-44 min-w-0 rounded-md border border-border/70 bg-background px-2 text-xs text-foreground disabled:opacity-60"
        data-testid="mcp-client-identity"
        disabled={!props.canAssign || pending || environmentId === null}
        value={claimed}
        onChange={(event) => {
          if (environmentId === null) return;
          const username = event.currentTarget.value;
          setPending(true);
          setError(null);
          void setClaim({
            environmentId,
            input: {
              sessionId: props.sessionId,
              username: username.length === 0 ? null : IdentityUsername.make(username),
            },
          }).then(
            (result) => {
              setPending(false);
              if (result._tag === "Failure") {
                setError(gt("Could not save identity."));
                return;
              }
              claimsQuery.refresh();
            },
            () => {
              setPending(false);
              setError(gt("Could not save identity."));
            },
          );
        }}
      >
        <option value="">{gt("Unassigned")}</option>
        {claimed.length > 0 && !people.some((person) => person.username === claimed) ? (
          <option value={claimed}>{claimed}</option>
        ) : null}
        {people.map((person) => (
          <option key={person.personId} value={person.username}>
            {person.name ?? person.username}
          </option>
        ))}
      </select>
      {error ? <span className="text-destructive">{error}</span> : null}
    </label>
  );
}
