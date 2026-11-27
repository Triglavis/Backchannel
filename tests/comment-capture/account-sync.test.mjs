import test from 'node:test';
import assert from 'node:assert/strict';
import {fillComposer, frontPageHTML, launchApp, STORIES, waitFor} from './harness.mjs';

const appURL = 'https://backchnnl.app/';
const storage = 'HNewhere:account_sync';
const queueStorage = 'HNewhere:queue';
const key = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const account = 'test-account';
const session = {account, token: 'test-session', expiresAt: Date.now() + 600000, recoveryKey: key, protocol: 2, revision: 0, base: null};

const noteKey = 'HNewhere:notes:url:framed.example.com/gc';
const sharedWritePrefix = 'HNewhere:storage_lock:account-storage:';

async function holdNextLibraryRead(page, key) {
  const read = Promise.withResolvers();
  const held = Promise.withResolvers();
  await page.exposeFunction('__holdLibraryRead', value => {
    read.resolve(value);
    return held.promise;
  });
  await page.evaluate(key => {
    const original = window.__gmStore;
    let armed = true;
    window.__gmStore = async (operation, requested, value) => {
      const result = await original(operation, requested, value);
      if (armed && operation === 'get' && requested === key) {
        armed = false;
        await window.__holdLibraryRead(result.has ? result.value : null);
      }
      return result;
    };
  }, key);
  return { read: read.promise, release: held.resolve };
}

for (const notes of [false, true]) test(`two Reader tabs keep both ${notes ? 'notes for the same article' : 'queued links'}`, {timeout:25000}, async () => {
  const stories = STORIES.slice(0, 2).map(story => ({
    ...story, key: new URL(story.url).host + new URL(story.url).pathname, source: 'hn', descendants: story.comments,
    permalink: 'https://news.ycombinator.com/item?id=' + story.id,
  }));
  const key = notes ? noteKey : queueStorage;
  const app = await launchApp({
    sharedStore: true, settings: {notepad: true, updateCheck: false, sourceRefreshMinutes: 0},
    values: {
      'HNewhere:collected': [], 'HNewhere:collected_migrated': true, 'HNewhere:collection_filed': true,
      'HNewhere:frontpage_feed:/hn/front/': {timestamp: Date.now(), status: 'ok', stories},
      [queueStorage]: notes ? [{...stories[0], addedAt: Date.now()}] : [],
    },
  });
  let held;
  try {
    const pages = [app.page, await app.context.newPage()];
    const texts = ['Note from tab 1', 'Note from tab 2'];
    const actions = await Promise.all(pages.map(async (page, i) => {
      page.setDefaultTimeout(7500);
      await page.emulateMedia({reducedMotion: 'reduce'});
      await page.goto(appURL);
      const list = page.locator('#app-list-body');
      if (!notes) {
        const row = list.locator('.browse-row').filter({has: page.getByRole('link', {name: stories[i].title, exact: true})});
        await row.locator('.browse-more').click();
        return page.locator('#app-row-menu').getByRole('menuitem', {name: 'Queue', exact: true});
      }
      await page.locator('#app-rail [data-app-view="queue"]').click();
      await list.getByRole('link', {name: stories[0].title, exact: true}).click();
      await page.locator(`#app .comment[data-comment-id="hn:${stories[0].id}01"]`).waitFor();
      return page.locator('#app-discussion-compose .compose-send-note');
    }));
    if (notes) {
      for (const [i, page] of pages.entries()) {
        await page.bringToFront();
        await fillComposer(page.locator('#app-discussion-compose .composer-text'), texts[i]);
      }
    }
    const saved = () => notes
      ? (app.store.get(key)?.notes || []).map(note => note.text)
      : app.store.get(key).map(link => link.url);
    const expected = notes ? texts : stories.map(story => story.url);
    held = await holdNextLibraryRead(pages[0], key);
    await actions[0].click();
    assert.deepEqual(await held.read, notes ? null : [], 'the first edit read the original storage value');
    await actions[1].click();
    assert(await waitFor(() => saved().includes(expected[1]) ||
      [...app.store.keys()].filter(name => name.startsWith(sharedWritePrefix)).length === 2, 5000),
      'the second edit reaches storage while the first is pending');
    held.release();
    assert(await waitFor(() => saved().includes(expected[0]), 5000));
    assert(await waitFor(() => ![...app.store.keys()].some(name => name.startsWith(sharedWritePrefix)), 5000));
    assert.deepEqual(saved().sort(), expected.slice().sort(), 'both independent edits survive');
    if (notes) assert.equal(app.store.get('HNewhere:notes_index').find(entry => entry.key === noteKey).count, 2);
    assert.deepEqual(app.errors, []);
  } finally {
    held?.release();
    await app.browser.close();
  }
});

test('a Queue click writes once even when its storage lease expires after the write', {timeout:15000}, async () => {
  const url = 'https://news.ycombinator.com/news';
  const app = await launchApp({sharedStore: true, topHosts: ['news.ycombinator.com'], values: {[queueStorage]: []},
    settings: {sourceRefreshMinutes: 0, updateCheck: false}});
  try {
    await app.context.route(url, route => route.fulfill({contentType: 'text/html', body: frontPageHTML([STORIES[0]])}));
    await app.page.goto(url);
    const link = app.page.locator('.hnewhere-queue-link');
    await link.waitFor();
    await app.page.evaluate(({queueStorage, sharedWritePrefix}) => {
      const set = GM.setValue;
      window.__fixtureQueueWrites = 0;
      GM.setValue = async (key, value) => {
        await set(key, value);
        if (key !== queueStorage || ++window.__fixtureQueueWrites !== 1) return;
        const lock = (await GM.listValues()).find(name => name.startsWith(sharedWritePrefix));
        if (lock) await set(lock, {...(await GM.getValue(lock)), expires: 0});
      };
    }, {queueStorage, sharedWritePrefix});
    await link.click();
    assert(await waitFor(async () => await link.textContent() === 'queued' &&
      ![...app.store.keys()].some(name => name.startsWith(sharedWritePrefix)), 5500));
    assert.equal(await app.page.evaluate(() => window.__fixtureQueueWrites), 1);
    assert.deepEqual(app.store.get(queueStorage).map(entry => entry.url), [STORIES[0].url]);
    assert.deepEqual(app.errors, []);
  } finally { await app.browser.close(); }
});

for (const latest of ['light', 'auto']) test(`Account sync keeps a newer ${latest} selection during an upload`, {timeout:25000}, async () => {
  const remote = {revision: 0, ciphertext: null, email: 'fixture@example.com'};
  const app = await launchApp({
    sharedStore: true, values: {[storage]: session}, settings: {sourceRefreshMinutes: 0, updateCheck: false},
  });
  const upload = Promise.withResolvers();
  try {
    await mockAccount(app, remote).start;
    await app.page.emulateMedia({reducedMotion: 'reduce'});
    const pane = await settings(app);
    const sync = pane.getByRole('button', {name: 'Sync now', exact: true});
    assert(await waitFor(() => sync.isEnabled(), 6000));
    const pending = 'HNewhere:account_pending_edit';
    const theme = () => app.store.get('HNewhere:settings').theme;
    const choose = value => app.page.locator(`#settings-panel label:has(input[data-setting="theme"][value="${value}"])`).click();
    await app.page.getByRole('button', {name: 'Appearance', exact: true}).click();
    await choose('light');
    assert(await waitFor(() => app.store.get(storage)?.base?.settings.theme === 'light' && !app.store.get(pending), 6000));
    const remoteLink = {id: 'queued-on-another-device', key: 'example.org/queued', url: 'https://example.org/queued',
      title: 'Link queued on the other device', addedAt: Date.now(), readAt: null};
    if (latest === 'auto') {
      const other = await launchApp({
        sharedStore: true, settings: app.store.get('HNewhere:settings'),
        values: {[storage]: app.store.get(storage), [queueStorage]: [remoteLink], [pending]: account},
      });
      try {
        await mockAccount(other, remote).start;
        await other.page.goto(appURL);
        assert(await waitFor(() => other.store.get(storage)?.base?.collection.queue?.some(link => link.key === remoteLink.key), 6000));
        assert(!app.store.get(queueStorage)?.some(link => link.key === remoteLink.key));
      } finally { await other.browser.close(); }
    }
    const revision = remote.revision;

    let started = false;
    remote.beforePut = () => { started = true; return upload.promise; };
    await choose('dark');
    assert(await waitFor(() => started, 6000), 'the first edit reaches the account service');
    await choose(latest);
    assert(await waitFor(() => theme() === latest, 5000), 'the second choice was saved locally');
    if (latest === 'auto') {
      await app.page.evaluate(({storage, revision}) => {
        const set = GM.setValue;
        GM.setValue = async (key, value) => {
          if (!window.__fixtureCheckpointFailed && key === storage && value.revision === revision) {
            window.__fixtureCheckpointFailed = true;
            throw new Error('Fixture checkpoint temporarily unavailable');
          }
          await set(key, value);
        };
      }, {storage, revision: revision + 1});
    }
    upload.resolve();
    await app.page.getByRole('button', {name: 'Account', exact: true}).click();
    const conflict = pane.locator('#account-conflict');
    assert(await waitFor(async () => await conflict.isVisible() ||
      (remote.revision > revision && !app.store.get(pending)), 6000));
    assert.equal(await conflict.isVisible(), false, 'a later change on this device is not a sync conflict');
    assert.equal(remote.revision, revision + 2, 'the later choice replaces the first upload');
    assert.equal(app.store.get(storage).base.settings.theme ?? 'auto', latest);
    assert.equal(theme() ?? 'auto', latest);
    if (latest === 'auto') {
      assert(await app.page.evaluate(() => window.__fixtureCheckpointFailed));
      assert(app.store.get(storage).base.collection.queue.some(link => link.key === remoteLink.key));
      assert(app.store.get(queueStorage).some(link => link.key === remoteLink.key), 'the retry preserves the other device’s queued link');
    }
    assert.deepEqual(app.errors, []);
  } finally {
    upload.resolve();
    await app.browser.close();
  }
});

