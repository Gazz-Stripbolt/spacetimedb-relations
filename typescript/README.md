# spacetimedb-relations for TypeScript (submodule)

Foreign keys with `restrict` / `cascade` / `set_null`, delete plans, multi-column unique, check and repair of
existing data, and pagination, as a **Spacetime submodule**. Source: [`src/index.ts`](src/index.ts) ·
Complete example: [`demo/typescript`](../demo/typescript/src/index.ts)

## Install

```bash
npm install @pogly/spacetimedb-relations spacetimedb
```

Use `spacetimedb` 2.13.x or 2.14.x, and keep only one copy of it in your module's dependency tree. With two copies,
`spacetime publish` fails with *"Local module schema inspection failed"*. The package ships compiled JavaScript plus
its TypeScript source, which is where the types come from.

A module built with the 2.14 library needs a 2.14 or newer host: the library's HTTP handler export changed, and older
hosts reject it ([release notes](https://github.com/clockworklabs/SpacetimeDB/releases/tag/v2.14.0)). If your host is still on 2.13, stay on `spacetimedb` 2.13.x.

To work on it from a clone instead, add this folder to your npm workspaces next to your module:

```jsonc
// package.json at your repo root
{ "private": true, "workspaces": ["spacetimedb-relations/typescript", "my-module"] }
// my-module/package.json
{ "dependencies": { "spacetimedb": "2.14.*", "@pogly/spacetimedb-relations": "*" } }
```

## Wire it up

A submodule can't reach your tables, so you register them with `table()` (which hands back checked writes), declare
`reference()` and `unique()` rules, and define the client-facing procedures and reducer as thin wrappers. Their names
then match the Rust and C# modules exactly.

```typescript
import { schema, table, t } from 'spacetimedb/server';
import * as relations from '@pogly/spacetimedb-relations';

const board = table({ name: 'board', public: true }, { id: t.u64().primaryKey().autoInc(), name: t.string() });
const card = table(
  { name: 'card', public: true },
  { id: t.u64().primaryKey().autoInc(), boardId: t.u64().index('btree'), title: t.string(), assignee: t.option(t.u64()) }
);
const spacetimedb = schema({ board, card, relations });
export default spacetimedb;

relations.setup({ scope: (ctx) => ctx.as.relations });

const boards = relations.table({
  name: 'board', key: t.u64(), keyOf: (r) => r.id,
  find: (ctx, id) => ctx.db.board.id.find(id), insert: (ctx, r) => ctx.db.board.insert(r),
  update: (ctx, r) => ctx.db.board.id.update(r), delete: (ctx, id) => ctx.db.board.id.delete(id),
  iter: (ctx) => ctx.db.board.iter(),
});
const cards = relations.table({ name: 'card', /* …the same five closures for card… */ });

relations.reference({
  child: 'card', column: 'board_id', parent: 'board', onDelete: relations.CASCADE,
  get: (r) => r.boardId,
  children: (ctx, id) => ctx.db.card.boardId.filter(id),   // optional: without it, deletes scan the child table
});

export const init = spacetimedb.init((ctx) => relations.configure(ctx));   // schema description + publisher is admin

export const addCard = spacetimedb.reducer({ boardId: t.u64(), title: t.string() }, (ctx, { boardId, title }) => {
  cards.insert(ctx, { id: 0n, boardId, title, assignee: undefined });   // "card.board_id = 7: no such board"
});
export const deleteBoard = spacetimedb.reducer({ id: t.u64() }, (ctx, { id }) => {
  boards.delete(ctx, id);   // its cards go too, all or nothing
});
```

The rest of the API:

- `reference({ …, nullable: true, setNull: (r) => ({ ...r, assignee: undefined }) })` for `option` columns and
  `SET_NULL`. Option columns can't be index-filtered, so leave `children` off for them.
- `unique({ table, columns, index, matches: (ctx, r) => ctx.db.cardTag.byCardTag.filter([r.cardId, r.tag]) })`
  for a multi-column unique constraint, through a btree index on those columns.
- `previewDelete` (or `planDelete(ctx, table, keyBytes)`) returns the `DeletePlan`; `deleteRow` is the untyped
  `delete` (Rust's `relations::delete`).
- `check` / `repair`, `isAdmin` / `addAdmin` / `removeAdmin`, `rawDelete`.
- Pagination: `page(rows, limit, keyOf, keyType)`, `cursor` / `cursorOf`, and subscribable pages with
  `setPage` / `clearPages` and, in a view, `pageState(ctx, list)` / `pageStates(ctx)`.

Client-facing wrappers (see the demo for the full set):

```typescript
import { SumBuilder, type TypeBuilder } from 'spacetimedb/server';
// Result<T, String> on the wire, the same as Rust and C# (why not t.result(): see below).
const result = <T extends TypeBuilder<any, any>>(name: string, ok: T) => new SumBuilder({ Ok: ok, Err: t.string() }, name);

export const relationsCheck = spacetimedb.procedure(result('CheckResult', t.array(relations.Violation)), (ctx) =>
  ctx.withTx((tx) => relations.isAdmin(tx, tx.sender)
    ? { tag: 'Ok' as const, value: relations.check(tx) }
    : { tag: 'Err' as const, value: 'relations_check is for admins' }));
// …plus relationsRepair (the same with repair/RepairReport) and relationsSetPage:
export const relationsSetPage = spacetimedb.reducer({ list: t.string(), after: t.option(t.string()), limit: t.u32() },
  (ctx, { list, after, limit }) => relations.setPage(ctx, ctx.sender, list, after, limit));
```

## Good to know

- **Only checked writes are enforced.** A raw write through `ctx.db` bypasses references and unique constraints.
  `relations_check` finds what slipped through; `relations_repair` fixes what it can.
- **The submodule's own tables are namespaced.** Clients and SQL see `relations.fk` and `relations.unique`
  (`SELECT * FROM relations.fk`), where the Rust and C# modules have `relations_fk` and `relations_unique`. The
  columns are the same.
- **`t.result()` doesn't work for procedure results in SDK 2.11.** Its serializer writes the `err` payload with the
  `ok` type's serializer, so returning `{ err }` crashes the module instance, and its typing (`T | E`) doesn't match
  what the serializer wants (`{ ok } | { err }`). A named `Ok`/`Err` sum is identical on the wire, so clients
  generated from the Rust module read it as their `Result`. An unnamed one fails publish with *"Local module schema
  inspection failed"*.
- Decode keys with the `spacetimedb` entry point's `AlgebraicType`/`BinaryReader` (`relations.decode` does), not with
  builders from `spacetimedb/server`.
