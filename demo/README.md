# Demo

A kanban board with real references. Boards hold lists, lists hold cards, cards have subtasks, comments and tags,
and members are assigned to cards and write comments.

- **Delete anything** and the page first asks the module what would happen (`demo_preview_delete`): "This also
  deletes 3 cards, 1 comment, 1 tag", "unlinks 2 cards (assignee set to none)", or "Blocked: 1 comment still
  references it".
- **Columns are live pages** of the `demo_card_page` view, five cards at a time. Prev/Next move your cursor with
  `relations_set_page`, and the page stays current while others edit.
- **The References panel** lists what the module declared (`relations_fk`).
- **Integrity:** "Raw-delete a list" deletes around the checks the way old code might, Check lists the orphans
  that leaves, and Repair applies each reference's rule to them.

The same demo exists in all three languages; each module serves the shared page from [`web/`](web) at `/route/`.

```bash
npm install && npm run build:web          # bundles web/ into web/dist/index.html
spacetime start                           # in another terminal
spacetime publish -s local relations -p demo/rust      # or demo/csharp, demo/typescript
open http://127.0.0.1:3000/v1/database/relations/route/
```

`scripts/e2e.sh rust|csharp|typescript` publishes a demo and runs the protocol and browser suites against it. The
TypeScript module's schema tables are namespaced (`relations.fk`), so its References panel stays empty with the
shared bindings.
