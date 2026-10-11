/**
 * # spacetimedb-relations: foreign keys, cascades, multi-column unique and pagination, as a submodule
 *
 * The TypeScript twin of `rust/relations.rs` and `csharp/Relations.cs`. Same result types, the
 * same hex-of-BSATN keys and the same error texts, so the same clients work against all three.
 *
 * A submodule can't touch its consumer's tables, so the consumer registers them with `table()`,
 * declares `reference()` and `unique()` rules, and defines the client-facing procedures and
 * reducer as thin wrappers (see README.md). The submodule's own tables live under the consumer's
 * namespace, e.g. `relations.fk`.
 */
import { schema, table as stdbTable, t, SenderError } from 'spacetimedb/server';
import type { Infer, ReducerCtx } from 'spacetimedb/server';
import { AlgebraicType, BinaryReader, BinaryWriter, type Identity } from 'spacetimedb';

// ---------------------------------------------------------------------------
// Constants (as in Rust)
// ---------------------------------------------------------------------------

/** On delete of the parent: refuse while children exist. */
export const RESTRICT = 0;
/** On delete of the parent: delete the children too (recursively). */
export const CASCADE = 1;
/** On delete of the parent: set the child's column to none. */
export const SET_NULL = 2;

export const VIOLATION_ORPHAN = 0;
export const VIOLATION_DUPLICATE = 1;

export const DEFAULT_PAGE = 50;
export const MAX_PAGE = 500;

// ---------------------------------------------------------------------------
// Result types (names and field order match Rust and C#, so BSATN matches)
// ---------------------------------------------------------------------------

/** A row, by table and key (hex of the key's BSATN). */
export const RowRef = t.object('RowRef', { tableName: t.string(), key: t.string() });
export type RowRef = Infer<typeof RowRef>;

/** A child row whose reference column would be set to none. */
export const NullRef = t.object('NullRef', { tableName: t.string(), column: t.string(), key: t.string() });
export type NullRef = Infer<typeof NullRef>;

/** A child row that blocks the delete (`restrict`). */
export const Blocker = t.object('Blocker', {
  tableName: t.string(),
  column: t.string(),
  key: t.string(),
  parentTable: t.string(),
  parentKey: t.string(),
});
export type Blocker = Infer<typeof Blocker>;

/** What deleting a row does. `deletes[0]` is the row itself; the rest are cascades. */
export const DeletePlan = t.object('DeletePlan', {
  deletes: t.array(RowRef),
  nulls: t.array(NullRef),
  blocked: t.array(Blocker),
});
export type DeletePlan = Infer<typeof DeletePlan>;

/**
 * A rule existing data breaks. Orphan: `tableName.column` points at a missing `parentTable` row.
 * Duplicate: another row has the same values in the unique columns (`column` = them joined by ",").
 */
export const Violation = t.object('Violation', {
  kind: t.u8(),
  tableName: t.string(),
  column: t.string(),
  key: t.string(),
  parentTable: t.string(),
  parentKey: t.string(),
});
export type Violation = Infer<typeof Violation>;

export const RepairReport = t.object('RepairReport', {
  deleted: t.array(RowRef),
  nulled: t.array(NullRef),
  /** What repair can't fix: orphans under `restrict` and duplicates (pick one yourself). */
  unresolved: t.array(Violation),
});
export type RepairReport = Infer<typeof RepairReport>;

// ---------------------------------------------------------------------------
// Tables (under the consumer's namespace)
// ---------------------------------------------------------------------------

/** The declared references, for clients and tools. Rewritten by `configure`. */
const fk = stdbTable(
  { name: 'fk', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    childTable: t.string(),
    childColumn: t.string(),
    parentTable: t.string(),
    onDelete: t.u8(),
    nullable: t.bool(),
    indexed: t.bool(),
  }
);

/** The declared multi-column unique constraints. Rewritten by `configure`. */
const unique_ = stdbTable(
  { name: 'unique', public: true },
  { id: t.u64().primaryKey().autoInc(), tableName: t.string(), columns: t.array(t.string()) }
);

/** Who may run check / repair (the publisher, after `configure`). */
const admin = stdbTable({ name: 'admin' }, { identity: t.identity().primaryKey() });

