// @effect-diagnostics globalPromise:off
/** One visible working message per request, updated with its completed response. */
export async function startTeamsResponse(input: {
  readonly send: (activity: {
    type: "message";
    text: string;
    id?: string;
  }) => Promise<{ id: string }>;
  readonly isNew: boolean;
  readonly threadUrl: string;
  readonly assertActive: () => void;
}): Promise<(text: string) => Promise<void>> {
  const link = input.isNew ? "\n\n[Open in T3 Code](" + input.threadUrl + ")" : "";
  input.assertActive();
  const working = await input.send({ type: "message", text: "Working…" + link });
  let firstAnswer = true;
  return async (text) => {
    input.assertActive();
    if (firstAnswer) {
      await input.send({ type: "message", id: working.id, text: text + link });
      firstAnswer = false;
    } else await input.send({ type: "message", text });
  };
}
