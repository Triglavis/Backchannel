import test from 'node:test';
import assert from 'node:assert/strict';
import {launchApp,STORIES,waitFor} from './harness.mjs';

const saveSelector='#app-article-actions [data-item-action="save"]';
const selectors=[saveSelector,'#app-view-toggle','#app-toggle-discussion'];
async function ready(width=1600){
  const app=await launchApp({sharedStore:true,viewport:{width,height:950},votable:{[STORIES[0].id]:'updown',[STORIES[7].id]:'updown'},settings:{sources:{hn:true},frontPageMode:'sources',updateCheck:false}});
  try{
    await app.page.goto('https://backchnnl.app/');await app.page.locator('#app-list-body .browse-title-link').first().click();
    await app.page.locator('#app-chin [data-item-action="save"]').waitFor();
    return app;
  }catch(error){await app.browser.close();throw error}
}

for(const width of [701,1600])test(`${width}px chin shows just the brand mark and the requested action order`,{timeout:15000},async()=>{
  const app=await ready(width);
  try{
    assert.equal((await app.page.locator('#app-chin-brand').textContent()).trim(),'','the brand is a mark without copyright text');
    assert.equal(await app.page.locator('#app-chin button[aria-label="Settings"]').count(),0,'the chin does not duplicate Settings');
    assert.equal(await app.page.locator('#app-chin .vote-button').count(),0);
    const boxes=[];for(const selector of selectors)boxes.push(await app.page.locator(selector).boundingBox());
    for(let i=1;i<boxes.length;i++){
      assert(Math.abs(boxes[i].x-boxes[i-1].x-boxes[i-1].width-6)<.1,'Save, Aa, and Discussion have 6px between controls');
    }
    assert(boxes.every(box=>box.y>=920&&box.y+box.height<=950),'the controls fit the existing chin');
    assert.equal(await app.page.locator('#settings-toggle').isVisible(),true,'Settings remains available in the rail');
    assert.deepEqual(app.errors,[]);
  }finally{await app.browser.close()}
});

test('chin keyboard order follows the visible controls without replacing their handlers',{timeout:20000},async()=>{
  const app=await ready();
  try{
    await app.page.locator(selectors[0]).focus();
    for(const selector of selectors.slice(1)){
      await app.page.keyboard.press(process.env.ENGINE==='webkit'?'Alt+Tab':'Tab');
      assert.equal(await app.page.locator(selector).evaluate(node=>node.getRootNode().activeElement===node),true,`Tab reaches ${selector} in visible order`);
    }
    const save=app.page.locator(saveSelector);
    await save.click();
    assert(await waitFor(async()=>/unsave/.test(await save.textContent()),3000));
    await app.page.locator('#app-list-body .browse-title-link').filter({hasText:STORIES[7].title}).first().click();
    await app.page.locator('#app-view-toggle').click();await app.page.locator('#app-view-menu').waitFor();
    assert.equal(await app.page.locator('#app-article-open').getAttribute('href'),STORIES[7].url,'the original-page control follows the new article');
    await app.page.keyboard.press('Escape');
    assert.deepEqual(app.errors,[]);
  }finally{await app.browser.close()}
});

