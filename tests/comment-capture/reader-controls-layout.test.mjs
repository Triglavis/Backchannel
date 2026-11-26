import test from 'node:test';
import assert from 'node:assert/strict';
import {launchApp,STORIES,waitFor} from './harness.mjs';

async function ready(app){
  await app.page.goto('https://backchnnl.app/');
  await app.page.locator('#app-list-body .browse-title-link').first().click();
  await app.page.locator('#comments-content .comment[data-comment-id]').first().waitFor();
  await app.page.locator('#app-article-body iframe').waitFor();
  assert(await waitFor(async()=>await app.page.locator('#panel').evaluate(panel=>getComputedStyle(panel).transform==='none'),2000),'pane entrance has settled before measuring its edge');
}

async function assertToolbarOrder(page, toolbar, selectors, axis = 'x') {
  const controls = selectors.map(selector => toolbar.locator(selector));
  const boxes = await Promise.all(controls.map(control => control.boundingBox()));
  assert(boxes.every(Boolean), 'all expected toolbar controls are visible');
  for (let index = 1; index < boxes.length; index++) {
    assert(boxes[index][axis] > boxes[index - 1][axis], `${selectors[index]} follows ${selectors[index - 1]} visually`);
  }

  await controls[0].focus();
  for (let index = 1; index < controls.length; index++) {
    await page.keyboard.press(process.env.ENGINE === 'webkit' ? 'Alt+Tab' : 'Tab');
    assert(await controls[index].evaluate(node => node.getRootNode().activeElement === node), `Tab reaches ${selectors[index]} after ${selectors[index - 1]}`);
  }
  return boxes;
}

test('wide Reader Front Pages toggle overlaps its panel and pane controls remain reachable when collapsed',{timeout:20000},async()=>{
  const app=await launchApp({sharedStore:true,viewport:{width:1600,height:950},settings:{sources:{hn:true},frontPageMode:'sources',updateCheck:false}});
  try{
    await ready(app);
    const actions = app.page.locator('#app-list > .app-pane-head .app-pane-actions');
    await assertToolbarOrder(app.page, actions, ['#app-list-sync', '#app-mark-read', '.app-select-links']);
    const edges=await app.page.locator('#app-reading').evaluate(reading=>{
      const root=reading.getRootNode(),list=root.querySelector('#app-list').getBoundingClientRect(),panel=root.querySelector('#panel').getBoundingClientRect();
      const b=id=>{const r=root.querySelector(id).getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,center:r.x+r.width/2}};
      return{listRight:list.right,panelLeft:panel.left,controlsRight:b('#app-list > .app-pane-head .app-select-links').right,left:b('#app-toggle-list'),right:b('#app-toggle-discussion')};
    });
    assert(Math.abs(edges.left.center-edges.listRight)<=1,'the Front Pages toggle straddles the list edge');
    assert(edges.left.x-edges.controlsRight>=4,`the pane toggle leaves the last list action clear: ${JSON.stringify(edges)}`);
    assert.equal(await app.page.locator('#app-toggle-discussion').evaluate(node=>Boolean(node.closest('#app-chin'))),true,'Discussion is available in the desktop chin');
    for(const [id,hidden] of [['#app-toggle-list','list-hidden'],['#app-toggle-discussion','discussion-hidden']]){
      await app.page.locator(id).click();
      assert(await waitFor(async()=>await app.page.locator('#app').evaluate((n,c)=>n.classList.contains(c),hidden),2000));
      const hit=await app.page.locator(id).evaluate(button=>{const r=button.getBoundingClientRect();return button.getRootNode().elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('button')===button});
      assert(hit,'the collapsed panel toggle remains clickable');
      if(hidden==='list-hidden'){
        const whole=await app.page.locator('#app-toggle-discussion').evaluate(button=>{const r=button.getBoundingClientRect(),root=button.getRootNode();return [r.left+2,r.right-2].every(x=>root.elementFromPoint(x,r.y+r.height/2)?.closest('button')===button)});
        assert(whole,'hiding the list does not clip either half of the Discussion toggle');
      }
      await app.page.locator(id).click();
      assert(await waitFor(async()=>!await app.page.locator('#app').evaluate((n,c)=>n.classList.contains(c),hidden),2000));
    }
    assert.equal(await app.page.locator('#app-toggle-discussion rect').count(),0,'Discussion uses a chat bubble rather than a pane glyph');
    assert.deepEqual(app.errors,[]);
  }finally{await app.browser.close()}
});

