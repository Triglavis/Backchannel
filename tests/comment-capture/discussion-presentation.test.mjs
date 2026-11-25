import test from 'node:test';
import assert from 'node:assert/strict';
import {launchApp, STORIES, NOW, waitFor} from './harness.mjs';
import {discussionFixture} from './fixtures.mjs';

const url=STORIES[0].url;
const redditValues={'HNewhere:reddit_tier':{tier:'archive',timestamp:Date.now()}};

async function settled(app){
  assert(await waitFor(async()=>await app.page.locator('#comments-content .comment[data-comment-id]').count()>0&&await app.page.locator('#comments-content .discussion-loading').count()===0&&await app.page.locator('.discussion-progress-strip:not([aria-hidden="true"])').count()===0,15000),'the discussion finishes rendering');
}

test('Reader removes its single-discussion banner when a second source arrives',{timeout:30000},async()=>{
  const fixture=discussionFixture(url,{rootCount:2,replyRoots:0});
  const app=await launchApp({sharedStore:true,handler:'Tampermonkey',settings:{sources:{hn:true,reddit:true},frontPageMode:'sources',updateCheck:false},values:redditValues,responses:fixture.responses});
  try{
    app.page.setDefaultTimeout(6000);
    await app.page.goto('https://backchnnl.app/');
    await app.page.locator('#app-list-body .browse-title-link').first().waitFor();
    await app.page.evaluate(()=>{
      const request=window.__gmXHR;
      window.__gmXHR=async options=>{
        if(options.url.includes('/api/posts/search')&&!window.__releaseRedditDiscovery)await new Promise(resolve=>window.__releaseRedditDiscovery=resolve);
        return request(options);
      };
    });
    await app.page.locator('#app-list-body .browse-title-link',{hasText:STORIES[0].title}).first().click();
    await app.page.locator('#comments-content .comment[data-comment-id^="hn:"]').first().waitFor();
    assert(await waitFor(async()=>await app.page.locator('#filter-banner.app-pinned:not(.hidden)').count()===1,5000),'the first source initially has its single-discussion banner');
    const byline = app.page.locator('#filter-banner');
    const hn = byline.getByRole('link',{name:'Hacker News',exact:true});
    assert(await hn.isVisible(),'the single discussion starts with its source link');
    assert.match(await byline.innerText(),/Hacker News.*30 comments/s);
    assert.equal(await byline.getByRole('button').count(),0,'the byline offers a close icon only when a filter is active');
    await app.page.locator('#app-discussion-meta .page-header-disclosure').click();
    assert.equal(await app.page.locator('#app-discussion-meta .source-menu').isVisible(),true);
    const hnDiscussions = app.page.getByRole('button',{name:/Hacker News discussions/i});
    assert.equal(await hnDiscussions.count(),1,'the source has a disclosure independent of its checkbox');
    await hnDiscussions.focus();
    await app.page.waitForFunction(()=>window.__releaseRedditDiscovery);
    await app.page.evaluate(()=>window.__releaseRedditDiscovery());
    await app.page.locator('#comments-content .comment[data-comment-id="reddit:root0"]').waitFor();
    await settled(app);
    assert.equal(await app.page.locator('#app-discussion-meta [data-select-all] input').isChecked(),true,'All sources is selected when the stale pinned banner appears');
    assert(await app.page.locator('#comments-content .comment[data-comment-id^="hn:"]:not(.comment-filter-hidden)').count()>0);
    assert.equal(await app.page.locator('#filter-banner:not(.hidden)').count(),0,'an unfiltered discussion with multiple sources has no focus banner');
    assert(await app.page.locator('#comments-content .comment[data-comment-id^="hn:"]').count()>0);
    assert.equal(await app.page.locator('#app-discussion-meta .source-menu').isVisible(),true,'the open Sources menu stays open when the discussion choices update');
    assert.equal(await hnDiscussions.getAttribute('aria-expanded'),'true','an expanded platform stays open as the source list grows');
    assert(await hnDiscussions.evaluate(button=>button.matches(':focus')),'keyboard focus stays on the source disclosure during discovery');
    const menu = app.page.locator('#app-discussion-meta .source-menu');
    const all = menu.getByRole('checkbox', {name:'All sources',exact:true});
    await all.uncheck();
    const empty = app.page.locator('#comments-content .app-discussion-empty').getByText('No discussions selected.', {exact:true});
    assert(await empty.isVisible(), 'unchecking all sources shows the discussion empty state');
    assert.equal(await app.page.locator('#filter-banner').isVisible(), false);
    assert.equal(await app.page.locator('#comments-content .comment[data-comment-id]:not(.comment-filter-hidden)').count(), 0);
    assert.equal(await empty.evaluate(node => getComputedStyle(node).justifyContent), 'center');
    const first = menu.locator('[data-discussion-key="reddit:fixture0"] input');
    await menu.getByRole('button',{name:/Reddit discussions/i}).click();
    await first.check();
    assert.equal(await empty.isVisible(), false);
    assert(await waitFor(async()=>await app.page.locator('#filter-banner:not(.hidden)').count()===1,3000),'choosing a discussion deliberately still shows focus');
    const source = byline.getByRole('link',{name:'r/community0',exact:true});
    const clear = byline.getByRole('button',{name:'Show all discussions',exact:true});
    assert.equal(await source.getAttribute('href'),'https://www.reddit.com' + fixture.posts[0].permalink);
    assert(await clear.isVisible());
    assert.equal(await clear.textContent(),'','the clear button has no visible text');
    assert.equal(await clear.locator('svg').count(),1,'the clear button displays the close icon');
    const [titleBox, clearBox, sourceBox, checkboxBox] = await Promise.all([
      app.page.locator('#panel .header-static-title').boundingBox(),
      clear.boundingBox(), source.boundingBox(), first.boundingBox(),
    ]);
    assert.equal(clearBox.width,checkboxBox.width,'the close button is as wide as a Sources checkbox');
    assert.equal(clearBox.height,checkboxBox.height,'the close button is as tall as a Sources checkbox');
    assert(Math.abs(clearBox.x - titleBox.x) < 1,'the filtered byline starts at the Discussion title inset');
    assert(clearBox.x + clearBox.width <= sourceBox.x,'the close icon precedes the source');
    assert(clearBox.y + clearBox.height > sourceBox.y && sourceBox.y + sourceBox.height > clearBox.y,'the source and close icon are on the same line');
    assert.equal(await app.page.locator('#comments-content .comment[data-comment-id^="hn:"]:not(.comment-filter-hidden)').count(),0,'a focused discussion actually filters the other source');
    const group = menu.locator('.choice-sub').filter({has:app.page.locator('[data-discussion-key="reddit:fixture0"]')}).locator('[data-source-group] input');
    assert(await all.evaluate(input=>input.indeterminate),'All sources marks a partial selection');
    assert(await group.evaluate(input=>input.indeterminate),'the Reddit group marks a partial selection');
    await group.click();
    assert(await group.isChecked(),'checking a group selects its discussions');
    assert.equal(await byline.getByRole('link').count(),fixture.posts.length,'each selected discussion has its own source link');
    assert.equal(await byline.getByRole('link',{name:'r/community1',exact:true}).getAttribute('href'),'https://www.reddit.com' + fixture.posts[1].permalink);
    assert(await app.page.locator('#comments-content .comment[data-comment-id="reddit:root1"]').isVisible());
    assert.equal(await app.page.locator('#comments-content .comment[data-comment-id^="hn:"]:not(.comment-filter-hidden)').count(),0,'checking a group leaves other sources excluded');
    assert(await menu.isVisible(),'checkbox changes leave the menu open');
    await app.page.locator('#app-discussion-meta .page-header-disclosure').click();
    await clear.click();
    assert(await waitFor(async()=>await app.page.locator('#filter-banner:not(.hidden)').count()===0,3000),'the close icon clears the discussion filter');
    await app.page.locator('#app-discussion-meta .page-header-disclosure').click();
    assert(await all.isChecked());
    assert.deepEqual(app.errors,[]);
  }finally{await app.browser.close()}
});

