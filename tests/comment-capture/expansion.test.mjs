import test from "node:test";
import assert from "node:assert/strict";
import { launchApp, STORIES, waitFor } from "./harness.mjs";
import { discussionFixture } from "./fixtures.mjs";

const url = STORIES[0].url;
const now = Math.floor(Date.now() / 1000);
const comment = (id, parent, body, replies = "") => ({ kind: "t1", data: { id, parent_id: parent, link_id: "t3_fixture0", author: "reader", body, score: 1, created_utc: now, replies } });

async function openArchive(initial, expanded, { handler = "Userscripts", expandedDelay = 0, reader = false, commentSort = "best" } = {}) {
  const fixture = discussionFixture(url);
  const expansion = Array.isArray(expanded) ? { json: { data: expanded } } : expanded;
  expansion.match = (path) => path.includes("/api/comments/tree") && new URL(path).searchParams.get("limit") === "25000";
  expansion.delay = expandedDelay;
  const responses = [
    { match: (path) => path.includes("/api/posts/search"), json: { data: [fixture.posts[0]] } },
    expansion,
    { match: (path) => path.includes("/api/comments/tree"), json: { data: initial } },
  ];
  const app = await launchApp({
    ...(reader ? {} : { appHost: new URL(url).hostname }), sharedStore: true, handler,
    settings: { sources: { hn: reader, reddit: true }, autoOpenSidebar: !reader, updateCheck: false, commentSort },
    values: { "HNewhere:reddit_read_window_notice": 2, "HNewhere:reddit_tier": { tier: "archive", timestamp: Date.now() } },
    responses,
  });
  await app.page.goto(reader ? "https://backchnnl.app/" : url);
  if (reader) await app.page.locator("#app-list-body .browse-title-link", { hasText: STORIES[0].title }).first().click();
  return app;
}

test("all 120 omitted roots remain loadable across multiple batches", { timeout: 45000 }, async () => {
  const root = comment("root", "t3_fixture0", "First comment");
  const ids = Array.from({ length: 120 }, (_, index) => `extra${index}`);
  const initial = [root, { kind: "more", data: { children: ids, count: 0 } }];
  const expanded = [root, ...ids.map((id) => comment(id, "t3_fixture0", `Comment ${id}`))];
  const app = await openArchive(initial, expanded);
  try {
    const more = app.page.locator("#comments-content .more-replies");
    await more.waitFor({ timeout: 15000 });
    assert.match(await more.textContent(), /^120 more replies/, "known IDs are not labeled as zero");
    await more.click();
    assert(await waitFor(async () => await app.page.locator("#comments-content .comment[data-comment-id]").count() === 101, 15000));
    await more.click();
    assert(await waitFor(async () => await app.page.locator("#comments-content .comment[data-comment-id]").count() === 121, 15000));
    assert.equal(await app.page.locator('#comments-content .comment[data-comment-id="reddit:extra119"]').count(), 1);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.browser.close();
  }
});

test('expanded replies remain available to another page using the shared discussion', { timeout: 45000 }, async () => {
  const root = comment('root', 't3_fixture0', 'First comment');
  const ids = Array.from({ length: 101 }, (_, index) => `extra${index}`);
  const initial = [root, { kind: 'more', data: { children: ids, count: ids.length } }];
  const expanded = [root, ...ids.map((id) => comment(id, 't3_fixture0', `Shared expanded reply ${id}`))];
  const app = await openArchive(initial, expanded, { handler: 'Tampermonkey' });
  try {
    const more = app.page.locator('#comments-content .more-replies');
    await more.waitFor({ timeout: 15000 });
    await more.click();
    assert(await waitFor(async () => await app.page.locator('#comments-content .comment[data-comment-id="reddit:extra99"]').count() === 1, 10000));
    assert(await waitFor(() => Boolean(app.store.get('HNewhere:thread_cache:reddit:fixture0')?.comments?.['reddit:extra99']), 5000), 'expanded comments are published to the shared discussion');
    const other = await app.context.newPage();
    await other.goto(url);
    assert(await waitFor(async () => await other.locator('#comments-content .comment[data-comment-id="reddit:extra99"]').count() === 1, 10000));
    const remaining = other.locator('#comments-content .more-replies');
    assert.match(await remaining.textContent(), /^1 more reply/, 'only the remaining reply is offered');
    await remaining.click();
    assert(await waitFor(async () => await other.locator('#comments-content .comment[data-comment-id="reddit:extra100"]').count() === 1, 10000));
    await other.locator('#comment-sort').click();
    await other.getByRole('menuitemradio', { name: 'Newest', exact: true }).click();
    assert(await waitFor(async () => await other.locator('#comments-content .discussion-loading').count() === 0 && await other.locator('#comments-content .comment[data-comment-id]').count() === 102, 15000), 'sorting keeps all replies expanded from the shared cache');
    assert.equal(await remaining.count(), 0, 'already loaded replies are not offered again');
    assert.deepEqual(app.errors, []);
  } finally { await app.browser.close(); }
});

