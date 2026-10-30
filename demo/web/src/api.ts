// Client API for the demo. All three demo modules (Rust, C#, TypeScript submodule) expose the
// same client-facing names, so one set of bindings covers them.
import { BinaryWriter, type Identity } from 'spacetimedb';
import { DbConnection } from './bindings/index';

export type Conn = DbConnection;
export type Board = { id: bigint; name: string };
export type List = { id: bigint; boardId: bigint; name: string };
export type Card = { id: bigint; listId: bigint; title: string; parentId: bigint | undefined; assignee: bigint | undefined };
export type Member = { id: bigint; name: string };
export type Comment = { id: bigint; cardId: bigint; authorId: bigint; text: string };
export type CardTag = { id: bigint; cardId: bigint; tag: string };
export type Plan = Extract<Awaited<ReturnType<Conn['procedures']['demoPreviewDelete']>>, { ok: unknown }>['ok'];

/** Demo tables, by canonical name. */
export const TABLES = ['demo_board', 'demo_list', 'demo_card', 'demo_comment', 'demo_card_tag', 'demo_member'] as const;
export type TableName = (typeof TABLES)[number];

/** Unwrap a procedure's `Result<T, string>`, throwing the error. */
export function unwrap<T>(r: { ok: T } | { err: string }): T {
  if ('err' in r) throw new Error(r.err);
  return r.ok;
}

/** A key as relations writes it: hex of its BSATN. Every demo key is a u64. */
export function key(id: bigint): string {
  const w = new BinaryWriter(8);
  w.writeU64(id);
  return [...w.getBuffer()].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The id inside a u64 key. */
export function idOf(hex: string): bigint {
  let v = 0n;
  for (let i = hex.length - 2; i >= 0; i -= 2) v = (v << 8n) | BigInt(parseInt(hex.slice(i, i + 2), 16));
  return v;
}

/** "3 demo_card, 1 demo_comment" style counts for a plan's deletes. */
export function counts(plan: Plan): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of plan.deletes) out[d.tableName] = (out[d.tableName] ?? 0) + 1;
  return out;
}

export function connect(host: string, db: string, token?: string, onDisconnect?: () => void): Promise<{ conn: Conn; identity: Identity; token: string }> {
  return new Promise((resolve, reject) =>
    DbConnection.builder()
      .withUri(host)
      .withDatabaseName(db)
      .withToken(token)
      .onConnect((conn, identity, tok) => resolve({ conn, identity, token: tok }))
      .onDisconnect(() => onDisconnect?.())
      .onConnectError((_c, e) => reject(e))
      .build()
  );
}

export const SUBSCRIPTIONS = [
  'SELECT * FROM demo_board',
  'SELECT * FROM demo_list',
  'SELECT * FROM demo_card',
  'SELECT * FROM demo_comment',
  'SELECT * FROM demo_card_tag',
  'SELECT * FROM demo_member',
  'SELECT * FROM demo_card_page',
];
