# relations.rs: foreign keys, cascades, multi-column unique and pagination for Rust modules

One file. Copy [`relations.rs`](relations.rs) to `src/relations.rs` (the module must be named `relations`; the macro
refers to `crate::relations`), and invoke `relations!` once at the crate root.

```rust
pub mod relations;

relations! {
    tables {
        board: Board => id: u64,
        card: Card => id: u64,
        member: Member => id: u64,
        card_tag: CardTag => id: u64,
    }
    references {
        card.board_id -> board [cascade] via board_id,   // `via`: a btree index on the column
        card.parent_id -> card [cascade, nullable],      // Option<u64>, self-reference
        card.assignee -> member [set_null, nullable],
        card_tag.card_id -> card [cascade] via card_id,
    }
    unique {
        card_tag(card_id, tag) via by_card_tag,          // a btree index on exactly (card_id, tag)
    }
}

#[spacetimedb::reducer(init)]
pub fn init(ctx: &ReducerContext) {
    relations::configure(ctx);   // publishes relations_fk / relations_unique, makes the publisher an admin
}
```

For each table, `relations!` generates `checked::<table>::{insert, update, upsert, delete, preview_delete}`. Use them
instead of the raw handle. Inserts and updates return `Err("card.board_id = 7: no such board")` for a missing parent
and `Err("card_tag: another row already has this (card_id, tag)")` for a duplicate. `delete` returns the plan it
applied, or an error naming what blocks it. A complete module is in [`demo/rust`](../demo/rust/src/lib.rs).

**Declarations**

- Every table that's a parent, a child or has a unique constraint goes in `tables` as `name: Row => pk: Key`.
- `references`: `child.column -> parent [mode]`, mode `restrict`, `cascade` or `set_null`. Add `, nullable` for
  `Option` columns; `set_null` requires it.
- `via index` makes deletes find children through a btree index on the column. It's only allowed on non-nullable
  columns, because SpacetimeDB 2.11 can't index-filter an `Option`. Without it, deletes scan the child table once per
  level of the cascade.
- Mistakes are compile errors: an unknown mode, `set_null` without `nullable`, `via` on a nullable column.

| Function | |
|---|---|
| `configure(ctx)` | Publish the schema tables and make the caller an admin. Call from `init` |
| `plan_delete(ctx, table, key)` / `delete(ctx, table, key)` | The same as `checked::t::preview_delete` / `delete`, by table name and BSATN key |
| `check(ctx)` / `repair(ctx)` | What `relations_check` / `relations_repair` call |
| `add_admin(ctx, who)` / `remove_admin` / `is_admin` | Who may run check and repair (the database itself always may) |
| `page(rows, limit, key_fn) -> Page<T>` | One page from a range scan: `items` and the `next` cursor |
| `cursor::<K>(Option<&str>)` / `cursor_of(&key)` | Decode / encode a cursor (hex of the key's BSATN) |
| `set_page(ctx, who, list, after, limit)` / `clear_pages(ctx, who)` | A client's position in a paged list |
| `page_state(view_ctx, list)` / `page_states(view_ctx)` | Read the viewer's positions from a view |
| `encode` / `decode` / `hex` / `unhex` | BSATN and key helpers |

Client-facing, added by the file: the `relations_check` and `relations_repair` procedures (admins only) and the
`relations_set_page` reducer. See [PROTOCOL](../docs/PROTOCOL.md).

Needs the `unstable` feature for procedures and views.
