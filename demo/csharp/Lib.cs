// Demo: a kanban board with real references. Boards hold lists, lists hold cards, cards have
// subtasks, comments and tags, members are assigned to cards and write comments.
// Serves the web client at /route/. The C# twin of demo/rust.

#pragma warning disable STDB_UNSTABLE

using SpacetimeDB;
using U64 = SpacetimeDB.BSATN.U64;

public static partial class Module
{
    [SpacetimeDB.Table(Accessor = "DemoMember", Public = true)]
    public partial struct DemoMember
    {
        [SpacetimeDB.PrimaryKey, SpacetimeDB.AutoInc]
        public ulong Id;
        public string Name;
    }

    [SpacetimeDB.Table(Accessor = "DemoBoard", Public = true)]
    public partial struct DemoBoard
    {
        [SpacetimeDB.PrimaryKey, SpacetimeDB.AutoInc]
        public ulong Id;
        public string Name;
    }

    [SpacetimeDB.Table(Accessor = "DemoList", Public = true)]
    public partial struct DemoList
    {
        [SpacetimeDB.PrimaryKey, SpacetimeDB.AutoInc]
        public ulong Id;
        [SpacetimeDB.Index.BTree]
        public ulong BoardId;
        public string Name;
    }

    [SpacetimeDB.Table(Accessor = "DemoCard", Public = true)]
    [SpacetimeDB.Index.BTree(Accessor = "ByList", Columns = new[] { nameof(ListId), nameof(Id) })]
    public partial struct DemoCard
    {
        [SpacetimeDB.PrimaryKey, SpacetimeDB.AutoInc]
        public ulong Id;
        public ulong ListId;
        public string Title;
        /// <summary>A subtask's parent card.</summary>
        public ulong? ParentId;
        public ulong? Assignee;
    }

    [SpacetimeDB.Table(Accessor = "DemoComment", Public = true)]
    public partial struct DemoComment
    {
        [SpacetimeDB.PrimaryKey, SpacetimeDB.AutoInc]
        public ulong Id;
        [SpacetimeDB.Index.BTree]
        public ulong CardId;
        [SpacetimeDB.Index.BTree]
        public ulong AuthorId;
        public string Text;
    }

    [SpacetimeDB.Table(Accessor = "DemoCardTag", Public = true)]
    [SpacetimeDB.Index.BTree(Accessor = "ByCardTag", Columns = new[] { nameof(CardId), nameof(Tag) })]
    public partial struct DemoCardTag
    {
        [SpacetimeDB.PrimaryKey, SpacetimeDB.AutoInc]
        public ulong Id;
        [SpacetimeDB.Index.BTree]
        public ulong CardId;
        public string Tag;
    }

    // Tables first, then references (in the same order as demo/rust), parents before children.
    static readonly RelationsTable<DemoMember, ulong, U64> Members = new(
        "demo_member", r => r.Id,
        (db, id) => db.DemoMember.Id.Find(id), (db, r) => db.DemoMember.Insert(r),
        (db, r) => db.DemoMember.Id.Update(r), (db, id) => db.DemoMember.Id.Delete(id), db => db.DemoMember.Iter());

    static readonly RelationsTable<DemoBoard, ulong, U64> Boards = new(
        "demo_board", r => r.Id,
        (db, id) => db.DemoBoard.Id.Find(id), (db, r) => db.DemoBoard.Insert(r),
        (db, r) => db.DemoBoard.Id.Update(r), (db, id) => db.DemoBoard.Id.Delete(id), db => db.DemoBoard.Iter());

    static readonly RelationsTable<DemoList, ulong, U64> Lists = new RelationsTable<DemoList, ulong, U64>(
        "demo_list", r => r.Id,
        (db, id) => db.DemoList.Id.Find(id), (db, r) => db.DemoList.Insert(r),
        (db, r) => db.DemoList.Id.Update(r), (db, id) => db.DemoList.Id.Delete(id), db => db.DemoList.Iter())
        .References("board_id", Boards, RELATIONS_CASCADE, r => r.BoardId, via: (db, k) => db.DemoList.BoardId.Filter(k));