test('an offline bookmark import and its undo sync across devices', {timeout: 25000}, async () => {
  const remote = {revision:0, ciphertext:null, capabilities:{emailAvailable:true}, email:'birb@example.com'};
  const options = {sharedStore:true, values:{[storage]:session}, settings:{updateCheck:false,sourceRefreshMinutes:0}};
  const first = await launchApp(options);
  const second = await launchApp(options);
  try {
    const firstAccount = mockAccount(first,remote);
    await Promise.all([
      firstAccount.start, mockAccount(second,remote).start,
      mockPasskeySupport(first), mockPasskeySupport(second),
    ]);
    first.page.setDefaultTimeout(4500);
    await first.page.goto(appURL);
    assert(await waitFor(() => first.store.get(storage)?.base));
    const revision = remote.revision;
    const syncAttempts = firstAccount.requests.filter(path => path === '/account/snapshot').length;
    remote.offline = true;
    await first.page.locator('#app-rail [data-app-view="collection"]').click();
    const [picker] = await Promise.all([
      first.page.waitForEvent('filechooser'),
      first.page.locator('#app-list-body').getByRole('button',{name:'Import bookmarks'}).click(),
    ]);
    await picker.setFiles({name:'bookmarks.html',mimeType:'text/html',buffer:Buffer.from(
      '<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><DT><A HREF="https://books.example.com/collected" ADD_DATE="1700000000">A saved library link</A></DL>',
    )});
    await first.page.getByRole('button',{name:'Import 1 link'}).click();
    await first.page.locator('#app-list-body').getByRole('link',{name:'A saved library link'}).waitFor();
    assert(await waitFor(() => firstAccount.requests.filter(path => path === '/account/snapshot').length > syncAttempts),'the import queues sync');
    assert.equal(remote.revision,revision,'the saved link remains available locally while the service is offline');
    remote.offline = false;
    await first.page.locator('#settings-toggle').click();
    await first.page.getByRole('button',{name:'Account',exact:true}).click();
    await first.page.getByRole('button',{name:'Sync now',exact:true}).click();
    assert(await waitFor(() => remote.revision > revision),'retry uploads the encrypted library');
    assert(!remote.ciphertext.includes('A saved library link'));
    await second.page.goto(appURL);
    assert(await waitFor(() => second.store.get('HNewhere:collected')?.some(entry=>entry.key==='books.example.com/collected')));
    const imported = second.store.get('HNewhere:collected').find(entry=>entry.key==='books.example.com/collected');
    assert.equal(imported.title,'A saved library link');
    assert.equal(imported.previewOnOpen,true);
    assert.equal(Object.hasOwn(imported,'unwatched'),false);
    assert.equal(imported.addedAt,1700000000000);

    const importedRevision = remote.revision;
    await first.page.locator('#app-settings-close').click();
    await first.page.locator('#toast').getByRole('button',{name:'Undo',exact:true}).click();
    assert(await waitFor(() => remote.revision > importedRevision),'undo uploads the removal');
    await second.page.locator('#settings-toggle').click();
    await second.page.getByRole('button',{name:'Account',exact:true}).click();
    await second.page.getByRole('button',{name:'Sync now',exact:true}).click();
    assert(await waitFor(() => second.store.get('HNewhere:collected')?.length === 0),'the second device receives the removal');
  } finally { await Promise.all([first.browser.close(),second.browser.close()]); }
});

async function mockPasskeySupport(app, {recordPasskeyDetails = false} = {}) {
  await app.context.addInitScript(({recordPasskeyDetails}) => {
    // Some headless WebKit builds lack WebAuthn. These UI tests mock the
    // ceremony. The Account Worker suite exercises the real Chromium API.
    if (typeof window.PublicKeyCredential !== 'function') {
      window.PublicKeyCredential = class PublicKeyCredential {};
    }
    if (!navigator.credentials) {
      const cancel = () => { throw new DOMException('Passkey cancelled in fixture', 'NotAllowedError'); };
      const credentials = Object.create({create:cancel, get:cancel});
      Object.defineProperty(navigator, 'credentials', {value:credentials, configurable:true});
    }
    if (recordPasskeyDetails) {
      window.passkeyDetails = [];
      Object.defineProperty(PublicKeyCredential, 'signalCurrentUserDetails', {value: details => {
        window.passkeyDetails.push(details);
        return new Promise((resolve, reject) => {
          window.finishPasskeyDetails = (accepted) => accepted ? resolve() : reject(new DOMException('Update dismissed', 'NotAllowedError'));
        });
      }});
    }
  }, {recordPasskeyDetails});
}

async function settings(app, url = appURL, {recordPasskeyDetails = false, beforeOpen} = {}) {
  app.page.setDefaultTimeout(4000);
  await mockPasskeySupport(app, {recordPasskeyDetails});
  await app.page.goto(url);
  await beforeOpen?.();
  await app.page.locator('#settings-toggle').click();
  await app.page.getByRole('button', {name: 'Account', exact: true}).click();
  return app.page.locator('#settings-account-sync');
}

async function linkedDevicesIn(panel) {
  const manage = panel.locator('#account-manage-page');
  const devices = manage.getByRole('region', {name:'Linked devices',exact:true});
  await devices.waitFor();
  assert.deepEqual(await manage.getByRole('heading', {level:4}).allTextContents(), ['Privacy', 'Linked devices']);
  return devices;
}

test('Reader source diagnostics require a signed-in account with sharing enabled', {timeout:20000}, async () => {
  const app = await launchApp({sharedStore:true, settings:{sources:{hn:true},frontPageMode:'sources',updateCheck:false,sourceRefreshMinutes:0}});
  const reports = [];
  const diagnosticsKey = 'HNewhere:account_diagnostics:' + account;
  try {
    app.page.setDefaultTimeout(4000);
    const remote = {revision:0, ciphertext:null, capabilities:{emailAvailable:true}, email:'birb@example.com'};
    await mockAccount(app, remote).start;
    await app.context.route('https://backchnnl.app/account/diagnostics', route => {
      const request = route.request();
      reports.push({body:request.postDataJSON(), authorization:request.headers().authorization});
      return route.fulfill({status:204});
    });
    const sync = app.page.locator('#app-list-sync');
    const reportCheckbox = app.page.getByRole('checkbox',{name:'Share diagnostics',exact:true});
    const syncFrontPage = async () => {
      const before = app.requests.filter(request => request.url === 'https://news.ycombinator.com/news').length;
      await sync.click();
      assert(await waitFor(() => app.requests.filter(request => request.url === 'https://news.ycombinator.com/news').length > before));
      assert(await waitFor(async () => await sync.getAttribute('aria-busy') === null));
    };
    const openPrivacy = async () => {
      const panel = await settings(app);
      await panel.getByRole('button',{name:'Manage account',exact:true}).click();
      await reportCheckbox.waitFor();
      assert(await waitFor(async () => !(await reportCheckbox.isDisabled())));
    };
    await app.page.goto(appURL);
    await syncFrontPage();
    assert.deepEqual(reports,[]);
    await app.page.locator('#settings-toggle').click();
    await app.page.locator('#settings-privacy').waitFor();
    assert.equal(await app.page.locator('#settings-privacy').getByRole('checkbox',{name:'Share diagnostics',exact:true,includeHidden:true}).count(),0);
    await app.page.locator('#app-settings-close').click();
    app.store.set(diagnosticsKey,Date.now()-1000);
    await syncFrontPage();
    assert.deepEqual(reports,[],'saved consent from a signed-out device does not send reports');
    app.store.delete(diagnosticsKey);
    app.store.set(storage,{...session,base:{}});
    await openPrivacy();
    assert.equal(await reportCheckbox.isChecked(),false);
    assert.equal(await reportCheckbox.getAttribute('aria-describedby'),'account-diagnostics-hint');
    assert.equal(await app.page.locator('#account-diagnostics-hint').textContent(),'Help improve Backchannel by sharing anonymized usage data.');
    await reportCheckbox.check();
    assert(await waitFor(() => app.store.get(diagnosticsKey) > 0));
    await app.page.locator('#app-settings-close').click();
    await syncFrontPage();
    assert(await waitFor(() => reports.some(({body}) => body.operation === 'feed' && body.source === 'hn')));
    assert(reports.every(({body,authorization}) => !authorization && Object.keys(body).sort().join(',') === 'duration,operation,outcome,source,version'));

    assert(await waitFor(() => app.store.get(storage)?.base?.preferences?.shareDiagnostics === true), 'consent sync finishes before reopening Account');
    await openPrivacy();
    await reportCheckbox.uncheck();
    assert(await waitFor(() => app.store.get(diagnosticsKey) === 0));
    const count = reports.length;
    await app.page.reload();
    await app.page.locator('#app-list-body .browse-title-link').first().waitFor();
    await syncFrontPage();
    assert.equal(reports.length,count);
  } finally { await app.browser.close(); }
});

function mockAccount(app, remote) {
  const requests = [];
  const start = app.context.route('https://backchnnl.app/account/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    requests.push(path);
    if (path === '/account/status') return route.fulfill({json: {available: !remote.offline, ...remote.capabilities}});
    if (remote.offline) return route.abort('failed');
    if (path === '/account/diagnostics') return route.fulfill({status: 204});
    assert.equal(request.headers().authorization, 'Bearer test-session');
    if (path === '/account/email') return route.fulfill({json: {email: remote.email || null}});
    if (path === '/account/email/options') return route.fulfill({json:{
      ceremony:'bbbbbbbb-bbbb-4bbb-abbb-bbbbbbbbbbbb',
      options:{challenge:key,rpId:'backchnnl.app',userVerification:'required',allowCredentials:[{id:key,type:'public-key'}]},
    }});
    if (path === '/account/email/start') {
      if (remote.emailSendError) return route.fulfill({status:500,json:{error:remote.emailSendError}});
      if (remote.beforeEmailSend) await remote.beforeEmailSend;
      remote.pendingEmail = request.postDataJSON().email;
      return route.fulfill({json:{verificationId:'account-email-change',retryAfter:60,remainingResends:3}});
    }
    if (path === '/account/email/verify') {
      const { email, verificationId, code } = request.postDataJSON();
      assert.equal(email,remote.pendingEmail);
      assert.equal(verificationId,'account-email-change');
      if (code !== '123456') return route.fulfill({status:401,json:{error:'invalid-email-code'}});
      remote.email = email.toLowerCase();
      return route.fulfill({json:{email:remote.email}});
    }
    if (path === '/account/delete/options') return route.fulfill({json:{
      ceremony: 'bbbbbbbb-bbbb-4bbb-abbb-bbbbbbbbbbbb',
      options:{challenge:key, rpId:'backchnnl.app', userVerification:'required', allowCredentials:[{type:'public-key',id:key}]},
    }});
    if (path === '/account/devices/current') {
      const device = request.postDataJSON();
      assert.match(device.id, /^[\w-]{36}$/);
      return route.fulfill({status:204});
    }
    if (path === '/account/devices') {
      return route.fulfill({json:{devices:[
        {id:'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name:'Mac · Safari', current:true, lastSeenAt:Date.now()},
        {id:'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb', name:'iPhone · Safari', current:false, lastSeenAt:Date.now()},
      ]}});
    }
    if (path === '/account/snapshot' && request.method() === 'GET') {
      if (remote.beforeGet) await remote.beforeGet();
      return route.fulfill({json: {revision: remote.revision, ciphertext: remote.ciphertext}});
    }
    if (path === '/account/snapshot' && request.method() === 'PUT') {
      const beforePut = remote.beforePut;
      remote.beforePut = null;
      if (beforePut) await beforePut();
      const expected = Number(JSON.parse(request.headers()['if-match']));
      if (expected !== remote.revision) return route.fulfill({status: 409, json: {error: 'revision-conflict', revision: remote.revision}});
      remote.revision++;
      remote.ciphertext = request.postDataJSON().ciphertext;
      return route.fulfill({json: {revision: remote.revision}});
    }
    if (path === '/account/session' && request.method() === 'DELETE') return route.fulfill({status: 204});
    await route.fulfill({status: 404, json: {error: 'not-found'}});
  });
  return {start, requests};
}

