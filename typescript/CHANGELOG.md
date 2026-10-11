# Changelog

## 0.1.0

First release.

- `table()` registration with checked `insert` / `update` / `upsert` / `delete` / `previewDelete`.
- `reference()` with `RESTRICT`, `CASCADE` and `SET_NULL`, nullable columns, self-references, index or scan lookups.
- `unique()` multi-column constraints, enforced by checked writes.
- Delete plans (`planDelete`), all-or-nothing deletes (`deleteRow`).
- `check` / `repair` of existing data, with admins.
- Pagination: `page`, `cursor` / `cursorOf`, and subscribable pages (`setPage`, `pageState`, `pageStates`).
- Public `relations.fk` / `relations.unique` tables describing the schema.
