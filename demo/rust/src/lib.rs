//! Demo: a kanban board with real references. Boards hold lists, lists hold cards, cards have
//! subtasks, comments and tags, members are assigned to cards and write comments.
//! Serves the web client at `/route/`.

#[path = "../../../rust/relations.rs"]
pub mod relations;

use http::{StatusCode, header};
use relations::DeletePlan;
use spacetimedb::http::{Body, HandlerContext, Request, Response, Router, handler, router};
use spacetimedb::{ProcedureContext, ReducerContext, SpacetimeType, Table, ViewContext};

const PAGE: &str = include_str!("../../web/dist/index.html");

#[spacetimedb::table(accessor = demo_member, public)]
#[derive(Clone, Debug)]
pub struct DemoMember {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub name: String,
}

#[spacetimedb::table(accessor = demo_board, public)]
#[derive(Clone, Debug)]
pub struct DemoBoard {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub name: String,
}

#[spacetimedb::table(accessor = demo_list, public)]
#[derive(Clone, Debug)]
pub struct DemoList {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub board_id: u64,
    pub name: String,
}

#[spacetimedb::table(
    accessor = demo_card,
    public,
    index(accessor = by_list, btree(columns = [list_id, id]))
)]
#[derive(Clone, Debug)]
pub struct DemoCard {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub list_id: u64,
    pub title: String,
    /// A subtask's parent card.
    pub parent_id: Option<u64>,
    pub assignee: Option<u64>,
}

#[spacetimedb::table(accessor = demo_comment, public)]
#[derive(Clone, Debug)]
pub struct DemoComment {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub card_id: u64,
    #[index(btree)]
    pub author_id: u64,
    pub text: String,
}

#[spacetimedb::table(
    accessor = demo_card_tag,
    public,
    index(accessor = by_card_tag, btree(columns = [card_id, tag]))
)]
#[derive(Clone, Debug)]
pub struct DemoCardTag {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub card_id: u64,
    pub tag: String,
}

relations! {
    tables {
        demo_member: DemoMember => id: u64,
        demo_board: DemoBoard => id: u64,
        demo_list: DemoList => id: u64,
        demo_card: DemoCard => id: u64,
        demo_comment: DemoComment => id: u64,
        demo_card_tag: DemoCardTag => id: u64,
    }
    references {
        demo_list.board_id -> demo_board [cascade] via board_id,
        demo_card.list_id -> demo_list [cascade] via by_list,
        demo_card.parent_id -> demo_card [cascade, nullable],
        demo_card.assignee -> demo_member [set_null, nullable],
        demo_comment.card_id -> demo_card [cascade] via card_id,
        demo_comment.author_id -> demo_member [restrict] via author_id,
        demo_card_tag.card_id -> demo_card [cascade] via card_id,
    }
    unique {
        demo_card_tag(card_id, tag) via by_card_tag,
    }
}

#[spacetimedb::reducer(init)]
pub fn init(ctx: &ReducerContext) {
    relations::configure(ctx);
}

#[spacetimedb::reducer(client_disconnected)]
pub fn client_disconnected(ctx: &ReducerContext) {
    relations::clear_pages(ctx, ctx.sender());
}

fn name(s: &str) -> Result<String, String> {
    let s = s.trim();
    match s.chars().count() {
        0 => Err("name is empty".into()),
        1..=80 => Ok(s.to_string()),
        _ => Err("name too long".into()),
    }
}

#[spacetimedb::reducer]
pub fn demo_add_member(ctx: &ReducerContext, name: String) -> Result<(), String> {
    checked::demo_member::insert(
        ctx,
        DemoMember {
            id: 0,
            name: self::name(&name)?,
        },
    )?;
    Ok(())
}

#[spacetimedb::reducer]
pub fn demo_add_board(ctx: &ReducerContext, name: String) -> Result<(), String> {
    checked::demo_board::insert(
        ctx,
        DemoBoard {
            id: 0,
            name: self::name(&name)?,
        },
    )?;
    Ok(())
}

#[spacetimedb::reducer]
pub fn demo_add_list(ctx: &ReducerContext, board_id: u64, name: String) -> Result<(), String> {
    checked::demo_list::insert(
        ctx,
        DemoList {
            id: 0,
            board_id,
            name: self::name(&name)?,
        },
    )?;
    Ok(())
}

#[spacetimedb::reducer]
pub fn demo_add_card(
    ctx: &ReducerContext,
    list_id: u64,
    title: String,
    parent_id: Option<u64>,
) -> Result<(), String> {
    checked::demo_card::insert(
        ctx,
        DemoCard {
            id: 0,
            list_id,
            title: name(&title)?,
            parent_id,
            assignee: None,
        },
    )?;
    Ok(())
}

#[spacetimedb::reducer]
pub fn demo_move_card(ctx: &ReducerContext, id: u64, list_id: u64) -> Result<(), String> {
    let card = ctx.db.demo_card().id().find(id).ok_or("no such card")?;
    checked::demo_card::update(ctx, DemoCard { list_id, ..card })?;
    Ok(())
}

#[spacetimedb::reducer]
pub fn demo_assign(ctx: &ReducerContext, id: u64, member: Option<u64>) -> Result<(), String> {
    let card = ctx.db.demo_card().id().find(id).ok_or("no such card")?;
    checked::demo_card::update(
        ctx,
        DemoCard {
            assignee: member,
            ..card
        },
    )?;
    Ok(())
}

