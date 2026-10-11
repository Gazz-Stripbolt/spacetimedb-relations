// Protocol tests: real clients against a published demo module.
//
//   DB=rel-rust HOST=ws://127.0.0.1:3000 npx tsx tests/server.test.mts
//
// Covers references (insert/update checks, nullable), multi-column unique, delete plans,
// cascade / set_null / restrict (all or nothing), cycles, check and repair (admins only),
// cursor pagination and live pages.
import assert from 'node:assert/strict';
import { connect, counts, idOf, key, unwrap, SUBSCRIPTIONS, type Conn, type Card } from '../demo/web/src/api.ts';

const HOST = process.env.HOST ?? 'ws://127.0.0.1:3000';
const DB = process.env.DB ?? 'rel-rust';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function client() {
  const { conn, identity } = await connect(HOST, DB);
  await new Promise<void>((res, rej) =>
    conn.subscriptionBuilder().onApplied(() => res()).onError((_c, e) => rej(e)).subscribe(SUBSCRIPTIONS)
  );
  const err = async (p: Promise<unknown>) => {
    try {
      const v = (await p) as { err?: string } | undefined;
      return v && typeof v === 'object' && 'err' in v ? v.err! : null; // a procedure's Err
    } catch (e) {
      return String((e as Error)?.message ?? e);
    }
  };
  return { conn, identity, err, r: conn.reducers, p: conn.procedures };
}
type Client = Awaited<ReturnType<typeof client>>;

const all = <T,>(it: Iterable<T>) => [...it];
const newest = <T extends { id: bigint }>(rows: Iterable<T>) => all(rows).sort((x, y) => Number(x.id - y.id)).at(-1)!;
const card = (c: { conn: Conn }, id: bigint) => (c.conn.db.demoCard.id.find(id) ?? undefined) as Card | undefined;

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const a = await client();
const eve = await client();

// Helpers that create a row and return its id (rows arrive through the subscription).
async function board(c: Client, name: string) {
  await c.r.demoAddBoard({ name });
  await sleep(50);
  return newest(c.conn.db.demoBoard.iter()).id;
}
async function list(c: Client, boardId: bigint, name: string) {
  await c.r.demoAddList({ boardId, name });
  await sleep(50);
  return newest(c.conn.db.demoList.iter()).id;
}
async function addCard(c: Client, listId: bigint, title: string, parentId?: bigint) {
  await c.r.demoAddCard({ listId, title, parentId });
  await sleep(50);
  return newest(c.conn.db.demoCard.iter()).id;
}
async function member(c: Client, name: string) {
  await c.r.demoAddMember({ name });
  await sleep(50);
  return newest(c.conn.db.demoMember.iter()).id;
}
async function comment(c: Client, cardId: bigint, authorId: bigint, text: string) {
  await c.r.demoAddComment({ cardId, authorId, text });
  await sleep(50);
  return newest(c.conn.db.demoComment.iter()).id;
}

await test('references: inserts and updates with a missing parent are refused, nullable columns accept none', async () => {
  assert.equal(await a.err(a.r.demoAddList({ boardId: 999n, name: 'x' })), 'demo_list.board_id = 999: no such demo_board');
  const b = await board(a, 'refs');
  const l = await list(a, b, 'todo');
  assert.equal(await a.err(a.r.demoAddCard({ listId: 999n, title: 'x', parentId: undefined })), 'demo_card.list_id = 999: no such demo_list');
  assert.equal(await a.err(a.r.demoAddCard({ listId: l, title: 'x', parentId: 999n })), 'demo_card.parent_id = 999: no such demo_card');
  const c = await addCard(a, l, 'top level');
  assert.equal(card(a, c)!.parentId, undefined);
  const sub = await addCard(a, l, 'subtask', c);
  assert.equal(card(a, sub)!.parentId, c);
  assert.equal(await a.err(a.r.demoMoveCard({ id: c, listId: 999n })), 'demo_card.list_id = 999: no such demo_list');
  assert.equal(card(a, c)!.listId, l, 'unchanged');
  const l2 = await list(a, b, 'doing');
  await a.r.demoMoveCard({ id: c, listId: l2 });
  await sleep(50);
  assert.equal(card(a, c)!.listId, l2);
  assert.equal(await a.err(a.r.demoAssign({ id: c, member: 999n })), 'demo_card.assignee = 999: no such demo_member');
  assert.equal(await a.err(a.r.demoAddComment({ cardId: c, authorId: 999n, text: 'hi' })), 'demo_comment.author_id = 999: no such demo_member');
});