    static readonly RelationsTable<DemoCard, ulong, U64> Cards = DeclareCards();

    static RelationsTable<DemoCard, ulong, U64> DeclareCards()
    {
        var cards = new RelationsTable<DemoCard, ulong, U64>(
            "demo_card", r => r.Id,
            (db, id) => db.DemoCard.Id.Find(id), (db, r) => db.DemoCard.Insert(r),
            (db, r) => db.DemoCard.Id.Update(r), (db, id) => db.DemoCard.Id.Delete(id), db => db.DemoCard.Iter());
        return cards
            .References("list_id", Lists, RELATIONS_CASCADE, r => r.ListId, via: (db, k) => db.DemoCard.ByList.Filter(k))
            .NullableReferences("parent_id", cards, RELATIONS_CASCADE, r => r.ParentId, r => r with { ParentId = null })
            .NullableReferences("assignee", Members, RELATIONS_SET_NULL, r => r.Assignee, r => r with { Assignee = null });
    }

    static readonly RelationsTable<DemoComment, ulong, U64> Comments = new RelationsTable<DemoComment, ulong, U64>(
        "demo_comment", r => r.Id,
        (db, id) => db.DemoComment.Id.Find(id), (db, r) => db.DemoComment.Insert(r),
        (db, r) => db.DemoComment.Id.Update(r), (db, id) => db.DemoComment.Id.Delete(id), db => db.DemoComment.Iter())
        .References("card_id", Cards, RELATIONS_CASCADE, r => r.CardId, via: (db, k) => db.DemoComment.CardId.Filter(k))
        .References("author_id", Members, RELATIONS_RESTRICT, r => r.AuthorId, via: (db, k) => db.DemoComment.AuthorId.Filter(k));

    static readonly RelationsTable<DemoCardTag, ulong, U64> Tags = new RelationsTable<DemoCardTag, ulong, U64>(
        "demo_card_tag", r => r.Id,
        (db, id) => db.DemoCardTag.Id.Find(id), (db, r) => db.DemoCardTag.Insert(r),
        (db, r) => db.DemoCardTag.Id.Update(r), (db, id) => db.DemoCardTag.Id.Delete(id), db => db.DemoCardTag.Iter())
        .References("card_id", Cards, RELATIONS_CASCADE, r => r.CardId, via: (db, k) => db.DemoCardTag.CardId.Filter(k))
        .Unique(new[] { "card_id", "tag" }, (db, r) => db.DemoCardTag.ByCardTag.Filter((r.CardId, r.Tag)));

    [SpacetimeDB.Reducer(ReducerKind.Init)]
    public static void Init(ReducerContext ctx) => RelationsConfigure(ctx);

    [SpacetimeDB.Reducer(ReducerKind.ClientDisconnected)]
    public static void ClientDisconnected(ReducerContext ctx) => RelationsClearPages(ctx.Db, ctx.Sender);

    static string CheckName(string s)
    {
        s = s.Trim();
        var n = s.EnumerateRunes().Count();
        if (n == 0) throw new Exception("name is empty");
        if (n > 80) throw new Exception("name too long");
        return s;
    }

    [SpacetimeDB.Reducer]
    public static void DemoAddMember(ReducerContext ctx, string name) =>
        Members.Insert(ctx, new DemoMember { Id = 0, Name = CheckName(name) });

    [SpacetimeDB.Reducer]
    public static void DemoAddBoard(ReducerContext ctx, string name) =>
        Boards.Insert(ctx, new DemoBoard { Id = 0, Name = CheckName(name) });

    [SpacetimeDB.Reducer]
    public static void DemoAddList(ReducerContext ctx, ulong boardId, string name) =>
        Lists.Insert(ctx, new DemoList { Id = 0, BoardId = boardId, Name = CheckName(name) });

