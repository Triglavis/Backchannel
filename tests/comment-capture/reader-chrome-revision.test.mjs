import test from 'node:test';
import assert from 'node:assert/strict';
import {launchApp,STORIES,waitFor} from './harness.mjs';

const settings={sources:{hn:true},frontPageMode:'sources',updateCheck:false};
async function ready(width=1600,story=STORIES[0]){
 const app=await launchApp({sharedStore:true,viewport:{width,height:950},settings,votable:{[STORIES[0].id]:'updown'}});
 try{
  await app.page.goto('https://backchnnl.app/');
  await app.page.locator('#app-list-body .browse-title-link').filter({hasText:story.title}).first().click();
  await app.page.locator('#comments-content .comment[data-comment-id]').first().waitFor();
  return app;
 }catch(error){await app.browser.close();throw error}
}

test('desktop Discussion shows the mobile total to the right and follows the selected story',{timeout:20000},async()=>{
 const app=await ready();
 try{
  const desktop=app.page.locator('#app-toggle-discussion .rail-badge');
  const mobile=app.page.locator('#app-bar-discussion .rail-badge');
  assert.equal(await desktop.count(),1,'desktop exposes the discussion count');
  assert.equal(await desktop.textContent(),'30');
  assert.equal(await desktop.textContent(),await mobile.textContent());
  const geometry=await app.page.locator('#app-toggle-discussion').evaluate(node=>{
   const icon=node.querySelector('svg').getBoundingClientRect(),badge=node.querySelector('.rail-badge').getBoundingClientRect(),button=node.getBoundingClientRect();
   return{iconRight:icon.right,badgeLeft:badge.left,badgeRight:badge.right,buttonRight:button.right,badgeHeight:badge.height};
  });
  assert(geometry.badgeLeft>=geometry.iconRight+3,'the total sits beside the icon');
  assert(geometry.badgeRight<=geometry.buttonRight&&geometry.badgeHeight>0,'the count fits its hit target');
  const buttons=await app.page.locator('#app-list-sync, #app-mark-read, #app-discussion-meta .page-header-disclosure').evaluateAll(nodes=>nodes.map(node=>{
   const {width,height}=node.getBoundingClientRect(),style=getComputedStyle(node);
   const radius=style.borderTopLeftRadius;
   return{id:node.id||node.className,rounded:radius==='50%'||parseFloat(radius)>=Math.min(width,height)/2,color:style.borderTopColor,border:style.borderTopWidth};
  }));
  for(const button of buttons){
   assert(button.rounded,`${button.id} is circular or pill-shaped`);
   assert.equal(button.border,'1px');
   assert.equal(button.color,'rgb(214, 214, 214)');
  }
  await app.page.locator('#app-list-body .browse-title-link').filter({hasText:STORIES[7].title}).first().click();
  assert(await waitFor(async()=>await desktop.textContent()==='3',4000),'the count follows the next story');
  assert.equal(await desktop.textContent(),await mobile.textContent());
  assert.deepEqual(app.errors,[]);
 }finally{await app.browser.close()}
});

test('Next in queue follows the article inside the Reader scroller',{timeout:20000},async()=>{
 const [next,current]=STORIES;
 const app=await launchApp({sharedStore:true,viewport:{width:1600,height:950},settings:{...settings,sourceRefreshMinutes:0},values:{
  'HNewhere:queue':[current,next].map((story,i)=>({...story,source:'hn',addedAt:i+1})),
 }});
 try{
  const {page}=app;
  page.setDefaultTimeout(5000);
  await page.goto('https://backchnnl.app/');
  await page.locator('#app-rail [data-app-view="queue"]').click();
  await page.locator('#app-list-body').getByRole('link',{name:current.title,exact:true}).click();
  const pane=page.locator('#app-article-body[data-mode="reader"]');
  await pane.waitFor();
  const queue=page.locator('#next-up');
  await queue.getByRole('link',{name:next.title,exact:true}).waitFor();
  assert.equal(await page.locator('#panel #next-up').count(),0,'the discussion does not contain the queue footer');
  assert(await queue.evaluate(node=>node.previousElementSibling?.matches('slot[name="reader"]')),'the queue follows the full article in the same scroller');
  await queue.getByRole('link',{name:next.title,exact:true}).click();
  assert.equal(await page.locator('#app-article-open').getAttribute('href'),next.url);
  await queue.waitFor({state:'hidden'});
  assert(await waitFor(()=>app.store.get('HNewhere:queue')?.every(entry=>entry.readAt)));
  assert.deepEqual(app.errors,[]);
 }finally{await app.browser.close()}
});