test('diagnostics consent follows the signed-in account across devices', {timeout: 24000}, async () => {
  const remote = {revision:0, ciphertext:null, email:'birb@example.com', capabilities:{emailAvailable:true}};
  const diagnosticsKey = 'HNewhere:account_diagnostics:' + account;
  const first = await launchApp({sharedStore:true, values:{[storage]:session, 'HNewhere:share_diagnostics':Date.now()-1000}});
  const second = await launchApp({sharedStore:true, values:{[storage]:session}, viewport:{width:390,height:844}, hasTouch:true});
  const managePrivacy = async (app, revision) => {
    const panel = await settings(app, appURL, {
      beforeOpen: async () => assert(await waitFor(() => app.store.get(storage)?.revision === revision), 'startup sync finishes before opening Account'),
    });
    await panel.getByRole('button',{name:'Manage account',exact:true}).click();
    return panel.getByRole('checkbox',{name:'Share diagnostics',exact:true});
  };
  try {
    await Promise.all([mockAccount(first,remote).start,mockAccount(second,remote).start]);
    const firstChoice = await managePrivacy(first, 1);
    const back = first.page.locator('#account-manage-back');
    assert(await waitFor(async () => !(await back.isDisabled()) && !(await firstChoice.isDisabled())));
    assert.equal(await firstChoice.isChecked(),false,'alpha consent was limited to the old device');
    await firstChoice.hover();
    await first.page.mouse.down();
    await firstChoice.evaluate((input, diagnosticsKey) => {
      const getValue = GM.getValue;
      const resume = new Promise(resolve => { window.resumeDiagnosticsRefresh = resolve; });
      GM.getValue = async (key, fallback) => {
        if (key !== diagnosticsKey) return getValue(key, fallback);
        GM.getValue = getValue;
        const value = await getValue(key, fallback);
        window.diagnosticsRefreshPending = true;
        await resume;
        return value;
      };
      input.closest('#settings-account-sync').dispatchEvent(new Event('account-settings-shown'));
    }, diagnosticsKey);
    assert(await waitFor(() => first.page.evaluate(() => window.diagnosticsRefreshPending)));
    await first.page.mouse.up();
    assert(await waitFor(() => first.store.get(diagnosticsKey) > 0), 'a profile refresh does not drop the click');
    await first.page.evaluate(() => window.resumeDiagnosticsRefresh());
    assert(await waitFor(() => first.store.get(storage)?.revision === 2));
    assert(await firstChoice.isChecked());
    const secondChoice = await managePrivacy(second, 2);
    assert(await waitFor(() => secondChoice.isChecked()),'the second device receives consent');
    await secondChoice.uncheck();
    assert(await waitFor(() => second.store.get(storage)?.revision === 3));
    await back.click();
    await first.page.getByRole('button',{name:'Sync now',exact:true}).click();
    assert(await waitFor(() => first.store.get(storage)?.revision === 3));
    await first.page.getByRole('button',{name:'Manage account',exact:true}).click();
    assert(await waitFor(async () => !(await firstChoice.isChecked())), 'turning sharing off syncs too');
  } finally { await Promise.all([first.browser.close(),second.browser.close()]); }
});

test('importing a different library preserves the account’s existing reading queue', {timeout: 20000}, async () => {
  const remote = {revision:0, ciphertext:null, email:'birb@example.com'};
  const entry = id => ({id, key:`example.com/${id}`, url:`https://example.com/${id}`, title:id, addedAt:10, readAt:null});
  const original = entry('original');
  const imported = entry('imported');
  const app = await launchApp({sharedStore:true, values:{[storage]:session, [queueStorage]:[original]}});
  try {
    await mockAccount(app, remote).start;
    const panel = await settings(app);
    assert(await waitFor(() => app.store.get(storage)?.revision === 1));
    await panel.getByRole('button',{name:'Sign out',exact:true}).click();
    await panel.locator('#account-entry-email').waitFor();
    assert.equal(app.store.get('HNewhere:account_sync_checkpoint')?.revision,1);

    app.store.set('HNewhere:account_data_owner','other-account');
    app.store.set(queueStorage,[imported]);
    app.store.set(storage,session);
    const reopened = await settings(app);
    await reopened.getByRole('button',{name:'Import and sync',exact:true}).click();
    assert(await waitFor(() => app.store.get(storage)?.revision === 2));
    assert.deepEqual(app.store.get(storage).base.collection.queue.map(item => item.id).sort(), ['imported','original']);
  } finally { await app.browser.close(); }
});

