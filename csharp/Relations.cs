// Relations.cs: foreign keys, cascades, multi-column unique and pagination for SpacetimeDB C# modules, one file.
//
// The C# twin of rust/relations.rs and the spacetimedb-relations TypeScript submodule: same tables,
// procedures and BSATN values, so the same clients work against all three.
//
// SpacetimeDB has no foreign keys, no ON DELETE, and unique constraints on single columns only.
// Drop this file into your module, declare each table once (as a static field), then its
// references and multi-column unique constraints:
//
//     static readonly RelationsTable<Board, ulong, SpacetimeDB.BSATN.U64> Boards = new(
//         "board", b => b.Id,
//         (db, id) => db.Board.Id.Find(id), (db, r) => db.Board.Insert(r),
//         (db, r) => db.Board.Id.Update(r), (db, id) => db.Board.Id.Delete(id), db => db.Board.Iter());
//     static readonly RelationsTable<Card, ulong, SpacetimeDB.BSATN.U64> Cards = new(...)
//         .References("board_id", Boards, RELATIONS_CASCADE, c => c.BoardId, via: (db, id) => db.Card.BoardId.Filter(id))
//         .NullableReferences("assignee", Members, RELATIONS_SET_NULL, c => c.Assignee, c => c with { Assignee = null });
//
// then write through it: Cards.Insert(ctx, row), .Update, .Upsert, .Delete (cascades, all or
// nothing), .PreviewDelete (what a delete would do). Call RelationsConfigure(ctx) from Init.

#pragma warning disable STDB_UNSTABLE
#nullable enable

using SpacetimeDB;
using SpacetimeDB.BSATN;

// ---------------------------------------------------------------------------
// Results (names and field order match rust/relations.rs, so the BSATN is identical)
// ---------------------------------------------------------------------------

/// <summary>A row, by table and key (hex of the key's BSATN).</summary>
[SpacetimeDB.Type]
public partial struct RowRef
{
    public string TableName;
    public string Key;
}

/// <summary>A child row whose reference column would be set to null.</summary>
[SpacetimeDB.Type]
public partial struct NullRef
{
    public string TableName;
    public string Column;
    public string Key;
}

/// <summary>A child row that blocks the delete (restrict).</summary>
[SpacetimeDB.Type]
public partial struct Blocker
{
    public string TableName;
    public string Column;
    public string Key;
    public string ParentTable;
    public string ParentKey;
}

/// <summary>What deleting a row does. Deletes[0] is the row itself; the rest are cascades.</summary>
[SpacetimeDB.Type]
public partial struct DeletePlan
{
    public List<RowRef> Deletes;
    public List<NullRef> Nulls;
    public List<Blocker> Blocked;

    public static DeletePlan Empty() => new() { Deletes = new(), Nulls = new(), Blocked = new() };

    /// <summary>"3 demo_list, 12 demo_card" style counts of the rows the plan deletes.</summary>
    public readonly List<(string Table, uint Count)> Counts()
    {
        var out_ = new List<(string Table, uint Count)>();
        foreach (var d in Deletes)
        {
            var i = out_.FindIndex(c => c.Table == d.TableName);
            if (i >= 0) out_[i] = (d.TableName, out_[i].Count + 1);
            else out_.Add((d.TableName, 1));
        }
        return out_;
    }
}

/// <summary>
/// A rule existing data breaks. Orphan: TableName.Column points at a missing ParentTable row.
/// Duplicate: another row has the same values in the unique columns (Column is them joined with ",").
/// ParentKey is the missing parent's key (orphans) or the key of the row it duplicates.
/// </summary>
[SpacetimeDB.Type]
public partial struct Violation
{
    public byte Kind;
    public string TableName;
    public string Column;
    public string Key;
    public string ParentTable;
    public string ParentKey;
}

[SpacetimeDB.Type]
public partial struct RepairReport
{
    public List<RowRef> Deleted;
    public List<NullRef> Nulled;
    /// <summary>What repair can't fix: orphans under restrict and duplicates (pick one yourself).</summary>
    public List<Violation> Unresolved;
}

/// <summary>A client's position in a paged list, read by your view with RelationsPageStateOf.</summary>
public readonly record struct RelationsPageState(string? After, uint Limit);

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/// <summary>What the library needs from a declared table, by BSATN key.</summary>
public interface IRelationsTable
{
    string Name { get; }
    bool ExistsBytes(Local db, byte[] key);
    bool RawDeleteBytes(Local db, byte[] key);
    /// <summary>A key for error messages (like Rust's Debug: 7, "abc").</summary>
    string Show(byte[] key);
}

