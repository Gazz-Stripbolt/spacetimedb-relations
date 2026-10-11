# Protocol

What clients see. Rust, C# and the TypeScript submodule expose the same names and BSATN-identical types (the
TypeScript submodule's own tables are namespaced: `relations.fk` rather than `relations_fk`).

## Keys

A key is **hex of its BSATN encoding**: the same bytes in every language. A `u64` id is 8 bytes little-endian, so id
`1` is `0100000000000000`. An `Identity` is its 32 bytes, a `String` is a u32 length then UTF-8.

```ts
const w = new BinaryWriter(8); w.writeU64(id);
const key = [...w.getBuffer()].map((b) => b.toString(16).padStart(2, '0')).join('');
```

Pagination cursors are keys too: the cursor after a page is the key of its last row.

## Tables

| Table | Public | Columns |
|---|---|---|
| `relations_fk` | yes | `id u64`, `child_table`, `child_column`, `parent_table` (strings), `on_delete u8` (0 restrict, 1 cascade, 2 set_null), `nullable bool`, `indexed bool` |
| `relations_unique` | yes | `id u64`, `table_name string`, `columns string[]` |
| `relations_admin` | no | `identity` |
| `relations_page` | no | `id u64`, `owner identity`, `list string`, `after string?`, `limit u32` |

`configure` rewrites `relations_fk` and `relations_unique` from the declarations, so they always describe the
published module.

## Procedures and reducers

| Name | Who | |
|---|---|---|
| `relations_check() -> Result<Violation[], string>` | admins | Orphans and duplicates in the current data |
| `relations_repair() -> Result<RepairReport, string>` | admins | Apply on-delete rules to orphans, in one transaction |
| `relations_set_page(list, after?, limit)` | anyone | Set your own position in `list` (limit 0 = 50, max 500) |

Non-admins get `Err("relations_check is for admins")` / `Err("relations_repair is for admins")`. An admin is the
identity that called `configure` (the publisher, from `init`), anyone added with `add_admin`, or the database itself.

The library functions behind a module's own reducers and procedures (`plan_delete`, `delete`, `page`, the checked
writes) aren't exposed by themselves. The demo exposes `demo_preview_delete(table, id) -> Result<DeletePlan, string>`
and `demo_delete(table, id)` to show them.

## Types

```
RowRef      { table_name: string, key: string }
NullRef     { table_name: string, column: string, key: string }
Blocker     { table_name: string, column: string, key: string, parent_table: string, parent_key: string }
DeletePlan  { deletes: RowRef[], nulls: NullRef[], blocked: Blocker[] }
Violation   { kind: u8, table_name: string, column: string, key: string, parent_table: string, parent_key: string }
RepairReport{ deleted: RowRef[], nulled: NullRef[], unresolved: Violation[] }
```

- **DeletePlan:** `deletes[0]` is the row itself, then every cascade, each row once (in breadth-first order).
  `nulls` are children whose reference is set to none. `blocked` are `restrict` children that would be left
  pointing at a deleted row. A row that's deleted anyway is never in `nulls` or `blocked`. A non-empty `blocked`
  means the delete is refused and nothing changes.
- **Violation:** `kind` 0 is an orphan: `table_name.column` of row `key` points at `parent_table` row
  `parent_key`, which doesn't exist. `kind` 1 is a duplicate: `column` lists the unique columns joined with ","; the
  row `key` repeats the values of `parent_key` (the row with the smallest key, which is the one kept).
- **RepairReport:** what repair deleted (cascade orphans and their own cascades) and unlinked (set_null orphans).
  `unresolved` are restrict orphans and duplicates: repair won't pick which row to drop.

`Result<T, string>` arrives in TypeScript clients as `{ ok: T } | { err: string }`. The generated types say
`T | string`; see [FINDINGS](FINDINGS.md#spacetimedb-quirks).

## Error messages

The same text in every language, so clients can match on them:

| | |
|---|---|
| Missing parent | `demo_card.list_id = 999: no such demo_list` |
| Unique | `demo_card_tag: another row already has this (card_id, tag)` |
| Restrict | `can't delete demo_member 1: demo_comment 3 still references demo_member 1 through author_id (and 1 more)` |
| Missing row | `demo_card 99: no such row` |
| Bad cursor | `bad hex key` |
