/** Keep retry ownership until bridge restoration leaves a live connection. */
export async function reconnectUntilReady(options: {
  readonly connect: () => Promise<void>;
  readonly isReady: () => boolean;
  readonly restore: () => Promise<void>;
  readonly wait: (attempt: number) => Promise<void>;
  readonly onFailure: (cause: unknown, attempt: number) => Promise<void>;
}) {
  for (let attempt = 0; ; attempt += 1) {
    await options.wait(attempt);
    try {
      await options.connect();
      await options.restore();
      // A second disconnect during restoration cannot start another loop while
      // this one owns reconnecting. Carry that retry here instead of losing it.
      if (options.isReady()) return;
    } catch (cause) {
      await options.onFailure(cause, attempt);
    }
  }
}