test('Account sync uploads a private snapshot and another local profile can apply it', {timeout: 30000}, async () => {
  const uploadStarted = Promise.withResolvers();
  const releaseUpload = Promise.withResolvers();
  const remote = {
    revision:0, ciphertext:null, capabilities:{emailAvailable:true}, email:'birb@example.com',
    beforePut: () => { uploadStarted.resolve(); return releaseUpload.promise; },
  };
  const saved = [{key: 'hn:42', kind: 'comment', url:'https://example.com/article', text:'Secret fixture comment', page:'example.com/article', addedAt: 15}];
  const collection = [{key:'example.com/article', url:'https://example.com/article', title:'Fixture article', addedAt: 6, unwatched:true, checkedAt:100, marks:{hn:23}}];
  const queue = [{id:'queued', key:'example.org/queued', url:'https://example.org/queued', title:'Queued fixture', addedAt:10, readAt:null}];
  const first = await launchApp({sharedStore: true, settings: {theme:'dark', sourceRefreshMinutes:15, hiddenTopics:['Browser privacy']}, values: {[storage]: session, [queueStorage]:queue, 'HNewhere:favorites': saved, 'HNewhere:collected': collection}});
  const second = await launchApp({sharedStore: true, values: {[storage]: session}});
  try {
    const firstAccount = mockAccount(first, remote);
    await Promise.all([firstAccount.start, mockAccount(second, remote).start]);
    const firstPanel = await settings(first, appURL, {beforeOpen: () => uploadStarted.promise});
    releaseUpload.resolve();
    assert(await waitFor(() => remote.revision === 1), 'the first profile uploads revision 1');
    assert(await waitFor(() => firstAccount.requests.includes('/account/status')), 'opening Account during startup sync still checks availability');
    await firstPanel.locator('#account-last-sync time[datetime]').waitFor({timeout:4000});
    const nav = first.page.locator('.app-settings-nav button').first();
    assert.equal(await nav.getAttribute('data-settings-section'), 'account');
    await nav.getByText('birb@example.com', {exact:true}).waitFor({timeout:2500});
    assert.equal(await nav.locator('.app-account-tab-title').textContent(), 'birb@example.com');
    assert.equal(await nav.locator('.app-account-tab-subtitle').textContent(), 'Backchannel\u00a0Account');
    assert.equal(await nav.evaluate(node => getComputedStyle(node).borderTopWidth), '0px');
    assert.equal(await firstPanel.getByRole('heading', {name:'Linked devices',exact:true}).isVisible(), false,
      'the Account overview leaves Linked devices in Manage account');
    const deletionStyle = await firstPanel.getByRole('button',{name:'Delete account…',exact:true}).evaluate(button => ({
      color: getComputedStyle(button).color,
      background: getComputedStyle(button).backgroundColor,
      actions: [...button.closest('#account-actions').querySelectorAll('button:not([hidden])')].map(item => item.textContent),
    }));
    assert.deepEqual(deletionStyle, {color:'rgb(255, 255, 255)', background:'rgb(193, 43, 36)', actions:['Manage account','Sign out','Delete account…']});
    const profile = firstPanel.locator('#account-profile');
    await profile.getByText('birb@example.com',{exact:true}).waitFor();
    const dividerGaps = await firstPanel.evaluate(panel => {
      const box = selector => panel.querySelector(selector).getBoundingClientRect();
      return [
        [box('#account-stage').top - box('#account-email-value').bottom, box('#account-signed-in .account-setting-row').top - box('#account-stage').top - 1],
        [box('#account-delete-section').top - box('#account-signed-in .account-setting-row').bottom, box('#account-actions').top - box('#account-delete-section').top - 1],
      ];
    });
    for (const [above, below] of dividerGaps) assert(Math.abs(above - below) < 1);
    const edit = profile.getByRole('button',{name:'Edit birb',exact:true});
    const overlay = edit.locator('.account-avatar-edit-label');
    assert.equal(await overlay.evaluate(node => getComputedStyle(node).opacity),'0');
    await edit.hover();
    assert(await waitFor(async () => await overlay.evaluate(node => getComputedStyle(node).opacity) === '1'));
    assert.equal(await profile.evaluate(header => {
      const edit = header.querySelector('#account-avatar-edit').getBoundingClientRect();
      const center = header.getBoundingClientRect();
      return Math.abs(edit.left + edit.width / 2 - center.left - center.width / 2) < 2;
    }),true,'the avatar edit control is centered in the profile');
    assert.equal(await firstPanel.getByRole('heading',{name:'Recovery email',exact:true}).count(),0);
    const profileLayout = () => profile.evaluate(element => {
      const {x,y,width,height} = element.getBoundingClientRect();
      const scroller = element.getRootNode().getElementById('app-settings-content');
      return {x,y:y + scroller.scrollTop,width,height};
    });
    const header = await profileLayout();
    await firstPanel.getByRole('button',{name:'Manage account',exact:true}).click();
    assert.deepEqual(await profileLayout(), header);
    assert.equal(await firstPanel.getByRole('button',{name:'Sync now',exact:true}).isVisible(),false);
    const manage = firstPanel.locator('#account-manage-page');
    const devices = await linkedDevicesIn(firstPanel);
    await devices.getByText('Mac · Safari · This device', {exact:true}).waitFor();
    await devices.getByRole('button', {name:'Sign out iPhone · Safari'}).waitFor();
    const address = manage.getByLabel('Email address',{exact:true});
    await address.waitFor({timeout:4000});
    assert.equal(await manage.locator('input[type="email"]').count(),1);
    assert.equal(await address.getAttribute('placeholder'),'birb@example.com');
    assert.equal(await address.isEditable(),true);
    assert.equal(await address.inputValue(),'');
    const emptyWidth = (await address.boundingBox()).width;
    const updateEmail = manage.getByRole('button',{name:'Update',exact:true});
    assert.equal(await updateEmail.isVisible(),false);
    const emailHint = manage.locator('#account-email-hint');
    assert.equal(await emailHint.isVisible(),false);
    await address.fill('n');
    await updateEmail.waitFor();
    assert(await updateEmail.isDisabled());
    assert.equal(await emailHint.isVisible(),false);
    await address.fill('birb@example.com');
    await updateEmail.waitFor({state:'hidden'});
    await address.fill('');
    await address.fill('draft-birb@example.com');
    await updateEmail.waitFor();
    await manage.locator('#account-email-update').evaluate(async node => {
      await Promise.all(node.getAnimations().map(animation => animation.finished));
    });
    const sizing = await manage.evaluate(section => {
      const root = section.getRootNode();
      const rect = id => root.getElementById(id).getBoundingClientRect();
      const address = rect('account-email-input');
      const button = rect('account-send-code');
      const privacy = rect('account-manage-privacy');
      const sharing = rect('account-share-diagnostics');
      const sharingLabel = root.getElementById('account-share-diagnostics').closest('label').getBoundingClientRect();
      const sharingText = rect('account-diagnostics-label');
      const sharingHint = rect('account-diagnostics-hint');
      const headingStyle = element => {
        const {fontSize,fontWeight,lineHeight} = getComputedStyle(element);
        return {fontSize,fontWeight,lineHeight};
      };
      return {
        heights:[address.height,button.height],
        expectedHeight:parseFloat(getComputedStyle(root.getElementById('settings-update-check')).height),
        width:address.width,
        gap:button.left-address.right,
        aligned:Math.abs(button.top-address.top) < .5,
        labelWeight:getComputedStyle(section.querySelector('.settings-field-label')).fontWeight,
        heading:headingStyle(root.getElementById('account-manage-heading')),
        referenceHeading:headingStyle(root.getElementById('account-devices-heading')),
        sharingWidth:sharing.width,
        sharingHeight:sharing.height,
        sharingFillsRow:Math.abs(sharingLabel.width - privacy.width) < 1 && Math.abs(sharing.left - privacy.left) < 1,
        sharingTextFollowsCheckbox:sharingText.left > sharing.right,
        sharingHintFollowsLabel:Math.abs(sharingText.left - sharingHint.left) < 1 && sharingHint.top >= sharingText.bottom,
      };
    });
    assert(sizing.heights.every(height => Math.abs(height - sizing.expectedHeight) < 0.5));
    assert(sizing.width < emptyWidth && sizing.gap >= 6 && sizing.gap <= 10 && sizing.aligned,JSON.stringify(sizing));
    assert.equal(sizing.labelWeight,'400');
    assert.deepEqual(sizing.heading,sizing.referenceHeading);
    assert(Math.abs(sizing.sharingWidth - sizing.sharingHeight) < 0.5);
    assert(sizing.sharingFillsRow);
    assert(sizing.sharingTextFollowsCheckbox);
    assert(sizing.sharingHintFollowsLabel);
    await first.page.evaluate(() => {
      Object.defineProperty(Object.getPrototypeOf(navigator.credentials), 'get', {value: async () => ({toJSON: () => ({id:'fixture-passkey'})})});
    });
    await emailHint.waitFor();
    assert.match(await emailHint.textContent(),/confirm your identity with your passkey/);
    await updateEmail.click({scroll:'none'});
    const codeField = first.page.getByLabel('Verification code',{exact:true});
    await codeField.waitFor();
    assert(Math.abs((await codeField.boundingBox()).height - sizing.expectedHeight) < 0.5);
    await codeField.waitFor();
    await address.waitFor({state:'hidden'});
    await manage.getByRole('button',{name:'Back',exact:true}).click();
    await address.waitFor();
    assert.equal(await address.inputValue(),'draft-birb@example.com');
    await codeField.waitFor({state:'hidden'});
    await address.fill('new-birb@example.com');
    await updateEmail.click({scroll:'none'});
    await codeField.fill('123456');
    assert(await manage.getByRole('heading',{name:'Manage account'}).isVisible());
    assert.equal(remote.email,'birb@example.com');
    assert.equal(await address.getAttribute('placeholder'),'birb@example.com');
    await manage.getByRole('button',{name:'Verify email',exact:true}).click({scroll:'none'});
    await first.page.locator('#toast.is-showing').filter({hasText:'Email updated.'}).waitFor();
    await codeField.waitFor({state:'hidden'});
    assert.equal(await address.getAttribute('placeholder'),'new-birb@example.com');
    assert.equal(await address.inputValue(),'');
    assert.equal(await emailHint.isVisible(),false);
    assert.equal(await codeField.isVisible(),false);
    assert.equal(await updateEmail.isVisible(),false);
    assert.deepEqual(await profileLayout(), header);
    await firstPanel.getByRole('button',{name:'Back',exact:true}).click();
    assert.equal(await firstPanel.getByLabel('Recovery key', {exact:true}).isVisible(), false, 'a keyed device does not see the unlock input');
    assert.equal(await firstPanel.getByText('Recovery options', {exact:true}).isVisible(), false);
    assert.equal(await firstPanel.getByRole('button', {name:'Show recovery key'}).isVisible(), false);
    const requestGate = Promise.withResolvers();
    remote.beforeGet = () => requestGate.promise;
    try {
      await firstPanel.getByRole('button',{name:'Sync now',exact:true}).click();
      const progress = firstPanel.getByRole('button',{name:'Syncing…',exact:true});
      await progress.waitFor();
      assert(await progress.isDisabled());
      assert.equal(await progress.locator('span').evaluate(el => getComputedStyle(el).animationName),'settings-update-glimmer');
    } finally {
      requestGate.resolve();
      remote.beforeGet = null;
    }
    await firstPanel.getByRole('button',{name:'Sync now',exact:true}).waitFor();
    assert.equal(await firstPanel.getByText('Synced.',{exact:true}).isVisible(),false);
    assert.match(remote.ciphertext,/^[\w-]+$/);
    assert(!remote.ciphertext.includes('Secret fixture comment'));
    await firstPanel.getByRole('button', {name:'Edit birb', exact:true}).click();
    assert.deepEqual(await profileLayout(), header);
    await firstPanel.getByRole('radio', {name:'Long bill', exact:true}).check();
    assert.equal(await profile.locator('#account-profile-avatar').getAttribute('data-birb-shape'),'long-bill');
    assert(await waitFor(() => first.store.get(`HNewhere:account_avatar:${account}`)?.shape === 'long-bill'), 'the first choice saves immediately');
    await firstPanel.getByRole('radio', {name:'Plum', exact:true}).check();
    await firstPanel.getByRole('radio', {name:'Lilac', exact:true}).check();
    assert.equal(await firstPanel.getByRole('button', {name:'Save birb', exact:true}).count(),0);
    assert(await firstPanel.getByRole('heading',{name:'Edit your birb'}).isVisible());
    assert(await waitFor(() => first.store.get(storage)?.base?.preferences?.avatar?.background === 'lilac'), 'the last choice syncs without leaving the editor');
    assert(!remote.ciphertext.includes('lilac'));
    const secondPanel = await settings(second);
    assert.equal(await secondPanel.getByLabel('Recovery key', {exact:true}).isVisible(), false);
    assert(await waitFor(() => second.store.get(storage)?.revision === remote.revision));
    assert.equal(second.store.get('HNewhere:settings').theme,'dark');
    assert.deepEqual(second.store.get('HNewhere:settings').hiddenTopics,['Browser privacy']);
    assert.deepEqual(second.store.get('HNewhere:favorites'), saved);
    assert.deepEqual(second.store.get(queueStorage),queue);
    const folder = second.store.get('HNewhere:collected')[0];
    assert.equal(folder.key,collection[0].key);
    assert.equal(folder.previewOnOpen,true);
    assert.equal(Object.hasOwn(folder,'unwatched'),false);
    assert.equal(folder.checkedAt ?? 0,0,'folder check state stays on its own device');
    await second.page.getByRole('button', {name:'Appearance', exact:true}).click();
    assert(await waitFor(() => second.page.locator('#settings-panel input[data-setting="theme"][value="dark"]').isChecked()));
    await second.page.getByRole('button', {name:'Account', exact:true}).click();
    await secondPanel.getByRole('button', {name:'Edit birb', exact:true}).click();
    for (const name of ['Long bill', 'Plum', 'Lilac']) assert(await secondPanel.getByRole('radio', {name, exact:true}).isChecked());
    await secondPanel.getByRole('radio', {name:'Mint', exact:true}).check();
    await second.page.getByRole('button', {name:'General', exact:true}).click();
    await second.page.getByRole('button', {name:'Account', exact:true}).click();
    await secondPanel.locator('#account-profile').waitFor();
    assert.equal(await secondPanel.getByRole('heading',{name:'Edit your birb'}).isVisible(),false);
    assert.equal(await secondPanel.getByRole('button', {name:'Show recovery key'}).count(),0);
    await secondPanel.getByRole('button', {name:'Sign out', exact:true}).click();
    assert(await waitFor(() => !second.store.get(storage)));
    await secondPanel.locator('#account-entry-email').waitFor();
    assert.equal(await secondPanel.getByText('Recovery options', {exact:true}).count(),0);
    assert.deepEqual(second.store.get('HNewhere:favorites'),saved);
    assert.deepEqual(first.errors,[]);
    assert.deepEqual(second.errors,[]);
  } finally {
    releaseUpload.resolve();
    await Promise.all([first.browser.close(), second.browser.close()]);
  }
});