test('the phone Reader discussion byline opens the original discussion in a new tab',{timeout:20000},async()=>{
  const app=await launchApp({
    sharedStore:true, hasTouch:true, viewport:{width:390,height:844},
    settings:{sources:{hn:true},frontPageMode:'sources',updateCheck:false},
  });
  try{
    const {page}=app;
    page.setDefaultTimeout(5000);
    await page.goto('https://backchnnl.app/');
    await page.locator('#app-list-body .browse-title-link',{hasText:STORIES[0].title}).first().click();
    await page.locator('#app[data-stage="article"]:not([data-moving])').waitFor();
    await page.locator('#app-bar-discussion').click();
    await settled(app);
    const source=page.locator('#filter-banner').getByRole('link',{name:'Hacker News',exact:true});
    const permalink='https://news.ycombinator.com/item?id='+STORIES[0].id;
    assert(await source.isVisible(),'single-source attribution is available in the phone Discussion panel');
    const [titleBox, sourceBox] = await Promise.all([
      page.locator('#panel .header-static-title').boundingBox(), source.boundingBox(),
    ]);
    assert(Math.abs(sourceBox.x - titleBox.x) < 1,'the single-source byline aligns with the Discussion title');
    const divider = await page.locator('#filter-banner').evaluate(banner => {
      const comments = banner.closest('#comments');
      const start = comments.getBoundingClientRect().left + comments.clientLeft;
      const {left, right} = banner.getBoundingClientRect();
      return {left: left - start, right: start + comments.clientWidth - right, border: getComputedStyle(banner).borderBottomWidth};
    });
    assert.equal(divider.border,'1px','the byline has a horizontal divider');
    assert(Math.abs(divider.left) < 1 && Math.abs(divider.right) < 1,'the byline divider spans the Discussion pane');
    assert.equal(await source.getAttribute('href'),permalink);
    assert.equal(await source.getAttribute('target'),'_blank');
    const [tab]=await Promise.all([app.context.waitForEvent('page',{timeout:5000}),source.click()]);
    await tab.waitForURL(permalink);
    assert.equal(await page.locator('#app[data-stage="discussion"]').count(),1);
    assert.equal(await page.locator('#app-article-open').getAttribute('href'),STORIES[0].url);
    await tab.close();
    assert.deepEqual(app.errors,[]);
  }finally{await app.browser.close()}
});

