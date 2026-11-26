import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {frontPageHTML,launchApp,STORIES,waitFor} from './harness.mjs';

const script=async()=> (await readFile(process.env.BC_SCRIPT||new URL('../../HNewhere.user.js',import.meta.url),'utf8')).replace('const TOAST_BRIEF_MS = 1800;','const TOAST_BRIEF_MS = 300;').replace('const TOAST_DISMISS_MS = 5200;','const TOAST_DISMISS_MS = 300;');

test('Reader starts one automatic sync for a stale feed on arrival', {timeout:15000}, async () => {
  const lastAttemptAt = Date.now() - 6 * 60 * 1000;
  const key = 'HNewhere:frontpage_feed:/hn/front/';
  const feed = 'https://news.ycombinator.com/news';
  const app = await launchApp({sharedStore:true,
    settings:{sources:{hn:true},sourceRefreshMinutes:5,updateCheck:false},
    values:{[key]:{timestamp:lastAttemptAt,status:'ok',stories:[{...STORIES[0],source:'hn'}]}},
    responses:[{match:url=>url===feed,delay:1200,text:frontPageHTML(STORIES)}],
  });
  try {
    await app.page.goto('https://backchnnl.app/');
    const sync = app.page.locator('#app-list-sync');
    await sync.waitFor();
    assert(await waitFor(() => app.requests.some(({url})=>url===feed), 3000));
    assert.equal(await sync.getAttribute('aria-busy'), 'true');
    assert(await waitFor(() => app.store.get(key)?.lastSuccessAt > lastAttemptAt, 4000));
    assert(await waitFor(async () => (await sync.getAttribute('aria-busy')) !== 'true', 4000));
    await app.page.reload();
    await app.page.locator('#app-list-sync').waitFor();
    assert.equal(app.requests.filter(({url})=>url===feed).length, 1);
  } finally {await app.browser.close();}
});

const phone={hasTouch:true,viewport:{width:390,height:844}};
const hnURL='https://news.ycombinator.com/news';
const hnKey='HNewhere:frontpage_feed:/hn/front/';
const redditKey='HNewhere:frontpage_feed:/reddit/front/';
const notices={'HNewhere:reddit_read_window_notice':2};
const redditRefreshKey='HNewhere:reddit_shared_refresh';

async function syncResult(app, selector = '#toast'){
  const status = app.page.locator(selector);
  assert(await waitFor(async () => ['Synced','Partial sync'].includes(await status.textContent()), 6000));
  return status.textContent();
}

for(const fail of [false,true]) test(`automatic phone Sync reports ${fail?'a fresh failure':'success'} despite an old feed failure`,{timeout:12000},async()=>{
  const now=Date.now();
  const stale=now-6*60_000;
  const app=await launchApp({...phone,sharedStore:true,handler:'Userscripts',tabs:true,topHosts:['www.reddit.com'],
    settings:{sources:{hn:true,reddit:true},sourceRefreshMinutes:5,updateCheck:false},values:{...notices,
      [hnKey]:{timestamp:stale,status:'ok',stories:[{...STORIES[0],source:'hn'}]},
      [redditKey]:{timestamp:now,status:'unavailable',stories:[],retryAt:now+60_000},
    },responses:[{match:url=>url===hnURL,status:fail?503:200,text:fail?'Unavailable':frontPageHTML(STORIES)}]});
  try{
    await app.page.goto('https://backchnnl.app/');
    assert(await waitFor(()=>app.store.get(hnKey)?.lastAttemptAt>stale,4000),'Hacker News was attempted');
    assert.equal(app.store.get(redditKey)?.timestamp,now,'Reddit was still in its retry interval');
    assert.equal(app.context.pages().length,1);
    assert.equal(await syncResult(app),fail?'Partial sync':'Synced');
    assert.deepEqual(app.errors,[]);
  }finally{await app.browser.close()}
});

async function syncPhoneList(page){
  await page.locator('#app-list-heading-button').tap();
  await page.getByRole('menuitem',{name:'Sync',exact:true}).tap();
}