test('the Account card sends and verifies enrollment codes before initiating a passkey', {timeout:16000}, async () => {
  const app = await launchApp({sharedStore:true, settings:{theme:'light'}});
  const requests = [];
  try {
    await app.context.route('https://backchnnl.app/account/**', async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      requests.push(path);
      if (path === '/account/status') return route.fulfill({json:{available:true,emailAvailable:true}});
      if (path === '/account/email/register/start') {
        if (request.postDataJSON().email === 'limited@example.com') {
          return route.fulfill({status:429,json:{error:'rate-limited',retryAfter:1200}});
        }
        assert.deepEqual(request.postDataJSON(), {email:'fixture@example.com',codeFormat:'numeric'});
        await new Promise(resolve => setTimeout(resolve, 350));
        return route.fulfill({json:{ok:true,verificationId:'fixture-code-id',retryAfter:60,remainingResends:3}});
      }
      if (path === '/account/register/options') {
        assert.deepEqual(request.postDataJSON(), {email:'fixture@example.com', verificationId:'fixture-code-id', code:'123456', flow:'continue'});
        return route.fulfill({status:401,json:{error:'invalid-email-code'}});
      }
      return route.fulfill({status:404,json:{error:'not-found'}});
    });
    const panel = await settings(app);
    await app.page.clock.install();
    const email = panel.locator('#account-entry-email');
    await email.waitFor();
    const entryWidth = (await email.boundingBox()).width;
    const verify = panel.getByRole('button',{name:'Verify email',exact:true});
    const resend = panel.getByRole('button',{name:'Send another code',exact:true});
    assert.equal(await app.page.locator('#app-settings-heading').isVisible(),false);
    assert(Math.abs((await email.boundingBox()).height - (await panel.getByRole('button',{name:'Continue',exact:true}).boundingBox()).height) < .1);
    const profile = panel.locator('#account-profile');
    const header = await profile.boundingBox();
    const avatar = profile.locator('#account-profile-avatar');
    assert.equal(await avatar.evaluate(node => getComputedStyle(node).borderRadius),'50%');
    assert(await avatar.evaluate(node => getComputedStyle(node).backgroundImage.startsWith('url(')));
    await app.page.evaluate(() => {
      const animate = Element.prototype.animate;
      window.accountSlides = [];
      Element.prototype.animate = function (frames, options) {
        if (this.parentElement?.id === 'account-stage' && frames.some(frame => frame.transform)) {
          window.accountSlides.push({id:this.id, frames});
        }
        return animate.call(this, frames, options);
      };
    });
    assert.deepEqual(requests,['/account/status']);
    const continueButton = panel.getByRole('button',{name:'Continue',exact:true});
    for (const invalidEmail of [
      '', 'fixture', 'fixture@local', '.fixture@example.com', 'fixture..birb@example.com',
      'fixture@-example.com', 'fixture@example.com.', 'a'.repeat(65) + '@example.com',
    ]) {
      await email.fill(invalidEmail);
      assert(await continueButton.isDisabled(), 'Continue is disabled for ' + JSON.stringify(invalidEmail));
    }
    await email.fill('fixture@local');
    await email.press('Enter');
    await panel.locator('#account-entry').getByRole('status').filter({hasText:'Enter a valid email address'}).waitFor();
    assert(Math.abs((await panel.getByRole('status').boundingBox()).width - entryWidth) < .1);
    assert(await email.isVisible());
    assert.deepEqual(requests,['/account/status']);
    await email.fill('limited@example.com');
    await continueButton.click();
    await panel.locator('#account-entry').getByRole('status').filter({hasText:'Try again in 20 minutes.'}).waitFor();
    await email.fill('fixture@example.com');
    assert.equal(await panel.getByRole('status').isVisible(),false);
    assert.equal(await continueButton.evaluate(button => getComputedStyle(button).backgroundColor),'rgb(35, 113, 64)');
    await continueButton.click();
    await panel.getByRole('button',{name:'Sending verification code…',exact:true}).waitFor();
    assert(await email.isDisabled());
    assert(await panel.getByRole('button',{name:'Sign in with passkey',exact:true}).isDisabled());
    const field = app.page.getByLabel('Verification code',{exact:true});
    await field.waitFor();
    assert(await field.evaluate(node => node.getRootNode() === document));
    assert.equal(await field.getAttribute('autocomplete'),'one-time-code');
    assert.equal(await field.getAttribute('inputmode'),'numeric');
    assert.equal(await field.getAttribute('maxlength'),'6');
    assert(Math.abs((await field.boundingBox()).width - entryWidth) < .1);
    const [verifyRect,resendRect] = await Promise.all([verify.boundingBox(),resend.boundingBox()]);
    assert(resendRect.y >= verifyRect.y + verifyRect.height && resendRect.width < verifyRect.width);
    assert(await verify.evaluate(el => getComputedStyle(el).backgroundColor !== getComputedStyle(el.parentElement.querySelector('#account-resend-code')).backgroundColor));
    assert(await resend.evaluate(button => {
      const primary = button.getRootNode().getElementById('account-verify-code');
      return parseFloat(getComputedStyle(button).fontSize) < parseFloat(getComputedStyle(primary).fontSize);
    }), 'resend uses smaller link text');
    assert(await resend.isDisabled());
    await panel.locator('#account-resend-control').hover();
    await app.page.getByRole('tooltip').filter({hasText:'Wait a minute'}).waitFor();
    assert((await field.boundingBox()).height > 40);
    await app.page.clock.fastForward(60001);
    assert.equal(await resend.isDisabled(),false);
    assert.equal(await panel.getByRole('textbox',{name:'Email address',exact:true}).count(),0);
    assert.deepEqual(await profile.boundingBox(),header);
    await field.fill('12345');
    assert(await verify.isDisabled());
    await panel.getByRole('heading',{name:'Check your email'}).click();
    await field.focus();
    assert.equal(await field.inputValue(),'12345');
    assert.equal(await field.getAttribute('autocomplete'),'one-time-code');
    await field.fill('123456');
    await field.press('Enter');
    await panel.getByRole('status').filter({hasText:'incorrect or expired'}).waitFor({timeout:4000});
    assert(await panel.locator('#account-code-field').getByRole('status',{exact:true}).isVisible());
    assert(await field.isVisible());
    await panel.getByRole('button',{name:'Back',exact:true}).click();
    await panel.locator('#account-entry-email').waitFor();
    assert.deepEqual(await profile.boundingBox(),header);
    const slides = await app.page.evaluate(() => window.accountSlides);
    assert(slides.some(({frames}) => frames[0].transform === 'translateX(100%)'));
    assert(slides.some(({frames}) => frames[0].transform === 'translateX(-100%)'));
    assert.equal(await email.inputValue(),'fixture@example.com');
    assert.equal(await panel.getByText('Recovery options',{exact:true}).count(),0);
    await app.page.emulateMedia({reducedMotion:'reduce'});
    await panel.getByRole('button',{name:'Continue',exact:true}).click();
    await field.waitFor();
    assert.equal(await app.page.evaluate(() => window.accountSlides.length),slides.length);
    assert.equal(await panel.locator('#account-stage > :not([hidden])').count(),1);
    assert.deepEqual(app.errors,[]);
  } finally { await app.browser.close(); }
});

test('passkey cancellation is silent and recovery continues from verified email', {timeout:14000}, async () => {
  const app = await launchApp({sharedStore:true});
  const requests = [];
  const ceremony = 'bbbbbbbb-bbbb-4bbb-abbb-bbbbbbbbbbbb';
  const options = {challenge:key,rpId:'backchnnl.app',userVerification:'required'};
  let signInError = true;
  try {
    await app.context.route('https://backchnnl.app/account/**', async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      requests.push(path);
      if (path === '/account/status') return route.fulfill({json:{available:true,emailAvailable:true}});
      if (path === '/account/login/options' && signInError) return route.fulfill({status:500,json:{error:'server-error'}});
      if (path === '/account/login/options' || path === '/account/register/options') return route.fulfill({json:{mode:'login',ceremony,options}});
      if (path === '/account/email/register/start') return route.fulfill({json:{ok:true}});
      if (path === '/account/recover/options') {
        assert.equal(request.postDataJSON().signInCeremony,ceremony);
        assert.match(request.postDataJSON().syncKeyVerifier,/^[A-Za-z0-9_-]{43}$/);
        return route.fulfill({json:{mode:'recover',ceremony,options}});
      }
      return route.fulfill({status:404,json:{error:'not-found'}});
    });
    const panel = await settings(app);
    await app.page.evaluate(() => {
      window.accountPasskeyRequests = 0;
      Object.defineProperty(Object.getPrototypeOf(navigator.credentials),'get',{value: () => {
        const cancelled = new DOMException('Unavailable in fixture','NotAllowedError');
        if (++window.accountPasskeyRequests === 2) return new Promise((resolve, reject) => {
          window.cancelAccountPasskey = () => reject(cancelled);
        });
        throw cancelled;
      }});
    });
    const signIn = panel.getByRole('button',{name:'Sign in with passkey',exact:true});
    await signIn.click();
    await panel.locator('#account-status-login').getByRole('status').filter({hasText:'Couldn’t sign in with your passkey'}).waitFor();
    signInError = false;
    await signIn.click();
    await signIn.waitFor();
    assert.equal(await panel.getByRole('status').isVisible(),false);
    await panel.locator('#account-entry-email').fill('fixture@example.com');
    await panel.getByRole('button',{name:'Continue',exact:true}).click();
    await app.page.getByLabel('Verification code',{exact:true}).fill(key);
    await panel.getByRole('button',{name:'Verify email',exact:true}).click();
    assert(await waitFor(() => app.page.evaluate(() => window.accountPasskeyRequests === 2)), 'verification prompts for the passkey');
    assert.equal(await signIn.isVisible(),false);
    await app.page.evaluate(() => window.cancelAccountPasskey());
    await signIn.waitFor();
    assert.equal(await panel.getByRole('status').isVisible(),false);
    const recover = panel.getByRole('button',{name:'Can’t use your passkey?',exact:true});
    assert(await recover.evaluate(button => {
      const primary = button.getRootNode().getElementById('account-passkey-login-submit');
      return button.getBoundingClientRect().top >= primary.getBoundingClientRect().bottom &&
        parseFloat(getComputedStyle(button).fontSize) < parseFloat(getComputedStyle(primary).fontSize);
    }), 'passkey recovery is small and below sign-in');
    await signIn.click();
    await signIn.waitFor();
    assert.equal(await panel.getByRole('status').isVisible(),false);
    assert.equal(await app.page.evaluate(() => window.accountPasskeyRequests),3);
    await recover.click();
    const keyField = panel.getByLabel('Recovery key',{exact:true});
    await keyField.fill(key);
    await panel.getByRole('button',{name:'Continue',exact:true}).click();
    await panel.getByRole('button',{name:'Replace passkey',exact:true}).waitFor();
    assert.equal(requests.filter(path=>path.startsWith('/account/email/')).length,1);
    assert.deepEqual(app.errors,[]);
  } finally { await app.browser.close(); }
});