/// <summary>A declared reference: Child.Column points at Parent's primary key.</summary>
public interface IRelationsRef
{
    string Child { get; }
    string Column { get; }
    string Parent { get; }
    byte OnDelete { get; }
    bool Nullable { get; }
    /// <summary>Children are found through a btree index (via) rather than a table scan.</summary>
    bool Indexed { get; }
    /// <summary>
    /// (parent key, child key) for every child of any of parentKeys (BSATN): one index filter per
    /// key with via, otherwise ONE scan of the child table for all of them.
    /// </summary>
    List<(byte[] Parent, byte[] Child)> Children(Local db, List<byte[]> parentKeys);
    void SetNull(Local db, byte[] childKey);
    /// <summary>(child key, missing parent key) for each child pointing nowhere.</summary>
    List<(byte[] Child, byte[] Parent)> Orphans(Local db);
}

/// <summary>A declared multi-column unique constraint.</summary>
public interface IRelationsUnique
{
    string Table { get; }
    string[] Columns { get; }
    /// <summary>(duplicate key, key of the first row with the same values), for each extra row.</summary>
    List<(byte[] Dup, byte[] First)> Duplicates(Local db);
}

/// <summary>
/// A table under relations: write through Insert/Update/Upsert/Delete to get reference checks,
/// unique checks and cascades. Declare references with References / NullableReferences, and
/// multi-column unique constraints with Unique. The table registers itself.
/// </summary>
public sealed class RelationsTable<TRow, TKey, TKeyRW> : IRelationsTable
    where TRow : struct
    where TKeyRW : IReadWrite<TKey>, new()
{
    static readonly TKeyRW KeyRW = new();

    readonly string name;
    readonly Func<TRow, TKey> key;
    readonly Func<Local, TKey, TRow?> find;
    readonly Func<Local, TRow, TRow> insert;
    readonly Func<Local, TRow, TRow> update;
    readonly Func<Local, TKey, bool> delete;
    readonly Func<Local, IEnumerable<TRow>> iter;
    // Run on checked inserts and updates: an error message, or null.
    readonly List<Func<Local, TRow, string?>> refChecks = new();
    readonly List<Func<Local, TRow, bool, string?>> uniqueChecks = new();

    public RelationsTable(
        string name,
        Func<TRow, TKey> key,
        Func<Local, TKey, TRow?> find,
        Func<Local, TRow, TRow> insert,
        Func<Local, TRow, TRow> update,
        Func<Local, TKey, bool> delete,
        Func<Local, IEnumerable<TRow>> iter)
    {
        this.name = name;
        this.key = key;
        this.find = find;
        this.insert = insert;
        this.update = update;
        this.delete = delete;
        this.iter = iter;
        Module.RelationsRegister(this);
    }

    public string Name => name;

    public TKey KeyOf(TRow row) => key(row);
    public static byte[] Encode(TKey k) => IStructuralReadWrite.ToBytes(KeyRW, k);
    public static TKey Decode(byte[] bytes)
    {
        using var reader = new BinaryReader(new MemoryStream(bytes));
        return KeyRW.Read(reader);
    }

    public bool Exists(Local db, TKey k) => find(db, k) is not null;
    public TRow? Find(Local db, TKey k) => find(db, k);

    // --- Checked writes ---

    /// <summary>Insert after checking references and unique constraints. Returns the inserted row.</summary>
    public TRow Insert(ReducerContext ctx, TRow row) => Insert(ctx.Db, row);

    public TRow Insert(Local db, TRow row)
    {
        Check(db, row, updating: false);
        try
        {
            return insert(db, row);
        }
        catch (Exception e)
        {
            throw new Exception($"{name}: {e.Message}");
        }
    }

    /// <summary>Update by primary key after checking references and unique constraints.</summary>
    public TRow Update(ReducerContext ctx, TRow row) => Update(ctx.Db, row);

    public TRow Update(Local db, TRow row)
    {
        if (find(db, key(row)) is null) throw new Exception($"{name} {ShowKey(key(row))}: no such row");
        Check(db, row, updating: true);
        return update(db, row);
    }

    /// <summary>Insert or update by primary key, checked.</summary>
    public TRow Upsert(ReducerContext ctx, TRow row) => Upsert(ctx.Db, row);

    public TRow Upsert(Local db, TRow row) => find(db, key(row)) is null ? Insert(db, row) : Update(db, row);

    /// <summary>Delete with cascades, all or nothing. Throws (nothing changes) if a restrict reference blocks it.</summary>
    public DeletePlan Delete(ReducerContext ctx, TKey k) => Module.RelationsDelete(ctx.Db, name, Encode(k));

    public DeletePlan Delete(Local db, TKey k) => Module.RelationsDelete(db, name, Encode(k));

    /// <summary>What Delete would do, without doing it.</summary>
    public DeletePlan PreviewDelete(ReducerContext ctx, TKey k) => Module.RelationsPlanDelete(ctx.Db, name, Encode(k));

    public DeletePlan PreviewDelete(Local db, TKey k) => Module.RelationsPlanDelete(db, name, Encode(k));

    void Check(Local db, TRow row, bool updating)
    {
        foreach (var c in refChecks)
        {
            if (c(db, row) is { } err) throw new Exception(err);
        }
        foreach (var c in uniqueChecks)
        {
            if (c(db, row, updating) is { } err) throw new Exception(err);
        }
    }

    // --- Declarations ---

    /// <summary>
    /// This table's column points at parent's primary key. onDelete: RELATIONS_RESTRICT or
    /// RELATIONS_CASCADE (set_null needs a nullable column: use NullableReferences). Pass via to
    /// find children through a btree index on the column; otherwise deletes scan this table.
    /// </summary>
    public RelationsTable<TRow, TKey, TKeyRW> References<TPRow, TPKey, TPKeyRW>(
        string column,
        RelationsTable<TPRow, TPKey, TPKeyRW> parent,
        byte onDelete,
        Func<TRow, TPKey> get,
        Func<Local, TPKey, IEnumerable<TRow>>? via = null)
        where TPRow : struct
        where TPKeyRW : IReadWrite<TPKey>, new()
    {
        if (onDelete == Module.RELATIONS_SET_NULL)
            throw new ArgumentException($"{name}.{column}: set_null needs a nullable column: use NullableReferences");
        return AddRef(column, parent, onDelete, false, r => (true, get(r)), via, null);
    }

    /// <summary>
    /// A nullable (TPKey?) column pointing at parent's primary key. onDelete may also be
    /// RELATIONS_SET_NULL, which writes setNull(row). Nullable columns can't be index-filtered,
    /// so deletes scan this table to find children.
    /// </summary>
    public RelationsTable<TRow, TKey, TKeyRW> NullableReferences<TPRow, TPKey, TPKeyRW>(
        string column,
        RelationsTable<TPRow, TPKey, TPKeyRW> parent,
        byte onDelete,
        Func<TRow, TPKey?> get,
        Func<TRow, TRow> setNull)
        where TPRow : struct
        where TPKey : struct
        where TPKeyRW : IReadWrite<TPKey>, new()
    {
        return AddRef(column, parent, onDelete, true, r => get(r) is { } k ? (true, k) : (false, default!), null, setNull);
    }

    RelationsTable<TRow, TKey, TKeyRW> AddRef<TPRow, TPKey, TPKeyRW>(
        string column,
        RelationsTable<TPRow, TPKey, TPKeyRW> parent,
        byte onDelete,
        bool nullable,
        Func<TRow, (bool Has, TPKey Key)> get,
        Func<Local, TPKey, IEnumerable<TRow>>? via,
        Func<TRow, TRow>? setNull)
        where TPRow : struct
        where TPKeyRW : IReadWrite<TPKey>, new()
    {
        if (onDelete > Module.RELATIONS_SET_NULL) throw new ArgumentException($"{name}.{column}: unknown on-delete mode {onDelete}");
        var fk = new Ref<TPRow, TPKey, TPKeyRW>(this, column, parent, onDelete, nullable, get, via, setNull);
        refChecks.Add((db, row) =>
        {
            var (has, k) = get(row);
            if (!has || parent.Exists(db, k)) return null;
            return $"{name}.{column} = {parent.ShowKey(k)}: no such {parent.Name}";
        });
        Module.RelationsRegister(fk);
        return this;
    }

    /// <summary>
    /// The columns (2 or more) must be unique together. matches(db, row) returns the rows with
    /// the same values, through a multi-column btree index: (db, r) => db.T.ByAB.Filter((r.A, r.B)).
    /// </summary>
    public RelationsTable<TRow, TKey, TKeyRW> Unique(string[] columns, Func<Local, TRow, IEnumerable<TRow>> matches)
    {
        uniqueChecks.Add((db, row, updating) =>
        {
            var mine = Encode(key(row));
            var clash = matches(db, row).Any(o => !updating || !Encode(key(o)).AsSpan().SequenceEqual(mine));
            return clash ? $"{name}: another row already has this ({string.Join(", ", columns)})" : null;
        });
        Module.RelationsRegister(new UniqueDecl(this, columns, matches));
        return this;
    }

    // --- IRelationsTable ---

    public bool ExistsBytes(Local db, byte[] k) => find(db, Decode(k)) is not null;
    public bool RawDeleteBytes(Local db, byte[] k) => delete(db, Decode(k));

    public string Show(byte[] k)
    {
        try
        {
            return ShowKey(Decode(k));
        }
        catch
        {
            return Module.RelationsHex(k);
        }
    }

    public string ShowKey(TKey k) => k switch
    {
        string s => "\"" + s.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"",
        null => "None",
        _ => k.ToString() ?? "",
    };

    sealed class Ref<TPRow, TPKey, TPKeyRW>(
        RelationsTable<TRow, TKey, TKeyRW> child,
        string column,
        RelationsTable<TPRow, TPKey, TPKeyRW> parent,
        byte onDelete,
        bool nullable,
        Func<TRow, (bool Has, TPKey Key)> get,
        Func<Local, TPKey, IEnumerable<TRow>>? via,
        Func<TRow, TRow>? setNull) : IRelationsRef
        where TPRow : struct
        where TPKeyRW : IReadWrite<TPKey>, new()
    {
        public string Child => child.name;
        public string Column => column;
        public string Parent => parent.Name;
        public byte OnDelete => onDelete;
        public bool Nullable => nullable;
        public bool Indexed => via is not null;

        public List<(byte[] Parent, byte[] Child)> Children(Local db, List<byte[]> parentKeys)
        {
            var out_ = new List<(byte[], byte[])>();
            if (via is not null)
            {
                foreach (var pk in parentKeys)
                {
                    foreach (var r in via(db, RelationsTable<TPRow, TPKey, TPKeyRW>.Decode(pk))) out_.Add((pk, Encode(child.key(r))));
                }
                return out_;
            }
            // Compare encoded keys: generic Equals on [SpacetimeDB.Type] structs isn't safe to rely on.
            var wanted = new HashSet<string>(parentKeys.Select(Module.RelationsHex));
            foreach (var r in child.iter(db))
            {
                if (get(r) is not (true, var k)) continue;
                var kb = RelationsTable<TPRow, TPKey, TPKeyRW>.Encode(k);
                if (wanted.Contains(Module.RelationsHex(kb))) out_.Add((kb, Encode(child.key(r))));
            }
            return out_;
        }

        public void SetNull(Local db, byte[] childKey)
        {
            if (setNull is null) throw new Exception($"{child.name}.{column} isn't nullable");
            if (child.find(db, Decode(childKey)) is not { } row) return;
            child.update(db, setNull(row));
        }

        public List<(byte[] Child, byte[] Parent)> Orphans(Local db)
        {
            var out_ = new List<(byte[], byte[])>();
            foreach (var r in child.iter(db))
            {
                var (has, k) = get(r);
                if (!has || parent.Exists(db, k)) continue;
                out_.Add((Encode(child.key(r)), RelationsTable<TPRow, TPKey, TPKeyRW>.Encode(k)));
            }
            return out_;
        }
    }

    sealed class UniqueDecl(RelationsTable<TRow, TKey, TKeyRW> table, string[] columns, Func<Local, TRow, IEnumerable<TRow>> matches)
        : IRelationsUnique
    {
        public string Table => table.name;
        public string[] Columns => columns;

        public List<(byte[] Dup, byte[] First)> Duplicates(Local db)
        {
            var out_ = new List<(byte[], byte[])>();
            var seen = new HashSet<string>();
            foreach (var r in table.iter(db))
            {
                // The row with the smallest key keeps its place; the others are the duplicates.
                var keys = matches(db, r).Select(o => table.key(o)).ToList();
                var mine = Encode(table.key(r));
                var first = keys.Count == 0 ? mine : Encode(keys.Min(RelationsKeyComparer<TKey>.Instance)!);
                if (!first.AsSpan().SequenceEqual(mine) && seen.Add(Module.RelationsHex(mine))) out_.Add((mine, first));
            }
            return out_;
        }
    }
}

