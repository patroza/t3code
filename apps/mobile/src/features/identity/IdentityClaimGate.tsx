import {
  filterPeopleForTypeahead,
  identityClaimRequired,
} from "@t3tools/client-runtime/state/identity";
import {
  IDENTITY_CLAIM_TYPEAHEAD_MIN_CHARS,
  IdentityUsername,
  type EnvironmentId,
} from "@t3tools/contracts";
import { useMemo, useState } from "react";
import { ActivityIndicator, Modal, Pressable, Text, TextInput, View } from "react-native";

import { useEnvironments } from "../../state/environments";
import { identityEnvironment } from "../../state/identity";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";

/**
 * Modal claim gate when a connected environment requires a session identity.
 * Uses the first connected environment (mobile typically has one active remote).
 */
export function IdentityClaimGate() {
  const { environments } = useEnvironments();
  const environmentId =
    environments.find((env) => env.entry.target._tag === "PrimaryConnectionTarget")
      ?.environmentId ??
    environments[0]?.environmentId ??
    null;
  if (environmentId === null) return null;
  return <IdentityClaimGateBody environmentId={environmentId} />;
}

function IdentityClaimGateBody(props: { readonly environmentId: EnvironmentId }) {
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
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const needsClaim = identityClaimRequired(snapshotQuery.data, claimQuery.data);
  const suggestions = useMemo(() => {
    if (!snapshotQuery.data) return [];
    return filterPeopleForTypeahead(
      snapshotQuery.data.people,
      query,
      IDENTITY_CLAIM_TYPEAHEAD_MIN_CHARS,
    );
  }, [query, snapshotQuery.data]);

  if (!needsClaim || !snapshotQuery.data) {
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
        environmentId: props.environmentId,
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

  return (
    <Modal visible animationType="fade" transparent testID="identity-claim-gate">
      <View className="flex-1 items-center justify-center bg-black/60 px-5">
        <View className="w-full max-w-md rounded-2xl border border-border bg-card p-5">
          <Text className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">
            Shared environment
          </Text>
          <Text className="mt-2 text-xl font-semibold text-foreground">Who are you?</Text>
          <Text className="mt-2 text-sm text-muted-foreground">
            Type at least {IDENTITY_CLAIM_TYPEAHEAD_MIN_CHARS} characters, then choose a map match.
          </Text>
          <TextInput
            autoFocus
            autoCapitalize="none"
            autoCorrect={false}
            value={query}
            editable={!submitting}
            placeholder="username"
            placeholderTextColor="#888"
            className="mt-4 rounded-lg border border-border bg-background px-3 py-2 text-foreground"
            onChangeText={(value) => {
              setQuery(value);
              setError(null);
            }}
            onSubmitEditing={() => void submit(query)}
          />
          {suggestions.map((person) => (
            <Pressable
              key={person.personId}
              disabled={submitting}
              className="mt-2 rounded-lg border border-border/60 px-3 py-2"
              onPress={() => {
                setQuery(person.username);
                void submit(person.username);
              }}
            >
              <Text className="font-medium text-foreground">{person.username}</Text>
              {person.name ? (
                <Text className="text-xs text-muted-foreground">{person.name}</Text>
              ) : null}
            </Pressable>
          ))}
          {error ? <Text className="mt-3 text-sm text-red-500">{error}</Text> : null}
          <Pressable
            disabled={submitting}
            className="mt-4 items-center rounded-lg bg-primary px-3 py-2"
            onPress={() => void submit(query)}
          >
            {submitting ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text className="font-medium text-primary-foreground">Continue</Text>
            )}
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}