test('phone Account controls match Settings typography and show passkey progress in the button', {timeout:12000}, async () => {
  const app = await launchApp({sharedStore:true, hasTouch:true, viewport:{width:390,height:844}});
  try {
    await app.context.route('https://backchnnl.app/account/**', route => {
      if (route.request().url().endsWith('/status')) return route.fulfill({json:{available:true,emailAvailable:true}});
      return route.fulfill({json:{ceremony:'fixture',options:{challenge:key,rpId:'backchnnl.app',userVerification:'required'}}});
    });
    const panel = await settings(app);
    assert.equal(await app.page.locator('#account-nav-status').isVisible(),false);
    const signIn = panel.locator('#account-login');
    await signIn.waitFor();
    const entry = await signIn.evaluate(button => {
      const root = button.getRootNode();
      const content = root.getElementById('app-settings-content');
      const stage = root.getElementById('account-stage');
      const actions = root.getElementById('account-sign-in-actions').getBoundingClientRect();
      const bottom = content.getBoundingClientRect().bottom - parseFloat(getComputedStyle(content).paddingBottom);
      return {
        topGap:actions.top - stage.getBoundingClientRect().top - parseFloat(getComputedStyle(stage).borderTopWidth),
        bottomGap:bottom - actions.bottom,
        email:root.getElementById('account-entry-email').getBoundingClientRect().height,
        button:button.getBoundingClientRect().height,
        standard:parseFloat(getComputedStyle(root.getElementById('settings-update-check')).height),
      };
    });
    assert(entry.topGap > 12 && Math.abs(entry.topGap - entry.bottomGap) < 1, JSON.stringify(entry));
    assert(Math.abs(entry.button - entry.standard) < .5 && Math.abs(entry.email - entry.button) < .5, JSON.stringify(entry));
    assert.equal(await panel.locator('#account-email-value').textContent(),'Sync your reading experience across all your devices.');
    const mismatches = await signIn.evaluate(control => {
      const root = control.getRootNode();
      const size = getComputedStyle(root.getElementById('settings-cache-clear')).fontSize;
      const controls = [
        ...root.querySelectorAll('#settings-account-sync :is(.settings-button:not(.account-text-action), input[type="email"], input[type="password"])'),
        root.host.querySelector('#account-email-code'),
      ];
      return controls.map(element => [element.id, getComputedStyle(element).fontSize])
        .filter(([, fontSize]) => fontSize !== size);
    });
    assert.deepEqual(mismatches, []);
    await app.page.evaluate(() => {
      Object.defineProperty(Object.getPrototypeOf(navigator.credentials),'get',{value: () => new Promise(() => {})});
    });
    await signIn.tap();
    await panel.getByRole('button',{name:'Signing in…',exact:true}).waitFor();
    assert.equal(await signIn.getAttribute('aria-busy'),'true');
    assert.equal(await signIn.locator('span').evaluate(el => getComputedStyle(el).animationName),'settings-update-glimmer');
    assert.equal(await panel.getByRole('status').isVisible(),false);
  } finally { await app.browser.close(); }
});

test('reloading Reader skips the same passkey details and still sends a changed email', {timeout:20000}, async () => {
  const app = await launchApp({sharedStore:true, values:{[storage]:{...session, base:{}}}});
  try {
    const remote = {email:'birb@example.com',capabilities:{emailAvailable:true}};
    const mock = mockAccount(app,remote);
    await mock.start;
    const panel = await settings(app, appURL, {recordPasskeyDetails:true});
    const emails = () => app.page.evaluate(() => window.passkeyDetails.map(details => details.name));
    const detailsKey = 'HNewhere:account_passkey_details:' + account;
    const waitForEmail = () => panel.locator('#account-email-value').getByText(remote.email,{exact:true}).waitFor();
    const expectUpdate = async () => {
      assert(await waitFor(async () => (await emails()).length === 1));
      assert.deepEqual(await emails(), [remote.email]);
    };
    const reloadAccount = async () => {
      await app.page.reload();
      await app.page.locator('#settings-toggle').click();
      await app.page.getByRole('button',{name:'Account',exact:true}).click();
      await waitForEmail();
    };
    await waitForEmail();
    await expectUpdate();

    await reloadAccount();
    assert.equal(await waitFor(async () => (await emails()).length > 0, 750), false, 'reload does not resend an in-flight update');

    remote.email = 'new-birb@example.com';
    await reloadAccount();
    await expectUpdate();
    await app.page.evaluate(() => window.finishPasskeyDetails(false));
    assert(await waitFor(() => !app.store.has(detailsKey)), 'a dismissed update can be retried after reload');
    const manage = panel.getByRole('button',{name:'Manage account',exact:true});
    assert(await waitFor(async () => !(await manage.isDisabled())));
    const emailReads = () => mock.requests.filter(path => path === '/account/email').length;
    const previousReads = emailReads();
    await panel.dispatchEvent('account-settings-shown');
    assert(await waitFor(() => emailReads() > previousReads));
    assert.equal(await waitFor(async () => (await emails()).length > 1, 750), false, 'a profile refresh respects the dismissal');

    await reloadAccount();
    await expectUpdate();
    await app.page.evaluate(() => window.finishPasskeyDetails(true));
    assert(await waitFor(() => app.store.get(detailsKey)?.fingerprint && !app.store.get(detailsKey)?.attempt));
    await app.page.clock.setFixedTime(Date.now() + 2 * 60_000);
    await reloadAccount();
    assert.equal(await waitFor(async () => (await emails()).length > 0, 750), false, 'reload does not resend a completed update');
    assert.deepEqual(app.errors, []);
  } finally { await app.browser.close(); }
});

test('email updates confirm the passkey before sending a code and anchor request errors to Update', {timeout:20000}, async () => {
  const app = await launchApp({sharedStore:true, values:{[storage]:{...session, base:{}}}});
  try {
    await app.page.clock.install();
    const sending = Promise.withResolvers();
    const remote = {email:'birb@example.com',capabilities:{emailAvailable:true},beforeEmailSend:sending.promise};
    const mock = mockAccount(app,remote);
    await mock.start;
    const panel = await settings(app, appURL, {recordPasskeyDetails:true});
    const passkeyDetails = name => ({
      rpId:'backchnnl.app', userId:Buffer.from(account).toString('base64url'), name, displayName:'Backchannel account',
    });
    await panel.locator('#account-email-value').getByText(remote.email,{exact:true}).waitFor();
    assert(await waitFor(() => app.page.evaluate(() => window.passkeyDetails.length === 1)));
    assert.deepEqual(await app.page.evaluate(() => window.passkeyDetails), [passkeyDetails(remote.email)]);
    await panel.getByRole('button',{name:'Manage account',exact:true}).click();
    const manage = panel.locator('#account-manage-page');
    const address = manage.getByLabel('Email address',{exact:true});
    await address.waitFor();
    assert.equal(await address.getAttribute('placeholder'),'birb@example.com');
    const update = manage.getByRole('button',{name:'Update',exact:true});
    assert(await waitFor(() => mock.requests.includes('/account/email/options')));
    await app.page.evaluate(() => {
      const button = document.querySelector('[data-hnewhere-app]').shadowRoot.getElementById('account-send-code');
      if (!button) throw new Error('Update button is missing');
      window.emailPrompts = [];
      window.emailSlides = [];
      const animate = Element.prototype.animate;
      Element.prototype.animate = function(frames, options) {
        if (this.parentElement?.id === 'account-manage-stage' && frames.some(frame => frame.transform)) {
          window.emailSlides.push({id:this.id, transforms:frames.map(frame => frame.transform)});
        }
        return animate.call(this, frames, options);
      };
      Object.defineProperty(Object.getPrototypeOf(navigator.credentials), 'get', {value: ({publicKey,signal,mediation}) => new Promise(resolve => {
        window.emailPrompts.push({
          allowed:publicKey.allowCredentials?.length, signal, resolve, mediation,
          buttonDisabled:button.disabled, active:navigator.userActivation?.isActive,
        });
      })});
    });
    await address.fill('new-birb@local');
    assert(await update.isDisabled());
    await address.blur();
    const invalidAddress = manage.locator('#account-status-email').getByRole('status').filter({hasText:'Enter a valid email address'});
    await invalidAddress.waitFor();
    await address.press('Enter');
    assert.equal(await app.page.evaluate(() => window.emailPrompts.length),0);
    assert(!mock.requests.includes('/account/email/start'));
    await address.fill('New-Birb+nest@sub.example.com');
    assert.equal(await invalidAddress.isVisible(),false);
    await update.click({scroll:'none'});
    const opened = await waitFor(() => app.page.evaluate(() => window.emailPrompts.length === 1),4000);
    if (!opened) {
      const count = await app.page.evaluate(() => window.emailPrompts.length);
      assert.fail(`Expected one passkey request. Got ${count}. Status: ${await manage.getByRole('status').allTextContents()}. Page errors: ${app.errors.join(', ')}`);
    }
    await manage.getByRole('button',{name:'Confirming passkey…',exact:true}).waitFor();
    const prompt = await app.page.evaluate(() => {
      const {allowed,buttonDisabled,active,mediation} = window.emailPrompts[0];
      return {allowed,buttonDisabled,active,mediation};
    });
    assert.equal(prompt.allowed,0);
    assert.equal(prompt.buttonDisabled,false);
    assert.equal(prompt.mediation,'required');
    if (prompt.active !== undefined) assert.equal(prompt.active,true);
    assert.equal(mock.requests.filter(path => path === '/account/email/options').length,1);
    assert(!mock.requests.includes('/account/email/start'));
    await app.page.clock.fastForward(61_000);
    const buttonFeedback = manage.locator('#account-status-send-code');
    const toast = buttonFeedback.getByRole('status').filter({hasText:'Passkey confirmation timed out'});
    await toast.waitFor();
    const [buttonBounds, toastBounds, anchorBounds] = await Promise.all([
      update.boundingBox(), toast.boundingBox(), buttonFeedback.boundingBox(),
    ]);
    assert.equal(buttonBounds.width,toastBounds.width);
    assert(anchorBounds.y >= buttonBounds.y + buttonBounds.height - 0.5);
    assert.equal(await toast.evaluate(element => getComputedStyle(element).animationName),'account-field-toast-in');
    assert(await app.page.evaluate(() => window.emailPrompts[0].signal.aborted));
    assert(!mock.requests.includes('/account/email/start'));
    assert(await waitFor(async () => !(await update.isDisabled())));
    await app.page.clock.fastForward(5 * 60_000);
    await address.press('Enter');
    await manage.getByRole('status').filter({hasText:'Select Update again to open the passkey prompt'}).waitFor();
    assert.equal(await app.page.evaluate(() => window.emailPrompts.length),1);
    await address.press('Enter');
    assert(await waitFor(() => app.page.evaluate(() => window.emailPrompts.length === 2)));
    remote.emailSendError = 'server-error';
    await app.page.evaluate(() => window.emailPrompts[1].resolve({toJSON: () => ({id:'fixture-passkey'})}));
    const deliveryError = buttonFeedback.getByRole('status').filter({hasText:'Couldn’t send a verification code'});
    await deliveryError.waitFor();
    assert.equal(await address.getAttribute('aria-invalid'),null);
    assert.equal(await manage.locator('#account-status-email').textContent(),'');
    assert.match(await update.getAttribute('aria-describedby'),/\baccount-status-send-code\b/);
    remote.emailSendError = null;
    await update.click({scroll:'none'});
    assert(await waitFor(() => app.page.evaluate(() => window.emailPrompts.length === 3)));
    await app.page.evaluate(() => window.emailPrompts[2].resolve({toJSON: () => ({id:'fixture-passkey'})}));
    await manage.getByRole('button',{name:'Sending verification code…',exact:true}).waitFor();
    const heading = manage.getByRole('heading',{name:'Manage account',exact:true});
    const headingLayout = () => heading.evaluate(element => {
      const {x,y,width,height} = element.getBoundingClientRect();
      const parent = element.parentElement.getBoundingClientRect();
      return {x:x - parent.x,y:y - parent.y,width,height};
    });
    const headingPosition = await headingLayout();
    sending.resolve();
    const code = app.page.getByLabel('Verification code',{exact:true});
    await code.waitFor();
    await address.waitFor({state:'hidden'});
    assert.equal(await address.isVisible(),false);
    assert.equal(await update.isVisible(),false);
    assert.deepEqual(await headingLayout(),headingPosition);
    assert.equal(await toast.isVisible(),false);
    const verify = manage.getByRole('button',{name:'Verify email',exact:true});
    await code.fill('000000');
    await verify.click({scroll:'none'});
    await manage.locator('#account-status-code [data-error]').waitFor();
    assert.deepEqual(await app.page.evaluate(() => window.passkeyDetails), [passkeyDetails('birb@example.com')]);
    await code.fill('123456');
    await verify.click({scroll:'none'});
    const confirmation = app.page.locator('#toast').filter({hasText:'Email updated.'});
    await confirmation.and(app.page.locator('.is-showing')).waitFor();
    assert.equal(await confirmation.getAttribute('data-kind'),'system');
    await code.waitFor({state:'hidden'});
    assert.equal(await address.getAttribute('placeholder'),'new-birb+nest@sub.example.com');
    assert.equal(await address.inputValue(),'');
    assert.deepEqual(await app.page.evaluate(() => window.emailSlides), [
      {id:'account-manage-email',transforms:['translateX(0)','translateX(-100%)']},
      {id:'account-manage-code',transforms:['translateX(100%)','translateX(0)']},
      {id:'account-manage-code',transforms:['translateX(0)','translateX(100%)']},
      {id:'account-manage-email',transforms:['translateX(-100%)','translateX(0)']},
    ]);
    assert.deepEqual(await headingLayout(),headingPosition);
    assert.equal(await manage.getByRole('status').filter({hasText:'Email updated.'}).isVisible(),false);
    await app.page.clock.fastForward(6000);
    assert.equal(await confirmation.evaluate(node => node.classList.contains('is-showing')),false);
    assert.deepEqual(await app.page.evaluate(() => window.passkeyDetails), [
      passkeyDetails('birb@example.com'), passkeyDetails('new-birb+nest@sub.example.com'),
    ]);
  } finally { await app.browser.close(); }
});