for (const [width, heading] of [[1600, '#app-list > .app-pane-head'], [390, '#app-list-heading']]) {
  test(`${width}px Collection places view tabs between the toolbar and link list`, {timeout: 20000}, async () => {
    const topic = {id: 'story:archive', kind: 'story', label: 'Preserving an online archive'};
    const saved = [
      {key: 'saved.example.com/article', url: 'https://saved.example.com/article', title: 'A saved article'},
      {key: 'saved.example.org/article', url: 'https://saved.example.org/article', title: 'A related article'},
    ];
    const app = await launchApp({
      sharedStore: true,
      viewport: {width, height: 950},
      settings: {sources: {hn: true}, frontPageMode: 'sources', updateCheck: false},
      values: {
        'HNewhere:collection_filed': true,
        'HNewhere:collected_migrated': true,
        'HNewhere:collected': saved.map(entry => ({...entry, addedAt: 1700000000000, unwatched: true})),
      },
      responses: [{match: url => url === 'https://topics.backchnnl.app/api/topics', json: {
        version: 1, generatedAt: new Date().toISOString(), topics: [topic],
        pages: saved.map(({key}) => ({key, topicIds: [topic.id]})),
      }}],
    });
    try {
      const {page} = app;
      await page.goto('https://backchnnl.app/');
      await page.locator('#app-rail [data-app-view="collection"]').click();
      await page.locator('#app-list-body').getByRole('link', {name: 'A saved article', exact: true}).waitFor();
      const controls = width === 1600 ? ['#app-list-sync', '.app-collection-filter', '.app-select-links'] : ['.app-collection-filter'];
      await assertToolbarOrder(page, page.locator(`${heading} .app-pane-actions`), controls);
      if (width === 390) {
        assert.equal(await page.getByRole('button', {name: 'Select links', exact: true}).count(), 0);
      }
      const tabs = page.getByRole('tablist', {name: 'Link view', exact: true});
      await tabs.waitFor();
      const [toolbar, tabStrip, list] = await Promise.all([page.locator(heading), tabs, page.locator('#app-list-body')].map(node => node.boundingBox()));
      assert(tabStrip.y >= toolbar.y + toolbar.height);
      assert(tabStrip.y + tabStrip.height <= list.y);
      assert.equal(await tabs.getByRole('tab', {name: 'By link', exact: true}).getAttribute('aria-selected'), 'true');
      assert.deepEqual(app.errors, []);
    } finally {
      await app.browser.close();
    }
  });
}

for (const colorScheme of ['light', 'dark']) test(`the open list row keeps text and its menu legible in ${colorScheme} mode`, async t => {
  const { browser, page } = await launchApp({ colorScheme, settings: { updateCheck: false, sources: { hn: true } } });
  t.after(() => browser.close());
  await page.goto('https://backchnnl.app/');
  const row = page.locator('#app-list-body .browse-row').first();
  await row.locator('.browse-title-link').click();
  assert(await waitFor(() => row.evaluate(node => node.classList.contains('is-open'))));
  await page.mouse.move(0, 0);
  const contrast = await row.evaluate(node => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d');
    const luminance = (rgb) => [...rgb.slice(0, 3)].map(value => value / 255)
      .reduce((sum, value, i) => sum + [0.2126, 0.7152, 0.0722][i] *
        (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4), 0);
    const paint = (color) => { context.fillStyle = color; context.fillRect(0, 0, 1, 1); };
    paint(getComputedStyle(node.closest('#app-list')).getPropertyValue('--surface'));
    paint(getComputedStyle(node).backgroundColor);
    const background = luminance(context.getImageData(0, 0, 1, 1).data);
    return ['.browse-title-link', '.browse-site', '.browse-more'].map(selector => {
      const color = getComputedStyle(node.querySelector(selector)).color;
      context.clearRect(0, 0, 1, 1);
      paint(color);
      const foreground = luminance(context.getImageData(0, 0, 1, 1).data);
      return (Math.max(background, foreground) + 0.05) / (Math.min(background, foreground) + 0.05);
    });
  });
  assert(contrast.every(value => value >= 4.5), `contrast for the title, metadata and menu is ${contrast.join(', ')}`);
});

