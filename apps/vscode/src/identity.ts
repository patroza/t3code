export interface IdentityPerson {
  readonly personId: string;
  readonly username: string;
  readonly name?: string;
}

export interface IdentitySnapshot {
  readonly enabled: boolean;
  readonly claimRequired: boolean;
  readonly people: ReadonlyArray<IdentityPerson>;
}

export interface SessionIdentityClaim {
  readonly personId: string;
  readonly username: string;
}

export interface IdentityStatus {
  readonly snapshot: IdentitySnapshot;
  readonly claim: SessionIdentityClaim | null;
}

export function filterIdentityPeople(
  people: ReadonlyArray<IdentityPerson>,
  query: string,
): ReadonlyArray<IdentityPerson> {
  const normalized = query.trim().toLocaleLowerCase();
  if (normalized.length < 3) return [];
  return people.filter((person) =>
    [person.username, person.name]
      .filter((value): value is string => value !== undefined)
      .some((value) => value.toLocaleLowerCase().includes(normalized)),
  );
}