for (const sidebar of [true, false]) {
  test(`the ${sidebar ? 'Sidebar keeps the title above the focused byline' : 'phone Reader gives the focused quote room above its divider'}`, {timeout:20000}, async(t)=>{
    const app = await launchApp({
      topHosts: [new URL(url).hostname],
      ...(sidebar ? {} : {hasTouch: true, viewport: {width: 390, height: 844}}),
      settings: {autoOpenSidebar: true, sources: {hn: true}, updateCheck: false},
    });
    t.after(()=>app.browser.close());
    const {page} = app;
    page.setDefaultTimeout(6000);
    await page.goto(sidebar ? url : 'https://backchnnl.app/');
    if (!sidebar) {
      await page.locator('#app-list-body .browse-title-link').first().click();
      await page.locator('#app-bar-discussion').click();
    }
    await settled(app);
    const banner = page.locator('#filter-banner');
    const focus = page.locator(`#comments-content .comment[data-comment-id="hn:${sidebar ? 900119 : 900100}"] .focus-link`);
    await focus.click();
    const close = banner.getByRole('button', {name: 'Show all comments', exact: true});
    await close.waitFor();
    const source = banner.getByRole('link', {name: 'Hacker News', exact: true});
    assert.equal(await source.count(), 1, 'the discussion source is linked in the byline');
    assert.equal(await source.getAttribute('target'), '_blank');
    assert(await banner.getByText('Focused comment', {exact: true}).isVisible());
    const layout = await banner.evaluate(node=>{
      const comments = node.closest('#comments');
      const {left, right, top, bottom} = node.getBoundingClientRect();
      const frame = comments.getBoundingClientRect();
      const details = comments.querySelector('.submission-details').getBoundingClientRect();
      const list = comments.querySelector('.top-level-comments').getBoundingClientRect();
      const quote = node.querySelector('.filter-banner-quote').getBoundingClientRect();
      return {
        start: left-frame.left-comments.clientLeft,
        end: frame.left+comments.clientLeft+comments.clientWidth-right,
        top: top-frame.top+comments.scrollTop,
        afterDetails: top >= details.bottom - 1,
        beforeComments: bottom <= list.top + 1,
        quoteGap: bottom - quote.bottom - parseFloat(getComputedStyle(node).borderBottomWidth),
        border: getComputedStyle(node).borderBottomWidth,
      };
    });
    assert.equal(layout.border, '1px');
    assert(Math.abs(layout.start)<1 && Math.abs(layout.end)<1, 'the divider spans the discussion pane');
    if (sidebar) {
      assert(layout.afterDetails && layout.beforeComments, 'the byline sits between the discussion details and the comments');
      assert(await waitFor(()=>page.locator('#comments').evaluate(node=>node.scrollTop <= 1)), 'focusing a lower comment reveals the title above the byline');
    } else {
      assert(Math.abs(layout.top-12)<1, 'the byline uses the same top inset even when the story details are visible');
      assert(layout.quoteGap >= 12, 'the quote has bottom padding before the horizontal rule');
    }
    await close.click();
    await close.waitFor({state: 'hidden'});
    assert(await focus.isVisible());
    assert.deepEqual(app.errors, []);
  });
}

