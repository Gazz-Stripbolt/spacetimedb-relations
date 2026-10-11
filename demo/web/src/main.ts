// Demo web client: a kanban board whose deletes cascade, unlink or get blocked, with a delete
// preview, live paged columns, the declared references and an integrity check/repair panel.
// Served by the demo modules at /route/, or open dist/index.html with ?host=ws://...&db=...
import { connect, counts, idOf, key, unwrap, SUBSCRIPTIONS, type Card, type Plan, type TableName } from './api';

const params = new URLSearchParams(location.search);
const routed = location.pathname.match(/\/v1\/database\/([^/]+)\/route/);
const HOST = params.get('host') ?? (routed ? location.origin.replace(/^http/, 'ws') : 'ws://127.0.0.1:3000');
const DB = params.get('db') ?? (routed ? decodeURIComponent(routed[1]) : 'rel-rust');
const TOKEN_KEY = `relations-demo:${HOST}:${DB}`;
const PAGE_SIZE = Number(params.get('page') ?? 5);
const MODES = ['restrict', 'cascade', 'set_null'];
const LABEL: Record<string, [string, string]> = {
  demo_board: ['board', 'boards'],
  demo_list: ['list', 'lists'],
  demo_card: ['card', 'cards'],
  demo_comment: ['comment', 'comments'],
  demo_card_tag: ['tag', 'tags'],
  demo_member: ['member', 'members'],
  subtask: ['subtask', 'subtasks'],
};
const plural = (t: string, n: number) => `${n} ${(LABEL[t] ?? [t, t])[n === 1 ? 0 : 1]}`;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const el = (tag: string, cls = '', text = '') => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};