for (const surface of ['phone Reader', 'desktop Reader', 'Sidebar']) test(`${surface} Sync reports a feed failure after switching from Unread to All`, {timeout:18000}, async () => {
  const mobile = surface === 'phone Reader';
  const sidebar = surface === 'Sidebar';
  const readStory = STORIES[5];
  const readURL = new URL(readStory.url);
  const lastSuccessAt = Date.now() - 60_000;
  const app = await launchApp({
    ...(mobile && phone),
    ...(sidebar && {appHost: new URL(STORIES[0].url).hostname}),
    sharedStore: true,
    settings: {sources: {hn: true}, sourceRefreshMinutes: 0, updateCheck: false, autoOpenSidebar: sidebar},
    values: {
      [hnKey]: {timestamp: lastSuccessAt, lastSuccessAt, status: 'ok', stories: [STORIES[0], readStory].map(story => ({...story, source: 'hn'}))},
      'HNewhere:seen_comments': {['url:' + readURL.host + readURL.pathname]: Math.floor(lastSuccessAt / 1000)},
    },
  });
  const {page} = app;
  const sync = page.locator(sidebar ? '#browse-home-sync' : '#app-list-sync');
  const list = page.locator(sidebar ? '#browse-list' : '#app-list-body');
  const readRow = list.getByRole('link', {name: readStory.title, exact: true});
  try {
    await page.emulateMedia({reducedMotion: 'reduce'});
    await page.goto(sidebar ? STORIES[0].url : 'https://backchnnl.app/');
    if (sidebar) {
      await page.locator('#comments-content .comment[data-comment-id]').first().waitFor();
      await page.locator('#browse-toggle .wordmark-root').click();
      await page.locator('#panel.browsing').waitFor({timeout:5000});
    } else {
      await list.getByRole('link', {name: STORIES[0].title, exact: true}).first().waitFor({timeout:5000});
    }
    assert.equal(await readRow.count(), 0, 'Unread hides the previously read link');
    await page.evaluate(url => {
      const request = window.__gmXHR;
      window.__gmXHR = async options => {
        if (options.url !== url) return request(options);
        await new Promise(resolve => window.__releaseFeed = resolve);
        return {status: 503, finalUrl: url, responseHeaders: 'content-type: text/html', text: 'Unavailable'};
      };
    }, hnURL);
    if (mobile) await syncPhoneList(page);
    else await sync.click();
    await page.waitForFunction(() => typeof window.__releaseFeed === 'function', null, {timeout:5000});
    assert.equal(await sync.getAttribute('aria-busy'), 'true');
    const all = page.locator(sidebar ? '#browse-tab-all' : '#app-rail [data-app-view="all"]');
    await all[mobile ? 'tap' : 'click']();
    const selected = sidebar ? 'aria-selected' : 'aria-pressed';
    assert(await waitFor(async () => await all.getAttribute(selected) === 'true', 4000));
    await page.evaluate(() => window.__releaseFeed());
    assert.equal(await syncResult(app, sidebar ? '#header-subtitle' : '#toast'), 'Partial sync');
    assert.equal(app.store.get(hnKey).status, 'unavailable');
    assert.equal(app.store.get(hnKey).lastSuccessAt, lastSuccessAt);
    assert.equal(await readRow.count(), 1, 'the completed Sync preserves the All view');
    assert.deepEqual(app.errors, []);
  } finally { await app.browser.close(); }
});

const post={id:'fresh123',url:'https://framed.example.com/reddit',title:'A current Reddit feed story',author:'fixture',subreddit:'news',permalink:'/r/news/comments/fresh123/article/',num_comments:2,created_utc:Math.floor(Date.now()/1000)-60,score:20};
const listing={data:{children:[{kind:'t3',data:post}]}};

for (const {provider,searchHost,feedURL,settings,listing} of [
  {provider:'bsky',searchHost:'https://constellation.microcosm.blue/links/all?',
    feedURL:'https://public.api.bsky.app/xrpc/app.bsky.feed.getFeed?',
    settings:{frontPageMode:'topics',frontPageTopics:['technology']},listing:{feed:[]}},
  {provider:'mastodon',searchHost:'https://www.tootfinder.ch/rest/api/search/',
    feedURL:'https://mastodon.social/api/v1/trends/links?',settings:{frontPageMode:'sources'},listing:[]},
]) test('phone Sync refreshes '+provider+' feeds while its discussion search is rate limited',{timeout:20000},async()=>{
  const source=(await script()).replace('init().catch(console.error);',
    'window.__hasCooldown=()=>sourceReadCooldowns.size>0;init().catch(console.error);');
  const app=await launchApp({...phone,source,sharedStore:true,settings:{
    sources:{hn:true,[provider]:true},sourceRefreshMinutes:0,updateCheck:false,...settings,
  },responses:[
    {match:url=>url.startsWith(searchHost),status:429,headers:'Retry-After: 60',json:{error:'rate limited'}},
    {match:url=>url.startsWith(feedURL),status:200,json:listing},
  ]});
  try{
    await app.page.emulateMedia({reducedMotion:'reduce'});
    await app.page.goto('https://backchnnl.app/');
    await syncPhoneList(app.page);
    assert.equal(await syncResult(app),'Synced');
    await app.page.locator('#app-list-body .browse-title-link',{hasText:STORIES[0].title}).first().tap();
    await app.page.waitForFunction(()=>window.__hasCooldown(),null,{timeout:6000});
    assert.equal(app.requests.filter(({url})=>url.startsWith(searchHost)).length,1);
    const initialFeeds=app.requests.filter(({url})=>url.startsWith(feedURL)).length;
    await app.page.locator('#app-bar-back').tap();
    await syncPhoneList(app.page);
    assert.equal(await syncResult(app),'Synced');
    assert.equal(app.requests.filter(({url})=>url.startsWith(feedURL)).length,initialFeeds+1);
  }finally{await app.browser.close()}
});

