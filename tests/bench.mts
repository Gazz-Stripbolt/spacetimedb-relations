// What the checks cost: checked vs raw inserts, a big cascade, and a page of a long list.
//
//   DB=rel-rust npx tsx tests/bench.mts
import { connect, unwrap } from '../demo/web/src/api.ts';

const HOST = process.env.HOST ?? 'ws://127.0.0.1:3000';
const DB = process.env.DB ?? 'rel-rust';
const N = Number(process.env.N ?? 2000);
const ROUNDS = 5;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const { conn } = await connect(HOST, DB);
await new Promise<void>((res) => conn.subscriptionBuilder().onApplied(() => res()).subscribe(['SELECT * FROM demo_board', 'SELECT * FROM demo_list']));
const r = conn.reducers;
const newest = <T extends { id: bigint }>(rows: Iterable<T>) => [...rows].sort((a, b) => Number(b.id - a.id))[0].id;

await r.demoAddBoard({ name: 'bench' });
await sleep(150);
const board = newest(conn.db.demoBoard.iter());
async function freshList() {
  await r.demoAddList({ boardId: board, name: 'bench' });
  await sleep(100);
  return newest(conn.db.demoList.iter());
}

const median = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
async function timeInserts(checked: boolean) {
  const runs: number[] = [];
  for (let i = 0; i < ROUNDS; i++) {
    const listId = await freshList();
    const t0 = performance.now();
    await r.demoBenchInsert({ listId, count: N, checked });
    runs.push(performance.now() - t0);
  }
  return median(runs);
}
await timeInserts(true); // warm up
const raw = await timeInserts(false);
const checked = await timeInserts(true);

const deletes: number[] = [];
const pages: number[] = [];
for (let i = 0; i < ROUNDS; i++) {
  const listId = await freshList();
  await r.demoBenchInsert({ listId, count: N, checked: false });
  let t0 = performance.now();
  unwrap(await conn.procedures.demoCards({ listId, after: undefined, limit: 50 }));
  pages.push(performance.now() - t0);
  t0 = performance.now();
  await r.demoDelete({ table: 'demo_list', id: listId });
  deletes.push(performance.now() - t0);
}
const del = median(deletes);
const page = median(pages);

const us = (ms: number) => ((ms * 1000) / N).toFixed(2);
console.log(`${DB}: ${N} rows per call (median of ${ROUNDS})`);
console.log(`  raw insert       ${raw.toFixed(1)} ms  (${us(raw)} µs/row)`);
console.log(`  checked insert   ${checked.toFixed(1)} ms  (${us(checked)} µs/row, +${us(checked - raw)} µs for the reference check)`);
console.log(`  cascade delete   ${del.toFixed(1)} ms  (a list with ${N} cards: ${us(del)} µs/row, plan + apply)`);
console.log(`  first page of 50 ${page.toFixed(1)} ms  (reads all ${N} cards of the list, see FINDINGS)`);
conn.disconnect();
process.exit(0);