test("sync preserves already expanded replies and keeps the remaining replies loadable", { timeout: 45000 }, async () => {
  const root = comment("root", "t3_fixture0", "First comment");
  const ids = Array.from({ length: 120 }, (_, index) => `extra${index}`);
  const initial = [root, { kind: "more", data: { children: ids, count: 120 } }];
  const expanded = [root, ...ids.map((id) => comment(id, "t3_fixture0", `Comment ${id}`))];
  const app = await openArchive(initial, expanded, { handler: "Tampermonkey" });
  try {
    const more = app.page.locator('#comments-content .more-replies');
    await more.waitFor({ timeout: 15000 });
    await more.click();
    assert(await waitFor(async () => await app.page.locator('#comments-content .comment[data-comment-id]').count() === 101, 15000));
    await app.page.locator('#browse-home-sync').click();
    assert(await waitFor(async () => await app.page.locator('#browse-home-sync').getAttribute('aria-busy') !== 'true', 15000));
    assert.equal(await app.page.locator('#comments-content .comment[data-comment-id]').count(), 101, 'expanded comments remain visible after sync');
    assert.match(await more.textContent(), /^20 more replies/, 'only the remaining replies are offered');
    await more.click();
    assert(await waitFor(async () => await app.page.locator('#comments-content .comment[data-comment-id]').count() === 121, 15000));
    assert.equal(await app.page.locator('#comments-content .comment[data-comment-id="reddit:extra119"]').count(), 1);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.browser.close();
  }
});

test("a reply expansion interrupted by sync remains retryable", { timeout: 45000 }, async () => {
  const root = comment("root", "t3_fixture0", "First comment");
  const ids = ["extra0", "extra1"];
  const initial = [root, { kind: "more", data: { children: ids, count: 2 } }];
  const expanded = [root, ...ids.map((id) => comment(id, "t3_fixture0", `Comment ${id}`))];
  const app = await openArchive(initial, expanded, { handler: "Tampermonkey", expandedDelay: 1600 });
  try {
    const more = app.page.locator('#comments-content .more-replies');
    await more.waitFor({ timeout: 15000 });
    await more.click();
    assert(await more.isDisabled());
    await app.page.locator('#browse-home-sync').click();
    assert(await waitFor(async () => await app.page.locator('#browse-home-sync').getAttribute('aria-busy') !== 'true', 15000));
    assert(await waitFor(async () => await more.count() === 1 && !(await more.isDisabled()), 10000), 'the interrupted expansion can be retried');
    await more.click();
    assert(await waitFor(async () => await app.page.locator('#comments-content .comment[data-comment-id]').count() === 3, 15000));
    assert.deepEqual(app.errors, []);
  } finally {
    await app.browser.close();
  }
});