test('a 429 with no Retry-After defers queued reads from the same feed host',{timeout:16000},async()=>{
  const isBlueskyFeed=url=>url.startsWith('https://public.api.bsky.app/xrpc/app.bsky.feed.getFeed?');
  const app=await launchApp({...phone,sharedStore:true,settings:{
    sources:{hn:true,bsky:true},frontPageMode:'topics',frontPageTopics:['world','us','technology','entertainment','sports','science'],
    sourceRefreshMinutes:0,updateCheck:false,
  },responses:[{match:isBlueskyFeed,status:429,json:{error:'rate limited'}}]});
  try{
    await app.page.goto('https://backchnnl.app/');
    await syncPhoneList(app.page);
    assert.equal(await syncResult(app),'Partial sync');
    const requests=app.requests.filter(({url})=>isBlueskyFeed(url));
    assert(requests.length>0&&requests.length<=3,'expected at most three in-flight reads, saw '+requests.length);
  }finally{await app.browser.close()}
});

test('phone Sync fetches combined Reddit topic feeds without redirecting to the homepage',{timeout:20000},async()=>{
  const topics=['entertainment','sports','science'];
  const expected=[
    '/r/entertainment%2Btelevision%2Bmovies%2Bgaming.json',
    '/r/nfl%2Bnba%2Bsoccer%2BCFB%2Bformula1%2BMMA%2Bbaseball%2Bhockey%2Bsports.json',
    '/r/science%2Bspace.json',
    '/r/popular.json',
  ];
  const app=await launchApp({...phone,sharedStore:true,handler:'Userscripts',tabs:true,topHosts:['www.reddit.com'],
    settings:{sources:{hn:true,reddit:true},frontPageMode:'topics',frontPageTopics:topics,frontPageIncludeTopLinks:true,
      sourceRefreshMinutes:0,updateCheck:false},values:notices});
  const paths=[];
  await app.context.route('https://www.reddit.com/**',route=>{
    const path=new URL(route.request().url()).pathname;
    if(path==='/') return route.fulfill({status:200,contentType:'text/html',body:'<title>Reddit fixture</title>'});
    if(path==='/api/me.json') return route.fulfill({status:200,json:{data:{name:'fixture'}}});
    paths.push(path);
    // A redirect with redirect: "error" rejects fetch like an aborted request.
    if(path.includes('+')) return route.abort();
    return route.fulfill({status:200,json:listing});
  });
  try{
    await app.page.goto('https://backchnnl.app/');
    await syncPhoneList(app.page);
    assert.equal(await syncResult(app),'Synced');
    assert.deepEqual(paths.sort(),expected.sort(),'the helper makes one listing request per topic or Popular');
    assert.equal(app.store.get('HNewhere:reddit_poll')?.until||0,0,'a good run leaves no source-wide retry delay');
    assert(await app.page.locator('#app-list-body .browse-title-link',{hasText:post.title}).count()>0);
    assert(await waitFor(()=>app.context.pages().length===1,5000),'the helper closes after delivering the listings');
    assert.deepEqual(app.errors,[]);
  }finally{await app.browser.close()}
});