test('an open Reader source group keeps keyboard focus when the first comments finish loading', {timeout:25000}, async(t)=>{
  const app = await launchApp({sharedStore:true,settings:{sources:{hn:true},frontPageMode:'sources',updateCheck:false}});
  t.after(()=>app.browser.close());
  const {page} = app;
  await page.goto('https://backchnnl.app/');
  const article = page.locator('#app-list-body .browse-title-link',{hasText:STORIES[0].title}).first();
  await article.waitFor();
  await page.evaluate(()=>{
    const request = window.__gmXHR;
    const gate = new Promise(release=>{ window.__releaseSourceThread = release; });
    window.__gmXHR = async options=>{
      if (options.url.endsWith('/v0/item/9001.json')) await gate;
      return request(options);
    };
  });
  await article.click();
  const trigger = page.locator('#app-discussion-meta .page-header-disclosure');
  await trigger.press('Enter');
  const menu = page.getByRole('group',{name:'Filter discussions by source'});
  const toggle = menu.getByRole('button',{name:/Hacker News discussions/i});
  await toggle.press('Space');
  await page.evaluate(()=>window.__releaseSourceThread());
  await settled(app);
  assert(await menu.isVisible(),'loading the first comments keeps the Source menu open');
  assert.equal(await toggle.getAttribute('aria-expanded'),'false');
  assert(await toggle.evaluate(button=>button.matches(':focus')));
  assert.deepEqual(app.errors,[]);
});

test('Reader source groups can fold and reopen independently of their selection', {timeout:30000}, async(t)=>{
  const fixture = discussionFixture(url,{rootCount:2,replyRoots:0});
  const app = await launchApp({sharedStore:true,handler:'Tampermonkey',settings:{sources:{hn:true,reddit:true},frontPageMode:'sources',updateCheck:false},values:redditValues,responses:fixture.responses});
  t.after(()=>app.browser.close());
  const {page} = app;
  await page.goto('https://backchnnl.app/');
  await page.locator('#app-list-body .browse-title-link',{hasText:STORIES[0].title}).first().click();
  await page.locator('#comments-content .comment[data-comment-id="reddit:root0"]').waitFor();
  await settled(app);
  const trigger = page.locator('#app-discussion-meta .page-header-disclosure');
  await trigger.press('Enter');
  const menu = page.getByRole('group',{name:'Filter discussions by source'});
  const thread = menu.locator('[data-discussion-key="reddit:fixture0"] input');
  const platform = menu.getByRole('checkbox',{name:'Reddit',exact:true});
  const all = menu.getByRole('checkbox',{name:'All sources',exact:true});
  const toggle = menu.getByRole('button',{name:/Reddit discussions/i});
  assert(await thread.isHidden(),'large source lists open at their platform headings');
  assert(await platform.isChecked());
  await platform.uncheck();
  assert(await thread.isHidden(),'selecting a platform does not expand it');
  assert(await all.evaluate(box=>box.indeterminate));
  await toggle.press('Enter');
  assert.equal(await toggle.getAttribute('aria-expanded'),'true');
  assert(await thread.isVisible());
  assert(!(await thread.isChecked()));
  await thread.check();
  await toggle.press('Space');
  assert(await thread.isHidden());
  assert(await thread.isChecked());
  assert(await platform.evaluate(box=>box.indeterminate),'a folded platform still communicates its partial selection');
  await toggle.press('Escape');
  assert(await trigger.evaluate(button=>button.matches(':focus')));
  await trigger.press('Enter');
  assert.equal(await toggle.getAttribute('aria-expanded'),'false');
  assert(await toggle.evaluate(button=>button.matches(':focus')),'keyboard reopening returns to the last platform');
  await all.check();
  assert(await platform.isChecked(),'All includes hidden discussions');
  assert(await thread.isHidden());
  await toggle.click();
  await page.keyboard.press('Escape');
  assert(await trigger.evaluate(button=>button.matches(':focus')),'a pointer disclosure still accepts Escape');
  assert.deepEqual(app.errors,[]);
});

