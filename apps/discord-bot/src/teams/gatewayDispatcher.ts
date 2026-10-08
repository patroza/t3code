// @effect-diagnostics globalPromise:off
import { TeamsGatewayPolicy, type GatewayActivity, type IntakeDecision } from "./gatewayPolicy.ts";

export type MentionDecision = Extract<IntakeDecision, { kind: "mention" }>;

/** One bounded queue per workspace; ambient messages never reach the work callback. */
export class TeamsGatewayDispatcher {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly pending = new Map<string, number>();
  private readonly policy: TeamsGatewayPolicy;

  constructor(policy: TeamsGatewayPolicy) {
    this.policy = policy;
  }

  receive(
    activity: GatewayActivity,
    execute: (decision: MentionDecision) => Promise<void>,
  ): string {
    const decision = this.policy.accept(activity);
    if (decision.kind !== "mention" || !decision.text) return decision.kind;
    const id = decision.lease.binding.workspace;
    const count = this.pending.get(id) ?? 0;
    if (count >= 20) return "capacity";
    this.pending.set(id, count + 1);
    const previous = this.queues.get(id) ?? Promise.resolve();
    const next = previous
      .then(async () => {
        if (this.policy.isActive(decision.lease)) await execute(decision);
      })
      .catch(() => {
        /* failure is bounded to this activity; never retry work automatically */
      })
      .finally(() => this.pending.set(id, (this.pending.get(id) ?? 1) - 1));
    this.queues.set(id, next);
    return "queued";
  }

  async drain(): Promise<void> {
    await Promise.all(this.queues.values());
  }
}