test('phone Sync keeps a completed Reddit listing when another listing hits a rate limit', {timeout:22000}, async () => {
  const cooldownKey = 'HNewhere:reddit_poll';
  const bridgeKey = /^HNewhere:bridge_result:[0-9a-f]{32}$/;
  const replyKey = /^HNewhere:bridge_result:[0-9a-f]{32}:\d+$/;
  const successPath = '/r/science%2Bspace.json';
  const limitedPath = '/r/technology%2BFuturology.json';
  const successKey = 'HNewhere:frontpage_feed:science/reddit/subreddits/science+space';
  const app = await launchApp({
    ...phone, sharedStore: true, handler: 'Userscripts', tabs: true, topHosts: ['www.reddit.com'],
    settings: {sources: {hn: true, reddit: true}, frontPageMode: 'topics', frontPageTopics: ['science', 'technology'], sourceRefreshMinutes: 0, updateCheck: false},
    values: notices,
  });
  const {page, context, store} = app;
  const paths = [];
  let helpers = 0;
  context.on('page', () => helpers++);
  let releaseReader;
  const readerReady = new Promise(resolve => releaseReader = resolve);
  await context.exposeFunction('__waitForRedditReplies', () => readerReady);
  await page.addInitScript(pattern => {
    const readyKey = new RegExp(pattern);
    const getStore = window.__gmStore;
    window.__gmStore = async (op, key, value) => {
      if (op === 'get' && readyKey.test(key)) await window.__waitForRedditReplies();
      return getStore(op, key, value);
    };
  }, bridgeKey.source);
  await context.route('https://www.reddit.com/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/') return route.fulfill({status: 200, contentType: 'text/html', body: '<title>Reddit fixture</title>'});
    if (path === '/api/me.json') return route.fulfill({status: 200, json: {data: {name: 'fixture'}}});
    paths.push(path);
    if (path === successPath) return route.fulfill({status: 200, json: listing});
    assert.equal(path, limitedPath);
    return route.fulfill({status: 429, headers: {'Retry-After': '60'}, json: {message: 'Rate limited'}});
  });
  try {
    await page.emulateMedia({reducedMotion: 'reduce'});
    await page.goto('https://backchnnl.app/');
    await syncPhoneList(page);
    const replies = () => [...store].filter(([key, value]) => replyKey.test(key) && value.phase === 'response').map(([, value]) => value.response);
    assert(await waitFor(() => replies().length === 2 && store.get(cooldownKey)?.until > Date.now(), 7000),
      'the helper publishes both listings before Reader consumes them');
    assert.deepEqual(replies().map(response => response.status).sort(), [200, 429]);
    assert(replies().some(response => response.ok && response.json?.data?.children?.[0]?.data?.title === post.title));
    const cooldown = store.get(cooldownKey);
    releaseReader();

    const article = page.locator('#app-list-body').getByRole('link', {name: post.title, exact: true});
    assert.equal(await syncResult(app), 'Partial sync');
    assert.equal(await article.count(), 1, 'Reader shows the successful listing during the cooldown');
    assert(store.get(successKey).stories.some(story => story.title === post.title), 'the successful listing is cached');
    assert.deepEqual(store.get(cooldownKey), cooldown, 'reading the listing preserves the provider cooldown');
    assert(await waitFor(() => store.get(redditRefreshKey)?.state === 'done' && context.pages().length === 1, 5000));

    await page.locator('#toast').evaluate(node => {
      window.__syncMessages = [];
      new MutationObserver(() => window.__syncMessages.push(node.textContent)).observe(node, {childList: true, characterData: true, subtree: true});
    });
    await syncPhoneList(page);
    assert(await waitFor(() => page.evaluate(() => window.__syncMessages.includes('Syncing…') && window.__syncMessages.includes('Partial sync')), 5000));
    assert.equal(await article.count(), 1);
    assert.deepEqual(paths.sort(), [successPath, limitedPath].sort(), 'a second Sync during the cooldown makes no listing request');
    assert.equal(helpers, 1, 'the second Sync does not open a new Reddit helper');
    assert.deepEqual(app.errors, []);
  } finally {
    releaseReader();
    await app.browser.close();
  }
});

test('a Reddit discussion redirect leaves Popular available for the next phone Sync',{timeout:22000},async()=>{
  const app=await launchApp({...phone,sharedStore:true,handler:'Userscripts',tabs:true,topHosts:['www.reddit.com'],
    settings:{sources:{hn:true,reddit:true},sourceRefreshMinutes:0,frontPageMode:'sources',updateCheck:false},values:notices});
  const redirectModes=[];
  let listings=0;
  await app.context.exposeFunction('__recordTestRedditRedirect',mode=>redirectModes.push(mode));
  await app.context.addInitScript(article=>{
    if(location.origin!=='https://www.reddit.com')return;
    const fetchReddit=window.fetch.bind(window);
    window.fetch=async (path,options={})=>{
      if(typeof path!=='string')return fetchReddit(path,options);
      const url=new URL(path,location.origin);
      if(url.pathname!=='/api/info.json'||url.searchParams.get('url')!==article) return fetchReddit(path,options);
      await window.__recordTestRedditRedirect(options.redirect||'follow');
      if(options.redirect==='error')throw new TypeError('A redirect is disallowed');
      return {type:'opaqueredirect',status:0,ok:false};
    };
  },STORIES[0].url);
  await app.context.route('https://www.reddit.com/**',route=>{
    const path=new URL(route.request().url()).pathname;
    if(path==='/')return route.fulfill({status:200,contentType:'text/html',body:'<title>Reddit fixture</title>'});
    if(path==='/api/me.json')return route.fulfill({status:200,json:{data:{name:'fixture'}}});
    if(path==='/r/popular.json')listings++;
    return route.fulfill({status:200,json:listing});
  });
  try{
    await app.page.emulateMedia({reducedMotion:'reduce'});
    await app.page.goto('https://backchnnl.app/');
    await syncPhoneList(app.page);
    assert.equal(await syncResult(app),'Synced');
    assert(await waitFor(()=>app.store.get(redditRefreshKey)?.state==='done'&&app.context.pages().length===1,5000));
    await app.page.locator('#app-list-body .browse-title-link',{hasText:STORIES[0].title}).first().tap();
    assert(await waitFor(()=>redirectModes.length>0&&app.store.get(redditRefreshKey)?.state==='done'&&app.context.pages().length===1,8000));
    const before=listings;
    await app.page.locator('#app-bar-back').tap();
    await syncPhoneList(app.page);
    assert.equal(await syncResult(app),'Synced');
    assert.equal(listings,before+1,'the next Sync contacts Reddit Popular');
    assert(redirectModes.every(mode=>mode==='manual'),'the helper receives the redirect without following it');
    assert.equal(app.store.get('HNewhere:reddit_poll')?.until||0,0);
  }finally{await app.browser.close()}
});

