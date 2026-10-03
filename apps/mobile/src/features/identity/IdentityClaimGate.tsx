import {
  filterPeopleForTypeahead,
  identityClaimRequired,
} from "@t3tools/client-runtime/state/identity";
import { IDENTITY_CLAIM_TYPEAHEAD_MIN_CHARS, IdentityUsername } from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Modal, Pressable, TextInput, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import { identityEnvironment } from "../../state/identity";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { resolveIdentityClaimCandidate } from "./identityClaimCandidate";

/**
 * Claim gate for multi-env mobile (e.g. local + t3vm).
 *
 * - Only **connected** environments are probed (never while reconnecting —
 *   identity RPCs on a flapping link heat the device and leave a Modal that
 *   steals all touches).
 * - Secondary remotes are ordered before primary so t3vm (map on) wins over
 *   smart/desktop primary (map off).
 * - At most one Modal is shown.
 */
export function IdentityClaimGate() {
  const { environments } = useEnvironments();
  const candidates = useMemo(() => {
    const connected = environments.filter(
      (environment) => environment.connection.phase === "connected",
    );
    const secondary = connected.filter(
      (environment) => environment.entry.target._tag !== "PrimaryConnectionTarget",
    );
    const primary = connected.filter(
      (environment) => environment.entry.target._tag === "PrimaryConnectionTarget",
    );
    return [...secondary, ...primary];
  }, [environments]);

  const [activeIndex, setActiveIndex] = useState(0);
  const candidateKey = candidates.map((environment) => environment.environmentId).join("\0");

  // A changed connection set starts a fresh probe. Reaching the end of an unchanged
  // set stays exhausted instead of wrapping to zero and probing forever.
  useEffect(() => {
    setActiveIndex(0);
  }, [candidateKey]);

  const onSkip = useCallback(() => {
    setActiveIndex((index) => index + 1);
  }, []);

  const environment = resolveIdentityClaimCandidate(candidates, activeIndex);
  if (environment === undefined) {
    return null;
  }

  // Probe candidates in order: each reports whether it needs a claim; we advance
  // past envs that do not (map off / already claimed) without showing a Modal.
  return (
    <IdentityClaimGateBody
      key={environment.environmentId}
      environment={environment}
      onSkip={onSkip}
    />
  );
}

function IdentityClaimGateBody(props: {
  readonly environment: EnvironmentPresentation;
  readonly onSkip: () => void;
}) {
  const environmentId = props.environment.environmentId;
  const target = useMemo(() => ({ environmentId, input: {} as const }), [environmentId]);
  const snapshotQuery = useEnvironmentQuery(identityEnvironment.snapshot(target));
  const claimQuery = useEnvironmentQuery(identityEnvironment.sessionClaim(target));
  const claimCommand = useAtomCommand(identityEnvironment.claim, {
    label: "identity-claim",
    reportFailure: true,
  });
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const didSkipRef = useRef(false);

  const needsClaim = identityClaimRequired(snapshotQuery.data, claimQuery.data);

  // Finished loading and this env does not need a claim → try next.
  useEffect(() => {
    if (snapshotQuery.isPending || claimQuery.isPending) {
      return;
    }
    // Snapshot failed or map disabled / already claimed.
    if (
      snapshotQuery.error !== null ||
      snapshotQuery.data === null ||
      !snapshotQuery.data.enabled ||
      !needsClaim
    ) {
      if (didSkipRef.current) {
        return;
      }
      didSkipRef.current = true;
      props.onSkip();
    }
  }, [
    claimQuery.isPending,
    needsClaim,
    props.onSkip,
    snapshotQuery.data,
    snapshotQuery.error,
    snapshotQuery.isPending,
  ]);

  const suggestions = useMemo(() => {
    if (!snapshotQuery.data) return [];
    return filterPeopleForTypeahead(
      snapshotQuery.data.people,
      query,
      IDENTITY_CLAIM_TYPEAHEAD_MIN_CHARS,
    );
  }, [query, snapshotQuery.data]);

  // No modal while loading, erroring, or not required — avoids a blank
  // touch-stealing overlay on reconnect.
  if (snapshotQuery.isPending || claimQuery.isPending) {
    return null;
  }
  if (!needsClaim || !snapshotQuery.data?.enabled) {
    return null;
  }

  const submit = async (username: string) => {
    const normalized = username.trim().toLowerCase();
    const exact = snapshotQuery.data?.people.find((person) => person.username === normalized);
    if (!exact) {
      setError("Pick a username from the server map.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await claimCommand({
        environmentId,
        input: {
          username: IdentityUsername.make(exact.username),
          method: "typeahead",
        },
      });
      claimQuery.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Claim failed");
    } finally {
      setSubmitting(false);
    }
  };

  const envLabel = props.environment.label.trim() || "this environment";

  return (
    <Modal
      visible
      animationType="fade"
      transparent
      statusBarTranslucent
      testID="identity-claim-gate"
      onRequestClose={() => {
        // Required claim — keep the modal.
      }}
    >
      <View className="flex-1 items-center justify-center bg-backdrop px-5">
        <View className="w-full max-w-md rounded-2xl border border-border bg-card p-5">
          <Text className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">
            Shared environment · {envLabel}
          </Text>
          <Text className="mt-2 text-xl font-semibold text-foreground">Who are you?</Text>
          <Text className="mt-2 text-sm text-muted-foreground">
            {envLabel} uses a closed identity map. Type at least{" "}
            {IDENTITY_CLAIM_TYPEAHEAD_MIN_CHARS} characters, then choose a map match.
          </Text>
          <TextInput
            autoFocus
            autoCapitalize="none"
            autoCorrect={false}
            editable={!submitting}
            placeholder="e.g. patroza"
            placeholderTextColor="#888"
            value={query}
            onChangeText={(value) => {
              setQuery(value);
              setError(null);
            }}
            onSubmitEditing={() => void submit(query)}
            className="mt-4 rounded-lg border border-border bg-background px-3 py-2.5 text-base text-foreground"
            testID="identity-claim-input"
          />
          {suggestions.length > 0 ? (
            <View className="mt-2 max-h-48 overflow-hidden rounded-lg border border-border">
              {suggestions.map((person) => (
                <Pressable
                  key={person.personId}
                  disabled={submitting}
                  onPress={() => {
                    setQuery(person.username);
                    void submit(person.username);
                  }}
                  className="border-b border-border px-3 py-2.5 active:bg-subtle"
                >
                  <Text className="text-base font-medium text-foreground">{person.username}</Text>
                  {person.name ? (
                    <Text className="text-xs text-muted-foreground">{person.name}</Text>
                  ) : null}
                </Pressable>
              ))}
            </View>
          ) : null}
          {error ? <Text className="mt-2 text-sm text-destructive">{error}</Text> : null}
          <Pressable
            disabled={submitting}
            onPress={() => void submit(query)}
            className="mt-4 items-center rounded-lg bg-primary px-4 py-2.5"
          >
            {submitting ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text className="text-base font-semibold text-primary-foreground">Save identity</Text>
            )}
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}