test('wide Reader keeps its real article actions together in the chin',{timeout:20000},async()=>{
  const app=await launchApp({sharedStore:true,viewport:{width:1600,height:950},votable:{[STORIES[0].id]:'updown'},settings:{sources:{hn:true},frontPageMode:'sources',updateCheck:false}});
  try{
    await ready(app);
    const ids=['#app-article-actions [data-item-action="save"]','#app-view-toggle','#app-toggle-discussion'];
    const boxes = await assertToolbarOrder(app.page, app.page.locator('#app-chin-actions'), ids);
    const chin=await app.page.locator('#app-chin').boundingBox();
    for(const box of boxes){assert(Math.abs(box.y+box.height/2-(boxes[0].y+boxes[0].height/2))<1,'controls align horizontally');assert(box.y>=chin.y&&box.y+box.height<=chin.y+chin.height,'controls fit inside the chin')}
    await app.page.locator('#app-view-toggle').click();
    const menu=app.page.locator('#app-view-menu');await menu.waitFor();
    const m=await menu.boundingBox();assert(m.y>=0&&m.y+m.height<=950,'the style menu opens fully inside the viewport');
    await app.page.keyboard.press('Escape');
    assert.equal(await app.page.locator('#app-chin .vote-button').count(),0,'voting is absent from the chin');
    await app.page.locator('#app-article-actions [data-item-action="save"]').click();
    assert(await waitFor(async()=>/unsave/i.test(await app.page.locator('#app-article-actions [data-item-action="save"]').textContent()),3000),'the real save control still saves');
    assert.deepEqual(app.errors,[]);
  }finally{await app.browser.close()}
});

for (const [width, hasTouch] of [[1600, false], [320, true]]) {
  test(`${width}px topic reading preserves the list toolbar and the compact Sources filter control`, {timeout: 20000}, async () => {
    const topic = {id: 'story:runtime-costs', kind: 'story', label: 'Runtime costs'};
    const pages = STORIES.slice(0, 2).map(({url}) => ({key: url.slice('https://'.length), topicIds: [topic.id]}));
    const app = await launchApp({
      sharedStore: true, viewport: {width, height: 850}, hasTouch, resubmissions: 1,
      settings: {sources: {hn: true}, frontPageMode: 'sources', sourceRefreshMinutes: 0, updateCheck: false},
      values: {
        'HNewhere:app_panes': {list: true, discussion: true},
        'HNewhere:frontpage_feed:/hn/front/': {
          timestamp: Date.now(), stories: STORIES.slice(0, 2).map(story => ({...story, source: 'hn', descendants: story.comments})),
        },
      },
      responses: [{match: url => url === 'https://topics.backchnnl.app/api/topics', json: {
        version: 1, generatedAt: new Date().toISOString(), topics: [topic], pages,
      }}],
    });
    try {
      const {page} = app;
      page.setDefaultTimeout(5000);
      const size = button => button.evaluate(node => [node, node.querySelector('svg')].map(part => {
        const {width, height} = part.getBoundingClientRect();
        return [width, height];
      }));
      await page.goto('https://backchnnl.app/');
      await page.getByRole('tab', {name: 'By topic', exact: true}).click();
      const card = page.locator('.app-topic-row').filter({hasText: topic.label});
      await card.click();
      await page.locator('.app-topic-article h1').getByText(topic.label, {exact: true}).waitFor();
      if (hasTouch) {
        await page.locator('#app[data-stage="article"]:not([data-moving])').waitFor();
        await page.locator('#app-bar-back').tap();
        await page.locator('#app[data-stage="list"]:not([data-moving])').waitFor();
      }
      assert(await card.isVisible());
      assert.equal(await page.getByRole('button', {name: 'Back to topics', exact: true}).isVisible(), false);
      await page.getByRole('tab', {name: 'By link', exact: true}).click();
      await page.locator('#app-list-body').getByRole('link', {name: STORIES[0].title, exact: true}).click();
      if (hasTouch) {
        await page.locator('#app[data-stage="article"]:not([data-moving])').waitFor();
        await page.locator('#app-bar-discussion').click();
        await page.locator('#app[data-stage="discussion"]:not([data-moving])').waitFor();
      }
      const sources = page.locator('#app-discussion-meta');
      await sources.getByRole('button', {name: /across 2 discussions/}).click();
      await sources.locator('[data-discussion-key] input').first().uncheck();
      const closeSize = await size(page.getByRole('button', {name: 'Show all discussions', exact: true}));
      assert.deepEqual(closeSize, [[15, 15], [12, 12]]);
      assert.deepEqual(app.errors, []);
    } finally {
      await app.browser.close();
    }
  });
}