test('manual phone Sync reports successful Reddit and then an actual feed failure',{timeout:20000},async()=>{
  const app=await launchApp({...phone,sharedStore:true,handler:'Userscripts',tabs:true,topHosts:['www.reddit.com'],
    settings:{sources:{hn:true,reddit:true},sourceRefreshMinutes:0,updateCheck:false},values:notices});
  let fail=false;
  let redditFeedReads=0;
  await app.context.route('https://www.reddit.com/**',route=>{
    const path=new URL(route.request().url()).pathname;
    if(path==='/') return route.fulfill({status:200,contentType:'text/html',body:'<title>Reddit fixture</title>'});
    if(path==='/api/me.json') return route.fulfill({status:200,json:{data:{name:'fixture'}}});
    assert.equal(path,'/r/popular.json');
    redditFeedReads++;
    return route.fulfill({status:fail?503:200,json:fail?{message:'Unavailable'}:listing});
  });
  try{
    await app.page.goto('https://backchnnl.app/');
    await syncPhoneList(app.page);
    assert.equal(await syncResult(app),'Synced');
    assert.equal(await app.page.locator('#app-list-body .browse-title-link',{hasText:post.title}).count(),1);
    assert(await waitFor(()=>app.context.pages().length===1,5000),'the successful helper closed');
    fail=true;
    await syncPhoneList(app.page);
    assert.equal(await syncResult(app),'Partial sync');
    assert.equal(redditFeedReads,2,'both manual Syncs attempted Reddit');
    assert.equal(await app.page.locator('#app-list-body .browse-title-link',{hasText:post.title}).count(),1,'saved Reddit articles stay visible after a failed refresh');
    assert.deepEqual(app.errors,[]);
  }finally{await app.browser.close()}
});

test('manual phone list Sync succeeds while an earlier Reddit discussion lookup fails',{timeout:22000},async()=>{
  const original=await readFile(process.env.BC_SCRIPT||new URL('../../HNewhere.user.js',import.meta.url),'utf8');
  const seam='else batch.failed = true;';
  assert(original.includes(seam));
  const source=original.replace(seam, 'else { batch.failed = true; if (response.status === 404) window.__articleLookupFailed = true; }');
  const saved=Date.now();
  const app=await launchApp({...phone,source,sharedStore:true,handler:'Userscripts',tabs:true,topHosts:['www.reddit.com'],
    settings:{sources:{hn:true,reddit:true},sourceRefreshMinutes:0,updateCheck:false},values:{...notices,
      [hnKey]:{timestamp:saved,status:'ok',stories:[{...STORIES[0],source:'hn'}]},
    }});
  let releaseArticle,releaseFeed;
  const articleGate=new Promise(resolve=>{releaseArticle=resolve});
  const feedGate=new Promise(resolve=>{releaseFeed=resolve});
  let articleRead=false;
  let feedRead=false;
  await app.context.route('https://www.reddit.com/**',async route=>{
    const url=new URL(route.request().url());
    if(url.pathname==='/')return route.fulfill({status:200,contentType:'text/html',body:'<title>Reddit fixture</title>'});
    if(url.pathname==='/api/me.json')return route.fulfill({status:200,json:{data:{name:'fixture'}}});
    if(url.pathname==='/r/popular.json'){
      feedRead=true;await feedGate;
      return route.fulfill({status:200,json:listing});
    }
    if(url.pathname==='/api/info.json'&&url.searchParams.get('url')===STORIES[0].url){
      articleRead=true;await articleGate;
      return route.fulfill({status:404,json:{message:'Not found'}});
    }
    return route.fulfill({status:200,json:{data:{children:[]}}});
  });
  try{
    await app.page.emulateMedia({reducedMotion:'reduce'});
    await app.page.goto('https://backchnnl.app/');
    await app.page.locator('#app-list-body .browse-title-link',{hasText:STORIES[0].title}).tap();
    assert(await waitFor(()=>articleRead,5000),'the visible article started a Reddit discussion lookup');
    await app.page.locator('#app-bar-back').tap();
    await syncPhoneList(app.page);
    assert(await waitFor(()=>feedRead,5000),'the manual list Sync read the actual Reddit feed');
    releaseArticle();
    await app.page.waitForFunction(()=>window.__articleLookupFailed,null,{timeout:4000});
    releaseFeed();
    assert.equal(await syncResult(app),'Synced');
    assert.equal(await app.page.locator('#app-list-body .browse-title-link',{hasText:post.title}).count(),1);
    assert.deepEqual(app.errors,[]);
  }finally{releaseArticle();releaseFeed();await app.browser.close()}
});