test('Next in queue scrolls into view after the full embedded article',{timeout:20000},async()=>{
 const [current,next]=[STORIES[0],STORIES[4]];
 const app=await launchApp({sharedStore:true,viewport:{width:1600,height:950},settings:{...settings,sourceRefreshMinutes:0},values:{
  'HNewhere:queue':[current,next].map((story,i)=>({...story,source:'hn',addedAt:i+1})),
 }});
 try{
  const {page}=app;
  page.setDefaultTimeout(5000);
  await page.goto('https://backchnnl.app/');
  await page.locator('#app-rail [data-app-view="queue"]').click();
  await page.locator('#app-list-body').getByRole('link',{name:current.title,exact:true}).click();
  const article=page.locator('#app-article');
  const footer=article.locator('#next-up');
  const link=footer.getByRole('link',{name:next.title,exact:true});
  await link.waitFor();
  await article.locator('#app-article-body[data-mode="frame-agent"]').waitFor();
  const articleBox=await article.boundingBox();
  const footerTop=(await footer.boundingBox()).y;
  assert(footerTop>=articleBox.y+articleBox.height-1,'the queue starts below the article viewport');

  const frame=article.frameLocator('.app-article-frame');
  assert(await waitFor(()=>frame.locator('html').evaluate(root=>innerHeight>1000&&root.scrollHeight<=innerHeight+1),5000),'the embedded document can be read using the article scroller');
  await link.scrollIntoViewIfNeeded();
  const after=await link.boundingBox();
  assert(after.y>=articleBox.y&&after.y+after.height<=articleBox.y+articleBox.height+1,'the queue link scrolls into the article viewport');
  await link.click();
  assert.equal(await page.locator('#app-article-open').getAttribute('href'),next.url);
  assert.deepEqual(app.errors,[]);
 }finally{await app.browser.close()}
});

test('Aa opens the current original page without an external button in the chin',{timeout:20000},async()=>{
 const app=await ready();
 try{
  assert.equal(await app.page.locator('#app-chin [aria-label="Open the original page"]').count(),0,'the chin no longer has an external action');
  await app.page.locator('#app-view-toggle').click();
  const original=app.page.locator('#app-view-menu a').filter({hasText:'Open the original page'});
  assert.equal(await original.count(),1,'Style includes an original-page link');
  assert.equal(await original.getAttribute('href'),STORIES[0].url);
  const [tab]=await Promise.all([app.context.waitForEvent('page'),original.click()]);
  await tab.waitForURL(STORIES[0].url);await tab.close();
  await app.page.locator('#app-list-body .browse-title-link').filter({hasText:STORIES[7].title}).first().click();
  await app.page.locator('#app-view-toggle').click();
  assert.equal(await original.getAttribute('href'),STORIES[7].url,'the menu follows the selected story');
  assert.deepEqual(app.errors,[]);
 }finally{await app.browser.close()}
});

test('Front Pages kebab opens its own original page while another article stays selected',{timeout:20000},async()=>{
 const app=await ready();
 try{
  const row=app.page.locator('#app-list-body .browse-row').filter({has:app.page.locator('.browse-title-link').filter({hasText:STORIES[7].title})}).first();
  await row.locator('.browse-more').click();
  const original=app.page.locator('#app-row-menu a').filter({hasText:'Open in new tab'});
  assert.equal(await original.count(),1,'the row menu provides a native original-page link');
  assert.equal(await original.getAttribute('href'),STORIES[7].url);
  await original.focus();
  const [tab]=await Promise.all([app.context.waitForEvent('page'),app.page.keyboard.press('Enter')]);
  await tab.waitForURL(STORIES[7].url);await tab.close();
  assert(await waitFor(()=>app.store.get('HNewhere:last')?.ids?.[0]===String(STORIES[7].id),1200),'the external page receives its own discussion IDs');
  assert(await waitFor(async()=>!await app.page.locator('#app-row-menu').isVisible(),1000),'the row menu finishes dismissing after the link opens');
  assert.equal(await app.page.locator('#app-article-open').getAttribute('href'),STORIES[0].url,'opening a row externally does not replace the selected article');
  assert.deepEqual(app.errors,[]);
 }finally{await app.browser.close()}
});

