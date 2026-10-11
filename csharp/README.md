# Relations.cs: foreign keys, cascades, multi-column unique and pagination for C# modules

One file. Add [`Relations.cs`](Relations.cs) to your module project, declare each table once as a static field, and
chain its references and multi-column unique constraints:

```csharp
using U64 = SpacetimeDB.BSATN.U64;

static readonly RelationsTable<Board, ulong, U64> Boards = new(
    "board", r => r.Id,
    (db, id) => db.Board.Id.Find(id), (db, r) => db.Board.Insert(r),
    (db, r) => db.Board.Id.Update(r), (db, id) => db.Board.Id.Delete(id), db => db.Board.Iter());

static readonly RelationsTable<Card, ulong, U64> Cards = new RelationsTable<Card, ulong, U64>(
    "card", r => r.Id,
    (db, id) => db.Card.Id.Find(id), (db, r) => db.Card.Insert(r),
    (db, r) => db.Card.Id.Update(r), (db, id) => db.Card.Id.Delete(id), db => db.Card.Iter())
    .References("board_id", Boards, RELATIONS_CASCADE, r => r.BoardId, via: (db, k) => db.Card.BoardId.Filter(k))
    .NullableReferences("assignee", Members, RELATIONS_SET_NULL, r => r.Assignee, r => r with { Assignee = null });

static readonly RelationsTable<CardTag, ulong, U64> Tags = new RelationsTable<CardTag, ulong, U64>(/* … */)
    .References("card_id", Cards, RELATIONS_CASCADE, r => r.CardId, via: (db, k) => db.CardTag.CardId.Filter(k))
    .Unique(new[] { "card_id", "tag" }, (db, r) => db.CardTag.ByCardTag.Filter((r.CardId, r.Tag)));

[SpacetimeDB.Reducer(ReducerKind.Init)]
public static void Init(ReducerContext ctx) => RelationsConfigure(ctx);

[SpacetimeDB.Reducer]
public static void DeleteBoard(ReducerContext ctx, ulong id) => Boards.Delete(ctx, id);   // cascades, all or nothing
```

Then write through the table objects: `Insert`, `Update`, `Upsert` (reference and unique checks), `Delete` (with
cascades; throws and changes nothing if a `restrict` reference blocks it) and `PreviewDelete` (the plan, without doing
it). The type arguments are the row, the key type and the key's serializer (`SpacetimeDB.BSATN.U64`,
`SpacetimeDB.BSATN.String`, `Identity.BSATN`, …). Names are the canonical (snake_case) table and column names, so
errors, plans and `relations_fk` match the Rust and TypeScript modules.

- `References` takes `RELATIONS_RESTRICT` or `RELATIONS_CASCADE`; `via` finds children through a btree index on the
  column (otherwise deletes scan the child table).
- `NullableReferences` is for `TKey?` columns of value-type keys and also allows `RELATIONS_SET_NULL`. Nullable
  columns can't be index-filtered, so it always scans.
- Declare parents before children (static fields initialize in order), and a self-reference from a helper method
  (see `DeclareCards` in the demo).

Library functions: `RelationsConfigure`, `RelationsAddAdmin` / `RelationsRemoveAdmin` / `RelationsIsAdmin`,
`RelationsPlanDelete` / `RelationsDelete`, `RelationsCheckNow` / `RelationsRepairNow`, and for pagination
`RelationsTakePage`, `RelationsCursor` / `RelationsCursorOf`, `RelationsSetPageFor`, `RelationsClearPages`,
`RelationsPageStateOf` / `RelationsPageStates`. The client-facing `relations_check` and `relations_repair` procedures
(admins only) and the `relations_set_page` reducer are included. A complete module is in
[`demo/csharp`](../demo/csharp/Lib.cs).
