export function resolveIdentityClaimCandidate<T>(
  candidates: readonly T[],
  activeIndex: number,
): T | undefined {
  return candidates[activeIndex];
}