test('moving original-page access into Aa preserves its keyboard shortcut',{timeout:15000},async()=>{
 const app=await ready();
 try{
  await app.page.locator('#app-view-toggle').focus();
  const opened=app.context.waitForEvent('page',{timeout:2500});
  await app.page.keyboard.press('o');
  const tab=await opened;await tab.waitForURL(STORIES[0].url);await tab.close();
  assert.deepEqual(app.errors,[]);
 }finally{await app.browser.close()}
});

test('keyboard users enter both article menus and return to their openers',{timeout:15000},async()=>{
 const app=await ready(1336);
 try{
  const style=app.page.locator('#app-view-toggle');
  await style.focus();await app.page.keyboard.press('Enter');
  assert(await app.page.locator('#app-view-menu').evaluate(menu=>menu.contains(menu.getRootNode().activeElement)),'opening Aa places focus inside its controls');
  let reached=false;
  for(let i=0;i<12;i++){
   if(await app.page.locator('#app-article-open').evaluate(link=>link.getRootNode().activeElement===link)){reached=true;break}
   await app.page.keyboard.press(process.env.ENGINE==='webkit'?'Alt+Tab':'Tab');
  }
  assert(reached,'Tab reaches the original-page link through the actual Style controls');
  await app.page.keyboard.press('Escape');
  assert(await style.evaluate(node=>node.getRootNode().activeElement===node));
  const more=app.page.locator('#app-list-body .browse-more').first();
  await more.focus();await app.page.keyboard.press('Enter');
  const menu=app.page.locator('#app-row-menu');
  assert(await menu.evaluate(node=>node.querySelector('[role="menuitem"]')===node.getRootNode().activeElement),'the row menu starts at its first item');
  await app.page.keyboard.press('End');
  assert(await menu.evaluate(node=>[...node.querySelectorAll('[role="menuitem"]')].at(-1)===node.getRootNode().activeElement),'End reaches the final action');
  await app.page.keyboard.press('ArrowDown');
  assert(await menu.evaluate(node=>node.getRootNode().activeElement===node.querySelector('[role="menuitem"]')),'ArrowDown wraps to the first action');
  await app.page.keyboard.press('Escape');
  assert(await more.evaluate(node=>node.getRootNode().activeElement===node),'Escape returns to the row opener');
  assert.deepEqual(app.errors,[]);
 }finally{await app.browser.close()}
});

test('middle-clicking a row original preserves its discussion context and dismisses the menu',{timeout:15000},async()=>{
 const app=await ready();
 try{
  const row=app.page.locator('#app-list-body .browse-row').filter({has:app.page.locator('.browse-title-link').filter({hasText:STORIES[7].title})}).first();
  await row.locator('.browse-more').click();
  const link=app.page.locator('#app-row-menu a');
  const [tab]=await Promise.all([app.context.waitForEvent('page',{timeout:2500}),link.click({button:'middle'})]);
  await tab.waitForURL(STORIES[7].url);await tab.close();
  assert(await waitFor(()=>app.store.get('HNewhere:last')?.ids?.[0]===String(STORIES[7].id),1200),'middle-click preserves the opened row context');
  assert(await waitFor(async()=>!await app.page.locator('#app-row-menu').isVisible(),1000),'middle-click dismisses the row menu');
  assert.deepEqual(app.errors,[]);
 }finally{await app.browser.close()}
});

test('an article menu keeps a temporary Front Pages preview open until its focus leaves',{timeout:15000},async()=>{
 const app=await launchApp({sharedStore:true,viewport:{width:1100,height:950},settings,values:{'HNewhere:app_panes':{list:false,discussion:true}}});
 try{
  await app.page.goto('https://backchnnl.app/');
  assert(await waitFor(async()=>!await app.page.locator('#app-list').isVisible(),2000),'the saved collapsed preference has loaded');
  await app.page.locator('#app-rail [data-app-view="source:hn"]').click();
  assert(await waitFor(()=>app.page.locator('#app').evaluate(node=>!node.classList.contains('list-moving')),2000),'the rail preview finishes opening before keyboard activation');
  const more=app.page.locator('#app-list-body .browse-more').first();
  await more.focus();await app.page.keyboard.press('Enter');
  assert(await app.page.locator('#app-row-menu').evaluate(node=>node.contains(node.getRootNode().activeElement)));
  await app.page.mouse.move(1000,400);await app.page.waitForTimeout(500);
  assert.equal(await app.page.locator('#app-list').isVisible(),true,'the associated menu holds the temporary panel open');
  await app.page.keyboard.press('Escape');
  assert(await more.evaluate(node=>node.getRootNode().activeElement===node));
  await app.page.locator('#app-toggle-list').focus();
  assert(await waitFor(async()=>!await app.page.locator('#app-list').isVisible(),2000),'leaving the menu and panel lets the preview collapse');
  assert.equal(app.store.get('HNewhere:app_panes').list,false,'using the menu does not pin the temporary panel');
  assert.deepEqual(app.errors,[]);
 }finally{await app.browser.close()}
});

