# Changelog

All notable changes to `@pogly/spacetimedb-relations` are listed here. It follows [semantic versioning](https://semver.org/).

## Unreleased

## 0.1.3 (2026-10-30)

- Works with SpacetimeDB 2.14: the `spacetimedb` peer range is now `2.13.* || 2.14.*`. No code changes. A module built with the 2.14 library needs a 2.14 or newer host.
- `package.json` declares `submodule.category` for the [SpacetimeDB submodule registry](https://spacetimedb.com/submodules).

## 0.1.2 (2026-10-13)

- Works with SpacetimeDB 2.12: the `spacetimedb` peer range is now `2.11.* || 2.12.*`. No code changes.

## 0.1.1 (2026-10-11)

- First release published from CI through npm trusted publishing, with provenance. No code changes.

## 0.1.0 (2026-10-11)

First release on npm.

- `table()` registration with checked `insert` / `update` / `upsert` / `delete` / `previewDelete`.
- `reference()` with `RESTRICT`, `CASCADE` and `SET_NULL`, nullable columns, self-references, index or scan lookups.
- `unique()` multi-column constraints, enforced by checked writes.
- Delete plans (`planDelete`), all-or-nothing deletes (`deleteRow`).
- `check` / `repair` of existing data, with admins.
- Pagination: `page`, `cursor` / `cursorOf`, and subscribable pages (`setPage`, `pageState`, `pageStates`).
- Public `relations.fk` / `relations.unique` tables describing the schema.