test('phone list sync refreshes the feed without rechecking the hidden article', {timeout:15000}, async () => {
  const app = await launchApp({...phone,sharedStore:true,
    settings:{sources:{hn:true},sourceRefreshMinutes:0,updateCheck:false}});
  try {
    const {page} = app;
    await page.emulateMedia({reducedMotion:'reduce'});
    await page.goto('https://backchnnl.app/');
    await syncPhoneList(page);
    await page.locator('#app-list-body .browse-title-link').first().tap();
    await page.locator('#comments-content .comment').first().waitFor({state:'attached'});
    await page.locator('#app-bar-back').tap();
    await page.evaluate(() => {
      const request = window.__gmXHR;
      window.__gmXHR = options => options.url.includes('hn.algolia.com/api/v1/search') ?
        {status:503,finalUrl:options.url,responseHeaders:'content-type: application/json',text:'{}'} : request(options);
    });
    await syncPhoneList(page);
    assert(await waitFor(() => app.requests.filter(({url})=>url===hnURL).length===2, 5000));
    assert(await waitFor(async () => await page.locator('#app-list-sync').getAttribute('aria-busy')!=='true', 5000));
    assert.equal(await page.locator('#toast').textContent(), 'Synced');
  } finally {await app.browser.close();}
});

for(const failed of [false,true])test(`Reader shows transient sync progress followed by ${failed?'Partial sync':'Synced'}`,{timeout:15000},async()=>{
  const app=await launchApp({source:await script(),sharedStore:true,settings:{sources:{hn:true},frontPageMode:'sources',updateCheck:false}});
  try{
    await app.page.goto('https://backchnnl.app/');
    await app.page.locator('#app-list-body .browse-title-link').first().waitFor();
    await app.page.evaluate(failed=>{
      const request=window.__gmXHR;
      window.__gmXHR=async options=>{
        if(options.url==='https://news.ycombinator.com/news'){
          await new Promise(resolve=>window.__releaseFeed=resolve);
          if(failed)return{status:503,finalUrl:options.url,responseHeaders:'content-type: text/html',text:'Unavailable'};
        }
        return request(options);
      };
    },failed);
    await app.page.locator('#app-list-sync').click();
    await app.page.waitForFunction(()=>window.__releaseFeed);
    assert.equal(await app.page.locator('#toast').textContent(),'Syncing…');
    await new Promise(resolve=>setTimeout(resolve,500));
    assert.equal(await app.page.locator('#toast').evaluate(node=>node.classList.contains('is-showing')),false,'progress expires even while a source is still running');
    assert.equal(await app.page.locator('#app-list-sync').getAttribute('aria-busy'),'true','the Sync button keeps indicating the ongoing work');
    await app.page.evaluate(()=>window.__releaseFeed());
    const text=failed?'Partial sync':'Synced';
    assert(await waitFor(async()=>await app.page.locator('#toast').textContent()===text,3000),'completion reports the whole sync outcome');
    assert(await waitFor(async()=>await app.page.locator('#app-list-sync').getAttribute('aria-busy')!=='true',3000));
    await new Promise(resolve=>setTimeout(resolve,500));
    assert.equal(await app.page.locator('#toast').evaluate(node=>node.classList.contains('is-showing')),false,'the final result also dismisses itself');
    assert(await app.page.locator('#app-list-body .browse-title-link').count()>0,'the saved article list remains available');
    assert.deepEqual(app.errors,[]);
  }finally{await app.browser.close()}
});