for(const pendingFocus of [false,true])test(`Reader clears ${pendingFocus?'a pending comment focus':'the previous focus banner'} as soon as another article is selected`,{timeout:25000},async()=>{
  const app=await launchApp({sharedStore:true,settings:{sources:{hn:true},frontPageMode:'sources',updateCheck:false}});
  try{
    await app.page.goto('https://backchnnl.app/');
    await app.page.locator('#app-list-body .browse-title-link',{hasText:STORIES[0].title}).first().click();
    await settled(app);
    assert.equal(await app.page.locator('#filter-banner:not(.hidden)').count(),1);
    await app.page.evaluate(()=>{
      const request=window.__gmXHR;
      window.__gmXHR=async options=>{
        await new Promise(resolve=>{(window.__releaseNextRequests||=[]).push(resolve)});
        return request(options);
      };
    });
    if(pendingFocus){
      await app.page.locator('#comments-content .focus-link').first().evaluate((element,title)=>{
        element.click();
        [...element.getRootNode().querySelectorAll('#app-list-body .browse-title-link')].find(link=>link.textContent.trim()===title).click();
      },STORIES[1].title);
    }else await app.page.locator('#app-list-body .browse-title-link',{hasText:STORIES[1].title}).first().click();
    await app.page.waitForFunction(()=>window.__releaseNextRequests?.length>0);
    assert.equal(await app.page.locator('#filter-banner:not(.hidden)').count(),0,'the previous banner cannot return in the provisional header while the next story loads');
    assert.equal(await app.page.locator('#filter-banner-quote').textContent(),'','old attribution is reset with the article');
    if(pendingFocus){
      await new Promise(resolve=>setTimeout(resolve,250));
      assert.equal(await app.page.locator('#filter-banner:not(.hidden)').count(),0,'the previous article’s queued animation cannot repaint its focus banner');
      assert.equal(await app.page.locator('#filter-banner-quote').textContent(),'');
      assert.equal(await app.page.locator('#comments-content').evaluate(node=>node.classList.contains('comments-transitioning')),false);
    }
    assert.deepEqual(app.errors,[]);
  }finally{await app.browser.close()}
});

