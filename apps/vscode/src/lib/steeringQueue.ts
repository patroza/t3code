/** Mirrors the server queueing follow-ups while a turn starts or runs. Bootstrap sends are exempt
 * because they create the thread in the same dispatch. */
export function sendEntersSteeringQueue(input: {
  readonly hasBootstrap: boolean;
  readonly sessionStatus: string | null | undefined;
  readonly hasPendingTurnStart: boolean;
}): boolean {
  if (input.hasBootstrap) return false;
  return (
    input.sessionStatus === "running" ||
    input.sessionStatus === "starting" ||
    input.hasPendingTurnStart
  );
}