test('a Reddit transport failure is a transient Partial sync result',{timeout:15000},async()=>{
  const source=(await script()).replace('init().catch(console.error);',`window.__failedRead=()=>finishRedditReadBatch({nonce:'fixture-failed',actionId:redditReadActionId,sequence:0,unresponsive:true,startedSyncRun:syncRunId});init().catch(console.error);`);
  const app=await launchApp({source,sharedStore:true,settings:{sources:{hn:true},frontPageMode:'sources',updateCheck:false}});
  try{
    await app.page.goto('https://backchnnl.app/');await app.page.locator('#app-list-body .browse-title-link').first().waitFor();
    await app.page.evaluate(()=>window.__failedRead());
    assert.equal(await app.page.locator('#toast').textContent(),'Partial sync');
    assert.equal(await app.page.locator('#toast .toast-action').count(),0,'sync outcomes use the standard Sync control for another attempt');
    await new Promise(resolve=>setTimeout(resolve,500));
    assert.equal(await app.page.locator('#toast').evaluate(node=>node.classList.contains('is-showing')),false);
    assert.deepEqual(app.errors,[]);
  }finally{await app.browser.close()}
});

test('waiting for Reddit sign-in does not create a persistent instruction toast',{timeout:10000},async()=>{
  const source=(await script()).replace('init().catch(console.error);',`window.__waitForRedditLogin=async()=>{const now=Date.now(),batch={nonce:'fixture-login',created:now,expires:now+900};await save(BRIDGE_RESULT_PREFIX+batch.nonce,{source:REDDIT_READ_SOURCE,nonce:batch.nonce,ts:now,phase:'login',requestId:0});window.__loginWait=waitRedditReadReply(batch,0);};init().catch(console.error);`);
  const app=await launchApp({source,sharedStore:true,settings:{sources:{hn:true},updateCheck:false}});
  try{
    await app.page.goto('https://backchnnl.app/');await app.page.locator('#app-list-body .browse-title-link').first().waitFor();
    await app.page.evaluate(()=>window.__waitForRedditLogin());
    await new Promise(resolve=>setTimeout(resolve,500));
    assert.equal(await app.page.locator('#toast').evaluate(node=>node.classList.contains('is-showing')),false,'a source waiting for authentication cannot leave instructions on screen');
    await app.page.evaluate(()=>window.__loginWait);
    assert.deepEqual(app.errors,[]);
  }finally{await app.browser.close()}
});

test('a new Sidebar Sync briefly reports an unresolved cleanup after its previous result expired',{timeout:15000},async()=>{
  const source=(await script()).replace('init().catch(console.error);',`window.__pendingCleanup=()=>{pendingReadHelpers.add('fixture-pending');showReadHelperCleanupNotice();};init().catch(console.error);`);
  const app=await launchApp({source,appHost:new URL(STORIES[0].url).hostname,sharedStore:true,settings:{sources:{hn:true},autoOpenSidebar:true,frontPageMode:'sources',updateCheck:false}});
  try{
    await app.page.goto(STORIES[0].url);await app.page.locator('#comments-content .comment[data-comment-id]').first().waitFor();
    await app.page.locator('#browse-toggle .wordmark-root').click();
    assert(await waitFor(async()=>await app.page.locator('#panel.browsing').count()===1,3000),'the test is in the inline Front Pages sync view');
    await app.page.locator('#browse-home-sync').waitFor();
    await app.page.evaluate(()=>window.__pendingCleanup());
    assert.equal(await app.page.locator('#toast').textContent(),'Partial sync');
    assert(await waitFor(async()=>!await app.page.locator('#toast').evaluate(node=>node.classList.contains('is-showing')),2000));
    await app.page.locator('#browse-home-sync').click();
    assert(await waitFor(async()=>await app.page.locator('#browse-home-sync').getAttribute('aria-busy')!=='true'&&await app.page.locator('#toast').evaluate(node=>node.classList.contains('is-showing')),3000),'a new attempt has its own visible terminal result');
    assert.equal(await app.page.locator('#toast').textContent(),'Partial sync');
    assert(await waitFor(async()=>!await app.page.locator('#toast').evaluate(node=>node.classList.contains('is-showing')),2000));
    assert.deepEqual(app.errors,[]);
  }finally{await app.browser.close()}
});