test('a resized Discussion stays beside the article throughout Front Pages motion',{timeout:20000},async()=>{
 const app=await ready(1336);
 try{
  await app.page.locator('#app-toggle-list').click();
  assert(await waitFor(()=>app.page.locator('#app').evaluate(node=>!node.classList.contains('list-moving')),2000));
  const handle=await app.page.locator('#panel #resize-handle').boundingBox();
  await app.page.mouse.move(handle.x+handle.width/2,handle.y+100);await app.page.mouse.down();
  await app.page.mouse.move(handle.x-540,handle.y+100,{steps:4});await app.page.mouse.up();
  const panel=await app.page.locator('#panel').boundingBox();
  assert(panel.width>850,'the real resize gesture exercises a capped Discussion');
  const frames=await app.page.locator('#app').evaluate(async node=>{
   const root=node.getRootNode(),start=performance.now(),frames=[];
   const record=()=>{const article=root.querySelector('#app-article').getBoundingClientRect(),panel=root.querySelector('#panel').getBoundingClientRect();frames.push({article:article.width,gap:panel.left-article.right})};
   record();root.querySelector('#app-toggle-list').click();
   await new Promise(resolve=>{const tick=()=>{record();if(performance.now()-start<360)requestAnimationFrame(tick);else resolve()};requestAnimationFrame(tick)});
   return frames;
  });
  assert(frames.every(frame=>Math.abs(frame.article-frames[0].article)<=1),'the article keeps its minimum width while the capped Discussion and list move together');
  assert(frames.every(frame=>Math.abs(frame.gap)<=1),'the article and Discussion keep a shared edge');
  assert.deepEqual(app.errors,[]);
 }finally{await app.browser.close()}
});

test('panel reversals and concurrent toggles settle to the latest state after resizing',{timeout:20000},async()=>{
 const app=await ready();
 try{
  await app.page.locator('#app').evaluate(async node=>{
   const root=node.getRootNode(),click=pane=>root.querySelector('#app-toggle-'+pane).click(),frame=()=>new Promise(requestAnimationFrame);
   click('list');click('discussion');await frame();await frame();click('list');click('discussion');await frame();await frame();click('list');
  });
  await app.page.setViewportSize({width:1100,height:950});
  assert(await waitFor(()=>app.page.locator('#app').evaluate(node=>!node.classList.contains('list-moving')&&!node.classList.contains('discussion-moving')),2000));
  assert.equal(await app.page.locator('#app-list').isVisible(),false,'the last list request remains closed');
  assert.equal(await app.page.locator('#panel').isVisible(),true,'the last discussion request remains open');
  const before=await app.page.locator('#panel').boundingBox();
  await app.page.locator('#app-toggle-list').click();
  assert(await waitFor(()=>app.page.locator('#app').evaluate(node=>!node.classList.contains('list-moving')),2000));
  const after=await app.page.locator('#panel').boundingBox();
  assert.equal(after.height,before.height,'the Discussion split survives list reversals and resize');
  assert(after.width<before.width,'opening Front Pages reserves the correct space');
  assert.deepEqual(app.errors,[]);
 }finally{await app.browser.close()}
});

test('reduced motion changes both panel layouts immediately',{timeout:15000},async()=>{
 const app=await ready();
 try{
  await app.page.emulateMedia({reducedMotion:'reduce'});
  const states=await app.page.locator('#app').evaluate(node=>{
   const root=node.getRootNode(),states=[];
   for(const pane of ['list','discussion'])for(const hidden of [true,false]){
    root.querySelector('#app-toggle-'+pane).click();
    states.push({pane,hidden:node.classList.contains(pane+'-hidden'),moving:node.classList.contains(pane+'-moving'),want:hidden});
   }
   return states;
  });
  assert(states.every(state=>state.hidden===state.want&&!state.moving),'reduced-motion users see the requested layout immediately');
  assert.deepEqual(app.errors,[]);
 }finally{await app.browser.close()}
});