    [SpacetimeDB.Reducer]
    public static void DemoAddCard(ReducerContext ctx, ulong listId, string title, ulong? parentId) =>
        Cards.Insert(ctx, new DemoCard { Id = 0, ListId = listId, Title = CheckName(title), ParentId = parentId, Assignee = null });

    static DemoCard CardOrThrow(ReducerContext ctx, ulong id) => ctx.Db.DemoCard.Id.Find(id) ?? throw new Exception("no such card");

    [SpacetimeDB.Reducer]
    public static void DemoMoveCard(ReducerContext ctx, ulong id, ulong listId) =>
        Cards.Update(ctx, CardOrThrow(ctx, id) with { ListId = listId });

    [SpacetimeDB.Reducer]
    public static void DemoSetParent(ReducerContext ctx, ulong id, ulong? parentId) =>
        Cards.Update(ctx, CardOrThrow(ctx, id) with { ParentId = parentId });

    [SpacetimeDB.Reducer]
    public static void DemoAssign(ReducerContext ctx, ulong id, ulong? member) =>
        Cards.Update(ctx, CardOrThrow(ctx, id) with { Assignee = member });

    [SpacetimeDB.Reducer]
    public static void DemoAddComment(ReducerContext ctx, ulong cardId, ulong authorId, string text) =>
        Comments.Insert(ctx, new DemoComment { Id = 0, CardId = cardId, AuthorId = authorId, Text = CheckName(text) });

    [SpacetimeDB.Reducer]
    public static void DemoAddTag(ReducerContext ctx, ulong cardId, string tag) =>
        Tags.Insert(ctx, new DemoCardTag { Id = 0, CardId = cardId, Tag = CheckName(tag) });

    [SpacetimeDB.Reducer]
    public static void DemoRetag(ReducerContext ctx, ulong id, string tag)
    {
        var t = ctx.Db.DemoCardTag.Id.Find(id) ?? throw new Exception("no such tag");
        Tags.Update(ctx, t with { Tag = CheckName(tag) });
    }

    static byte[] IdKey(ulong id) => RelationsTable<DemoCard, ulong, U64>.Encode(id);

    /// <summary>Delete any demo row by table name and id, with its cascades.</summary>
    [SpacetimeDB.Reducer]
    public static void DemoDelete(ReducerContext ctx, string table, ulong id) => RelationsDelete(ctx.Db, table, IdKey(id));

    /// <summary>What DemoDelete would do.</summary>
    [SpacetimeDB.Procedure]
    public static Result<DeletePlan, string> DemoPreviewDelete(ProcedureContext ctx, string table, ulong id)
    {
        try
        {
            return Result<DeletePlan, string>.Ok(ctx.WithTx(tx => RelationsPlanDelete(tx.Db, table, IdKey(id))));
        }
        catch (Exception e)
        {
            return Result<DeletePlan, string>.Err(e.Message);
        }
    }

    /// <summary>
    /// Test helper: delete straight through the table handle, the way older code might, leaving
    /// orphans behind for relations_check / relations_repair to find.
    /// </summary>
    [SpacetimeDB.Reducer]
    public static void DemoRawDelete(ReducerContext ctx, string table, ulong id)
    {
        if (!RelationsTableNamed(table).RawDeleteBytes(ctx.Db, IdKey(id))) throw new Exception("no such row");
    }

    /// <summary>Test helper: insert a tag without the unique check, to make a duplicate.</summary>
    [SpacetimeDB.Reducer]
    public static void DemoRawAddTag(ReducerContext ctx, ulong cardId, string tag) =>
        ctx.Db.DemoCardTag.Insert(new DemoCardTag { Id = 0, CardId = cardId, Tag = tag });