for(const mode of ['Sidebar','Reader'])test(`${mode} Sources shows a single reported count without partial-refresh diagnostics`,{timeout:30000},async()=>{
  const fixture=discussionFixture(url,{rootCount:2,replyRoots:0});
  const tree=fixture.responses.find(response=>response.match('https://fixture/api/comments/tree?link_id=t3_fixture0'));
  const sidebar=mode==='Sidebar';
  const app=await launchApp({...(sidebar?{appHost:new URL(url).hostname}:{}),sharedStore:true,handler:'Tampermonkey',settings:{sources:{hn:!sidebar,reddit:true},autoOpenSidebar:sidebar,frontPageMode:'sources',updateCheck:false},values:redditValues,responses:fixture.responses});
  try{
    await app.page.goto(sidebar?url:'https://backchnnl.app/');
    if(!sidebar)await app.page.locator('#app-list-body .browse-title-link',{hasText:STORIES[0].title}).first().click();
    await app.page.locator('#comments-content .comment[data-comment-id="reddit:root0"]').waitFor();
    await settled(app);
    const disclosure=app.page.locator(sidebar?'#comments-content .page-header-disclosure':'#app-discussion-meta .page-header-disclosure');
    await disclosure.click();
    const menu=app.page.locator(sidebar?'#comments-content .source-menu':'#app-discussion-meta .source-menu');
    await menu.getByRole('button',{name:/Reddit discussions/i}).click();
    const entry=menu.locator('.source-menu-entry').filter({has:app.page.locator('[data-discussion-key="reddit:fixture0"]')});
    assert.equal((await entry.locator('.source-menu-hint').innerText()).trim(),'2156 comments','only the source comment total is presented');
    assert.equal(await menu.locator('.discussion-source-status').count(),0,'partial load diagnostics are not displayed');
    await disclosure.click();
    tree.json={data:fixture.trees.get('fixture0').slice(0,1)};
    await app.page.locator(sidebar?'#browse-home-sync':'#app-list-sync').click();
    assert(await waitFor(async()=>await app.page.locator(sidebar?'#browse-home-sync':'#app-list-sync').getAttribute('aria-busy')!=='true',15000));
    await settled(app);
    assert.equal(await app.page.locator('#comments-content .comment[data-comment-id="reddit:root1"]').count(),1,'comments omitted by the partial refresh stay available');
    await disclosure.click();
    assert.equal(await menu.locator('.discussion-source-status').count(),0,'retaining saved comments does not add a partial-refresh announcement');
    assert.doesNotMatch(await menu.innerText(),/loaded|refresh|retry/i);
    assert.deepEqual(app.errors,[]);
  }finally{await app.browser.close()}
});

for(const commentsAvailable of [false,true])test(`Sources ${commentsAvailable?'keeps real comments despite a zero metadata count':'omits a discussion with no comments'}`,{timeout:20000},async()=>{
  const now=new Date().toISOString();
  const post={post:{id:71,name:'A matching article',url,published:now,creator_id:4},creator:{name:'reader',actor_id:'https://lemmy.world/u/reader'},community:{name:'empty',actor_id:'https://lemmy.world/c/empty'},counts:{comments:0,score:1}};
  const comments=commentsAvailable?[{comment:{id:72,post_id:71,creator_id:4,content:'A real comment despite stale counts',published:now,path:'0.72'},creator:post.creator,counts:{score:1}}]:[];
  const app=await launchApp({sharedStore:true,settings:{sources:{hn:true,lemmy:true},frontPageMode:'sources',updateCheck:false},responses:[
    {match:path=>path.includes('lemmy.world/api/v3/search'),json:{posts:[post]}},
    {match:path=>path.includes('lemmy.world/api/v3/comment/list'),json:{comments}},
  ]});
  try{
    await app.page.goto('https://backchnnl.app/');
    await app.page.locator('#app-list-body .browse-title-link',{hasText:STORIES[0].title}).first().click();
    await settled(app);
    await app.page.locator('#app-discussion-meta .page-header-disclosure').click();
    const entry=app.page.locator('#app-discussion-meta .source-menu-entry').filter({has:app.page.locator('[data-discussion-key="lemmy:71"]')});
    assert.equal(await entry.count(),commentsAvailable?1:0,'only a discussion that can contribute comments is selectable');
    if(commentsAvailable){
      assert.equal(await app.page.locator('#comments-content .comment[data-comment-id="lemmy:72"]').count(),1);
      assert.equal((await entry.locator('.source-menu-hint').innerText()).trim(),'1 comment');
      await app.page.locator('#app-discussion-meta [data-select-all] input').uncheck();
      await entry.locator('input').check();
      assert(await waitFor(async()=>await app.page.locator('#filter-banner:not(.hidden)').count()===1,3000));
      assert.match(await app.page.locator('#filter-banner .app-discussion-byline').textContent(),/\b1 comment\b/,'focusing the source uses the same meaningful comment count');
    }else{
      const source = app.page.locator('#filter-banner').getByRole('link',{name:'Hacker News',exact:true});
      assert.equal(await source.isVisible(),true,'the single remaining discussion can still be opened at its source');
      assert.equal(await source.getAttribute('href'),'https://news.ycombinator.com/item?id=9001');
    }
    assert.doesNotMatch(await app.page.locator('#app-discussion-meta .source-menu').innerText(),/\b0 comments\b/);
    assert.deepEqual(app.errors,[]);
  }finally{await app.browser.close()}
});

