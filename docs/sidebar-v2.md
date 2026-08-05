# Sidebar V2 ordering contract

Web and mobile persist thread-list ordering with the historical enum
`"recency" | "project" | "none"`. The enum predates Sidebar V2, so its names are storage
compatibility—not a literal description of every renderer.

| Persisted value | User-facing label | Sidebar V1             | Sidebar V2                                            |
| --------------- | ----------------- | ---------------------- | ----------------------------------------------------- |
| `project`       | Group by default  | Project-group sections | Upstream V2 static creation order                     |
| `recency`       | Group by recency  | Recency sections       | Latest-activity order within pinned and active blocks |
| `none`          | Group by nothing  | Flat legacy list       | Treated as upstream/default V2 order                  |

Do not make `project` group V2 rows by project. In V2, pinning and lifecycle placement outrank the
ordering preference: pinned cards remain above active cards, snoozed threads remain on the Snoozed
shelf, and settled threads remain on the Settled shelf. The preference changes ordering only; it
must not select a different row component or visual treatment.

Renaming the stored `project` value would require an explicit web-local-storage and mobile
preferences migration. Until then, code should use the labels and behavior above rather than infer
V2 behavior from the legacy enum spelling.
