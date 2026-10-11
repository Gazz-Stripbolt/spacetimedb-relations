/**
 * Demo: a kanban board with real references, in TypeScript with `spacetimedb-relations` as a
 * submodule. Boards hold lists, lists hold cards, cards have subtasks, comments and tags, members
 * are assigned to cards and write comments. Same behaviour and client-facing names as demo/rust
 * and demo/csharp; serves the web client at /route/.
 */
import { schema, table, t, Range, Router, SumBuilder, SyncResponse, SenderError, type ReducerCtx, type TypeBuilder } from 'spacetimedb/server';
import * as relations from '@pogly/spacetimedb-relations';
import PAGE from './page.gen';

const demoMember = table({ name: 'demo_member', public: true }, { id: t.u64().primaryKey().autoInc(), name: t.string() });

const demoBoard = table({ name: 'demo_board', public: true }, { id: t.u64().primaryKey().autoInc(), name: t.string() });

const demoList = table(
  { name: 'demo_list', public: true },
  { id: t.u64().primaryKey().autoInc(), boardId: t.u64().index('btree'), name: t.string() }
);

const demoCard = table(
  { name: 'demo_card', public: true, indexes: [{ accessor: 'byList', algorithm: 'btree', columns: ['listId', 'id'] }] },
  {
    id: t.u64().primaryKey().autoInc(),
    listId: t.u64(),
    title: t.string(),
    /** A subtask's parent card. */
    parentId: t.option(t.u64()),
    assignee: t.option(t.u64()),
  }
);

const demoComment = table(
  { name: 'demo_comment', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    cardId: t.u64().index('btree'),
    authorId: t.u64().index('btree'),
    text: t.string(),
  }
);

const demoCardTag = table(
  { name: 'demo_card_tag', public: true, indexes: [{ accessor: 'byCardTag', algorithm: 'btree', columns: ['cardId', 'tag'] }] },
  { id: t.u64().primaryKey().autoInc(), cardId: t.u64().index('btree'), tag: t.string() }
);

const spacetimedb = schema({ demoMember, demoBoard, demoList, demoCard, demoComment, demoCardTag, relations });
export default spacetimedb;
type Ctx = ReducerCtx<typeof spacetimedb.schemaType>;
type Card = typeof demoCard.rowType.type;
type Tag = typeof demoCardTag.rowType.type;

// Procedures return `Result<T, String>`, like Rust and C#. `t.result()` can't be used for that in
// SDK 2.11: its serializer writes the `err` payload with the `ok` type's serializer (and its typing
// says `T | E` where the serializer wants `{ ok } | { err }`). An `Ok`/`Err` sum is the same on the
// wire (tag 0 = ok, tag 1 = err), so Rust-generated clients read it as their Result. See FINDINGS.
const result = <T extends TypeBuilder<any, any>>(name: string, okType: T) =>
  new SumBuilder({ Ok: okType, Err: t.string() }, name);
const ok = <T>(value: T) => ({ tag: 'Ok' as const, value });
const err = (message: string) => ({ tag: 'Err' as const, value: message });

/** Run `fn` and return its value as a Result: SenderErrors become `err`. */
function attempt<T>(fn: () => T) {
  try {
    return ok(fn());
  } catch (e) {
    if (e instanceof SenderError) return err(e.message);
    throw e;
  }
}

// ---------------------------------------------------------------------------
// relations wiring: tables, references and unique constraints
// (a submodule can't reach your tables, so you hand it small closures)
// ---------------------------------------------------------------------------

relations.setup<Ctx>({ scope: (ctx) => ctx.as.relations });