test('searching Settings for Sync schedule opens the Sources section',{timeout:15000},async()=>{
  const app=await launchApp({sharedStore:true,settings:{sources:{hn:true},frontPageMode:'sources',updateCheck:false}});
  try{
    await app.page.goto('https://backchnnl.app/');
    await app.page.locator('#app-rail-search').click();
    await app.page.locator('#app-search-input').fill('Sync schedule');
    await app.page.locator('#app-search-results .app-search-item').filter({hasText:'Sync schedule'}).first().click({timeout:3000});
    await app.page.locator('#app-settings-modal').waitFor({state:'visible',timeout:3000});
    assert.equal(await app.page.locator('#app-settings-modal').getAttribute('data-section'),'sources','the setting search result points to its own section');
    assert.equal(await app.page.locator('#setting-source-refresh').isVisible(),true);
    assert.deepEqual(app.errors,[]);
  }finally{await app.browser.close()}
});

for(const [name,reader,width] of [['Reader',true,1440],['mobile Reader',true,390],['Sidebar',false,1440]])test(`${name} Sync schedule uses a custom dropdown with saved values and the requested layout`,{timeout:20000},async()=>{
  const app=await launchApp({viewport:{width,height:844},...(reader?{}:{appHost:new URL(STORIES[0].url).hostname}),sharedStore:true,settings:{sources:{hn:true},frontPageMode:'sources',autoOpenSidebar:!reader,sourceRefreshMinutes:15,updateCheck:false}});
  try{
    await app.page.goto(reader?'https://backchnnl.app/':STORIES[0].url);
    await app.page.locator('#settings-toggle').click();
    await app.page.locator('[data-settings-section="sources"]').click();
    const row=app.page.locator('.settings-sync-schedule');
    await row.waitFor({timeout:3000});
    const toggle=row.getByRole('button',{name:/Sync schedule/});
    assert.equal(await row.locator('select').count(),0,'the visible schedule control is an app dropdown');
    assert.match(await toggle.innerText(),/Every 15 minutes/);
    assert.equal(await row.locator('.appearance-row-hint').textContent(),'Determine how often sources should automatically sync.');
    const geometry=await row.evaluate(element=>{
      const box=node=>{const r=node.getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,bottom:r.bottom}};
      return{row:box(element),label:box(element.querySelector('.appearance-row-label')),hint:box(element.querySelector('.appearance-row-hint')),toggle:box(element.querySelector('button')),previous:box(element.previousElementSibling)};
    });
    assert(geometry.toggle.x-geometry.label.right>=12,'the label and dropdown have a minimum horizontal gap');
    assert(Math.abs(geometry.row.right-geometry.toggle.right)<2,'the dropdown aligns to the far right');
    assert(geometry.hint.y>=geometry.label.bottom&&geometry.hint.y-geometry.label.bottom<=4,'the hint sits tightly below the label');
    assert(geometry.label.y-geometry.previous.bottom>=10,'the schedule is separated from the preceding radio group');
    await toggle.click();
    const list=row.getByRole('listbox');
    assert.equal(await list.isVisible(),true);
    assert.equal(await list.getByRole('option',{selected:true}).innerText(),'Every 15 minutes');
    const bounds=await list.evaluate(menu=>{const box=menu.getBoundingClientRect(),content=menu.closest('.app-settings-content').getBoundingClientRect();return{top:box.top,bottom:box.bottom,clipTop:content.top,clipBottom:content.bottom}});
    assert(bounds.top>=bounds.clipTop&&bounds.bottom<=bounds.clipBottom,'all dropdown choices fit inside the visible settings content');
    const manual=await list.getByRole('option',{name:'Manual',exact:true}).boundingBox();
    await app.page.mouse.click(manual.x+manual.width/2,manual.y+manual.height/2);
    assert(await waitFor(()=>app.store.get('HNewhere:settings')?.sourceRefreshMinutes===0,3000));
    await list.waitFor({state:'hidden',timeout:2000});
    assert.match(await toggle.innerText(),/Manual/);
    await toggle.focus();await toggle.press('ArrowDown');
    await app.page.keyboard.press('Home');await app.page.keyboard.press('Enter');
    assert(await waitFor(()=>app.store.get('HNewhere:settings')?.sourceRefreshMinutes===5,3000),'keyboard selection saves the numeric setting');
    await toggle.click();await app.page.keyboard.press('Escape');
    await list.waitFor({state:'hidden',timeout:2000});
    assert.equal(await toggle.evaluate(node=>node.getRootNode().activeElement===node),true,'Escape returns focus to the dropdown');
    await toggle.click();await app.page.locator('#app-settings-heading').click();
    await list.waitFor({state:'hidden',timeout:2000});
    await app.page.reload();await app.page.locator('#settings-toggle').click();
    await app.page.locator('[data-settings-section="sources"]').click();
    assert.match(await app.page.locator('.settings-sync-schedule').getByRole('button',{name:/Sync schedule/}).innerText(),/Every 5 minutes/,'the schedule survives reload');
    assert.deepEqual(app.errors,[]);
  }finally{await app.browser.close()}
});