#[spacetimedb::reducer]
pub fn demo_add_comment(
    ctx: &ReducerContext,
    card_id: u64,
    author_id: u64,
    text: String,
) -> Result<(), String> {
    checked::demo_comment::insert(
        ctx,
        DemoComment {
            id: 0,
            card_id,
            author_id,
            text: name(&text)?,
        },
    )?;
    Ok(())
}

#[spacetimedb::reducer]
pub fn demo_add_tag(ctx: &ReducerContext, card_id: u64, tag: String) -> Result<(), String> {
    checked::demo_card_tag::insert(
        ctx,
        DemoCardTag {
            id: 0,
            card_id,
            tag: name(&tag)?,
        },
    )?;
    Ok(())
}

#[spacetimedb::reducer]
pub fn demo_retag(ctx: &ReducerContext, id: u64, tag: String) -> Result<(), String> {
    let t = ctx.db.demo_card_tag().id().find(id).ok_or("no such tag")?;
    checked::demo_card_tag::update(
        ctx,
        DemoCardTag {
            tag: name(&tag)?,
            ..t
        },
    )?;
    Ok(())
}

/// Delete any demo row by table name and id, with its cascades.
#[spacetimedb::reducer]
pub fn demo_delete(ctx: &ReducerContext, table: String, id: u64) -> Result<(), String> {
    relations::delete(ctx, &table, &relations::encode(&id))?;
    Ok(())
}

/// What `demo_delete` would do.
#[spacetimedb::procedure]
pub fn demo_preview_delete(
    ctx: &mut ProcedureContext,
    table: String,
    id: u64,
) -> Result<DeletePlan, String> {
    ctx.with_tx(|tx| relations::plan_delete(tx, &table, &relations::encode(&id)))
}

/// Test helper: delete straight through the table handle, the way older code might, leaving
/// orphans behind for `relations_check` / `relations_repair` to find.
#[spacetimedb::reducer]
pub fn demo_raw_delete(ctx: &ReducerContext, table: String, id: u64) -> Result<(), String> {
    match __relations_raw_delete(ctx, &table, &relations::encode(&id))? {
        true => Ok(()),
        false => Err("no such row".into()),
    }
}

/// Test helper: insert a tag without the unique check, to make a duplicate.
#[spacetimedb::reducer]
pub fn demo_raw_add_tag(ctx: &ReducerContext, card_id: u64, tag: String) {
    ctx.db.demo_card_tag().insert(DemoCardTag {
        id: 0,
        card_id,
        tag,
    });
}

/// Demo only: anyone may run check and repair.
#[spacetimedb::reducer]
pub fn demo_become_admin(ctx: &ReducerContext) {
    relations::add_admin(ctx, ctx.sender());
}

// --- Pagination ------------------------------------------------------------

#[derive(SpacetimeType)]
pub struct CardPage {
    pub items: Vec<DemoCard>,
    pub next: Option<String>,
}

/// One page of a list's cards, by id. `after`: the previous page's `next`.
#[spacetimedb::procedure]
pub fn demo_cards(
    ctx: &mut ProcedureContext,
    list_id: u64,
    after: Option<String>,
    limit: u32,
) -> Result<CardPage, String> {
    let after: Option<u64> = relations::cursor(after.as_deref())?;
    Ok(ctx.with_tx(|tx| {
        let from = after.map_or(0, |a| a + 1);
        let p = relations::page(
            tx.db.demo_card().by_list().filter((list_id, from..)),
            limit,
            |c| c.id,
        );
        CardPage {
            items: p.items,
            next: p.next,
        }
    }))
}

/// The cards on the viewer's current page of each list they've paged ("list:<id>", set with
/// `relations_set_page`). Subscribe to it and the page stays live.
#[spacetimedb::view(accessor = demo_card_page, public)]
pub fn demo_card_page(ctx: &ViewContext) -> Vec<DemoCard> {
    let mut out = Vec::new();
    for (list, state) in relations::page_states(ctx) {
        let Some(list_id) = list
            .strip_prefix("list:")
            .and_then(|s| s.parse::<u64>().ok())
        else {
            continue;
        };
        let Ok(after) = relations::cursor::<u64>(state.after.as_deref()) else {
            continue;
        };
        let from = after.map_or(0, |a| a + 1);
        out.extend(
            ctx.db
                .demo_card()
                .by_list()
                .filter((list_id, from..))
                .take(state.limit as usize),
        );
    }
    out
}

// --- Benchmark -------------------------------------------------------------

/// Insert `count` cards into `list_id`, checked or raw.
#[spacetimedb::reducer]
pub fn demo_bench_insert(
    ctx: &ReducerContext,
    list_id: u64,
    count: u32,
    checked: bool,
) -> Result<(), String> {
    for i in 0..count {
        let card = DemoCard {
            id: 0,
            list_id,
            title: format!("card {i}"),
            parent_id: None,
            assignee: None,
        };
        if checked {
            checked::demo_card::insert(ctx, card)?;
        } else {
            ctx.db.demo_card().insert(card);
        }
    }
    Ok(())
}

#[handler]
fn page(_ctx: &mut HandlerContext, _req: Request) -> Response {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-cache")
        .body(Body::from_bytes(PAGE))
        .unwrap()
}

#[router]
fn routes() -> Router {
    Router::new().get("/", page)
}