test("sync keeps expanded Bluesky replies without restoring an exhausted more button", { timeout: 45000 }, async () => {
  const uri = (index) => `at://did:plc:fixture/app.bsky.feed.post/depth${index}`;
  const post = (index, replyCount = 1) => ({ uri: uri(index), author: { handle: 'reader.bsky.social', did: 'did:plc:fixture' }, embed: index === 0 ? { external: { uri: url } } : undefined, record: { text: `Bluesky depth ${index}`, createdAt: new Date().toISOString() }, replyCount, likeCount: 1 });
  let chain = { post: post(10), replies: [] };
  for (let index = 9; index >= 0; index--) chain = { post: post(index), replies: [chain] };
  const extra = { post: post(11, 0), replies: [] };
  const story = { source: 'bsky', id: uri(0), url, title: STORIES[0].title, descendants: 1 };
  const app = await launchApp({ appHost: new URL(url).hostname, sharedStore: true, settings: { sources: { hn: false, bsky: true }, autoOpenSidebar: true, frontPageMode: 'topics', frontPageTopics: ['technology'], updateCheck: false }, values: {
    'HNewhere:frontpage_feed:technology/bsky/at://did:plc:cndfx4udwgvpjaakvxvh7wm5/app.bsky.feed.generator/flipboard-tech': { timestamp: Date.now(), stories: [story] },
  }, responses: [
    { match: (path) => path.includes('constellation.microcosm.blue/links/all'), json: { links: {} } },
    { match: (path) => path.includes('/app.bsky.feed.getPosts'), json: { posts: [post(0)] } },
    { match: (path) => path.includes('/app.bsky.feed.getPostThread') && new URL(path).searchParams.get('uri') === uri(0), json: { thread: chain } },
    { match: (path) => path.includes('/app.bsky.feed.getPostThread') && new URL(path).searchParams.get('uri') === uri(10), json: { thread: { post: post(10), replies: [extra] } } },
    { match: (path) => path.includes('/app.bsky.feed.getPostThread') && new URL(path).searchParams.get('uri') === uri(11), json: { thread: extra } },
  ] });
  try {
    await app.page.goto(url);
    const more = app.page.locator('#comments-content .more-replies');
    await more.waitFor({ timeout: 15000 });
    await more.click();
    assert(await waitFor(async () => (await app.page.locator('#comments-content').textContent()).includes('Bluesky depth 11'), 15000));
    const sync = app.page.locator('#browse-home-sync');
    await sync.click();
    assert(await waitFor(async () => await sync.getAttribute('aria-busy') !== 'true', 15000));
    assert.equal(await app.page.locator('#comments-content .comment[data-comment-id]').count(), 12);
    assert.equal(await more.count(), 0, 'an already expanded reply is not offered a second time');
    await app.page.locator('#comment-sort').click();
    await app.page.getByRole('menuitemradio', { name: 'Newest', exact: true }).click();
    assert(await waitFor(async () => await app.page.locator('#comments-content .discussion-loading').count() === 1, 5000));
    assert(await waitFor(async () => await app.page.locator('#comments-content .discussion-loading').count() === 0, 15000));
    assert(await waitFor(async () => await app.page.locator('#comments-content .comment[data-comment-id]').count() === 12, 15000));
    assert.equal(await more.count(), 0, 'sorting does not restore the exhausted button');
    assert.deepEqual(app.errors, []);
  } finally {
    await app.browser.close();
  }
});

test("expanding an archived reply preserves its nested descendants", { timeout: 45000 }, async () => {
  const more = { kind: "more", data: { children: ["child"], count: 2, parent_id: "t1_root" } };
  const initial = [comment("root", "t3_fixture0", "Parent", { kind: "Listing", data: { children: [more] } })];
  const grandchild = comment("grandchild", "t1_child", "Nested reply");
  const expanded = [comment("child", "t1_root", "Expanded reply", { kind: "Listing", data: { children: [grandchild] } })];
  const app = await openArchive(initial, expanded);
  try {
    const button = app.page.locator("#comments-content .more-replies");
    await button.waitFor({ timeout: 15000 });
    await button.click();
    assert(await waitFor(async () => await app.page.locator('#comments-content .comment[data-comment-id="reddit:grandchild"]').count() === 1, 15000));
    const root = app.page.locator('#comments-content .comment[data-comment-id="reddit:root"]');
    assert.equal(await root.locator('.comment[data-comment-id="reddit:grandchild"]').count(), 1);
    assert.equal(await app.page.locator("#comments-content .comment[data-comment-id]").count(), 3);
    assert(app.requests.some(({ url }) => url.includes("/api/comments/tree") && new URL(url).searchParams.get("parent_id") === "t1_root"));
    assert.deepEqual(app.errors, []);
  } finally {
    await app.browser.close();
  }
});