for(const width of [1600,1100])test(`${width}px built-in Reader clips the outer corner when Front Pages is closed`,{timeout:20000},async()=>{
 const app=await ready(width,STORIES[1]);
 try{
  assert(await waitFor(async()=>await app.page.locator('#app-article-body').getAttribute('data-mode')==='reader',8000));
  await app.page.locator('#app-toggle-list').click();
  assert(await waitFor(()=>app.page.locator('#app').evaluate(node=>node.classList.contains('list-hidden')&&!node.classList.contains('list-moving')),2000));
  const box=await app.page.locator('#app-reading').boundingBox();
  const corner=await app.page.screenshot({clip:{x:box.x,y:box.y,width:2,height:2},animations:'disabled'});
  const rail=await app.page.screenshot({clip:{x:box.x-4,y:box.y,width:2,height:2},animations:'disabled'});
  assert(corner.equals(rail),'the pixels outside the rounded content corner show the rail through the clipped Reader gradient');
  assert.deepEqual(app.errors,[]);
 }finally{await app.browser.close()}
});

for(const width of [1600,1100])test(`${width}px panel motion keeps article layout continuous in both directions`,{timeout:20000},async()=>{
 const app=await ready(width);
 try{
  assert(await waitFor(()=>app.page.locator('#panel').evaluate(node=>getComputedStyle(node).transform==='none'),2000));
  for(const pane of ['list','discussion'])for(const direction of ['close','open']){
   const {frames,settled}=await app.page.locator('#app').evaluate(async(app,pane)=>{
    const root=app.getRootNode(),article=root.querySelector('#app-article');
    const paneElement=root.querySelector(pane==='list'?'#app-list':'#panel');
    const paneAnimations=()=>[...app.getAnimations(),...paneElement.getAnimations()];
    const previous=new Set(paneAnimations()),frames=[];
    const record=fraction=>{const {x,width,height}=article.getBoundingClientRect();frames.push({fraction,x,width,height})};
    record(0);
    root.querySelector('#app-toggle-'+pane).click();
    const animations=paneAnimations().filter(animation=>!previous.has(animation));
    if(!animations.length)throw new Error(`No animation started for ${pane}`);

    // Sample the computed layout even when the browser skips intermediate frames.
    for(const animation of animations)animation.pause();
    await Promise.all(animations.map(animation=>animation.ready));
    const duration=Math.max(...animations.map(animation=>animation.effect.getComputedTiming().endTime));
    for(let step=0;step<=20;step++){
     const fraction=step/20;
     for(const animation of animations)animation.currentTime=duration*fraction;
     record(fraction);
    }

    const finished=Promise.all(animations.map(animation=>animation.finished));
    for(const animation of animations)animation.finish();
    await finished;
    record(1);
    return {frames,settled:!app.classList.contains(pane+'-moving')};
   },pane);
   assert(settled,`${pane} ${direction} settles after the animation finishes`);
   const first=frames[0],last=frames.at(-1);
   const axis=pane==='list'?'x':width===1600?'width':'height';
   assert(Math.abs(last[axis]-first[axis])>=10,`${pane} ${direction} changes article ${axis}`);
   for(const key of ['x','width','height']){
    const min=Math.min(first[key],last[key]),max=Math.max(first[key],last[key]),range=max-min;
    if(range<10)continue;
    assert(frames.some(frame=>frame[key]>min+range*.15&&frame[key]<max-range*.15),`${pane} ${direction} interpolates article ${key}`);
    for(let i=1;i<frames.length;i++){
     const elapsed=frames[i].fraction-frames[i-1].fraction,allowed=range*(elapsed*3+.03)+1;
     assert(Math.abs(frames[i][key]-frames[i-1][key])<=allowed,`${pane} ${direction} article ${key} does not jump between frames: ${JSON.stringify({before:frames[i-1],after:frames[i],allowed,frames})}`);
    }
   }
  }
  assert.deepEqual(app.errors,[]);
 }finally{await app.browser.close()}
});