await test('unique: (card_id, tag) is unique across inserts and updates', async () => {
  const l = await list(a, await board(a, 'tags'), 'l');
  const c1 = await addCard(a, l, 'one');
  const c2 = await addCard(a, l, 'two');
  await a.r.demoAddTag({ cardId: c1, tag: 'red' });
  await a.r.demoAddTag({ cardId: c2, tag: 'red' });
  await a.r.demoAddTag({ cardId: c1, tag: 'blue' });
  assert.equal(await a.err(a.r.demoAddTag({ cardId: c1, tag: 'red' })), 'demo_card_tag: another row already has this (card_id, tag)');
  await sleep(50);
  const blue = all(a.conn.db.demoCardTag.iter()).find((t) => t.cardId === c1 && t.tag === 'blue')!;
  assert.equal(await a.err(a.r.demoRetag({ id: blue.id, tag: 'red' })), 'demo_card_tag: another row already has this (card_id, tag)');
  await a.r.demoRetag({ id: blue.id, tag: 'blue' }); // same values: not a clash with itself
  await a.r.demoRetag({ id: blue.id, tag: 'green' });
  await sleep(50);
  assert.equal(a.conn.db.demoCardTag.id.find(blue.id)!.tag, 'green');
  assert.equal(await a.err(a.r.demoAddTag({ cardId: 999n, tag: 'x' })), 'demo_card_tag.card_id = 999: no such demo_card');
});

await test('preview: a delete plan lists every cascade (once) and changes nothing', async () => {
  const b = await board(a, 'preview');
  const l1 = await list(a, b, 'l1');
  const l2 = await list(a, b, 'l2');
  const m = await member(a, 'pat');
  const c1 = await addCard(a, l1, 'c1');
  const sub = await addCard(a, l2, 'sub of c1 in another list', c1); // reachable two ways
  await addCard(a, l2, 'c2');
  await comment(a, c1, m, 'hello');
  await a.r.demoAddTag({ cardId: sub, tag: 't' });
  await a.r.demoAssign({ id: c1, member: m });
  const plan = unwrap(await a.p.demoPreviewDelete({ table: 'demo_board', id: b }));
  assert.deepEqual(plan.deletes[0], { tableName: 'demo_board', key: key(b) });
  assert.deepEqual(counts(plan), { demo_board: 1, demo_list: 2, demo_card: 3, demo_comment: 1, demo_card_tag: 1 });
  assert.equal(new Set(plan.deletes.map((d) => d.tableName + d.key)).size, plan.deletes.length, 'no duplicates');
  assert.deepEqual(plan.nulls, [], 'the assigned card is deleted anyway');
  assert.deepEqual(plan.blocked, [], 'the comment blocking its author is deleted too');
  await sleep(50);
  assert.ok(a.conn.db.demoBoard.id.find(b) && card(a, sub), 'nothing deleted');
  assert.equal(await a.err(a.p.demoPreviewDelete({ table: 'demo_board', id: 999n })), 'demo_board 999: no such row');
  assert.match((await a.err(a.p.demoPreviewDelete({ table: 'nope', id: 1n }))) ?? '', /nope/);
});

await test('cascade: deleting a board removes its lists, cards, subtasks, comments and tags, nothing else', async () => {
  const b = await board(a, 'doomed');
  const keep = await board(a, 'kept');
  const lk = await list(a, keep, 'kept list');
  const ck = await addCard(a, lk, 'kept card');
  const m = await member(a, 'sam');
  const l = await list(a, b, 'l');
  const c = await addCard(a, l, 'c');
  const s1 = await addCard(a, l, 's1', c);
  const s2 = await addCard(a, lk, 's2 (in the kept board, but a subtask of a doomed card)', s1);
  const cm = await comment(a, s2, m, 'deep');
  await a.r.demoAddTag({ cardId: s2, tag: 'deep' });
  await a.r.demoDelete({ table: 'demo_board', id: b });
  await sleep(100);
  assert.equal(a.conn.db.demoBoard.id.find(b) ?? undefined, undefined);
  assert.equal(a.conn.db.demoList.id.find(l) ?? undefined, undefined);
  for (const id of [c, s1, s2]) assert.equal(card(a, id), undefined, `card ${id} deleted`);
  assert.equal(a.conn.db.demoComment.id.find(cm) ?? undefined, undefined);
  assert.ok(!all(a.conn.db.demoCardTag.iter()).some((t) => t.cardId === s2));
  assert.ok(a.conn.db.demoBoard.id.find(keep) && a.conn.db.demoList.id.find(lk) && card(a, ck), 'the other board is untouched');
  assert.ok(a.conn.db.demoMember.id.find(m), 'members are parents, not children');
});