test("unexpandable missing replies keep the available comments without a load diagnostic", { timeout: 30000 }, async () => {
  const initial = [comment("root", "t3_fixture0", "Parent"), { kind: "more", data: { children: [], count: 3 } }];
  const app = await openArchive(initial, []);
  try {
    const disclosure = app.page.locator("#sidebar-discussion-meta").getByRole("button", { name: "Sources", exact: true });
    await disclosure.waitFor({ timeout: 15000 });
    await disclosure.click();
    assert.equal(await app.page.locator("#source-menu .discussion-source-status").count(), 0);
    assert.equal(await app.page.locator('#comments-content .comment[data-comment-id="reddit:root"]').count(), 1);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.browser.close();
  }
});

const rootMore = (ids) => ({ kind: "more", data: { children: ids, count: ids.length } });
const archiveButton = (page) => page.locator('#comments-content .top-level-comments > .more-replies[data-discussion-key="reddit:fixture0"]');
const redditRoots = (page) => page.locator('#comments-content .top-level-comments .comment[data-comment-id^="reddit:"]');

test("partial archive expansions show available replies and retry only the missing ones", { timeout: 25000 }, async t => {
  const root = comment("root", "t3_fixture0", "First comment");
  const available = ["availablea", "availableb"].map(id => comment(id, "t3_fixture0", id));
  const expanded = [root, ...available];
  const app = await openArchive([root, rootMore(["missing", ...available.map(node => node.data.id)])], expanded,
    { handler: "Tampermonkey", expandedDelay: 500 });
  t.after(() => app.browser.close());
  const { page } = app;
  const more = archiveButton(page);
  const roots = redditRoots(page);
  await more.focus();
  await page.keyboard.press("Enter");
  assert(await more.isDisabled());
  assert(await more.evaluate(node => node.matches(":focus")), "the loading button stays focused");
  assert(await waitFor(async () => await roots.count() === 3), "a successful subset is visible");
  assert(await waitFor(async () => await more.textContent() === "1 more reply"), "only the missing reply is counted");
  assert.deepEqual(app.store.get("HNewhere:thread_cache:reddit:fixture0")?.rootMore?.ids, ["missing"]);

  await page.keyboard.press("Enter");
  assert(await waitFor(async () => await more.textContent() === "1 more reply — try again"), "an empty retry stays available");
  assert.equal(await roots.count(), 3);
  assert(await more.evaluate(node => node.matches(":focus")), "the retry has keyboard focus");
  expanded.push(comment("missing", "t3_fixture0", "Missing reply now available"));
  await page.keyboard.press("Enter");
  await more.waitFor({ state: "detached" });
  const focus = page.locator('[data-comment-id="reddit:missing"] .focus-link');
  assert(await focus.evaluate(node => node.matches(":focus")), "focus moves to a nearby reply when the button is exhausted");
  assert.deepEqual(await roots.evaluateAll(nodes => nodes.map(node => node.dataset.commentId)),
    ["reddit:root", "reddit:availablea", "reddit:availableb", "reddit:missing"]);
  assert.deepEqual(app.errors, []);
});