for(const width of [390])test(`${width}px Reader retains its bottom-right mobile-style action column`,{timeout:20000},async()=>{
  const story = STORIES[1];
  const app = await launchApp({
    sharedStore: true, viewport: {width, height: 900}, votable: {[story.id]: true},
    settings: {sources: {hn: true}, frontPageMode: 'sources', sourceRefreshMinutes: 0, updateCheck: false},
    values: {
      'HNewhere:frontpage_feed:/hn/front/': {
        timestamp: Date.now(), stories: [{...story, source: 'hn', descendants: story.comments}],
      },
    },
  });
  try{
    await app.page.goto('https://backchnnl.app/');
    const row = app.page.locator('#app-list-body .app-row').filter({hasText: story.title});
    const more = row.getByRole('button', {name: 'More', exact: true});
    let menuBox;
    assert(await waitFor(async () => {
      menuBox = await more.evaluate(button => {
        const {width, right} = button.getBoundingClientRect();
        return {width, rightMargin: button.closest('.app-row').getBoundingClientRect().right - right};
      });
      return menuBox.width > 0;
    }, 4000), 'the row menu is visible before measuring its spacing');
    assert.deepEqual(menuBox, {width: 24, rightMargin: 16});
    await row.locator('.browse-title-link').click();
    const like=app.page.locator('#app-bar-like');
    await like.waitFor();
    await app.page.locator('#app-bar-view').waitFor();
    assert.equal(await app.page.locator('#app-bar-open').count(), 0);
    const controls = ['#app-bar-like', '#app-bar-view', '#app-bar-save', '#app-bar-discussion'];
    const boxes = await assertToolbarOrder(app.page, app.page.locator('#app-bar'), controls, 'y');
    for(const box of boxes)assert(Math.abs(box.x+box.width/2-(boxes[0].x+boxes[0].width/2))<1,'controls share a vertical center line');
    const bounds=await app.page.locator(width===390?'#app':'#app-article').boundingBox();
    assert(bounds.x+bounds.width-boxes[0].x-boxes[0].width>=8&&bounds.x+bounds.width-boxes[0].x-boxes[0].width<=18,'the column stays at the right edge');
    const [vote]=await Promise.all([app.context.waitForEvent('page'),like.click()]);
    await vote.waitForURL(target=>target.hostname==='news.ycombinator.com'&&new URLSearchParams(target.hash.slice(1)).get('action')==='up');
    assert.equal(new URLSearchParams(new URL(vote.url()).hash.slice(1)).get('item'),String(story.id));
    await vote.close();
    await app.page.locator('#app-bar-view').click();
    const original = app.page.getByRole('link', {name: 'Open the original page'});
    assert.equal(await original.getAttribute('target'), '_blank');
    assert.equal(await original.getAttribute('href'), story.url);
    await app.page.locator('#app-bar-view').click();
    await app.page.locator('#app-bar-discussion').click();
    const compose = app.page.getByRole('button', {name: 'Comment and note composer'});
    await compose.waitFor();
    const header = app.page.locator('#panel > header');
    assert.equal(await header.getByRole('button', {name: 'Comment and note composer'}).count(), 1);
    const field = app.page.locator('#app-discussion-compose textarea');
    assert.equal(await field.isVisible(), false);
    await compose.click();
    await field.waitFor();
    assert.equal(await compose.getAttribute('aria-expanded'), 'true');
    const metrics = await field.evaluate(node => ({
      input: parseFloat(getComputedStyle(node).fontSize),
      placeholder: parseFloat(getComputedStyle(node, '::placeholder').fontSize),
      padding: parseFloat(getComputedStyle(node).paddingBlockStart),
    }));
    assert(metrics.input >= 16 && metrics.placeholder < metrics.input && metrics.padding > 3);
    await field.fill('Keep the draft between openings');
    await compose.click();
    assert.equal(await field.isVisible(), false);
    await compose.click();
    assert.equal(await field.inputValue(), 'Keep the draft between openings');
    assert.deepEqual(app.errors,[]);
  }finally{await app.browser.close()}
});