function storedToken(): string | undefined {
  if (params.has('fresh')) return undefined;
  try {
    return localStorage.getItem(TOKEN_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function toast(text: string) {
  const t = $('toast');
  t.textContent = text;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 4000);
}

async function call(p: Promise<unknown>) {
  try {
    const v = (await p) as { err?: string } | undefined;
    if (v && typeof v === 'object' && 'err' in v) toast(v.err!);
  } catch (e) {
    toast(String((e as Error)?.message ?? e));
  }
}

let session: Awaited<ReturnType<typeof connect>>;
try {
  session = await connect(HOST, DB, storedToken(), () => {
    $('status').textContent = 'disconnected';
    $('status').classList.add('bad');
  });
} catch (e) {
  $('status').textContent = `can't connect: ${e}`;
  $('status').classList.add('bad');
  throw e;
}
const { conn, identity: me } = session;
try {
  localStorage.setItem(TOKEN_KEY, session.token);
} catch {}
$('me').textContent = `you: ${me.toHexString().slice(0, 8)}`;
const db = conn.db;
const r = conn.reducers;
const p = conn.procedures;

// The demo lets everyone run check and repair.
void r.demoBecomeAdmin({});

let board: bigint | undefined;
/** Per list: the cursors of the pages before the current one, so Prev can go back. */
const cursors = new Map<bigint, (string | undefined)[]>();

const sorted = <T extends { id: bigint }>(rows: Iterable<T>) => [...rows].sort((a, b) => Number(a.id - b.id));
const cards = () => sorted(db.demoCard.iter()) as Card[];

// --- Delete with a preview ------------------------------------------------------

async function askDelete(table: TableName, id: bigint, what: string) {
  let plan: Plan;
  try {
    plan = unwrap(await p.demoPreviewDelete({ table, id }));
  } catch (e) {
    toast(String((e as Error).message));
    return;
  }
  const dlg = $<HTMLDialogElement>('confirm');
  $('confirm-title').textContent = `Delete ${what}?`;
  const body = $('confirm-body');
  body.replaceChildren();
  const c = counts(plan);
  c[table]--;
  const also = Object.entries(c).filter(([, n]) => n > 0);
  if (also.length) {
    body.append(el('div', '', 'This also deletes:'));
    const ul = el('ul');
    for (const [t, n] of also) ul.append(el('li', '', plural(t, n)));
    body.append(ul);
  } else if (!plan.blocked.length) {
    body.append(el('div', '', 'Nothing else is affected.'));
  }
  if (plan.nulls.length) {
    const byCol = new Map<string, number>();
    for (const n of plan.nulls) byCol.set(`${n.tableName}.${n.column}`, (byCol.get(`${n.tableName}.${n.column}`) ?? 0) + 1);
    body.append(el('div', '', 'And unlinks:'));
    const ul = el('ul');
    for (const [col, n] of byCol) ul.append(el('li', '', `${plural(col.split('.')[0], n)} (${col.split('.')[1]} set to none)`));
    body.append(ul);
  }
  if (plan.blocked.length) {
    body.append(el('div', 'blocked', `Blocked: ${plural(plan.blocked[0].tableName, plan.blocked.length)} still reference it (restrict).`));
    const ul = el('ul', 'blocked');
    for (const b of plan.blocked.slice(0, 5)) ul.append(el('li', '', `${b.tableName} #${idOf(b.key)} via ${b.column}`));
    body.append(ul);
  }
  $<HTMLButtonElement>('confirm-ok').disabled = plan.blocked.length > 0;
  $('confirm-ok').onclick = () => {
    dlg.close();
    void call(r.demoDelete({ table, id }));
  };
  dlg.showModal();
}
$('confirm-cancel').onclick = () => $<HTMLDialogElement>('confirm').close();

// --- Rendering ------------------------------------------------------------------

function renderNav() {
  const boards = sorted(db.demoBoard.iter());
  if (board === undefined || !db.demoBoard.id.find(board)) board = boards[0]?.id;
  const lists = [...db.demoList.iter()];
  $('boards').replaceChildren(
    ...boards.map((b) => {
      const it = el('div', `item${b.id === board ? ' sel' : ''}`);
      it.dataset.id = String(b.id);
      it.append(el('span', '', b.name), el('span', 'n', String(lists.filter((l) => l.boardId === b.id).length)));
      const x = el('button', 'x', '×');
      x.title = 'Delete board';
      x.onclick = (e) => {
        e.stopPropagation();
        void askDelete('demo_board', b.id, `board “${b.name}”`);
      };
      it.append(x);
      it.onclick = () => {
        board = b.id;
        render();
      };
      return it;
    })
  );
  const all = cards();
  $('members').replaceChildren(
    ...sorted(db.demoMember.iter()).map((m) => {
      const it = el('div', 'item');
      it.dataset.id = String(m.id);
      it.append(el('span', '', m.name), el('span', 'n', `${all.filter((c) => c.assignee === m.id).length} assigned`));
      const x = el('button', 'x', '×');
      x.title = 'Delete member';
      x.onclick = () => void askDelete('demo_member', m.id, `member “${m.name}”`);
      it.append(x);
      return it;
    })
  );
}

function setPage(listId: bigint, after: string | undefined) {
  void call(r.relationsSetPage({ list: `list:${listId}`, after, limit: PAGE_SIZE }));
}

/** One column per list, kept across renders so a half-typed card title survives live updates. */
type Column = { root: HTMLElement; name: HTMLElement; count: HTMLElement; cards: HTMLElement; pager: HTMLElement };
const columns = new Map<bigint, Column>();

function makeColumn(listId: bigint): Column {
  const root = el('div', 'column');
  root.dataset.id = String(listId);
  const head = el('div', 'head');
  const name = el('span');
  const count = el('span', 'n');
  const x = el('button', 'x', '×');
  x.title = 'Delete list';
  x.onclick = () => void askDelete('demo_list', listId, `list “${name.textContent}”`);
  head.append(name, count, x);
  const cards = el('div');
  cards.style.cssText = 'display:flex;flex-direction:column;gap:8px';
  const pager = el('div', 'pager');
  const form = el('form', 'add') as HTMLFormElement;
  form.innerHTML = '<input name="title" placeholder="New card" maxlength="80" required><button class="btn small">Add</button>';
  form.onsubmit = (e) => {
    e.preventDefault();
    const input = form.elements.namedItem('title') as HTMLInputElement;
    void call(r.demoAddCard({ listId, title: input.value, parentId: undefined }));
    input.value = '';
  };
  root.append(head, cards, pager, form);
  cursors.set(listId, []);
  setPage(listId, undefined);
  return { root, name, count, cards, pager };
}

function renderColumns() {
  const b = board === undefined ? undefined : db.demoBoard.id.find(board);
  $('board-name').textContent = b ? b.name : '';
  $('add-list').hidden = !b;
  const cols = $('columns');
  const lists = b ? sorted(db.demoList.iter()).filter((l) => l.boardId === b.id) : [];
  for (const [id, c] of columns) {
    if (!lists.some((l) => l.id === id)) {
      c.root.remove();
      columns.delete(id);
      cursors.delete(id);
    }
  }
  cols.querySelector('.empty')?.remove();
  if (!b) {
    cols.append(el('div', 'empty', 'Add a board to start.'));
    return;
  }
  const all = cards();
  const members = sorted(db.demoMember.iter());
  const comments = [...db.demoComment.iter()];
  const tags = [...db.demoCardTag.iter()];
  const paged = [...db.demoCardPage.iter()] as Card[];
  lists.forEach((l, i) => {
    let col = columns.get(l.id);
    if (!col) columns.set(l.id, (col = makeColumn(l.id)));
    if (cols.children[i] !== col.root) cols.insertBefore(col.root, cols.children[i] ?? null);
    col.name.textContent = l.name;
    const total = all.filter((c) => c.listId === l.id).length;
    col.count.textContent = plural('demo_card', total);
    const mine = paged.filter((c) => c.listId === l.id).sort((a, c) => Number(a.id - c.id));
    col.cards.replaceChildren(...mine.map((c) => cardEl(c, all, members, comments, tags)));
    if (total === 0) col.cards.append(el('div', 'hint', 'No cards yet.'));
    // Pager: Prev pops a cursor, Next pushes the last key of this page.
    const stack = cursors.get(l.id)!;
    col.pager.replaceChildren();
    col.pager.hidden = !(stack.length || total > PAGE_SIZE);
    const prev = el('button', 'btn small', 'Prev') as HTMLButtonElement;
    prev.disabled = stack.length === 0;
    prev.onclick = () => {
      stack.pop();
      setPage(l.id, stack.at(-1));
    };
    const next = el('button', 'btn small', 'Next') as HTMLButtonElement;
    const last = mine.at(-1);
    next.disabled = !last || !all.some((c) => c.listId === l.id && c.id > last.id);
    next.onclick = () => {
      stack.push(key(last!.id));
      setPage(l.id, stack.at(-1));
    };
    col.pager.append(prev, el('span', 'grow', `page ${stack.length + 1}`), next);
  });
}

function cardEl(c: Card, all: Card[], members: { id: bigint; name: string }[], comments: { cardId: bigint }[], tags: { cardId: bigint; tag: string }[]) {
  const box = el('div', 'card');
  box.dataset.id = String(c.id);
  const t = el('div', 't');
  t.append(el('span', 'id', `#${c.id}`), el('span', '', c.title));
  box.append(t);
  const meta = el('div', 'meta');
  if (c.parentId !== undefined) meta.append(el('span', 'chip parent', `subtask of #${c.parentId}`));
  const subs = all.filter((x) => x.parentId === c.id).length;
  if (subs) meta.append(el('span', 'chip', plural('subtask', subs)));
  const n = comments.filter((x) => x.cardId === c.id).length;
  if (n) meta.append(el('span', 'chip', plural('demo_comment', n)));
  for (const tg of tags.filter((x) => x.cardId === c.id)) meta.append(el('span', 'chip', `#${tg.tag}`));
  const sel = el('select') as HTMLSelectElement;
  sel.title = 'Assignee';
  sel.append(new Option('unassigned', ''));
  for (const m of members) sel.append(new Option(m.name, String(m.id), false, c.assignee === m.id));
  sel.onchange = () => void call(r.demoAssign({ id: c.id, member: sel.value ? BigInt(sel.value) : undefined }));
  meta.append(sel);
  box.append(meta);
  const actions = el('div', 'meta');
  const sub = el('button', 'btn small', '+ subtask');
  sub.onclick = () => {
    const title = prompt('Subtask title');
    if (title) void call(r.demoAddCard({ listId: c.listId, title, parentId: c.id }));
  };
  const com = el('button', 'btn small', '+ comment');
  com.onclick = () => {
    const author = c.assignee ?? members[0]?.id;
    if (author === undefined) return toast('Add a member first: comments need an author.');
    const text = prompt(`Comment as ${members.find((m) => m.id === author)?.name}`);
    if (text) void call(r.demoAddComment({ cardId: c.id, authorId: author, text }));
  };
  const tag = el('button', 'btn small', '+ tag');
  tag.onclick = () => {
    const name = prompt('Tag');
    if (name) void call(r.demoAddTag({ cardId: c.id, tag: name }));
  };
  const del = el('button', 'btn small danger', 'Delete');
  del.onclick = () => void askDelete('demo_card', c.id, `card #${c.id}`);
  actions.append(sub, com, tag, del);
  box.append(actions);
  return box;
}

function renderSchema() {
  let fks: { childTable: string; childColumn: string; parentTable: string; onDelete: number; nullable: boolean }[] = [];
  try {
    fks = [...db.relationsFk.iter()];
  } catch {}
  $('schema').replaceChildren(
    ...(fks.length
      ? fks.map((f) => {
          const row = el('div', 'rel');
          row.append(el('span', '', `${f.childTable}.${f.childColumn}${f.nullable ? '?' : ''} → ${f.parentTable}`));
          row.append(el('span', `mode ${MODES[f.onDelete]}`, MODES[f.onDelete]));
          return row;
        })
      : [el('div', 'hint', 'Not subscribed (the TypeScript submodule namespaces this table).')])
  );
}

function render() {
  renderNav();
  renderColumns();
  renderSchema();
}

// --- Integrity panel -------------------------------------------------------------

async function check() {
  const out = $('violations');
  try {
    const v = unwrap(await p.relationsCheck({}));
    out.replaceChildren(
      ...(v.length
        ? v.map((x) =>
            el(
              'div',
              'v',
              x.kind === 0
                ? `orphan: ${x.tableName} #${idOf(x.key)}: ${x.column} → missing ${x.parentTable} #${idOf(x.parentKey)}`
                : `duplicate: ${x.tableName} #${idOf(x.key)} repeats (${x.column}) of #${idOf(x.parentKey)}`
            )
          )
        : [el('div', 'v ok', 'No orphans or duplicates.')])
    );
  } catch (e) {
    toast(String((e as Error).message));
  }
}

$('check').onclick = () => void check();
$('repair').onclick = async () => {
  try {
    const rep = unwrap(await p.relationsRepair({}));
    toast(`Repair: deleted ${rep.deleted.length}, unlinked ${rep.nulled.length}, left ${rep.unresolved.length} for you`);
    await check();
  } catch (e) {
    toast(String((e as Error).message));
  }
};
$('break-list').onclick = async () => {
  const l = sorted(db.demoList.iter()).filter((x) => x.boardId === board).at(-1);
  if (!l) return toast('No list on this board to break.');
  await call(r.demoRawDelete({ table: 'demo_list', id: l.id }));
  await check();
};
$('break-member').onclick = async () => {
  const m = sorted(db.demoMember.iter()).at(-1);
  if (!m) return toast('No member to break.');
  await call(r.demoRawDelete({ table: 'demo_member', id: m.id }));
  await check();
};

for (const [form, fn] of [
  ['add-board', (name: string) => r.demoAddBoard({ name })],
  ['add-member', (name: string) => r.demoAddMember({ name })],
  ['add-list', (name: string) => (board === undefined ? Promise.resolve() : r.demoAddList({ boardId: board, name }))],
] as const) {
  const f = $<HTMLFormElement>(form);
  f.onsubmit = (e) => {
    e.preventDefault();
    const input = f.elements.namedItem('name') as HTMLInputElement;
    void call(fn(input.value));
    input.value = '';
  };
}

let queued = false;
const schedule = () => {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    render();
  });
};
for (const t of [db.demoBoard, db.demoList, db.demoCard, db.demoComment, db.demoCardTag, db.demoMember, db.demoCardPage] as const) {
  (t as { onInsert(cb: () => void): void }).onInsert(schedule);
  (t as { onDelete(cb: () => void): void }).onDelete(schedule);
  (t as { onUpdate?(cb: () => void): void }).onUpdate?.(schedule);
}
db.relationsFk.onInsert(schedule);

conn
  .subscriptionBuilder()
  .onApplied(() => {
    $('status').textContent = 'connected';
    render();
  })
  .onError(() => {
    $('status').textContent = 'subscription failed';
    $('status').classList.add('bad');
  })
  .subscribe(SUBSCRIPTIONS);
// Separately, so a module that names it differently still gets the board.
conn.subscriptionBuilder().onApplied(schedule).onError(() => {}).subscribe(['SELECT * FROM relations_fk']);
