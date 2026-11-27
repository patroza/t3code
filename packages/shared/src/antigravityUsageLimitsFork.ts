import type { ServerProviderUsageWindow } from "@t3tools/contracts";

const KIND_ORDER: Record<ServerProviderUsageWindow["kind"], number> = {
  session: 0,
  weekly: 1,
  monthly: 2,
  other: 3,
};

function antigravityWindowScope(id: string): string {
  const match = id.match(/^(?:5h|weekly)_(.+)$/);
  return match?.[1] ?? "";
}

/**
 * Order Antigravity display windows so Gemini's own unscoped `5-hour` and `Weekly` headline
 * windows come first, followed by scoped groups (`5-hour · Claude/GPT`, `Weekly · Claude/GPT`).
 */
export function sortAntigravityDisplayLimitWindows<
  T extends Pick<ServerProviderUsageWindow, "id" | "kind">,
>(windows: readonly T[]): readonly T[] {
  return [...windows].sort((left, right) => {
    const leftScope = antigravityWindowScope(left.id);
    const rightScope = antigravityWindowScope(right.id);
    const leftScoped = leftScope.length > 0 ? 1 : 0;
    const rightScoped = rightScope.length > 0 ? 1 : 0;
    return (
      leftScoped - rightScoped ||
      leftScope.localeCompare(rightScope) ||
      KIND_ORDER[left.kind] - KIND_ORDER[right.kind] ||
      left.id.localeCompare(right.id)
    );
  });
}