/** Each client's position in each paged list (see `pageState`). */
const page_ = stdbTable(
  { name: 'page', indexes: [{ accessor: 'byOwnerList', algorithm: 'btree', columns: ['owner', 'list'] }] },
  {
    id: t.u64().primaryKey().autoInc(),
    owner: t.identity().index('btree'),
    list: t.string(),
    /** Hex BSATN of the last key of the previous page. None: the first page. */
    after: t.option(t.string()),
    limit: t.u32(),
  }
);

const spacetimedb = schema({ fk, unique: unique_, admin, page: page_ });
export default spacetimedb;

/** A context narrowed to this submodule: `ctx.as.relations` (or whatever you named it). */
export type RelationsCtx = ReducerCtx<typeof spacetimedb.schemaType>;
type RelationsDb = RelationsCtx['db'];

/** Your module's context, as relations sees it. */
export interface HostCtx {
  sender: Identity;
  databaseIdentity: Identity;
}

let scopeOf: (ctx: any) => RelationsCtx = () => {
  throw new Error('call relations.setup({ scope: (ctx) => ctx.as.relations }) first');
};
let viewDbOf: (ctx: any) => RelationsDb = (ctx) => ctx.db.relations;

/**
 * Tell relations how to reach its own tables from your context: `(ctx) => ctx.as.relations`.
 * `viewDb` does the same for a view's context (default `(ctx) => ctx.db.relations`).
 */