test('new account creation requires email delivery while existing users can sign in', {timeout:10000}, async () => {
  const app = await launchApp({sharedStore:true, values:{[storage]:{...session, protocol:undefined, recoveryKey:''}}});
  try {
    await app.context.route('https://backchnnl.app/account/status', route => route.fulfill({json:{available:true,emailAvailable:false}}));
    const panel = await settings(app);
    const signIn = panel.getByRole('button', {name:'Sign in with passkey',exact:true});
    await signIn.waitFor();
    assert(!(await signIn.isDisabled()));
    assert(await panel.getByRole('button', {name:'Continue',exact:true}).isDisabled());
    assert(await panel.getByText('Email verification is temporarily unavailable.', {exact:true}).isVisible());
  } finally { await app.browser.close(); }
});

test('a browser without Ed25519 keeps legacy passkey sign-in available', {timeout:12000}, async () => {
  const app = await launchApp({sharedStore:true, settings:{updateCheck:false,sourceRefreshMinutes:0}});
  const encoder = new TextEncoder();
  const credentialId = 'fixture-passkey';
  const seed = new Uint8Array(32).fill(7);
  const iv = new Uint8Array(12).fill(9);
  const cipher = await crypto.subtle.importKey('raw', seed, 'AES-GCM', false, ['encrypt']);
  const additionalData = encoder.encode(JSON.stringify(['backchannel-key-envelope',1,account,credentialId]));
  const sealed = await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData}, cipher, Buffer.from(key,'base64url'));
  const envelope = Buffer.concat([Buffer.from(iv),Buffer.from(sealed)]).toString('base64url');
  const verifications = [];
  const completions = [];
  let modern = true;
  try {
    await app.context.route('https://backchnnl.app/account/**', async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === '/account/status') return route.fulfill({json:{available:true}});
      if (path === '/account/login/options') return route.fulfill({json:{ceremony:'fixture',options:{challenge:key,rpId:'backchnnl.app'}}});
      if (path === '/account/login/verify') {
        const body = request.postDataJSON();
        verifications.push(body);
        return route.fulfill({json:{account,envelope,unlock:key,keyProofVersion:modern ? 2 : body.keyProofVersion === 2 ? 1 : undefined}});
      }
      if (path === '/account/login/complete') {
        completions.push(request.postDataJSON());
        return route.fulfill({json:{account,token:session.token,expiresAt:session.expiresAt}});
      }
      return route.fulfill({status:404,json:{error:'not-found'}});
    });
    const panel = await settings(app);
    await app.page.evaluate(({credentialId, seed}) => {
      const importKey = crypto.subtle.importKey.bind(crypto.subtle);
      Object.defineProperty(crypto.subtle, 'importKey', { value(format, data, algorithm, ...options) {
        if (algorithm === 'Ed25519') throw new DOMException('Unavailable in fixture', 'NotSupportedError');
        return importKey(format, data, algorithm, ...options);
      }});
      const credentials = navigator.credentials;
      Object.defineProperty(navigator, 'credentials', {value: credentials, configurable: true});
      Object.defineProperty(credentials, 'get', { value: async () => ({
        toJSON: () => ({id:credentialId,clientExtensionResults:{}}),
        getClientExtensionResults: () => ({prf:{results:{first:new Uint8Array(seed)}}}),
      }) });
    }, {credentialId,seed:[...seed]});
    const signIn = panel.getByRole('button',{name:'Sign in with passkey',exact:true});
    await signIn.click();
    await panel.getByRole('status').filter({hasText:'Update your browser to use this Backchannel account.'}).waitFor();
    assert.equal(completions.length,0);
    modern = false;
    await signIn.click();
    assert(await waitFor(() => app.store.get(storage)?.token === session.token));
    assert.equal(verifications.length,2);
    assert(verifications.every(body => body.keyProofVersion === undefined));
    assert.match(completions[0].syncKeyVerifier,/^[A-Za-z0-9_-]{43}$/);
    assert.equal(completions[0].syncKeySignature,undefined);
  } finally { await app.browser.close(); }
});

test('a stalled deletion passkey times out and can be retried or cancelled', {timeout:15000}, async () => {
  const app = await launchApp({
    sharedStore:true, values:{[storage]:{...session,base:{}}}, settings:{updateCheck:false,sourceRefreshMinutes:0},
  });
  try {
    app.page.setDefaultTimeout(4000);
    await app.page.clock.install();
    const remote = {revision:0,ciphertext:null,email:'birb@example.com',capabilities:{emailAvailable:true}};
    const proxy = mockAccount(app, remote);
    await Promise.all([proxy.start,mockPasskeySupport(app)]);
    await app.page.goto(appURL+'#account-sync');
    const panel = app.page.locator('#settings-account-sync');
    await panel.locator('#account-email-value').getByText(remote.email,{exact:true}).waitFor();
    await app.page.evaluate(() => {
      window.deletionPrompts = [];
      window.accountActionFades = [];
      const animate = Element.prototype.animate;
      Element.prototype.animate = function(frames, options) {
        if (this.id === 'account-actions' || this.id === 'account-delete-confirm') {
          window.accountActionFades.push([this.id, ...frames.map(frame => frame.opacity)]);
        }
        return animate.call(this, frames, options);
      };
      Object.defineProperty(Object.getPrototypeOf(navigator.credentials),'get',{value: ({publicKey,signal}) => {
        window.deletionPrompts.push({signal, allowed:publicKey.allowCredentials?.length ?? 0, active:navigator.userActivation?.isActive});
        return new Promise(() => {});
      }});
    });
    const status = panel.getByRole('status');
    const confirm = panel.getByRole('button',{name:'Delete account',exact:true});
    const deletion = panel.getByRole('button',{name:'Delete account…',exact:true});
    await deletion.click();
    await deletion.waitFor({state:'hidden'});
    assert.deepEqual(await app.page.evaluate(() => window.accountActionFades.slice(0,2)), [
      ['account-actions',1,0],
      ['account-delete-confirm',0,1],
    ]);
    const cancel = panel.getByRole('button',{name:'Cancel',exact:true});
    assert((await confirm.boundingBox()).x > (await cancel.boundingBox()).x);
    const prefetched = await waitFor(() => proxy.requests.includes('/account/delete/options'), 1800);
    await confirm.click();
    assert(await waitFor(() => app.page.evaluate(() => window.deletionPrompts.length === 1), 2000), await status.textContent());
    await app.page.clock.fastForward(61000);
    await status.filter({hasText:'Passkey confirmation timed out'}).waitFor({timeout:2500});
    assert(prefetched, 'preparing the challenge does not use the confirmation click');
    const first = await app.page.evaluate(() => window.deletionPrompts.map(({signal,allowed,active}) => ({aborted:signal?.aborted,allowed,active})));
    assert.equal(first[0].aborted,true);
    assert.equal(first[0].allowed,0,'the platform can find the existing discoverable passkey');
    if (first[0].active !== undefined) assert.equal(first[0].active,true);
    await confirm.click();
    assert(await waitFor(() => app.page.evaluate(() => window.deletionPrompts.length === 2)));
    await cancel.click();
    assert(await waitFor(() => app.page.evaluate(() => window.deletionPrompts[1].signal.aborted)));
    await confirm.waitFor({state:'hidden'});
    await deletion.waitFor();
    assert(app.store.get(storage)?.token);
    assert(!proxy.requests.includes('/account'));
    assert.deepEqual(app.errors,[]);
  } finally { await app.browser.close(); }
});