await test('set_null: deleting a member unassigns their cards and keeps the cards', async () => {
  const l = await list(a, await board(a, 'assign'), 'l');
  const m = await member(a, 'lee');
  const c1 = await addCard(a, l, 'c1');
  const c2 = await addCard(a, l, 'c2');
  await a.r.demoAssign({ id: c1, member: m });
  await a.r.demoAssign({ id: c2, member: m });
  const plan = unwrap(await a.p.demoPreviewDelete({ table: 'demo_member', id: m }));
  assert.deepEqual(counts(plan), { demo_member: 1 });
  assert.deepEqual(plan.nulls.map((n) => [n.tableName, n.column, idOf(n.key)]).sort(), [['demo_card', 'assignee', c1], ['demo_card', 'assignee', c2]].sort());
  await a.r.demoDelete({ table: 'demo_member', id: m });
  await sleep(100);
  assert.equal(a.conn.db.demoMember.id.find(m) ?? undefined, undefined);
  assert.equal(card(a, c1)!.assignee, undefined);
  assert.equal(card(a, c2)!.assignee, undefined);
});

await test('restrict: a member with comments can\'t be deleted, and nothing changes (all or nothing)', async () => {
  const l = await list(a, await board(a, 'restrict'), 'l');
  const m = await member(a, 'kim');
  const c1 = await addCard(a, l, 'c1');
  const c2 = await addCard(a, l, 'c2');
  await a.r.demoAssign({ id: c1, member: m });
  const cm1 = await comment(a, c1, m, 'one');
  const cm2 = await comment(a, c2, m, 'two');
  const plan = unwrap(await a.p.demoPreviewDelete({ table: 'demo_member', id: m }));
  assert.deepEqual(plan.blocked.map((b) => idOf(b.key)).sort(), [cm1, cm2].sort());
  assert.equal(plan.blocked[0].parentTable, 'demo_member');
  const e = await a.err(a.r.demoDelete({ table: 'demo_member', id: m }));
  assert.equal(e, `can't delete demo_member ${m}: demo_comment ${plan.blocked[0].key === key(cm1) ? cm1 : cm2} still references demo_member ${m} through author_id (and 1 more)`);
  await sleep(50);
  assert.ok(a.conn.db.demoMember.id.find(m));
  assert.equal(card(a, c1)!.assignee, m, 'the set_null part was not applied either');
  // Once the comments go (with their cards), the member can go.
  await a.r.demoDelete({ table: 'demo_card', id: c1 });
  await a.r.demoDelete({ table: 'demo_card', id: c2 });
  await a.r.demoDelete({ table: 'demo_member', id: m });
  await sleep(50);
  assert.equal(a.conn.db.demoMember.id.find(m) ?? undefined, undefined);
});

await test('cycles: a parent loop is deleted once, without looping', async () => {
  const l = await list(a, await board(a, 'cycle'), 'l');
  const x = await addCard(a, l, 'x');
  const y = await addCard(a, l, 'y', x);
  const z = await addCard(a, l, 'z', y);
  await a.r.demoSetParent({ id: x, parentId: z }); // x -> z -> y -> x
  await sleep(50);
  const plan = unwrap(await a.p.demoPreviewDelete({ table: 'demo_card', id: y }));
  assert.deepEqual(plan.deletes.map((d) => idOf(d.key)).sort(), [x, y, z].sort());
  await a.r.demoDelete({ table: 'demo_card', id: y });
  await sleep(50);
  for (const id of [x, y, z]) assert.equal(card(a, id), undefined);
});

// Old code (or a migration) can write around the checks. Check finds what that broke.
let orphanList = 0n;
let orphanCards: bigint[] = [];
let ghost = 0n;
let assigned = 0n;
let authored = 0n;
let author = 0n;
let dupCard = 0n;