const members = relations.table<Ctx, typeof demoMember.rowType.type, bigint>({
  name: 'demo_member',
  key: t.u64(),
  keyOf: (r) => r.id,
  find: (ctx, id) => ctx.db.demoMember.id.find(id),
  insert: (ctx, r) => ctx.db.demoMember.insert(r),
  update: (ctx, r) => ctx.db.demoMember.id.update(r),
  delete: (ctx, id) => ctx.db.demoMember.id.delete(id),
  iter: (ctx) => ctx.db.demoMember.iter(),
});
const boards = relations.table<Ctx, typeof demoBoard.rowType.type, bigint>({
  name: 'demo_board',
  key: t.u64(),
  keyOf: (r) => r.id,
  find: (ctx, id) => ctx.db.demoBoard.id.find(id),
  insert: (ctx, r) => ctx.db.demoBoard.insert(r),
  update: (ctx, r) => ctx.db.demoBoard.id.update(r),
  delete: (ctx, id) => ctx.db.demoBoard.id.delete(id),
  iter: (ctx) => ctx.db.demoBoard.iter(),
});
const lists = relations.table<Ctx, typeof demoList.rowType.type, bigint>({
  name: 'demo_list',
  key: t.u64(),
  keyOf: (r) => r.id,
  find: (ctx, id) => ctx.db.demoList.id.find(id),
  insert: (ctx, r) => ctx.db.demoList.insert(r),
  update: (ctx, r) => ctx.db.demoList.id.update(r),
  delete: (ctx, id) => ctx.db.demoList.id.delete(id),
  iter: (ctx) => ctx.db.demoList.iter(),
});
const cards = relations.table<Ctx, Card, bigint>({
  name: 'demo_card',
  key: t.u64(),
  keyOf: (r) => r.id,
  find: (ctx, id) => ctx.db.demoCard.id.find(id),
  insert: (ctx, r) => ctx.db.demoCard.insert(r),
  update: (ctx, r) => ctx.db.demoCard.id.update(r),
  delete: (ctx, id) => ctx.db.demoCard.id.delete(id),
  iter: (ctx) => ctx.db.demoCard.iter(),
});
const comments = relations.table<Ctx, typeof demoComment.rowType.type, bigint>({
  name: 'demo_comment',
  key: t.u64(),
  keyOf: (r) => r.id,
  find: (ctx, id) => ctx.db.demoComment.id.find(id),
  insert: (ctx, r) => ctx.db.demoComment.insert(r),
  update: (ctx, r) => ctx.db.demoComment.id.update(r),
  delete: (ctx, id) => ctx.db.demoComment.id.delete(id),
  iter: (ctx) => ctx.db.demoComment.iter(),
});
const tags = relations.table<Ctx, Tag, bigint>({
  name: 'demo_card_tag',
  key: t.u64(),
  keyOf: (r) => r.id,
  find: (ctx, id) => ctx.db.demoCardTag.id.find(id),
  insert: (ctx, r) => ctx.db.demoCardTag.insert(r),
  update: (ctx, r) => ctx.db.demoCardTag.id.update(r),
  delete: (ctx, id) => ctx.db.demoCardTag.id.delete(id),
  iter: (ctx) => ctx.db.demoCardTag.iter(),
});

relations.reference<Ctx, typeof demoList.rowType.type, bigint>({
  child: 'demo_list', column: 'board_id', parent: 'demo_board', onDelete: relations.CASCADE,
  get: (r) => r.boardId,
  children: (ctx, id) => ctx.db.demoList.boardId.filter(id),
});
relations.reference<Ctx, Card, bigint>({
  child: 'demo_card', column: 'list_id', parent: 'demo_list', onDelete: relations.CASCADE,
  get: (r) => r.listId,
  children: (ctx, id) => ctx.db.demoCard.byList.filter(id),
});
relations.reference<Ctx, Card, bigint>({
  child: 'demo_card', column: 'parent_id', parent: 'demo_card', onDelete: relations.CASCADE, nullable: true,
  get: (r) => r.parentId,
});
relations.reference<Ctx, Card, bigint>({
  child: 'demo_card', column: 'assignee', parent: 'demo_member', onDelete: relations.SET_NULL, nullable: true,
  get: (r) => r.assignee,
  setNull: (r) => ({ ...r, assignee: undefined }),
});
relations.reference<Ctx, typeof demoComment.rowType.type, bigint>({
  child: 'demo_comment', column: 'card_id', parent: 'demo_card', onDelete: relations.CASCADE,
  get: (r) => r.cardId,
  children: (ctx, id) => ctx.db.demoComment.cardId.filter(id),
});
relations.reference<Ctx, typeof demoComment.rowType.type, bigint>({
  child: 'demo_comment', column: 'author_id', parent: 'demo_member', onDelete: relations.RESTRICT,
  get: (r) => r.authorId,
  children: (ctx, id) => ctx.db.demoComment.authorId.filter(id),
});
relations.reference<Ctx, Tag, bigint>({
  child: 'demo_card_tag', column: 'card_id', parent: 'demo_card', onDelete: relations.CASCADE,
  get: (r) => r.cardId,
  children: (ctx, id) => ctx.db.demoCardTag.cardId.filter(id),
});
relations.unique<Ctx, Tag>({
  table: 'demo_card_tag', columns: ['card_id', 'tag'], index: 'by_card_tag',
  matches: (ctx, r) => ctx.db.demoCardTag.byCardTag.filter([r.cardId, r.tag]),
});