test('phone Reader keeps the viewport edges clear while pulling to sync', {timeout: 15000}, async t => {
  const app = await launchApp({
    sharedStore: true, hasTouch: true, viewport: {width: 390, height: 844},
    settings: {sources: {hn: true}, frontPageMode: 'sources', sourceRefreshMinutes: 0, updateCheck: false},
    values: {
      'HNewhere:frontpage_feed:/hn/front/': {
        timestamp: Date.now(), stories: STORIES.map(story => ({...story, source: 'hn', descendants: story.comments})),
      },
    },
  });
  t.after(() => app.browser.close());
  const {page} = app;
  await page.emulateMedia({reducedMotion: 'reduce'});
  await page.goto('https://backchnnl.app/');
  await page.locator('#app-list-body .browse-title-link').first().waitFor();
  const viewport = page.locator('#app > .toast-viewport');
  const boxes = () => viewport.evaluate(node => node.getClientRects().length);
  assert.equal(await boxes(), 0, 'the notification wrapper adds no box on initial load');
  await page.evaluate(() => {
    const request = window.__gmXHR;
    window.__gmXHR = async options => {
      if (options.url === 'https://news.ycombinator.com/news') {
        await new Promise(resolve => { window.releasePullFeed = resolve; });
      }
      return request(options);
    };
  });
  const list = page.locator('#app-list');
  const canceled = await list.evaluate(node => {
    const touch = (type, y) => {
      const event = new Event(type, {bubbles: true, cancelable: true, composed: true});
      const point = {clientX: 120, clientY: y};
      Object.defineProperties(event, {
        touches: {value: type === 'touchend' ? [] : [point]},
        changedTouches: {value: [point]},
      });
      return node.dispatchEvent(event);
    };
    touch('touchstart', 150);
    const canceled = !touch('touchmove', 280);
    touch('touchend', 280);
    return canceled;
  });
  assert(canceled, 'the Reader handles the pull gesture');
  await page.waitForFunction(() => typeof window.releasePullFeed === 'function');
  const toast = viewport.locator('#toast');
  assert.equal(await toast.textContent(), 'Syncing…');
  assert(await waitFor(() => toast.evaluate(node => {
    const {top, width} = node.getBoundingClientRect();
    return getComputedStyle(node).position === 'fixed' && top > 0 && width < innerWidth * 0.9;
  }), 2000), 'the visible toast is inset and compact');
  assert.equal(await boxes(), 0, 'Sync feedback leaves the viewport edges clear');
  await page.evaluate(() => window.releasePullFeed());
  assert(await waitFor(async () => await toast.textContent() === 'Synced', 5000));
  assert.equal(await boxes(), 0, 'the viewport stays clear when pull Sync finishes');
  assert.deepEqual(app.errors, []);
});