/// <summary>
/// Key order, as Rust's Ord: ordinal for strings (Comparer.Default would be culture-sensitive),
/// IComparable otherwise, and BSATN bytes as a last resort.
/// </summary>
public sealed class RelationsKeyComparer<TK> : IComparer<TK>
{
    public static readonly RelationsKeyComparer<TK> Instance = new();

    public int Compare(TK? a, TK? b) => (a, b) switch
    {
        (string x, string y) => string.CompareOrdinal(x, y),
        (IComparable<TK> x, _) when b is not null => x.CompareTo(b),
        (IComparable x, _) when b is not null => x.CompareTo(b),
        _ => Comparer<TK>.Default.Compare(a!, b!),
    };
}

public static partial class Module
{
    /// <summary>On delete of the parent: refuse while children exist.</summary>
    public const byte RELATIONS_RESTRICT = 0;
    /// <summary>On delete of the parent: delete the children too (recursively).</summary>
    public const byte RELATIONS_CASCADE = 1;
    /// <summary>On delete of the parent: set the child's column to null.</summary>
    public const byte RELATIONS_SET_NULL = 2;
    public const byte RELATIONS_VIOLATION_ORPHAN = 0;
    public const byte RELATIONS_VIOLATION_DUPLICATE = 1;
    public const uint RELATIONS_DEFAULT_PAGE = 50;
    public const uint RELATIONS_MAX_PAGE = 500;

