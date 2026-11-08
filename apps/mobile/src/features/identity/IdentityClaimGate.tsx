import {
  filterPeopleForTypeahead,
  identityClaimRequired,
} from "@t3tools/client-runtime/state/identity";
import { IDENTITY_CLAIM_TYPEAHEAD_MIN_CHARS, IdentityUsername } from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Modal, Pressable, TextInput, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import { identityEnvironment } from "../../state/identity";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { resolveIdentityClaimCandidate } from "./identityClaimCandidate";

/** Probe connected remotes before the primary environment, showing one claim modal at a time. */
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

  const candidateKey = candidates.map((environment) => environment.environmentId).join("\0");
  const [selection, setSelection] = useState({ key: candidateKey, index: 0 });
  if (selection.key !== candidateKey) setSelection({ key: candidateKey, index: 0 });
  const activeIndex = selection.key === candidateKey ? selection.index : 0;
  const onSkip = useCallback(() => {
    setSelection((current) => ({ ...current, index: current.index + 1 }));
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
  const { onSkip } = props;
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

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Advance the parent candidate only after both remote identity queries settle.
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
      onSkip();
    }
  }, [
    claimQuery.isPending,
    needsClaim,
    onSkip,
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
    }
    setSubmitting(false);
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
