import type { PresentedTasks } from "@t3tools/shared/integrationTasks";

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