for (const colorScheme of ['light', 'dark']) {
  test(`toggled chin buttons use a solid white background and the selected rail glyph color in ${colorScheme} mode`, {timeout: 20000}, async () => {
    const app = await launchApp({sharedStore: true, colorScheme, settings: {updateCheck: false}});
    try {
      const {page} = app;
      await page.goto('https://backchnnl.app/');
      const story = page.locator('#app-list-body .browse-title-link').first();
      await story.waitFor();
      const chin = page.locator('#app-chin');
      const discussion = chin.locator('#app-toggle-discussion');
      const style = chin.locator('#app-view-toggle');
      const save = chin.locator('[data-item-action="save"]');
      const rail = page.locator('#app-rail .rail-button.is-current:visible').first();
      const selected = {
        background: 'rgb(255, 255, 255)',
        image: 'none',
        glyph: await rail.evaluate(button => getComputedStyle(button).color),
      };
      const colors = button => button.evaluate(node => {
        const paint = getComputedStyle(node);
        const path = node.querySelector('svg path');
        return {
          background: paint.backgroundColor,
          image: paint.backgroundImage,
          glyph: path ? getComputedStyle(path).fill : getComputedStyle(node, '::after').backgroundColor,
        };
      });
      const checkSelected = async (button, label) => {
        await page.mouse.move(0, 0);
        assert.deepEqual(await colors(button), selected, label);
        await button.hover();
        assert.deepEqual(await colors(button), selected, `${label} on hover`);
      };

      assert(await discussion.isDisabled());
      assert.equal(await discussion.isVisible(), false);
      assert.notEqual((await colors(discussion)).background, selected.background);
      await story.click();
      await discussion.waitFor();
      const resting = await colors(save);
      await checkSelected(discussion, 'Visible Discussion');
      await discussion.click();
      const hovered = await colors(discussion);
      assert.notEqual(hovered.background, selected.background);
      assert.notEqual(hovered.background, resting.background);
      await page.mouse.move(0, 0);
      assert.deepEqual(await colors(discussion), resting, 'Hidden Discussion');
      await save.click();
      await save.filter({hasText: 'unsave'}).waitFor();
      await checkSelected(save, 'Saved story');
      await style.click();
      await page.locator('#app-view-menu').waitFor();
      await checkSelected(style, 'Open style menu');
      await page.keyboard.press('Escape');
      await page.mouse.move(0, 0);
      assert.deepEqual(await colors(style), resting, 'Closed style menu');
      assert.deepEqual(app.errors, []);
    } finally {
      await app.browser.close();
    }
  });
}

test('borderless chin buttons keep each glyph vertically centered',{timeout:15000},async()=>{
  const app=await ready();
  try{
    const measurements=await app.page.locator('#app-chin').evaluate(async chin=>{
      return Promise.all([...chin.querySelectorAll('.app-head-icon')].map(async button=>{
        const svg=button.querySelector('svg');
        const mask=getComputedStyle(button,'::after');
        const image=new Image();
        if(svg){
          const copy=svg.cloneNode(true);
          copy.setAttribute('xmlns','http://www.w3.org/2000/svg');
          image.src='data:image/svg+xml,'+encodeURIComponent(copy.outerHTML);
        }else{
          image.src=mask.maskImage.slice(5,-2);
        }
        await image.decode();
        const canvas=document.createElement('canvas');
        const size=128;
        canvas.width=canvas.height=size;
        const context=canvas.getContext('2d');
        context.drawImage(image,0,0,size,size);
        const pixels=context.getImageData(0,0,size,size).data;
        let ink=0,weightedY=0;
        for(let i=3;i<pixels.length;i+=4){
          ink+=pixels[i];
          weightedY+=pixels[i]*(Math.floor(i/4/size)+.5);
        }
        const {top,height}=button.getBoundingClientRect();
        const icon=svg?.getBoundingClientRect()||{
          top:top+button.clientTop+parseFloat(mask.top)+parseFloat(mask.marginTop)+new DOMMatrix(mask.transform).m42,
          height:parseFloat(mask.height),
        };
        const style=getComputedStyle(button);
        return{
          label:button.getAttribute('aria-label')||button.dataset.itemAction,
          offset:icon.top+icon.height*weightedY/ink/size-top-height/2,
          border:style.borderTopWidth,
        };
      }));
    });
    assert.equal(measurements.length,3);
    for(const {label,offset,border} of measurements){
      assert(Math.abs(offset)<.3,`${label} glyph center is ${offset.toFixed(2)}px from the center of its button`);
      assert.equal(border,'0px');
    }
  }finally{await app.browser.close()}
});