    // -----------------------------------------------------------------------
    // Tables
    // -----------------------------------------------------------------------

    /// <summary>The declared references, for clients and tools. Rewritten by RelationsConfigure.</summary>
    [SpacetimeDB.Table(Accessor = "RelationsFk", Public = true)]
    public partial struct RelationsFk
    {
        [SpacetimeDB.PrimaryKey, SpacetimeDB.AutoInc]
        public ulong Id;
        public string ChildTable;
        public string ChildColumn;
        public string ParentTable;
        public byte OnDelete;
        public bool Nullable;
        public bool Indexed;
    }

    /// <summary>The declared multi-column unique constraints. Rewritten by RelationsConfigure.</summary>
    [SpacetimeDB.Table(Accessor = "RelationsUnique", Public = true)]
    public partial struct RelationsUnique
    {
        [SpacetimeDB.PrimaryKey, SpacetimeDB.AutoInc]
        public ulong Id;
        public string TableName;
        public List<string> Columns;
    }

    /// <summary>Who may run relations_check / relations_repair (the publisher, after RelationsConfigure).</summary>
    [SpacetimeDB.Table(Accessor = "RelationsAdmin")]
    public partial struct RelationsAdmin
    {
        [SpacetimeDB.PrimaryKey]
        public Identity Identity;
    }