test('Sidebar shows the remaining discussion details when an empty source is omitted',{timeout:20000},async()=>{
  const post={post:{id:71,name:'An empty match',url,published:new Date().toISOString()},creator:{name:'reader'},community:{name:'empty'},counts:{comments:0}};
  const app=await launchApp({appHost:new URL(url).hostname,sharedStore:true,settings:{sources:{hn:true,lemmy:true},autoOpenSidebar:true,updateCheck:false},responses:[
    {match:path=>path.includes('lemmy.world/api/v3/search'),json:{posts:[post]}},
    {match:path=>path.includes('lemmy.world/api/v3/comment/list'),json:{comments:[]}},
  ]});
  try{
    await app.page.goto(url);
    await settled(app);
    const details=app.page.locator('#comments-content .submission-detail[data-discussion-key="hn:9001"]');
    assert(await waitFor(()=>details.isVisible()),'the source post details stay visible without an extra filter selection');
    assert.equal(await app.page.locator('#comments-content .source-menu [data-discussion-key="lemmy:71"]').count(),0);
    assert.deepEqual(app.errors,[]);
  }finally{await app.browser.close()}
});

test('correcting a stale source count preserves the unread sorting control',{timeout:20000},async()=>{
  const now=new Date().toISOString();
  const creator={name:'reader',actor_id:'https://lemmy.world/u/reader'};
  const post={post:{id:71,name:'A matching article',url,published:now},creator,community:{name:'stale'},counts:{comments:0}};
  const app=await launchApp({appHost:new URL(url).hostname,sharedStore:true,settings:{sources:{hn:true,lemmy:true},autoOpenSidebar:true,newCommentsFirst:true,updateCheck:false},values:{'HNewhere:seen_comments':{'hn:9001':NOW-3600,'lemmy:71':NOW-3600}},responses:[
    {match:path=>path.includes('lemmy.world/api/v3/search'),json:{posts:[post]}},
    {match:path=>path.includes('lemmy.world/api/v3/comment/list'),json:{comments:[{comment:{id:72,post_id:71,content:'A new comment',published:now,path:'0.72'},creator,counts:{score:1}}]}},
  ]});
  try{
    await app.page.goto(url);
    await app.page.locator('#comments-content .comment[data-comment-id="lemmy:72"]').waitFor();
    await settled(app);
    const sort=app.page.locator('#comment-sort');
    const menu=app.page.locator('#comment-sort-options');
    const unread=menu.getByRole('menuitemcheckbox',{name:'Prioritize unread comments',exact:true});
    assert.equal(await app.page.locator('#sort-new-first').isVisible(),false,'the unread control is inside the dropdown');
    await sort.click();
    assert.equal(await menu.getByRole('menuitemradio',{name:'Best',exact:true}).getAttribute('aria-checked'),'true');
    assert.equal(await menu.locator('[role="separator"] + [role="menuitemcheckbox"]').count(),1,'a divider separates the toggle from the sort choices');
    assert.equal(await unread.getAttribute('aria-checked'),'true','count reconciliation preserves the unread preference');
    await app.page.keyboard.press('End');
    assert(await unread.evaluate(node=>node.matches(':focus')),'the unread toggle is reachable from the keyboard');
    await app.page.keyboard.press('Space');
    assert(await waitFor(()=>app.store.get('HNewhere:settings')?.newCommentsFirst===false),'the toggle saves the preference');
    await app.page.reload();
    await app.page.locator('#comments-content .comment[data-comment-id="lemmy:72"]').waitFor();
    await settled(app);
    await sort.click();
    assert.equal(await menu.getByRole('menuitemradio',{name:'Best',exact:true}).getAttribute('aria-checked'),'true','toggling unread keeps the selected sort order');
    assert.equal(await unread.getAttribute('aria-checked'),'false','the unread preference persists');
    assert.deepEqual(app.errors,[]);
  }finally{await app.browser.close()}
});