// Client-facing API (same names as Rust/C#).

/** Find orphans and duplicates. Admins only. */
export const relationsCheck = spacetimedb.procedure(result('CheckResult', t.array(relations.Violation)), (ctx) =>
  ctx.withTx((tx) =>
    relations.isAdmin(tx, tx.sender) ? ok(relations.check(tx)) : err('relations_check is for admins')
  )
);

/** Apply on-delete rules to orphans, in one transaction. Admins only. */
export const relationsRepair = spacetimedb.procedure(result('RepairResult', relations.RepairReport), (ctx) =>
  ctx.withTx((tx) =>
    relations.isAdmin(tx, tx.sender) ? ok(relations.repair(tx)) : err('relations_repair is for admins')
  )
);

/** Move the caller to a page of `list` (`after` = the previous page's last key, as a cursor). */
export const relationsSetPage = spacetimedb.reducer(
  { list: t.string(), after: t.option(t.string()), limit: t.u32() },
  (ctx, { list, after, limit }) => relations.setPage(ctx, ctx.sender, list, after, limit)
);

// ---------------------------------------------------------------------------
// The app
// ---------------------------------------------------------------------------

export const init = spacetimedb.init((ctx) => relations.configure(ctx));

export const onDisconnect = spacetimedb.clientDisconnected((ctx) => relations.clearPages(ctx, ctx.sender));

function name(s: string): string {
  s = s.trim();
  const n = [...s].length;
  if (n === 0) throw new SenderError('name is empty');
  if (n > 80) throw new SenderError('name too long');
  return s;
}

function findCard(ctx: Ctx, id: bigint): Card {
  const c = ctx.db.demoCard.id.find(id);
  if (!c) throw new SenderError('no such card');
  return c;
}

export const demoAddMember = spacetimedb.reducer({ name: t.string() }, (ctx, a) => {
  members.insert(ctx, { id: 0n, name: name(a.name) });
});

export const demoAddBoard = spacetimedb.reducer({ name: t.string() }, (ctx, a) => {
  boards.insert(ctx, { id: 0n, name: name(a.name) });
});

export const demoAddList = spacetimedb.reducer({ boardId: t.u64(), name: t.string() }, (ctx, a) => {
  lists.insert(ctx, { id: 0n, boardId: a.boardId, name: name(a.name) });
});

export const demoAddCard = spacetimedb.reducer(
  { listId: t.u64(), title: t.string(), parentId: t.option(t.u64()) },
  (ctx, { listId, title, parentId }) => {
    cards.insert(ctx, { id: 0n, listId, title: name(title), parentId, assignee: undefined });
  }
);

export const demoMoveCard = spacetimedb.reducer({ id: t.u64(), listId: t.u64() }, (ctx, { id, listId }) => {
  cards.update(ctx, { ...findCard(ctx, id), listId });
});

export const demoSetParent = spacetimedb.reducer({ id: t.u64(), parentId: t.option(t.u64()) }, (ctx, { id, parentId }) => {
  cards.update(ctx, { ...findCard(ctx, id), parentId });
});

export const demoAssign = spacetimedb.reducer({ id: t.u64(), member: t.option(t.u64()) }, (ctx, { id, member }) => {
  cards.update(ctx, { ...findCard(ctx, id), assignee: member });
});

export const demoAddComment = spacetimedb.reducer(
  { cardId: t.u64(), authorId: t.u64(), text: t.string() },
  (ctx, { cardId, authorId, text }) => {
    comments.insert(ctx, { id: 0n, cardId, authorId, text: name(text) });
  }
);

export const demoAddTag = spacetimedb.reducer({ cardId: t.u64(), tag: t.string() }, (ctx, { cardId, tag }) => {
  tags.insert(ctx, { id: 0n, cardId, tag: name(tag) });
});