    /// <summary>Each client's position in each paged list (see RelationsPageStateOf).</summary>
    [SpacetimeDB.Table(Accessor = "RelationsPage")]
    [SpacetimeDB.Index.BTree(Accessor = "ByOwnerList", Columns = new[] { nameof(Owner), nameof(List) })]
    public partial struct RelationsPage
    {
        [SpacetimeDB.PrimaryKey, SpacetimeDB.AutoInc]
        public ulong Id;
        [SpacetimeDB.Index.BTree]
        public Identity Owner;
        public string List;
        /// <summary>Hex BSATN of the last key of the previous page. null: the first page.</summary>
        public string? After;
        public uint Limit;
    }

    // -----------------------------------------------------------------------
    // Registry
    // -----------------------------------------------------------------------

    // No initializers on purpose: declarations register during static initialization, in
    // whatever order the partial class parts run.
    static List<IRelationsTable>? relationsTables;
    static List<IRelationsRef>? relationsRefs;
    static List<IRelationsUnique>? relationsUniques;
    static List<IRelationsTable> RelationsTables => relationsTables ??= new();
    static List<IRelationsRef> RelationsRefs => relationsRefs ??= new();
    static List<IRelationsUnique> RelationsUniques => relationsUniques ??= new();

    public static void RelationsRegister(IRelationsTable t)
    {
        if (RelationsTables.Any(x => x.Name == t.Name)) throw new ArgumentException($"{t.Name} is declared twice");
        RelationsTables.Add(t);
    }

    public static void RelationsRegister(IRelationsRef r) => RelationsRefs.Add(r);
    public static void RelationsRegister(IRelationsUnique u) => RelationsUniques.Add(u);

    static IRelationsTable RelationsTableNamed(string name) =>
        RelationsTables.FirstOrDefault(t => t.Name == name) ?? throw new Exception($"{name} isn't declared in relations!");

    static string RelationsShow(string table, byte[] key) =>
        RelationsTables.FirstOrDefault(t => t.Name == table) is { } t ? t.Show(key) : RelationsHex(key);

    // -----------------------------------------------------------------------
    // Library API
    // -----------------------------------------------------------------------

    /// <summary>
    /// Call from Init: publishes the schema description and makes the caller (the publisher) an
    /// admin. Safe to call again after a republish.
    /// </summary>
    public static void RelationsConfigure(ReducerContext ctx)
    {
        foreach (var r in ctx.Db.RelationsFk.Iter().ToList()) ctx.Db.RelationsFk.Id.Delete(r.Id);
        foreach (var fk in RelationsRefs)
        {
            ctx.Db.RelationsFk.Insert(new RelationsFk
            {
                Id = 0,
                ChildTable = fk.Child,
                ChildColumn = fk.Column,
                ParentTable = fk.Parent,
                OnDelete = fk.OnDelete,
                Nullable = fk.Nullable,
                Indexed = fk.Indexed,
            });
        }
        foreach (var r in ctx.Db.RelationsUnique.Iter().ToList()) ctx.Db.RelationsUnique.Id.Delete(r.Id);
        foreach (var u in RelationsUniques)
        {
            ctx.Db.RelationsUnique.Insert(new RelationsUnique { Id = 0, TableName = u.Table, Columns = u.Columns.ToList() });
        }
        RelationsAddAdmin(ctx.Db, ctx.Sender);
    }

    public static void RelationsAddAdmin(Local db, Identity who)
    {
        if (db.RelationsAdmin.Identity.Find(who) is null) db.RelationsAdmin.Insert(new RelationsAdmin { Identity = who });
    }

    public static void RelationsRemoveAdmin(Local db, Identity who) => db.RelationsAdmin.Identity.Delete(who);