test("archive expansion moves past a batch of missing IDs to reach later replies", { timeout: 25000 }, async t => {
  const root = comment("root", "t3_fixture0", "First comment");
  const ids = Array.from({ length: 100 }, (_, index) => `missing${index}`);
  const expanded = { status: 500, json: { data: [] } };
  const app = await openArchive([root, rootMore([...ids, "later"])], expanded, { handler: "Tampermonkey" });
  t.after(() => app.browser.close());
  const { page } = app;
  const more = archiveButton(page);

  await more.click();
  assert(await waitFor(async () => await more.textContent() === "101 more replies — try again"), "a failed archive response keeps the count and retry");
  assert.equal(app.store.get("HNewhere:thread_cache:reddit:fixture0")?.rootMore?.ids?.[0], ids[0]);
  expanded.status = 200;
  await more.click();
  assert(await waitFor(async () => await more.textContent() === "101 more replies — try again"), "an empty archive response keeps the count and retry");
  assert.equal(app.store.get("HNewhere:thread_cache:reddit:fixture0")?.rootMore?.ids?.[0], "later", "only a successful read advances the queue");
  expanded.json.data.push(root, comment("later", "t3_fixture0", "A reply in the next batch"));
  await more.click();
  assert(await waitFor(() => page.locator('[data-comment-id="reddit:later"]').isVisible()), "missing IDs in the first batch do not block the next reply");
  assert(await waitFor(async () => await more.textContent() === "100 more replies"));
  assert.equal(await redditRoots(page).count(), 2);
  assert.deepEqual(app.errors, []);
});

for (const [surface, commentSort, expected] of [
  ["Reader", "newest", ["latest", "recent", "middle", "old", "earliest"]],
  ["Sidebar", "oldest", ["earliest", "old", "middle", "recent", "latest"]],
  ["Sidebar", "best", ["old", "recent", "earliest", "latest", "middle"]],
]) {
  test(`${surface} inserts expanded roots in the active ${commentSort} order`, { timeout: 25000 }, async t => {
    const timed = (id, age) => {
      const node = comment(id, "t3_fixture0", id);
      node.data.created_utc -= age;
      return node;
    };
    const initial = [timed("old", 1000), timed("recent", 100)];
    if (commentSort === "oldest") initial[1].data.body = "A long comment with enough text to scroll. ".repeat(140);
    const additional = [timed("earliest", 1500), timed("latest", 50), timed("middle", 500)];
    const app = await openArchive([...initial, rootMore(additional.map(node => node.data.id))], [...initial, ...additional],
      { handler: "Tampermonkey", reader: surface === "Reader", commentSort });
    t.after(() => app.browser.close());
    const { page } = app;
    const roots = redditRoots(page);
    const existing = page.locator('[data-comment-id="reddit:old"]');
    await existing.waitFor();
    await existing.evaluate(node => { node.dataset.expansionFixture = "retained"; });

    const more = archiveButton(page);
    const recentText = page.locator('[data-comment-id="reddit:recent"] .text');
    let before;
    if (commentSort === "oldest") {
      const scrollTop = await more.evaluate(button => {
        const comments = button.closest("#comments");
        comments.scrollTo({ top: comments.scrollHeight, behavior: "instant" });
        return comments.scrollTop;
      });
      assert(scrollTop > 0, "the Sidebar starts with a scrolled position to preserve");
      before = (await recentText.boundingBox()).y;
    }
    await more.click();
    await more.waitFor({ state: "detached" });
    if (before !== undefined) assert(Math.abs((await recentText.boundingBox()).y - before) < 2, "the old content holds its position");
    assert.deepEqual(await roots.evaluateAll(nodes => nodes.map(node => node.dataset.commentId.slice(7))), expected);
    assert.equal(await existing.getAttribute("data-expansion-fixture"), "retained");
    const timestamps = await page.locator('#comments-content .top-level-comments .comment[data-created-at]').evaluateAll(nodes => nodes.map(node => Number(node.dataset.createdAt)));
    if (commentSort === "newest") assert.deepEqual(timestamps, [...timestamps].sort((left, right) => right - left));
    if (commentSort === "oldest") assert.deepEqual(timestamps, [...timestamps].sort((left, right) => left - right));
    assert.deepEqual(app.errors, []);
  });
}
