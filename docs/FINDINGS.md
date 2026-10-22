# Findings

What we learned building relations on Spacetime 2.11.

## Numbers

[`tests/bench.mts`](../tests/bench.mts), 2,000 rows per call, median of 5 runs on the 2-vCPU dev VM (shared with other
builds, so treat it as relative):

| | Rust | C# (NativeAOT) | TypeScript |
|---|---|---|---|
| Raw insert, per row | 16.9 µs | 18.9 µs | 17.7 µs |
| Checked insert, per row | 18.2 µs | 31.2 µs | 24.0 µs |
| Cascade delete of a list with 2,000 cards (plan + apply) | 29 ms | 50 ms | 50 ms |
| First page of 50 from a 2,000-card list | 6.6 ms | 7.9 ms | 9.0 ms |

Each figure is one call's round trip from a client on the same machine (inserts: one call of 2,000 rows, divided by
2,000). The reference check costs one primary-key lookup per reference.

- **The reference check** is one primary-key lookup per non-null reference, so it costs about as much as a `find`.
- **A cascade** is planned before anything is written: one index lookup per child per indexed reference, and one
  scan of the child table per level for a reference without an index. Then it applies the plan, leaves first. The
  planning reads are most of the cost, and the plan doubles as the preview.
- **A page reads its whole range** (see the quirk below), so keep ranges narrow: one list's cards, not every card.

## Design notes

- **No triggers, so wrappers.** Spacetime modules can't observe writes, so references are enforced on writes that
  go through `checked::*` (Rust), `RelationsTable` (C#) or the submodule's wrappers (TS). Raw writes skip the checks.
  `relations_check` finds what that broke and `relations_repair` cleans up what has a rule. The same tools work for
  data written before relations was added.
- **Plan first, then write.** A delete builds the whole plan (cascades, unlinks, blockers) with reads only, and only
  writes when nothing blocks it. A refused delete changes nothing, even if the calling reducer ignores the error and
  returns `Ok`. The preview is the same plan, so what a UI shows is exactly what the delete will do.
- **Restrict means "no orphans left", not "no children".** A `restrict` child that the same delete cascades away
  doesn't block it. Deleting a card whose comments reference a member is fine; deleting the member while the comments
  remain isn't. This is SQL's `NO ACTION` checked at the end, which is what people usually want from `RESTRICT`.
- **Cycles are fine.** Each row enters the plan once, so a parent loop (x → z → y → x) is deleted once.
- **Breadth first, by level.** The first version planned row by row. A reference without an index (every nullable
  one) then scanned its child table once per deleted row, and deleting a list with 2,000 cards took 17 seconds
  (the card table also holds the subtask self-reference). Grouping each level's rows by table scans once per level:
  24 ms.
- **Multi-column unique is enforced through an index, by the wrappers.** Spacetime 2.11 only has single-column
  `#[unique]`, so a duplicate written around the wrappers isn't stopped. `relations_check` reports it, and repair
  leaves it for you to resolve: picking which row to drop is an application decision. If you need the database to
  enforce it, store a composite key column (for example the hex of `(card_id, tag)`'s BSATN) with `#[unique]` on it.
- **Keys are hex BSATN, as in spacetimedb-history.** Plans and violations name rows from any table with one string
  type, byte-identical across languages. Error messages decode them back (`demo_member 1`, not `0100000000000000`).
  Ordering uses the typed key, not the bytes: little-endian integers don't sort as bytes.
- **Subscribable pages without view parameters.** Views can't take arguments, so a client's position is a row
  (`relations_page`: owner, list, cursor, limit) and the view reads the viewer's rows. Moving to another page is a
  reducer call, and the view stays live. Clean up with `clear_pages` on disconnect.

## Spacetime quirks

- **Index range scans aren't in key order inside a transaction that wrote to the range.** The datastore iterates the
  transaction's own inserts first and then the committed rows (`tx_iter.chain(commit_iter)` in
  `locking_tx_datastore/mut_tx.rs`). Views are refreshed inside the writing transaction, so a view that takes "the
  first 5 cards by id" materializes the wrong 5 (the four oldest plus the one just inserted) and keeps them. A new
  connection with the same identity gets the same wrong rows. Reproduced on Rust, C# and TypeScript modules. Our
  `page()` reads the whole range and selects the smallest keys; once the scan is ordered it could stop after
  `limit + 1` rows. Worth an upstream issue: anything that relies on btree order inside a reducer is affected.
- **`Option` columns can't be index-filtered** (`FilterableValue` covers integers, bool, strings, `Identity`, `Uuid`,
  `Timestamp`, `ConnectionId`, `Hash` and plain enums). Nullable references therefore can't use `via`, and deletes
  scan for their children. A sentinel (`0` = none) on a plain `u64` column keeps an index, at the cost of the
  sentinel.
- **Only single-column unique constraints** (see above). Multi-column btree indexes work for lookups, including
  prefix filters (`by_list.filter(list_id)` on a `(list_id, id)` index) in Rust and C#.
- **TS SDK: `t.result()` is mistyped and half-broken.**
  - The inferred type is `T | E`, but values are `{ ok: T } | { err: E }`. That's what clients receive, and what
    the server-side serializer expects.
  - On the server, the result serializer builds its `err` serializer from the `ok` variant. Returning `{ err }`
    from a procedure crashes the instance ("Cannot read properties of undefined (reading 'length')").
  - An unnamed sum type as a procedure return type fails `spacetime publish` ("Local module schema inspection
    failed").
  - The TS submodule therefore declares named `Ok`/`Err` sums (`DeletePlanResult` and friends). They're identical on
    the wire (tag 0 ok, tag 1 err), so clients generated from Rust read them as their `Result`.
- **C#: `WithTx` rolls back and rethrows when its body throws**, and `TryWithTx` wants an `Exception` error type. The
  procedures throw inside `WithTx` and turn the exception into `Err` outside it, which rolls back like Rust's
  `try_with_tx`. C#'s default string comparison is culture-sensitive, so keys compare ordinally to match Rust.
- **C#: index ranges take an inclusive `Bound<T>(min, max)`**, so "after X" is `new Bound<ulong>(x + 1, ulong.MaxValue)`.
- **TS: a submodule's tables are namespaced** (`relations.fk`), but its index names aren't (`fk_id_idx_btree`).