test('an established account uploads edits and skips scheduled or focus-triggered network requests when clean', {timeout: 23000}, async () => {
  const remote = {revision:0,ciphertext:null};
  const app = await launchApp({sharedStore:true, values:{[storage]: session}, topHosts:['news.ycombinator.com']});
  try {
    await app.page.clock.install();
    const proxy = mockAccount(app, remote);
    await proxy.start;
    remote.beforePut = () => {
      app.store.set('HNewhere:settings', {...app.store.get('HNewhere:settings'), theme:'dark'});
    };
    const panel = await settings(app);
    assert(await waitFor(() => app.store.get(storage)?.revision === 2), 'the retry includes the edit made during upload');
    assert.equal(app.store.get(storage).base.settings.theme,'dark');

    await app.page.getByRole('button', {name:'Appearance',exact:true}).click();
    await app.page.locator('#settings-panel label:has(input[data-setting="theme"][value="light"])').click();
    assert(await waitFor(() => app.store.get(storage)?.revision === 3), 'saving a setting triggers an immediate sync even with a legacy automatic:false preference');
    assert.equal(app.store.get(storage).base.settings.theme,'light');
    assert.equal(await panel.getByText('Automatic sync', {exact:true}).count(), 0);

    const snapshots = () => proxy.requests.filter(path => path === '/account/snapshot').length;
    const before = snapshots();
    await app.page.clock.fastForward(180001);
    await app.page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await app.page.clock.runFor(1000);
    assert.equal(snapshots(),before);

    await app.context.route('https://news.ycombinator.com/news', route => route.fulfill({contentType:'text/html',body:`
      <table><tr class="athing" id="42"><td class="title"><span class="titleline"><a href="https://example.net/queue">Queue outside Reader</a></span></td></tr>
      <tr><td class="subtext"><a class="hnuser">fixture</a></td></tr></table>`}));
    const news = await app.context.newPage();
    await news.goto('https://news.ycombinator.com/news');
    const queueLink = news.locator('.hnewhere-queue-link');
    await queueLink.click();
    assert(await waitFor(() => app.store.get(queueStorage)?.length === 1));
    await app.page.evaluate(() => window.dispatchEvent(new Event('focus')));
    assert(await waitFor(() => app.store.get(storage)?.revision === 4), 'Reader uploads the queue edit on focus');
    assert.equal(app.store.get(storage).base.collection.queue[0].title,'Queue outside Reader');

    await queueLink.click();
    assert(await waitFor(() => app.store.get(queueStorage)?.length === 0));
    await news.close();
    await app.page.evaluate(() => window.dispatchEvent(new Event('focus')));
    assert(await waitFor(() => app.store.get(storage)?.revision === 5), 'Reader uploads the queue deletion');

    remote.offline = true;
    await app.page.getByRole('button', {name:'Account',exact:true}).click();
    await panel.getByRole('status').filter({hasText:'unavailable'}).waitFor();
    assert(await panel.getByRole('button',{name:'Sync now',exact:true}).isDisabled());
    await panel.getByRole('button',{name:'Sign out',exact:true}).click();
    assert(await waitFor(() => !app.store.get(storage)), 'a device can sign out while the service is offline');
    assert.equal(app.store.get('HNewhere:settings').theme,'light');
    assert.deepEqual(app.errors,[]);
  } finally { await app.browser.close(); }
});

test('a passkey timeout cannot appear on sign-in after the account session is removed', {timeout:15000}, async () => {
  const app = await launchApp({sharedStore:true, values:{[storage]: session}});
  try {
    await app.page.clock.install();
    await mockAccount(app, {revision:0,ciphertext:null,email:'birb@example.com',capabilities:{emailAvailable:true}}).start;
    const panel = await settings(app, appURL, {
      beforeOpen: async () => assert(await waitFor(() => app.store.get(storage)?.base, 5000), 'the initial account sync completes'),
    });
    await app.page.evaluate(() => {
      Object.defineProperty(Object.getPrototypeOf(navigator.credentials),'get',{value: () => {
        window.confirmingDeletion = true;
        return new Promise(() => {});
      }});
    });
    await panel.getByRole('button',{name:'Delete account…',exact:true}).click();
    await panel.getByRole('button',{name:'Delete account',exact:true}).click();
    assert(await waitFor(() => app.page.evaluate(() => window.confirmingDeletion)));
    app.store.delete(storage);
    await app.page.clock.fastForward(61000);
    await panel.getByRole('button',{name:'Sign in with passkey',exact:true}).waitFor();
    assert.equal(await panel.getByRole('status').filter({hasText:'Passkey confirmation timed out'}).isVisible(),false);
    assert.deepEqual(app.errors,[]);
  } finally { await app.browser.close(); }
});

test('Phone Sidebar Account uses the private Account settings in place', {timeout:15000}, async () => {
  const article = STORIES[0].url;
  const shell = appURL + 'sidebar-settings';
  const lastSync = Date.now() - 60_000;
  const app = await launchApp({
    topHosts:[new URL(article).hostname], sharedStore:true, hasTouch:true, isMobile:true,
    viewport:{width:393,height:852}, contentPages:[shell],
    settings:{autoOpenSidebar:true,keepSidebarSize:true,updateCheck:false},
    pages:{[article]:{html:'<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Account fixture</title></head><body><article>Account layout fixture</article></body></html>'}},
    values:{[storage]:{...session,lastSync},['HNewhere:account_avatar:' + account]:{shape:'wide',color:'blue',background:'sky'}},
  });
  try {
    await mockPasskeySupport(app);
    await app.context.route(shell, (route) => route.fulfill({
      contentType:'text/html',headers:{'content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'"},
      body:'<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body></body></html>',
    }));
    await app.context.addInitScript(({ url, publisher }) => {
      if (location.href === publisher) Object.defineProperty(window, "outerWidth", { get: () => 393 });
      if (location.origin + location.pathname !== url) return;
      window.avatarImagesBlocked = 0;
      document.addEventListener("securitypolicyviolation", (event) => {
        if (event.effectiveDirective === "img-src") window.avatarImagesBlocked++;
      });
    }, { url: shell, publisher: article });
    const remote = {revision:0,ciphertext:null,email:'birb@example.com',capabilities:{emailAvailable:true}};
    const api = mockAccount(app, remote);
    await api.start;
    const accountWrites = [];
    await app.context.route(appURL + "account/**", async (route) => {
      const request = route.request();
      if (request.method() !== "GET") accountWrites.push(await request.allHeaders());
      await route.fallback();
    });
    await app.page.goto(article);
    app.context.setDefaultTimeout(5000);
    await app.page.getByRole("button", { name: "Open Backchannel settings" }).click();
    const accountTab = app.page.getByRole("button", { name: "Account", exact: true });
    await accountTab.evaluate((button) => button.click());
    assert.equal(app.page.frames().some((frame) => frame.url().startsWith(shell)), false);
    assert.deepEqual(api.requests, []);
    await accountTab.click();
    const accountFrame = () => app.page.frames().find((frame) => frame.url().startsWith(shell));
    assert(await waitFor(accountFrame, 4500), 'Account is loaded inside Sidebar Settings');
    const frame = accountFrame();
    const panel = frame.locator('#settings-account-sync');
    const sync = panel.getByRole('button', {name:'Sync now',exact:true});
    await sync.waitFor();
    assert.equal(await panel.locator('#account-profile-avatar').getAttribute('data-birb-shape'), 'wide');
    await frame.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await frame.evaluate(() => window.avatarImagesBlocked), 0, "the private frame permits the bundled avatar");
    assert.equal(await panel.getByRole('heading', {name:'Linked devices',exact:true}).isVisible(), false);
    await app.page.setViewportSize({ width:197, height:426 });
    assert(await waitFor(() => app.page.locator("#panel").evaluate((el) => el.style.zoom === "0.5")));
    const accountFits = (selector) => frame.evaluate((selector) => {
      const root = document.querySelector("body > div").shadowRoot;
      const section = root.getElementById("settings-account-sync");
      const rows = [...section.querySelectorAll(selector)];
      return innerWidth > 300 && Math.abs(document.body.getBoundingClientRect().width - innerWidth) <= 1 &&
        rows.length > 0 && rows.every(row => row.getBoundingClientRect().width > 0 && row.getBoundingClientRect().right <= innerWidth + 1);
    }, selector);
    assert(await waitFor(() => accountFits("#account-profile-avatar, #account-sync-now")), "Account avatar and controls fit the logical Settings frame at 200% zoom");
    const frameBox = await (await frame.frameElement()).boundingBox();
    assert(Math.abs(frameBox.width / (await frame.evaluate(() => innerWidth)) - 0.5) < 0.025);
    assert(await panel.getByRole('button', {name:'Sign out',exact:true}).isVisible());
    assert(await panel.getByRole('button', {name:'Delete account…',exact:true}).isVisible());
    assert(await waitFor(() => sync.isEnabled()));
    const beforeSync = api.requests.filter(path => path === '/account/snapshot').length;
    await sync.scrollIntoViewIfNeeded();
    const buttonCenter = await sync.evaluate((el) => {
      const { x, y, width, height } = el.getBoundingClientRect();
      return { x: x + width / 2, y: y + height / 2 };
    });
    const positionedFrame = await (await frame.frameElement()).boundingBox();
    const scale = positionedFrame.width / (await frame.evaluate(() => innerWidth));
    await app.page.mouse.click(positionedFrame.x + buttonCenter.x * scale, positionedFrame.y + buttonCenter.y * scale);
    assert(await waitFor(() => api.requests.filter(path => path === '/account/snapshot').length > beforeSync));
    const manage = panel.getByRole('button', {name:'Manage account',exact:true});
    assert(await waitFor(() => manage.isEnabled()));
    await manage.press('Enter');
    const devices = await linkedDevicesIn(panel);
    await devices.getByRole('button', {name:'Sign out iPhone · Safari'}).waitFor();
    assert(await waitFor(() => accountFits(".account-device-list li")), "Linked devices fit the logical Settings frame at 200% zoom");
    await app.page.setViewportSize({ width:393, height:852 });
    assert(await waitFor(() => app.page.locator("#panel").evaluate((el) => !el.style.zoom)));
    assert.equal(await panel.locator('#account-email-input').getAttribute('placeholder'), 'birb@example.com');
    assert.equal(await app.page.getByText('birb@example.com', { exact:true }).count(), 0);
    assert.deepEqual(app.context.pages(), [app.page]);
    assert.equal(app.page.url(), article);
    assert.equal(await frame.locator('#app-rail').count(),0);
    assert(accountWrites.length > 0, 'Account sends an authenticated same-origin write');
    for (const headers of accountWrites) {
      assert.equal(headers.origin, new URL(appURL).origin);
      assert(!['same-site', 'cross-site'].includes(headers['sec-fetch-site']));
    }
    await panel.locator('#account-manage-back').click();
    const [passkeyWindow] = await Promise.all([
      app.context.waitForEvent('page'),
      panel.getByRole('button', {name:'Delete account…',exact:true}).click(),
    ]);
    await passkeyWindow.waitForURL(appURL + '#settings/account');
    const windowAccount = passkeyWindow.locator('#settings-account-sync');
    assert.equal(await windowAccount.getByRole('heading', {name:'Linked devices',exact:true}).isVisible(), false);
    await windowAccount.getByRole('button', {name:'Manage account',exact:true}).click();
    const windowDevices = await linkedDevicesIn(windowAccount);
    await windowDevices.getByText('Mac · Safari · This device', {exact:true}).waitFor();
    assert.equal(await passkeyWindow.locator('#app-rail').count(),0);
    assert.equal(await passkeyWindow.evaluate(() => Boolean(window.opener)), false);
    assert(!api.requests.includes('/account/delete/options'), 'Account deletion still requires the user to confirm in Backchannel');
    await passkeyWindow.close();
    assert(await panel.isVisible());
    assert.deepEqual(app.errors,[]);
  } finally { await app.browser.close(); }
});