export const demoRetag = spacetimedb.reducer({ id: t.u64(), tag: t.string() }, (ctx, { id, tag }) => {
  const row = ctx.db.demoCardTag.id.find(id);
  if (!row) throw new SenderError('no such tag');
  tags.update(ctx, { ...row, tag: name(tag) });
});

/** Delete any demo row by table name and id, with its cascades. */
export const demoDelete = spacetimedb.reducer({ table: t.string(), id: t.u64() }, (ctx, { table, id }) => {
  relations.deleteRow(ctx, table, relations.encode(t.u64(), id));
});

/** What `demo_delete` would do. */
export const demoPreviewDelete = spacetimedb.procedure(
  { table: t.string(), id: t.u64() },
  result('DeletePlanResult', relations.DeletePlan),
  (ctx, { table, id }) => ctx.withTx((tx) => attempt(() => relations.planDelete(tx, table, relations.encode(t.u64(), id))))
);

/**
 * Test helper: delete straight through the table handle, the way older code might, leaving
 * orphans behind for `relations_check` / `relations_repair` to find.
 */
export const demoRawDelete = spacetimedb.reducer({ table: t.string(), id: t.u64() }, (ctx, { table, id }) => {
  if (!relations.rawDelete(ctx, table, relations.encode(t.u64(), id))) throw new SenderError('no such row');
});

/** Test helper: insert a tag without the unique check, to make a duplicate. */
export const demoRawAddTag = spacetimedb.reducer({ cardId: t.u64(), tag: t.string() }, (ctx, { cardId, tag }) => {
  ctx.db.demoCardTag.insert({ id: 0n, cardId, tag });
});

/** Demo only: anyone may run check and repair. */
export const demoBecomeAdmin = spacetimedb.reducer((ctx) => relations.addAdmin(ctx, ctx.sender));

// --- Pagination ------------------------------------------------------------

const CardPage = t.object('CardPage', { items: t.array(demoCard.rowType), next: t.option(t.string()) });

const cardsFrom = (db: Ctx['db'], listId: bigint, from: bigint) =>
  db.demoCard.byList.filter([listId, new Range({ tag: 'included', value: from }, { tag: 'unbounded' })]);

/** One page of a list's cards, by id. `after`: the previous page's `next`. */
export const demoCards = spacetimedb.procedure(
  { listId: t.u64(), after: t.option(t.string()), limit: t.u32() },
  result('CardPageResult', CardPage),
  (ctx, { listId, after, limit }) =>
    ctx.withTx((tx) =>
      attempt(() => {
        const a = relations.cursor(t.u64(), after);
        const from = a === undefined ? 0n : a + 1n;
        return relations.page(cardsFrom(tx.db as Ctx['db'], listId, from), limit, (c) => c.id, t.u64());
      })
    )
);

/**
 * The cards on the viewer's current page of each list they've paged ("list:<id>", set with
 * `relations_set_page`). Subscribe to it and the page stays live.
 */
export const demoCardPage = spacetimedb.view({ public: true }, t.array(demoCard.rowType), (ctx) => {
  const out: Card[] = [];
  for (const [list, state] of relations.pageStates(ctx)) {
    const m = /^list:(\d+)$/.exec(list);
    if (!m) continue;
    let after: bigint | undefined;
    try {
      after = relations.cursor(t.u64(), state.after);
    } catch {
      continue;
    }
    const from = after === undefined ? 0n : after + 1n;
    // page() sorts: in the writing transaction, the scan isn't in key order (see FINDINGS).
    out.push(...relations.page(cardsFrom(ctx.db as unknown as Ctx['db'], BigInt(m[1]), from), state.limit, (c) => c.id, t.u64()).items);
  }
  return out;
});

// --- Benchmark -------------------------------------------------------------

/** Insert `count` cards into `list_id`, checked or raw. */
export const demoBenchInsert = spacetimedb.reducer(
  { listId: t.u64(), count: t.u32(), checked: t.bool() },
  (ctx, { listId, count, checked }) => {
    for (let i = 0; i < count; i++) {
      const card = { id: 0n, listId, title: `card ${i}`, parentId: undefined, assignee: undefined };
      if (checked) cards.insert(ctx, card);
      else ctx.db.demoCard.insert(card);
    }
  }
);

export const page = spacetimedb.httpHandler(
  () => new SyncResponse(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' } })
);
export const router = spacetimedb.httpRouter(new Router().get('/', page));