    /// <summary>Demo only: anyone may run check and repair.</summary>
    [SpacetimeDB.Reducer]
    public static void DemoBecomeAdmin(ReducerContext ctx) => RelationsAddAdmin(ctx.Db, ctx.Sender);

    // --- Pagination ----------------------------------------------------------

    [SpacetimeDB.Type]
    public partial struct CardPage
    {
        public List<DemoCard> Items;
        public string? Next;
    }

    static IEnumerable<DemoCard> CardsFrom(Local db, ulong listId, ulong from) =>
        db.DemoCard.ByList.Filter((listId, new SpacetimeDB.Bound<ulong>(from, ulong.MaxValue)));

    /// <summary>One page of a list's cards, by id. after: the previous page's next.</summary>
    [SpacetimeDB.Procedure]
    public static Result<CardPage, string> DemoCards(ProcedureContext ctx, ulong listId, string? after, uint limit)
    {
        try
        {
            var from = RelationsCursor<ulong, U64>(after, out var a) ? a + 1 : 0;
            return Result<CardPage, string>.Ok(ctx.WithTx(tx =>
            {
                var (items, next) = RelationsTakePage<DemoCard, ulong, U64>(CardsFrom(tx.Db, listId, from), limit, c => c.Id);
                return new CardPage { Items = items, Next = next };
            }));
        }
        catch (Exception e)
        {
            return Result<CardPage, string>.Err(e.Message);
        }
    }

    /// <summary>
    /// The cards on the viewer's current page of each list they've paged ("list:&lt;id&gt;", set with
    /// relations_set_page). Subscribe to it and the page stays live.
    /// </summary>
    [SpacetimeDB.View(Accessor = "DemoCardPage", Public = true)]
    public static List<DemoCard> DemoCardPage(ViewContext ctx)
    {
        var out_ = new List<DemoCard>();
        foreach (var (list, state) in RelationsPageStates(ctx))
        {
            if (!list.StartsWith("list:") || !ulong.TryParse(list.AsSpan(5), out var listId)) continue;
            ulong from;
            try
            {
                from = RelationsCursor<ulong, U64>(state.After, out var a) ? a + 1 : 0;
            }
            catch
            {
                continue;
            }
            // Through RelationsTakePage, not Take(limit): views refresh inside the writing
            // transaction, where a range scan isn't in key order.
            var rows = ctx.Db.DemoCard.ByList.Filter((listId, new SpacetimeDB.Bound<ulong>(from, ulong.MaxValue)));
            out_.AddRange(RelationsTakePage<DemoCard, ulong, U64>(rows, state.Limit, c => c.Id).Items);
        }
        return out_;
    }

    // --- Benchmark -----------------------------------------------------------

    /// <summary>Insert count cards into listId, checked or raw.</summary>
    [SpacetimeDB.Reducer]
    public static void DemoBenchInsert(ReducerContext ctx, ulong listId, uint count, bool @checked)
    {
        for (uint i = 0; i < count; i++)
        {
            var card = new DemoCard { Id = 0, ListId = listId, Title = $"card {i}", ParentId = null, Assignee = null };
            if (@checked) Cards.Insert(ctx, card);
            else ctx.Db.DemoCard.Insert(card);
        }
    }

    static readonly Lazy<byte[]> DemoPage = new(() =>
    {
        using var s = typeof(Module).Assembly.GetManifestResourceStream("index.html")!;
        using var m = new MemoryStream();
        s.CopyTo(m);
        return m.ToArray();
    });

    [SpacetimeDB.HttpHandler]
    public static HttpResponse Page(HandlerContext ctx, HttpRequest req) =>
        new(200, HttpVersion.Http11,
            new List<HttpHeader> { new("content-type", "text/html; charset=utf-8"), new("cache-control", "no-cache") },
            new HttpBody(DemoPage.Value));

    [SpacetimeDB.HttpRouter]
    public static Router Routes() => Router.New().Get("/", Handlers.Page);
}
