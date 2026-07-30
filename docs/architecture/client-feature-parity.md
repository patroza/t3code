# Cross-client feature parity

T3 Code ships the same product through multiple client surfaces: web/desktop, mobile phone,
mobile tablet, and integration-specific shells. A feature is not complete merely because its
server contract exists or one client renders it. When a capability applies to more than one
client, parity must be designed and tested as part of the feature.

This document describes how to keep equivalent behavior across clients without forcing every
platform to use identical UI.

## What parity means

Parity is equivalence of product capability and outcomes, not pixel identity.

For a cross-client feature, every applicable client must agree on:

- supported states, modes, defaults, and transitions;
- which records match or are excluded;
- empty, loading, unsupported, and partially configured behavior;
- persistence and migration semantics;
- accessibility-visible names and actions;
- the server and shared-contract versions required by the feature.

Clients may use platform-native presentation. For example, web can use a popover while mobile uses
an action menu, provided both expose the same choices and produce the same filtered thread set.

## Shared model first

Put client-neutral behavior in a shared package before wiring client UI. Prefer:

- schemas and transport contracts in `packages/contracts`;
- runtime behavior and deterministic view models in `packages/client-runtime`;
- server/client utilities in `packages/shared` only when both sides consume them.

The shared model should own:

- the closed set of feature modes;
- defaults and compatibility fallbacks;
- matching, sorting, grouping, and transition rules;
- user-facing option labels when the wording should remain equivalent;
- a serializable state shape when clients persist the feature.

Client components should translate that model into native controls rather than independently
reimplementing the rules.

The ownership filter is a useful example. `Any`, `Mine`, and `Theirs`, environment-specific identity
resolution, and thread matching belong to a shared model. Web and mobile should only decide whether
those options appear as a select, popover, or native menu.

## Feature parity manifest

Maintain a typed manifest for features that require more than one client. The initial shape can be a
TypeScript data file checked by tests:

```ts
{
  id: "thread-ownership-filter",
  clients: ["web", "mobile"],
  capabilities: ["any", "mine", "theirs"],
  surfaces: {
    web: ["thread-sidebar"],
    mobile: ["phone-thread-list", "tablet-thread-sidebar"],
  },
}
```

The manifest is an inventory and a CI input. It should answer:

1. Which clients must implement this feature?
2. Which user-visible surfaces expose it?
3. Which shared capabilities must every implementation support?
4. Where are the behavior and surface tests?

Do not list a client when the capability is intentionally inapplicable. Document that decision next
to the manifest entry so omission is reviewable rather than accidental.

## Contract fixtures

Test shared behavior with a common fixture matrix. Every client adapter should receive equivalent
inputs and produce equivalent outcomes.

For a filtering feature, fixtures should cover:

| Case                                               | Expected behavior                    |
| -------------------------------------------------- | ------------------------------------ |
| Claimed person is the thread origin                | Included by `Mine`                   |
| Claimed person is a later participant              | Included by `Mine`                   |
| Claimed person is absent                           | Included by `Theirs`                 |
| Environment has no usable claim                    | Hidden from both `Mine` and `Theirs` |
| Same person participates through multiple channels | One person-level participant         |
| Legacy payload lacks a newly added field           | Compatibility fallback applies       |

Prefer asserting stable results such as matching thread IDs or state transitions. Do not duplicate
the same filtering algorithm inside each client's tests, because identical tests over duplicated
implementations can still drift together unnoticed.

## Surface existence tests

Shared behavior tests do not prove that a client still exposes the feature. Every declared surface
needs a lightweight test that fails if its wiring disappears.

Good assertions include:

- the menu/select contains every required mode;
- the client invokes the shared model or adapter;
- an accessibility label or stable test ID exists;
- phone and tablet/split-view entry points both register the feature;
- a popup, sheet, or native menu remains reachable when the visible count collapses to one.

Keep these checks alongside the affected client. The repository-level fork surface tests remain the
last defense against stack conflict resolutions that preserve helpers while dropping UI wiring.

## CI enforcement

CI should fail when a parity-managed feature is only partially updated.

The parity check should:

1. validate the manifest and reject unknown clients or surfaces;
2. require a behavior fixture suite for every manifest entry;
3. require each declared client surface to register an existence test;
4. run the common fixtures against every declared client adapter;
5. report missing clients and surfaces by feature ID;
6. allow an explicit, documented applicability exception rather than a silent omission.

The existing local gates still apply: root `vp check`, full recursive typecheck, focused behavior
tests, and integrated verification for every affected client available on the host.

## Pull request workflow

When a change adds or alters cross-client behavior, the PR description should answer:

- Which parity-manifest entry is new or changed?
- Which clients and surfaces are affected?
- Which behavior moved into a shared model?
- Which common fixtures were added or updated?
- Which client surface tests prove the feature is reachable?
- Which clients were verified interactively?
- Why is any client intentionally excluded?

If one PR cannot safely update every client, use dependent PRs and keep the feature unavailable or
explicitly experimental until the parity set is complete. Do not silently ship one client and rely
on a later cleanup task.

## Adoption plan

Introduce parity enforcement incrementally:

1. Add the typed manifest and validator without blocking CI.
2. Register high-risk shared features such as identity, thread filtering, settlement, snooze, and
   source-control actions.
3. Extract duplicated decision logic into `packages/client-runtime`.
4. Add common fixture suites and client surface registrations.
5. Make missing registrations or failing equivalence checks blocking.
6. Add the parity questions to the pull request template.

Start with features that have already drifted between web and mobile. Their failure modes provide
the most useful fixtures and the clearest validation that the system catches real omissions.