await test('check: admins only; finds orphans of every kind and duplicates', async () => {
  assert.equal(await a.err(eve.p.relationsCheck({})), 'relations_check is for admins');
  assert.equal(await a.err(eve.p.relationsRepair({})), 'relations_repair is for admins');
  await a.r.demoBecomeAdmin({});
  assert.deepEqual(unwrap(await a.p.relationsCheck({})), [], 'clean so far');

  const b = await board(a, 'broken');
  orphanList = await list(a, b, 'goes away');
  orphanCards = [await addCard(a, orphanList, 'o1'), await addCard(a, orphanList, 'o2')];
  const sub = await addCard(a, orphanList, 'o3', orphanCards[0]);
  orphanCards.push(sub);
  await comment(a, orphanCards[0], await member(a, 'commenter'), 'c');
  ghost = await member(a, 'ghost');
  const keep = await list(a, b, 'kept');
  assigned = await addCard(a, keep, 'assigned to the ghost');
  await a.r.demoAssign({ id: assigned, member: ghost });
  author = await member(a, 'author');
  authored = await comment(a, assigned, author, 'by someone who is about to vanish');
  dupCard = await addCard(a, keep, 'dup tags');
  await a.r.demoAddTag({ cardId: dupCard, tag: 'dup' });
  await a.r.demoRawAddTag({ cardId: dupCard, tag: 'dup' });

  await a.r.demoRawDelete({ table: 'demo_list', id: orphanList });
  await a.r.demoRawDelete({ table: 'demo_member', id: ghost });
  await a.r.demoRawDelete({ table: 'demo_member', id: author });
  await sleep(100);

  const v = unwrap(await a.p.relationsCheck({}));
  const orphans = v.filter((x) => x.kind === 0).map((x) => `${x.tableName}.${x.column} ${idOf(x.key)} -> ${x.parentTable} ${idOf(x.parentKey)}`).sort();
  assert.deepEqual(
    orphans,
    [
      ...orphanCards.slice(0, 2).map((c) => `demo_card.list_id ${c} -> demo_list ${orphanList}`),
      `demo_card.list_id ${sub} -> demo_list ${orphanList}`,
      `demo_card.assignee ${assigned} -> demo_member ${ghost}`,
      `demo_comment.author_id ${authored} -> demo_member ${author}`,
    ].sort()
  );
  const dups = v.filter((x) => x.kind === 1);
  assert.equal(dups.length, 1);
  assert.equal(dups[0].tableName, 'demo_card_tag');
  assert.equal(dups[0].column, 'card_id,tag');
  assert.ok(idOf(dups[0].key) > idOf(dups[0].parentKey), 'the later row is the duplicate of the first');
});

await test('repair: cascades and unlinks orphans, reports what it can\'t fix', async () => {
  const report = unwrap(await a.p.relationsRepair({}));
  const deleted = report.deleted.map((d) => `${d.tableName} ${idOf(d.key)}`);
  for (const c of orphanCards) assert.ok(deleted.includes(`demo_card ${c}`), `orphan card ${c} deleted`);
  assert.ok(report.deleted.some((d) => d.tableName === 'demo_comment'), "the orphans' comments went with them");
  assert.deepEqual(report.nulled.map((n) => `${n.tableName}.${n.column} ${idOf(n.key)}`), [`demo_card.assignee ${assigned}`]);
  assert.deepEqual(report.unresolved.map((u) => `${u.kind} ${u.tableName}`).sort(), ['0 demo_comment', '1 demo_card_tag']);
  await sleep(100);
  for (const c of orphanCards) assert.equal(card(a, c), undefined);
  assert.equal(card(a, assigned)!.assignee, undefined);
  assert.ok(a.conn.db.demoComment.id.find(authored), 'restrict orphans are left alone');
  const left = unwrap(await a.p.relationsCheck({}));
  assert.deepEqual(left.map((u) => `${u.kind} ${u.tableName}`).sort(), ['0 demo_comment', '1 demo_card_tag']);
  // Fix the rest by hand: drop the orphaned comment and the duplicate tag.
  await a.r.demoDelete({ table: 'demo_comment', id: authored });
  await a.r.demoDelete({ table: 'demo_card_tag', id: idOf(left.find((u) => u.kind === 1)!.key) });
  assert.deepEqual(unwrap(await a.p.relationsCheck({})), []);
});

