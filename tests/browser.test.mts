// Browser tests: the demo page in headless Chromium, two people on one board.
//
//   PAGE=http://127.0.0.1:3000/v1/database/rel-rust/route/ npx tsx tests/browser.test.mts
//   SHOTS=docs  ...also saves docs/demo-{light,dark}.png
import assert from 'node:assert/strict';
import { chromium, type Page } from 'playwright';

const PAGE = process.env.PAGE ?? 'http://127.0.0.1:3000/v1/database/rel-rust/route/';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const browser = await chromium.launch();
async function open(scheme: 'light' | 'dark' = 'light'): Promise<Page> {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme })).newPage();
  page.on('pageerror', (e) => console.error('[page]', e.message));
  await page.goto(`${PAGE}${PAGE.includes('?') ? '&' : '?'}fresh=1`);
  await page.waitForFunction(() => document.querySelector('#status')?.textContent === 'connected');
  return page;
}
const add = async (p: Page, form: string, value: string) => {
  await p.fill(`${form} input`, value);
  await p.press(`${form} input`, 'Enter');
};
const column = (p: Page, name: string) => p.locator('.column', { has: p.locator('.head', { hasText: name }) });

try {
  const ada = await open();
  const bo = await open();
  const tag = `b${Date.now() % 100000}`;

  await test('boards, lists and cards made by one person show up for the other', async () => {
    await add(ada, '#add-board', `Launch ${tag}`);
    await ada.locator('#boards .item', { hasText: `Launch ${tag}` }).click();
    await bo.locator('#boards .item', { hasText: `Launch ${tag}` }).click();
    await add(ada, '#add-list', 'Todo');
    await add(ada, '#add-list', 'Done');
    await add(ada, '#add-member', `Ada ${tag}`);
    for (const t of ['Write post', 'Record video', 'Ship it']) {
      await column(ada, 'Todo').locator('form.add input').fill(t);
      await column(ada, 'Todo').locator('form.add input').press('Enter');
    }
    await bo.waitForFunction(() => document.querySelectorAll('.column .card').length === 3);
  });

  await test('deleting a list previews its cascade, then removes it for everyone', async () => {
    const card = column(ada, 'Todo').locator('.card').first();
    ada.once('dialog', (d) => d.accept('hello'));
    await card.locator('button', { hasText: '+ comment' }).click();
    ada.once('dialog', (d) => d.accept('launch'));
    await card.locator('button', { hasText: '+ tag' }).click();
    await bo.waitForSelector('.chip >> text=#launch');
    await column(ada, 'Todo').locator('.head .x').click();
    await ada.waitForSelector('dialog[open]');
    const body = await ada.textContent('#confirm-body');
    assert.match(body!, /3 cards/);
    assert.match(body!, /1 comment/);
    assert.match(body!, /1 tag/);
    if (process.env.SHOTS) await ada.screenshot({ path: `${process.env.SHOTS}/demo-dialog.png` });
    await ada.click('#confirm-ok');
    await bo.waitForFunction(() => ![...document.querySelectorAll('.column .head')].some((h) => h.textContent?.startsWith('Todo')));
    assert.equal(await bo.locator('.column .card').count(), 0);
  });

  await test('a member who wrote comments is protected: the dialog shows what blocks it', async () => {
    await column(ada, 'Done').locator('form.add input').fill('Retro');
    await column(ada, 'Done').locator('form.add input').press('Enter');
    const card = column(ada, 'Done').locator('.card').first();
    await card.waitFor();
    await card.locator('select').selectOption({ label: `Ada ${tag}` });
    await ada.waitForFunction(() => document.querySelector('.column:last-child .card select')?.selectedIndex === 1);
    ada.once('dialog', (d) => d.accept('went well'));
    await card.locator('button', { hasText: '+ comment' }).click();
    await ada.waitForSelector('.chip >> text=1 comment');
    await ada.locator('#members .item', { hasText: `Ada ${tag}` }).locator('.x').click();
    await ada.waitForSelector('dialog[open]');
    assert.match((await ada.textContent('#confirm-body'))!, /Blocked: 1 comment/);
    assert.equal(await ada.isDisabled('#confirm-ok'), true);
    await ada.click('#confirm-cancel');
  });

  await test('columns page through cards live, five at a time', async () => {
    const col = column(ada, 'Done');
    for (let i = 1; i <= 6; i++) {
      await col.locator('form.add input').fill(`Task ${i}`);
      await col.locator('form.add input').press('Enter');
    }
    await ada.waitForFunction(() => document.querySelector('.column:last-child .head .n')?.textContent === '7 cards');
    await ada.waitForFunction(() => document.querySelectorAll('.column:last-child .card').length === 5);
    await col.locator('button', { hasText: 'Next' }).click();
    await ada.waitForFunction(() => document.querySelectorAll('.column:last-child .card').length === 2);
    assert.match((await col.locator('.pager').textContent())!, /page 2/);
    assert.equal(await bo.locator('.column:last-child .card').count(), 5, "Bo's page didn't move");
    await col.locator('button', { hasText: 'Prev' }).click();
    await ada.waitForFunction(() => document.querySelectorAll('.column:last-child .card').length === 5);
  });

  await test('integrity: a raw delete leaves orphans, check finds them, repair cascades them away', async () => {
    await ada.click('#break-list');
    await ada.waitForSelector('#violations .v >> text=orphan');
    const orphans = await ada.locator('#violations .v').count();
    assert.ok(orphans >= 7, `the list's ${orphans} cards are orphans`);
    await ada.click('#repair');
    await ada.waitForSelector('#violations .v.ok');
  });

  if (process.env.SHOTS) {
    // A tidy board for the README, in both themes.
    await add(ada, '#add-board', `Website ${tag}`);
    await ada.locator('#boards .item', { hasText: `Website ${tag}` }).click();
    for (const l of ['Backlog', 'In progress', 'Done']) await add(ada, '#add-list', l);
    await add(ada, '#add-member', 'Bo');
    await sleep(300);
    const cards: [string, string[]][] = [
      ['Backlog', ['Pricing page', 'Blog: launch post', 'Dark mode', 'Fix footer links', 'Accessibility pass', 'Sitemap']],
      ['In progress', ['New landing hero', 'Signup flow']],
      ['Done', ['Pick a font']],
    ];
    for (const [l, titles] of cards) {
      for (const t of titles) {
        await column(ada, l).locator('form.add input').fill(t);
        await column(ada, l).locator('form.add input').press('Enter');
        await sleep(80);
      }
    }
    await sleep(400);
    const hero = column(ada, 'In progress').locator('.card').first();
    await hero.locator('select').selectOption({ label: 'Bo' });
    ada.once('dialog', (d) => d.accept('Copy review'));
    await hero.locator('button', { hasText: '+ subtask' }).click();
    ada.once('dialog', (d) => d.accept('looks great'));
    await hero.locator('button', { hasText: '+ comment' }).click();
    ada.once('dialog', (d) => d.accept('design'));
    await hero.locator('button', { hasText: '+ tag' }).click();
    await ada.click('#check');
    await sleep(4500); // let the repair toast fade
    await ada.screenshot({ path: `${process.env.SHOTS}/demo-light.png` });
    const dark = await open('dark');
    await dark.locator('#boards .item', { hasText: `Website ${tag}` }).click();
    await dark.click('#check');
    await sleep(800);
    await dark.screenshot({ path: `${process.env.SHOTS}/demo-dark.png` });
  }
} finally {
  await browser.close();
}
console.log(`\n${passed} passed`);