    public static bool RelationsIsAdmin(Local db, Identity who, Identity self) =>
        who == self || db.RelationsAdmin.Identity.Find(who) is not null;

    public static bool RelationsIsAdmin(ReducerContext ctx, Identity who) => RelationsIsAdmin(ctx.Db, who, ctx.DatabaseIdentity);

    /// <summary>What deleting table/key (BSATN) would do. Reads only. Throws if the row doesn't exist.</summary>
    public static DeletePlan RelationsPlanDelete(Local db, string table, byte[] key)
    {
        if (!RelationsTableNamed(table).ExistsBytes(db, key))
            throw new Exception($"{table} {RelationsShow(table, key)}: no such row");
        var seen = new HashSet<(string, string)> { (table, RelationsHex(key)) };
        var order = new List<(string Table, byte[] Key)> { (table, key) };
        var nulls = new List<(string Table, string Column, byte[] Key)>();
        var restricts = new List<(string Table, string Column, byte[] Key, string ParentTable, byte[] ParentKey)>();
        // Breadth first, one level at a time, so a reference without an index is scanned once per
        // level rather than once per row.
        var frontier = new List<(string Table, byte[] Key)>(order);
        while (frontier.Count > 0)
        {
            var byTable = new List<(string Table, List<byte[]> Keys)>();
            foreach (var (t, k) in frontier)
            {
                var i = byTable.FindIndex(x => x.Table == t);
                if (i >= 0) byTable[i].Keys.Add(k);
                else byTable.Add((t, new List<byte[]> { k }));
            }
            frontier = new();
            foreach (var (t, keys) in byTable)
            {
                foreach (var fk in RelationsRefs.Where(f => f.Parent == t))
                {
                    foreach (var (pk, ck) in fk.Children(db, keys))
                    {
                        switch (fk.OnDelete)
                        {
                            case RELATIONS_CASCADE:
                                if (seen.Add((fk.Child, RelationsHex(ck))))
                                {
                                    order.Add((fk.Child, ck));
                                    frontier.Add((fk.Child, ck));
                                }
                                break;
                            case RELATIONS_SET_NULL:
                                nulls.Add((fk.Child, fk.Column, ck));
                                break;
                            default:
                                restricts.Add((fk.Child, fk.Column, ck, t, pk));
                                break;
                        }
                    }
                }
            }
        }
        // A child that's deleted anyway neither needs unlinking nor blocks anything.
        var plan = DeletePlan.Empty();
        plan.Deletes.AddRange(order.Select(o => new RowRef { TableName = o.Table, Key = RelationsHex(o.Key) }));
        var nulled = new HashSet<(string, string, string)>();
        foreach (var (t, c, k) in nulls)
        {
            var hex = RelationsHex(k);
            if (!seen.Contains((t, hex)) && nulled.Add((t, c, hex))) plan.Nulls.Add(new NullRef { TableName = t, Column = c, Key = hex });
        }
        foreach (var (t, c, k, pt, pk) in restricts)
        {
            var hex = RelationsHex(k);
            if (!seen.Contains((t, hex)))
                plan.Blocked.Add(new Blocker { TableName = t, Column = c, Key = hex, ParentTable = pt, ParentKey = RelationsHex(pk) });
        }
        return plan;
    }

    /// <summary>
    /// Delete table/key (BSATN) with every cascade, all or nothing. Throws (nothing changes) if a
    /// restrict reference blocks it. Returns what was done.
    /// </summary>
    public static DeletePlan RelationsDelete(Local db, string table, byte[] key)
    {
        var plan = RelationsPlanDelete(db, table, key);
        if (plan.Blocked.Count > 0)
        {
            var b = plan.Blocked[0];
            var more = plan.Blocked.Count == 1 ? "" : $" (and {plan.Blocked.Count - 1} more)";
            throw new Exception(
                $"can't delete {table} {RelationsShow(table, key)}: {b.TableName} {RelationsShowHex(b.TableName, b.Key)} "
                + $"still references {b.ParentTable} {RelationsShowHex(b.ParentTable, b.ParentKey)} through {b.Column}{more}");
        }
        RelationsApply(db, plan);
        return plan;
    }

    static string RelationsShowHex(string table, string hex)
    {
        try
        {
            return RelationsShow(table, RelationsUnhex(hex));
        }
        catch
        {
            return hex;
        }
    }

    static void RelationsApply(Local db, DeletePlan plan)
    {
        foreach (var n in plan.Nulls) RelationsSetNull(db, n.TableName, n.Column, RelationsUnhex(n.Key));
        // Leaves first.
        for (var i = plan.Deletes.Count - 1; i >= 0; i--)
        {
            RelationsTableNamed(plan.Deletes[i].TableName).RawDeleteBytes(db, RelationsUnhex(plan.Deletes[i].Key));
        }
    }