await test('pagination: cursors walk a list in pages with no gaps or repeats', async () => {
  const l = await list(a, await board(a, 'paged'), 'long');
  await a.r.demoBenchInsert({ listId: l, count: 120, checked: true });
  const seen: bigint[] = [];
  let after: string | undefined;
  const sizes: number[] = [];
  for (;;) {
    const p = unwrap(await a.p.demoCards({ listId: l, after, limit: 50 }));
    sizes.push(p.items.length);
    seen.push(...p.items.map((c) => c.id));
    assert.ok(p.items.every((c) => c.listId === l));
    if (!p.next) break;
    assert.equal(p.next, key(p.items.at(-1)!.id), 'the cursor is the last key');
    after = p.next;
  }
  assert.deepEqual(sizes, [50, 50, 20]);
  assert.equal(new Set(seen).size, 120);
  assert.deepEqual(seen, [...seen].sort((x, y) => Number(x - y)), 'in key order');
  assert.equal(unwrap(await a.p.demoCards({ listId: l, after: undefined, limit: 0 })).items.length, 50, '0 = default');
  await a.r.demoBenchInsert({ listId: l, count: 450, checked: false });
  assert.equal(unwrap(await a.p.demoCards({ listId: l, after: undefined, limit: 100000 })).items.length, 500, 'capped');
  assert.match((await a.err(a.p.demoCards({ listId: l, after: 'zz', limit: 5 }))) ?? '', /bad hex key/);
});

await test('live pages: each client subscribes to its own page of a list, and it stays current', async () => {
  const l = await list(a, await board(a, 'live'), 'live');
  await a.r.demoBenchInsert({ listId: l, count: 25, checked: true });
  await sleep(100);
  const ids = all(a.conn.db.demoCard.iter()).filter((c) => c.listId === l).map((c) => c.id).sort((x, y) => Number(x - y));
  const page = (c: Client) => all(c.conn.db.demoCardPage.iter()).filter((x) => x.listId === l).map((x) => x.id).sort((x, y) => Number(x - y));
  await a.r.relationsSetPage({ list: `list:${l}`, after: undefined, limit: 10 });
  await eve.r.relationsSetPage({ list: `list:${l}`, after: key(ids[9]), limit: 10 });
  await sleep(150);
  assert.deepEqual(page(a), ids.slice(0, 10));
  assert.deepEqual(page(eve), ids.slice(10, 20), 'pages are per viewer');
  await a.r.relationsSetPage({ list: `list:${l}`, after: key(ids[19]), limit: 10 });
  await sleep(150);
  assert.deepEqual(page(a), ids.slice(20));
  await a.r.demoDelete({ table: 'demo_card', id: ids[21] });
  await a.r.demoAddCard({ listId: l, title: 'new', parentId: undefined });
  await sleep(150);
  const fresh = newest(a.conn.db.demoCard.iter()).id;
  assert.deepEqual(page(a), [...ids.slice(20).filter((i) => i !== ids[21]), fresh], 'live: deletes and inserts show up');
  assert.match((await a.err(a.r.relationsSetPage({ list: 'x', after: 'zz', limit: 1 }))) ?? '', /bad hex key/);
});

await test('live pages stay right when rows land past the page (index scans in a write are out of order)', async () => {
  const l = await list(a, await board(a, 'order'), 'order');
  await a.r.relationsSetPage({ list: `list:${l}`, after: undefined, limit: 3 });
  const made: bigint[] = [];
  for (let i = 0; i < 6; i++) made.push(await addCard(a, l, `o${i}`));
  await a.r.demoBenchInsert({ listId: l, count: 4, checked: true }); // several in one transaction
  await sleep(150);
  const page = all(a.conn.db.demoCardPage.iter()).filter((x) => x.listId === l).map((x) => x.id).sort((x, y) => Number(x - y));
  assert.deepEqual(page, made.slice(0, 3), 'the first three by id, not the newest');
  const again = await client(); // the server's materialized rows, through a new connection
  await again.r.relationsSetPage({ list: `list:${l}`, after: key(made[1]), limit: 3 });
  await sleep(150);
  const p2 = all(again.conn.db.demoCardPage.iter()).filter((x) => x.listId === l).map((x) => x.id).sort((x, y) => Number(x - y));
  assert.deepEqual(p2, made.slice(2, 5));
  again.conn.disconnect();
});

console.log(`\n${passed} passed`);
for (const c of [a, eve]) c.conn.disconnect();
process.exit(0);
