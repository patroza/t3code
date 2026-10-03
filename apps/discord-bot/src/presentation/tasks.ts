import type { OrchestrationThreadActivity, TurnId } from "@t3tools/contracts";

export interface PresentedTask {
  readonly step: string;
  readonly status: "pending" | "inProgress" | "completed";
}

export interface PresentedTasks {
  readonly contextKey: string;
  readonly explanation: string | null;
  readonly createdAt: string;
  readonly tasks: ReadonlyArray<PresentedTask>;
}

function planFromActivity(activity: OrchestrationThreadActivity): PresentedTasks | null {
  if (activity.kind !== "turn.plan.updated") return null;
  const payload =
    typeof activity.payload === "object" && activity.payload !== null
      ? (activity.payload as Record<string, unknown>)
      : null;
  if (!Array.isArray(payload?.plan)) return null;
  const tasks: PresentedTask[] = [];
  for (const entry of payload.plan) {
    if (typeof entry !== "object" || entry === null) continue;
    const task = entry as Record<string, unknown>;
    if (typeof task.step !== "string" || task.step.trim() === "") continue;
    tasks.push({
      step: task.step.trim(),
      status: task.status === "completed" || task.status === "inProgress" ? task.status : "pending",
    });
  }
  if (tasks.length === 0) return null;
  return {
    contextKey: activity.turnId ?? activity.id,
    explanation: typeof payload.explanation === "string" ? payload.explanation : null,
    createdAt: activity.createdAt,
    tasks,
  };
}

export function presentTasks(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  latestTurnId: TurnId | null,
): PresentedTasks | null {
  const plans = activities
    .filter((activity) => activity.kind === "turn.plan.updated")
    .toSorted(
      (left, right) =>
        (left.sequence ?? 0) - (right.sequence ?? 0) ||
        left.createdAt.localeCompare(right.createdAt),
    );
  const preferred =
    (latestTurnId === null
      ? undefined
      : plans.findLast((activity) => activity.turnId === latestTurnId)) ?? plans.at(-1);
  return preferred === undefined ? null : planFromActivity(preferred);
}

export function formatTasksForDiscord(tasks: PresentedTasks): string {
  const completed = tasks.tasks.filter((task) => task.status === "completed").length;
  const lines = [
    `**Tasks ${completed}/${tasks.tasks.length}**`,
    ...(tasks.explanation ? [`_${tasks.explanation}_`] : []),
    ...tasks.tasks.map((task) => {
      const icon = task.status === "completed" ? "✅" : task.status === "inProgress" ? "◐" : "○";
      return `${icon} ${task.step}`;
    }),
  ];
  return lines.join("\n");
}