    static IRelationsRef RelationsRefNamed(string child, string column) =>
        RelationsRefs.FirstOrDefault(f => f.Child == child && f.Column == column)
        ?? throw new Exception($"{child}.{column} isn't a declared reference");

    static void RelationsSetNull(Local db, string child, string column, byte[] key) =>
        RelationsRefNamed(child, column).SetNull(db, key);

    /// <summary>Every orphan and duplicate in the current data.</summary>
    public static List<Violation> RelationsCheckNow(Local db)
    {
        var out_ = new List<Violation>();
        foreach (var fk in RelationsRefs)
        {
            foreach (var (ck, pk) in fk.Orphans(db))
            {
                out_.Add(new Violation
                {
                    Kind = RELATIONS_VIOLATION_ORPHAN,
                    TableName = fk.Child,
                    Column = fk.Column,
                    Key = RelationsHex(ck),
                    ParentTable = fk.Parent,
                    ParentKey = RelationsHex(pk),
                });
            }
        }
        foreach (var u in RelationsUniques)
        {
            foreach (var (k, first) in u.Duplicates(db))
            {
                out_.Add(new Violation
                {
                    Kind = RELATIONS_VIOLATION_DUPLICATE,
                    TableName = u.Table,
                    Column = string.Join(",", u.Columns),
                    Key = RelationsHex(k),
                    ParentTable = u.Table,
                    ParentKey = RelationsHex(first),
                });
            }
        }
        return out_;
    }

    /// <summary>
    /// Apply each reference's on-delete rule to its orphans: cascade deletes them (and their own
    /// children), set_null unlinks them, restrict orphans and duplicates are reported only.
    /// </summary>
    public static RepairReport RelationsRepairNow(Local db)
    {
        var report = new RepairReport { Deleted = new(), Nulled = new(), Unresolved = new() };
        foreach (var v in RelationsCheckNow(db))
        {
            if (v.Kind != RELATIONS_VIOLATION_ORPHAN)
            {
                report.Unresolved.Add(v);
                continue;
            }
            var fk = RelationsRefNamed(v.TableName, v.Column);
            var key = RelationsUnhex(v.Key);
            // An earlier cascade may have removed it already.
            if (!RelationsTableNamed(v.TableName).ExistsBytes(db, key)) continue;
            switch (fk.OnDelete)
            {
                case RELATIONS_CASCADE:
                    DeletePlan plan;
                    try
                    {
                        plan = RelationsPlanDelete(db, v.TableName, key);
                    }
                    catch
                    {
                        report.Unresolved.Add(v);
                        break;
                    }
                    if (plan.Blocked.Count > 0)
                    {
                        report.Unresolved.Add(v);
                        break;
                    }
                    RelationsApply(db, plan);
                    report.Deleted.AddRange(plan.Deletes);
                    report.Nulled.AddRange(plan.Nulls);
                    break;
                case RELATIONS_SET_NULL:
                    RelationsSetNull(db, v.TableName, v.Column, key);
                    report.Nulled.Add(new NullRef { TableName = v.TableName, Column = v.Column, Key = v.Key });
                    break;
                default:
                    report.Unresolved.Add(v);
                    break;
            }
        }
        return report;
    }

    // --- Pagination ---------------------------------------------------------

    /// <summary>Clamp a requested page size: 0 means RELATIONS_DEFAULT_PAGE, at most RELATIONS_MAX_PAGE.</summary>
    public static int RelationsPageSize(uint limit) => limit == 0 ? (int)RELATIONS_DEFAULT_PAGE : (int)Math.Min(limit, RELATIONS_MAX_PAGE);

    /// <summary>
    /// Take one page from rows (already positioned after the cursor): the limit smallest keys, in
    /// key order. Next is the cursor of the last row returned, if more rows follow. It reads the
    /// whole range on purpose: inside a transaction that wrote to it, a btree range scan yields
    /// the transaction's own rows first, so the scan isn't in key order (and views refresh inside
    /// the writing transaction).
    /// </summary>
    public static (List<T> Items, string? Next) RelationsTakePage<T, TK, TKRW>(IEnumerable<T> rows, uint limit, Func<T, TK> key)
        where TKRW : IReadWrite<TK>, new()
    {
        var n = RelationsPageSize(limit);
        var all = rows.ToList();
        var more = all.Count > n;
        var items = all.OrderBy(key, RelationsKeyComparer<TK>.Instance).Take(n).ToList();
        var next = more && items.Count > 0 ? RelationsCursorOf<TK, TKRW>(key(items[^1])) : null;
        return (items, next);
    }

    /// <summary>The cursor for a key: hex of its BSATN.</summary>
    public static string RelationsCursorOf<TK, TKRW>(TK key) where TKRW : IReadWrite<TK>, new() =>
        RelationsHex(IStructuralReadWrite.ToBytes(new TKRW(), key));

