import {
  filterPeopleForTypeahead,
  identityClaimRequired,
} from "@t3tools/client-runtime/state/identity";
import {
  IDENTITY_CLAIM_TYPEAHEAD_MIN_CHARS,
  IdentityUsername,
  type EnvironmentId,
  type IdentityPersonPublic,
} from "@t3tools/contracts";
import { useMemo, useState } from "react";

import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { identityEnvironment } from "../../state/identity";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { IdentityAvatar } from "./IdentityAvatar";

/**
 * Full-screen "Who are you?" gate when the active environment has a closed
 * identity map and this auth session has not claimed yet.
 */
export function IdentityClaimGate() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const environmentId =
    primaryEnvironmentId ??
    environments.find((env) => env.entry.target._tag === "PrimaryConnectionTarget")
      ?.environmentId ??
    environments[0]?.environmentId ??
    null;

  if (environmentId === null) {
    return null;
  }

  return <IdentityClaimGateForEnvironment environmentId={environmentId} />;
}

function IdentityClaimGateForEnvironment(props: { readonly environmentId: EnvironmentId }) {
  const target = useMemo(
    () => ({ environmentId: props.environmentId, input: {} as const }),
    [props.environmentId],
  );
  const snapshotQuery = useEnvironmentQuery(identityEnvironment.snapshot(target));
  const claimQuery = useEnvironmentQuery(identityEnvironment.sessionClaim(target));
  const claimCommand = useAtomCommand(identityEnvironment.claim, {
    label: "identity-claim",
    reportFailure: true,
  });

  const needsClaim = identityClaimRequired(snapshotQuery.data, claimQuery.data);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const suggestions = useMemo(() => {
    if (!snapshotQuery.data) return [] as ReadonlyArray<IdentityPersonPublic>;
    return filterPeopleForTypeahead(
      snapshotQuery.data.people,
      query,
      IDENTITY_CLAIM_TYPEAHEAD_MIN_CHARS,
    );
  }, [query, snapshotQuery.data]);

  if (!needsClaim || !snapshotQuery.data) {
    return null;
  }

  const snapshot = snapshotQuery.data;

  const submitUsername = async (username: string) => {
    const normalized = username.trim().toLowerCase();
    if (normalized.length === 0) {
      setError("Type your username, then pick a match from the list.");
      return;
    }
    const exact = snapshot.people.find((person) => person.username === normalized);
    if (!exact) {
      setError("That identity is not on this server’s map. Keep typing to see matches.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await claimCommand({
        environmentId: props.environmentId,
        input: {
          username: IdentityUsername.make(exact.username),
          method: "typeahead",
        },
      });
      if (result._tag === "Failure") {
        setError("Could not claim identity on this server.");
        return;
      }
      claimQuery.refresh();
      snapshotQuery.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not claim identity.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-background/92 px-4 backdrop-blur-sm"
      data-testid="identity-claim-gate"
      role="dialog"
      aria-modal="true"
      aria-labelledby="identity-claim-title"
    >
      <section className="w-full max-w-md rounded-2xl border border-border/80 bg-card p-6 shadow-2xl shadow-black/25">
        <p className="text-[11px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
          Shared environment
        </p>
        <h1 id="identity-claim-title" className="mt-2 text-xl font-semibold tracking-tight">
          Who are you?
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          This server uses a closed identity map. Type at least {IDENTITY_CLAIM_TYPEAHEAD_MIN_CHARS}{" "}
          characters of your username, then choose a match. Free-form names are not allowed.
        </p>

        <label
          className="mt-5 block text-xs font-medium text-muted-foreground"
          htmlFor="identity-claim-input"
        >
          Username
        </label>
        <Input
          id="identity-claim-input"
          autoFocus
          autoComplete="username"
          value={query}
          disabled={submitting}
          placeholder="e.g. patroza"
          className="mt-1.5"
          onChange={(event) => {
            setQuery(event.currentTarget.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void submitUsername(query);
            }
          }}
        />

        {suggestions.length > 0 ? (
          <ul
            className="mt-2 max-h-48 overflow-auto rounded-lg border border-border/70 bg-background/60 p-1"
            data-testid="identity-claim-suggestions"
          >
            {suggestions.map((person) => (
              <li key={person.personId}>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
                  disabled={submitting}
                  onClick={() => {
                    setQuery(person.username);
                    void submitUsername(person.username);
                  }}
                >
                  <IdentityAvatar
                    personId={person.personId}
                    username={person.username}
                    name={person.name}
                    size="sm"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{person.username}</span>
                    {person.name ? (
                      <span className="block truncate text-xs text-muted-foreground">
                        {person.name}
                      </span>
                    ) : null}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : query.trim().length >= IDENTITY_CLAIM_TYPEAHEAD_MIN_CHARS ? (
          <p className="mt-2 text-xs text-muted-foreground">No map matches for that query.</p>
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">
            Type {IDENTITY_CLAIM_TYPEAHEAD_MIN_CHARS}+ characters to search the map.
          </p>
        )}

        {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}

        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" disabled={submitting} onClick={() => void submitUsername(query)}>
            {submitting ? "Claiming…" : "Continue"}
          </Button>
        </div>
      </section>
    </div>
  );
}