export function setup<C>(opts: { scope: (ctx: C) => RelationsCtx; viewDb?: (ctx: any) => RelationsDb }): void {
  scopeOf = opts.scope;
  if (opts.viewDb) viewDbOf = opts.viewDb;
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

/** Anything with an `algebraicType`: a table's `rowType`, or a type builder like `t.u64()`. */
export interface Typed<T> {
  algebraicType: unknown;
  readonly type?: T;
}

// Use the `spacetimedb` entry point's AlgebraicType and BinaryReader/Writer: `spacetimedb/server`'s
// builders reject a reader from the other entry point (see FINDINGS).
const serializers = new WeakMap<object, (w: BinaryWriter, v: any) => void>();
const deserializers = new WeakMap<object, (r: BinaryReader) => any>();

export function encode<T>(ty: Typed<T>, value: T): Uint8Array {
  let ser = serializers.get(ty);
  if (!ser) serializers.set(ty, (ser = AlgebraicType.makeSerializer(ty.algebraicType as any)));
  const w = new BinaryWriter(16);
  ser(w, value);
  return w.getBuffer();
}

export function decode<T>(ty: Typed<T>, bytes: Uint8Array): T {
  let de = deserializers.get(ty);
  if (!de) deserializers.set(ty, (de = AlgebraicType.makeDeserializer(ty.algebraicType as any)));
  try {
    return de(new BinaryReader(bytes));
  } catch (e) {
    throw new SenderError(`bad key: ${(e as Error)?.message ?? e}`);
  }
}

export const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

export function unhex(s: string): Uint8Array {
  if (s.length % 2 || !/^[0-9a-fA-F]*$/.test(s)) throw new SenderError('bad hex key');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** A key value as error messages show it: numbers plain, strings quoted (like Rust's `{:?}`). */
function showValue(v: unknown): string {
  if (typeof v === 'bigint' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'string') return JSON.stringify(v);
  if (v && typeof (v as any).toHexString === 'function') return (v as any).toHexString();
  return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
}

/**
 * Order two key values the way SpacetimeDB orders them: numbers and bigints numerically, strings
 * by code unit, identities by value, options with none first, arrays/tuples element-wise. (BSATN
 * bytes don't sort: integers are little-endian.)
 */
export function compareKeys(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === undefined || a === null) return -1;
  if (b === undefined || b === null) return 1;
  if ((typeof a === 'bigint' || typeof a === 'number') && (typeof b === 'bigint' || typeof b === 'number')) {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  const big = (v: any) => v?.__identity__ ?? v?.__connection_id__ ?? v?.__timestamp_micros_since_unix_epoch__;
  if (big(a) !== undefined && big(b) !== undefined) return compareKeys(big(a), big(b));
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const c = compareKeys(a[i], b[i]);
      if (c) return c;
    }
    return a.length - b.length;
  }
  const sa = showValue(a);
  const sb = showValue(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------

/** What `table()` needs to know about one of your tables. `C` is your module's context type. */
export interface TableSpec<C, Row, Key> {
  /** The table's canonical name, e.g. `demo_card`. */
  name: string;
  /** The primary key's type builder, e.g. `t.u64()`. */
  key: Typed<Key>;
  keyOf: (row: Row) => Key;
  find: (ctx: C, key: Key) => Row | null | undefined;
  insert: (ctx: C, row: Row) => Row;
  update: (ctx: C, row: Row) => Row;
  delete: (ctx: C, key: Key) => unknown;
  iter: (ctx: C) => Iterable<Row>;
}

/** A reference `child.column -> parent`. Declare it after both tables. */
export interface ReferenceSpec<C, Row, Key> {
  child: string;
  column: string;
  parent: string;
  /** RESTRICT, CASCADE or SET_NULL. */
  onDelete: number;
  /** The column is an `option` (required by SET_NULL). */
  nullable?: boolean;
  /** The parent key this row points at, or undefined/null for none. */
  get: (row: Row) => Key | null | undefined;
  /** The row with the column set to none (SET_NULL). */
  setNull?: (row: Row) => Row;
  /** The child rows pointing at `key`, through a btree index on the column. Without it, deletes scan the child table. */
  children?: (ctx: C, key: Key) => Iterable<Row>;
}

/** A multi-column unique constraint, checked through a btree index on exactly those columns. */
export interface UniqueSpec<C, Row> {
  table: string;
  columns: string[];
  /** The index's name, for the schema description. */
  index: string;
  /** The rows with the same values in `columns` as `row` (including itself, if stored). */
  matches: (ctx: C, row: Row) => Iterable<Row>;
}

/** Checked writes for one table. */
export interface Checked<C, Row, Key> {
  /** Insert after checking references and unique constraints. Returns the inserted row. */
  insert(ctx: C, row: Row): Row;
  /** Update by primary key after checking references and unique constraints. */
  update(ctx: C, row: Row): Row;
  /** Insert or update by primary key, checked. */
  upsert(ctx: C, row: Row): Row;
  /** Delete with cascades, all or nothing. Throws if a `restrict` reference blocks it. */
  delete(ctx: C, key: Key): DeletePlan;
  /** What `delete` would do, without doing it. */
  previewDelete(ctx: C, key: Key): DeletePlan;
}

interface RegTable {
  name: string;
  key: Typed<any>;
  keyBytes(row: any): Uint8Array;
  keyOf(row: any): unknown;
  find(ctx: any, key: Uint8Array): any;
  rawUpdate(ctx: any, row: any): void;
  rawDelete(ctx: any, key: Uint8Array): boolean;
  iter(ctx: any): Iterable<any>;
}

interface RegRef {
  child: string;
  column: string;
  parent: string;
  onDelete: number;
  nullable: boolean;
  indexed: boolean;
  get(row: any): unknown;
  setNull?(row: any): any;
  children?(ctx: any, key: any): Iterable<any>;
}

interface RegUnique {
  table: string;
  columns: string[];
  index: string;
  matches(ctx: any, row: any): Iterable<any>;
}

const tables = new Map<string, RegTable>();
const refs: RegRef[] = [];
const uniques: RegUnique[] = [];

function tableNamed(name: string): RegTable {
  const t = tables.get(name);
  if (!t) throw new SenderError(`${name} isn't declared in relations`);
  return t;
}

/** A key, for error messages: the decoded key (hex if it doesn't decode). */
function show(table: string, key: Uint8Array): string {
  const t = tables.get(table);
  if (!t) return hex(key);
  try {
    return showValue(decode(t.key, key));
  } catch {
    return hex(key);
  }
}

/** Register one of your tables and get checked writes for it. Call at module load. */
export function table<C extends HostCtx, Row, Key>(spec: TableSpec<C, Row, Key>): Checked<C, Row, Key> {
  const keyBytes = (k: Key) => encode(spec.key, k);
  tables.set(spec.name, {
    name: spec.name,
    key: spec.key,
    keyBytes: (row) => keyBytes(spec.keyOf(row)),
    keyOf: (row) => spec.keyOf(row),
    find: (ctx, k) => spec.find(ctx, decode(spec.key, k)) ?? undefined,
    rawUpdate: (ctx, row) => void spec.update(ctx, row),
    rawDelete: (ctx, k) => {
      const key = decode(spec.key, k);
      if (!spec.find(ctx, key)) return false;
      spec.delete(ctx, key);
      return true;
    },
    iter: (ctx) => spec.iter(ctx),
  });
  const api: Checked<C, Row, Key> = {
    insert(ctx, row) {
      checkRefs(ctx, spec.name, row);
      checkUnique(ctx, spec.name, row, false);
      try {
        return spec.insert(ctx, row);
      } catch (e) {
        throw new SenderError(`${spec.name}: ${(e as Error)?.message ?? e}`);
      }
    },
    update(ctx, row) {
      const k = spec.keyOf(row);
      if (!spec.find(ctx, k)) throw new SenderError(`${spec.name} ${showValue(k)}: no such row`);
      checkRefs(ctx, spec.name, row);
      checkUnique(ctx, spec.name, row, true);
      return spec.update(ctx, row);
    },
    upsert(ctx, row) {
      return spec.find(ctx, spec.keyOf(row)) ? api.update(ctx, row) : api.insert(ctx, row);
    },
    delete(ctx, key) {
      return deleteRow(ctx, spec.name, keyBytes(key));
    },
    previewDelete(ctx, key) {
      return planDelete(ctx, spec.name, keyBytes(key));
    },
  };
  return api;
}

/** Declare a reference `child.column -> parent`. Call at module load, after `table()` for both. */
export function reference<C extends HostCtx, Row, Key>(spec: ReferenceSpec<C, Row, Key>): void {
  const nullable = !!spec.nullable;
  if (![RESTRICT, CASCADE, SET_NULL].includes(spec.onDelete)) {
    throw new Error(`${spec.child}.${spec.column}: unknown on-delete mode ${spec.onDelete}: use RESTRICT, CASCADE or SET_NULL`);
  }
  if (spec.onDelete === SET_NULL && (!nullable || !spec.setNull)) {
    throw new Error(`${spec.child}.${spec.column}: SET_NULL needs a nullable column and setNull`);
  }
  if (nullable && spec.children) {
    throw new Error(`${spec.child}.${spec.column}: children (an index) needs a non-nullable column: option columns can't be index-filtered`);
  }
  refs.push({
    child: spec.child,
    column: spec.column,
    parent: spec.parent,
    onDelete: spec.onDelete,
    nullable,
    indexed: !!spec.children,
    get: spec.get as (row: any) => unknown,
    setNull: spec.setNull as ((row: any) => any) | undefined,
    children: spec.children as ((ctx: any, key: any) => Iterable<any>) | undefined,
  });
}

/** Declare a multi-column unique constraint. Call at module load. */
export function unique<C extends HostCtx, Row>(spec: UniqueSpec<C, Row>): void {
  uniques.push({ table: spec.table, columns: spec.columns, index: spec.index, matches: spec.matches as any });
}

function checkRefs(ctx: unknown, table: string, row: unknown): void {
  for (const r of refs) {
    if (r.child !== table) continue;
    const k = r.get(row);
    if (k === undefined || k === null) continue;
    const parent = tableNamed(r.parent);
    if (!parent.find(ctx, encode(parent.key, k))) {
      throw new SenderError(`${r.child}.${r.column} = ${showValue(k)}: no such ${r.parent}`);
    }
  }
}

function checkUnique(ctx: unknown, table: string, row: unknown, updating: boolean): void {
  const t = tables.get(table);
  for (const u of uniques) {
    if (u.table !== table) continue;
    const mine = updating && t ? hex(t.keyBytes(row)) : undefined;
    for (const o of u.matches(ctx, row)) {
      if (!updating || !t || hex(t.keyBytes(o)) !== mine) {
        throw new SenderError(`${table}: another row already has this (${u.columns.join(', ')})`);
      }
    }
  }
}

/**
 * The children of reference `r` pointing at any of `parentKeys` (BSATN), as (parent key, child
 * key) pairs. Indexed: one index lookup per key. Otherwise: one scan of the child table.
 */
function childrenOf(ctx: unknown, r: RegRef, parentKeys: Uint8Array[]): [Uint8Array, Uint8Array][] {
  const child = tableNamed(r.child);
  const parent = tableNamed(r.parent);
  const out: [Uint8Array, Uint8Array][] = [];
  if (r.children) {
    for (const pk of parentKeys) {
      for (const row of r.children(ctx, decode(parent.key, pk))) out.push([pk, child.keyBytes(row)]);
    }
    return out;
  }
  const wanted = new Map(parentKeys.map((k) => [hex(k), k]));
  for (const row of child.iter(ctx)) {
    const v = r.get(row);
    if (v === undefined || v === null) continue;
    const pk = wanted.get(hex(encode(parent.key, v)));
    if (pk) out.push([pk, child.keyBytes(row)]);
  }
  return out;
}

function setNull(ctx: unknown, table: string, column: string, key: Uint8Array): void {
  const r = refs.find((x) => x.child === table && x.column === column);
  if (!r) throw new SenderError(`${table}.${column} isn't a declared reference`);
  if (!r.nullable || !r.setNull) throw new SenderError(`${table}.${column} isn't nullable`);
  const t = tableNamed(table);
  const row = t.find(ctx, key);
  if (!row) return;
  t.rawUpdate(ctx, r.setNull(row));
}

// ---------------------------------------------------------------------------
// Library API: pass your module's ctx
// ---------------------------------------------------------------------------

/**
 * Call from `init`: publishes the schema description and makes the caller (the publisher) an
 * admin. Safe to call again.
 */
export function configure(ctx: HostCtx): void {
  const h = scopeOf(ctx);
  for (const r of [...h.db.fk.iter()]) h.db.fk.id.delete(r.id);
  for (const r of refs) {
    h.db.fk.insert({
      id: 0n,
      childTable: r.child,
      childColumn: r.column,
      parentTable: r.parent,
      onDelete: r.onDelete,
      nullable: r.nullable,
      indexed: r.indexed,
    });
  }
  for (const r of [...h.db.unique.iter()]) h.db.unique.id.delete(r.id);
  for (const u of uniques) h.db.unique.insert({ id: 0n, tableName: u.table, columns: u.columns });
  addAdmin(ctx, ctx.sender);
}

export function addAdmin(ctx: HostCtx, who: Identity): void {
  const h = scopeOf(ctx);
  if (!h.db.admin.identity.find(who)) h.db.admin.insert({ identity: who });
}

export function removeAdmin(ctx: HostCtx, who: Identity): void {
  scopeOf(ctx).db.admin.identity.delete(who);
}

export function isAdmin(ctx: HostCtx, who: Identity): boolean {
  return who.isEqual(ctx.databaseIdentity) || !!scopeOf(ctx).db.admin.identity.find(who);
}

/** Whether `table`/`key` (BSATN) exists. */
export function exists(ctx: HostCtx, table: string, key: Uint8Array): boolean {
  return !!tableNamed(table).find(ctx, key);
}

/** Delete straight through the table handle: no cascades, no checks. For tests and migrations. */
export function rawDelete(ctx: HostCtx, table: string, key: Uint8Array): boolean {
  return tableNamed(table).rawDelete(ctx, key);
}

/** What deleting `table`/`key` (BSATN) would do. Reads only. */
export function planDelete(ctx: HostCtx, table: string, key: Uint8Array): DeletePlan {
  if (!exists(ctx, table, key)) throw new SenderError(`${table} ${show(table, key)}: no such row`);
  const id = (t: string, k: Uint8Array) => `${t}\u0000${hex(k)}`;
  const seen = new Set<string>([id(table, key)]);
  const order: [string, Uint8Array][] = [[table, key]];
  const nulls: [string, string, Uint8Array][] = [];
  const restricts: [string, string, Uint8Array, string, Uint8Array][] = [];
  // Breadth first, one level at a time, so a reference without an index is scanned once per
  // level rather than once per row.
  let frontier: [string, Uint8Array][] = [[table, key]];
  while (frontier.length) {
    const byTable = new Map<string, Uint8Array[]>();
    for (const [t, k] of frontier) {
      const keys = byTable.get(t);
      if (keys) keys.push(k);
      else byTable.set(t, [k]);
    }
    frontier = [];
    for (const [t, keys] of byTable) {
      for (const r of refs) {
        if (r.parent !== t) continue;
        for (const [pk, ck] of childrenOf(ctx, r, keys)) {
          if (r.onDelete === CASCADE) {
            if (!seen.has(id(r.child, ck))) {
              seen.add(id(r.child, ck));
              order.push([r.child, ck]);
              frontier.push([r.child, ck]);
            }
          } else if (r.onDelete === SET_NULL) nulls.push([r.child, r.column, ck]);
          else restricts.push([r.child, r.column, ck, t, pk]);
        }
      }
    }
  }
  // A child that's deleted anyway neither needs unlinking nor blocks anything.
  const plan: DeletePlan = { deletes: order.map(([t, k]) => ({ tableName: t, key: hex(k) })), nulls: [], blocked: [] };
  const nulled = new Set<string>();
  for (const [t, c, k] of nulls) {
    const n = `${t}\u0000${c}\u0000${hex(k)}`;
    if (!seen.has(id(t, k)) && !nulled.has(n)) {
      nulled.add(n);
      plan.nulls.push({ tableName: t, column: c, key: hex(k) });
    }
  }
  for (const [t, c, k, pt, pk] of restricts) {
    if (!seen.has(id(t, k))) plan.blocked.push({ tableName: t, column: c, key: hex(k), parentTable: pt, parentKey: hex(pk) });
  }
  return plan;
}

/**
 * Delete `table`/`key` (BSATN) with every cascade, all or nothing. Throws (nothing changes) if
 * a `restrict` reference blocks it. Returns what was done. (Rust: `relations::delete`.)
 */
export function deleteRow(ctx: HostCtx, table: string, key: Uint8Array): DeletePlan {
  const plan = planDelete(ctx, table, key);
  const b = plan.blocked[0];
  if (b) {
    const more = plan.blocked.length > 1 ? ` (and ${plan.blocked.length - 1} more)` : '';
    const showHex = (t: string, k: string) => {
      try {
        return show(t, unhex(k));
      } catch {
        return k;
      }
    };
    throw new SenderError(
      `can't delete ${table} ${show(table, key)}: ${b.tableName} ${showHex(b.tableName, b.key)} still references ` +
        `${b.parentTable} ${showHex(b.parentTable, b.parentKey)} through ${b.column}${more}`
    );
  }
  apply(ctx, plan);
  return plan;
}

function apply(ctx: HostCtx, plan: DeletePlan): void {
  for (const n of plan.nulls) setNull(ctx, n.tableName, n.column, unhex(n.key));
  // Leaves first.
  for (const d of [...plan.deletes].reverse()) tableNamed(d.tableName).rawDelete(ctx, unhex(d.key));
}

/** "3 demo_list, 12 demo_card" style counts of the rows a plan deletes. */
export function counts(plan: DeletePlan): [string, number][] {
  const out = new Map<string, number>();
  for (const d of plan.deletes) out.set(d.tableName, (out.get(d.tableName) ?? 0) + 1);
  return [...out];
}

/** Every orphan and duplicate in the current data. */
export function check(ctx: HostCtx): Violation[] {
  const out: Violation[] = [];
  for (const r of refs) {
    const child = tableNamed(r.child);
    const parent = tableNamed(r.parent);
    for (const row of child.iter(ctx)) {
      const k = r.get(row);
      if (k === undefined || k === null) continue;
      const pk = encode(parent.key, k);
      if (parent.find(ctx, pk)) continue;
      out.push({
        kind: VIOLATION_ORPHAN,
        tableName: r.child,
        column: r.column,
        key: hex(child.keyBytes(row)),
        parentTable: r.parent,
        parentKey: hex(pk),
      });
    }
  }
  for (const u of uniques) {
    const t = tableNamed(u.table);
    const seen = new Set<string>();
    for (const row of t.iter(ctx)) {
      // "First" is the row with the smallest key (by value, as in Rust and C#).
      let firstRow: unknown;
      for (const o of u.matches(ctx, row)) {
        if (firstRow === undefined || compareKeys(t.keyOf(o), t.keyOf(firstRow)) < 0) firstRow = o;
      }
      const first = firstRow === undefined ? undefined : t.keyBytes(firstRow);
      const mine = hex(t.keyBytes(row));
      if (first && hex(first) !== mine && !seen.has(mine)) {
        seen.add(mine);
        out.push({
          kind: VIOLATION_DUPLICATE,
          tableName: u.table,
          column: u.columns.join(','),
          key: mine,
          parentTable: u.table,
          parentKey: hex(first),
        });
      }
    }
  }
  return out;
}

/**
 * Apply each reference's on-delete rule to its orphans: CASCADE deletes them (and their own
 * children), SET_NULL unlinks them, RESTRICT orphans and duplicates are reported only.
 */
export function repair(ctx: HostCtx): RepairReport {
  const report: RepairReport = { deleted: [], nulled: [], unresolved: [] };
  for (const v of check(ctx)) {
    if (v.kind !== VIOLATION_ORPHAN) {
      report.unresolved.push(v);
      continue;
    }
    const r = refs.find((x) => x.child === v.tableName && x.column === v.column);
    if (!r) throw new SenderError('unknown reference');
    const key = unhex(v.key);
    // An earlier cascade may have removed it already.
    if (!exists(ctx, v.tableName, key)) continue;
    if (r.onDelete === CASCADE) {
      const plan = planDelete(ctx, v.tableName, key);
      if (plan.blocked.length === 0) {
        apply(ctx, plan);
        report.deleted.push(...plan.deletes);
        report.nulled.push(...plan.nulls);
      } else report.unresolved.push(v);
    } else if (r.onDelete === SET_NULL) {
      setNull(ctx, v.tableName, v.column, key);
      report.nulled.push({ tableName: v.tableName, column: v.column, key: v.key });
    } else report.unresolved.push(v);
  }
  return report;
}

// --- Pagination ------------------------------------------------------------

/** A client's position in a paged list, read by your view with `pageState`. */
export interface PageState {
  after: string | undefined;
  limit: number;
}

/** A page from `page()`: the rows, and the cursor for the next page (undefined at the end). */
export interface Page<T> {
  items: T[];
  next: string | undefined;
}

/** Clamp a requested page size: 0 means DEFAULT_PAGE, at most MAX_PAGE. */
export function pageSize(limit: number): number {
  return limit === 0 ? DEFAULT_PAGE : Math.min(limit, MAX_PAGE);
}

/**
 * Take one page from `rows` (already positioned after the cursor): the `limit` rows with the
 * smallest keys, in key order. `next` is the cursor of the last row returned, if more rows follow.
 *
 * This reads the whole range: inside a transaction that wrote into it (which is where views are
 * refreshed), an index range scan yields the transaction's own rows first and then the committed
 * ones, so the scan isn't in key order (see FINDINGS).
 */
export function page<T, K>(rows: Iterable<T>, limit: number, keyOf: (row: T) => K, keyType: Typed<K>): Page<T> {
  const n = pageSize(limit);
  const all = [...rows].map((row) => ({ row, key: keyOf(row) }));
  all.sort((a, b) => compareKeys(a.key, b.key));
  const items = all.slice(0, n);
  const last = items[items.length - 1];
  return { items: items.map((x) => x.row), next: all.length > n && last ? cursorOf(keyType, last.key) : undefined };
}

/** The cursor for a key: hex of its BSATN. */
export function cursorOf<K>(keyType: Typed<K>, key: K): string {
  return hex(encode(keyType, key));
}

/** Decode a cursor back into a key. undefined (or "") is the first page. */
export function cursor<K>(keyType: Typed<K>, c: string | null | undefined): K | undefined {
  if (c === undefined || c === null || c === '') return undefined;
  return decode(keyType, unhex(c));
}

/** Set `who`'s position in `list`. Your `relations_set_page` reducer calls this for the sender. */
export function setPage(ctx: HostCtx, who: Identity, list: string, after: string | undefined, limit: number): void {
  if (list.length > 256) throw new SenderError('list name too long');
  if (after !== undefined) unhex(after);
  const h = scopeOf(ctx);
  const size = pageSize(limit);
  const existing = h.db.page.byOwnerList.filter([who, list]).next();
  if (!existing.done) h.db.page.id.update({ ...existing.value, after, limit: size });
  else h.db.page.insert({ id: 0n, owner: who, list, after, limit: size });
}

/** Forget all of `who`'s page positions (e.g. from your `clientDisconnected`). */
export function clearPages(ctx: HostCtx, who: Identity): void {
  const h = scopeOf(ctx);
  for (const p of [...h.db.page.owner.filter(who)]) h.db.page.id.delete(p.id);
}

/**
 * The viewer's position in `list`, for a view (pass the view's ctx). Before the client has set
 * one: the first page with DEFAULT_PAGE rows.
 */
export function pageState(ctx: { sender: Identity; db: unknown }, list: string): PageState {
  const db = viewDbOf(ctx);
  const p = db.page.byOwnerList.filter([ctx.sender, list]).next();
  return p.done ? { after: undefined, limit: DEFAULT_PAGE } : { after: p.value.after ?? undefined, limit: p.value.limit };
}

/** Every list the viewer has a position in, for views over several lists. */
export function pageStates(ctx: { sender: Identity; db: unknown }): [string, PageState][] {
  const db = viewDbOf(ctx);
  return [...db.page.owner.filter(ctx.sender)].map((p) => [p.list, { after: p.after ?? undefined, limit: p.limit }]);
}