    /// <summary>Decode a cursor back into a key. False for null or "" (the first page). Throws on a bad cursor.</summary>
    public static bool RelationsCursor<TK, TKRW>(string? cursor, out TK key) where TKRW : IReadWrite<TK>, new()
    {
        key = default!;
        if (string.IsNullOrEmpty(cursor)) return false;
        var bytes = RelationsUnhex(cursor);
        try
        {
            using var reader = new BinaryReader(new MemoryStream(bytes));
            key = new TKRW().Read(reader);
            if (reader.BaseStream.Position != bytes.Length) throw new Exception("trailing bytes");
        }
        catch (Exception e)
        {
            throw new Exception($"bad key: {e.Message}");
        }
        return true;
    }

    /// <summary>Set who's position in list. relations_set_page calls this for the sender.</summary>
    public static void RelationsSetPageFor(Local db, Identity who, string list, string? after, uint limit)
    {
        if (System.Text.Encoding.UTF8.GetByteCount(list) > 256) throw new Exception("list name too long");
        if (after is not null) RelationsUnhex(after);
        var size = (uint)RelationsPageSize(limit);
        if (db.RelationsPage.ByOwnerList.Filter((who, list)).FirstOrDefault() is { Id: not 0 } p)
        {
            db.RelationsPage.Id.Update(p with { After = after, Limit = size });
        }
        else
        {
            db.RelationsPage.Insert(new RelationsPage { Id = 0, Owner = who, List = list, After = after, Limit = size });
        }
    }

    /// <summary>Forget all of who's page positions (e.g. from your ClientDisconnected).</summary>
    public static void RelationsClearPages(Local db, Identity who)
    {
        foreach (var p in db.RelationsPage.Owner.Filter(who).ToList()) db.RelationsPage.Id.Delete(p.Id);
    }

    /// <summary>
    /// The viewer's position in list, for a view. Before the client has set one: the first page
    /// with RELATIONS_DEFAULT_PAGE rows.
    /// </summary>
    public static RelationsPageState RelationsPageStateOf(ViewContext ctx, string list)
    {
        foreach (var p in ctx.Db.RelationsPage.ByOwnerList.Filter((ctx.Sender, list))) return new(p.After, p.Limit);
        return new(null, RELATIONS_DEFAULT_PAGE);
    }

    /// <summary>Every list the viewer has a position in, for views over several lists.</summary>
    public static List<(string List, RelationsPageState State)> RelationsPageStates(ViewContext ctx) =>
        ctx.Db.RelationsPage.Owner.Filter(ctx.Sender).Select(p => (p.List, new RelationsPageState(p.After, p.Limit))).ToList();

    // --- Encoding -----------------------------------------------------------

    public static string RelationsHex(byte[] bytes) => Convert.ToHexString(bytes).ToLowerInvariant();

    public static byte[] RelationsUnhex(string s)
    {
        if (s.Length % 2 != 0) throw new Exception("bad hex key");
        try
        {
            return Convert.FromHexString(s);
        }
        catch (FormatException)
        {
            throw new Exception("bad hex key");
        }
    }

    // -----------------------------------------------------------------------
    // Client-facing reducers and procedures
    // -----------------------------------------------------------------------

    /// <summary>Find orphans and duplicates. Admins only.</summary>
    [SpacetimeDB.Procedure]
    public static Result<List<Violation>, string> RelationsCheck(ProcedureContext ctx)
    {
        try
        {
            return Result<List<Violation>, string>.Ok(ctx.WithTx(tx =>
            {
                if (!RelationsIsAdmin(tx.Db, tx.Sender, ProcedureContextBase.Identity)) throw new Exception("relations_check is for admins");
                return RelationsCheckNow(tx.Db);
            }));
        }
        catch (Exception e)
        {
            return Result<List<Violation>, string>.Err(e.Message);
        }
    }

    /// <summary>Apply on-delete rules to orphans, in one transaction (rolled back on error). Admins only.</summary>
    [SpacetimeDB.Procedure]
    public static Result<RepairReport, string> RelationsRepair(ProcedureContext ctx)
    {
        try
        {
            return Result<RepairReport, string>.Ok(ctx.WithTx(tx =>
            {
                if (!RelationsIsAdmin(tx.Db, tx.Sender, ProcedureContextBase.Identity)) throw new Exception("relations_repair is for admins");
                return RelationsRepairNow(tx.Db);
            }));
        }
        catch (Exception e)
        {
            return Result<RepairReport, string>.Err(e.Message);
        }
    }

    /// <summary>Move the caller to a page of list (after = the previous page's last key, as a cursor).</summary>
    [SpacetimeDB.Reducer]
    public static void RelationsSetPage(ReducerContext ctx, string list, string? after, uint limit) =>
        RelationsSetPageFor(ctx.Db, ctx.Sender, list, after, limit);
}
