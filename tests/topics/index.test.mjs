import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { groupPages } from "../../topics/grouping.mjs";
import { buildTopicsIndex, retainedEvidenceKeys } from "../../topics/index.mjs";
import worker from "../../topics/worker.mjs";

const DAY = 86_400_000;
const START = Date.parse("2026-11-20T12:00:00.000Z");
const REFRESH_TOKEN = "test-refresh-token";
const migrations = new URL("../../topics/migrations/", import.meta.url);

async function service(t, options = {}) {
  const runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script: "export default { fetch: () => new Response() };",
    d1Databases: { TOPICS_DB: "topics-test", ACCOUNTS_DB: "accounts-test" },
  }));
  t.after(() => runtime.dispose());
  const db = await runtime.getD1Database("TOPICS_DB");
  for (const file of (await readdir(migrations)).sort()) {
    const sql = await readFile(new URL(file, migrations), "utf8");
    await db.exec(sql.replaceAll("\n", " "));
  }
  const accounts = await runtime.getD1Database("ACCOUNTS_DB");
  const env = { TOPICS_DB: db, ACCOUNTS_DB: accounts, REFRESH_TOKEN, ...options };
  const request = (path = "/api/topics", init, context) => worker.fetch(new Request("https://topics.test" + path, init), env, context);
  const refresh = () => request("/internal/refresh", {
    method: "POST",
    headers: { Authorization: "Bearer " + REFRESH_TOKEN },
  });
  return { db, accounts, request, refresh, scheduled: () => worker.scheduled({}, env) };
}

function mockFeeds(t, getFeeds) {
  t.mock.method(globalThis, "fetch", async (url) => {
    const source = new URL(url).hostname;
    const feeds = getFeeds();
    if (!(source in feeds)) return new Response(null, { status: 503 });
    return Response.json(feeds[source]);
  });
}

function publicPosts(now, path, title = "Public article", id = 1) {
  const created = new Date(now).toISOString();
  return {
    "hn.algolia.com": {
      hits: [{ objectID: String(id), title, url: "HTTPS://EXAMPLE.ORG:8443/" + path, created_at: created, num_comments: 2 }],
    },
    "lobste.rs": [{
      short_id: String(id), title, url: "https://example.org:8443/" + path,
      comments_url: "https://lobste.rs/s/" + id, created_at: created, comment_count: 3,
    }],
    "lemmy.world": { posts: [] },
    "public.api.bsky.app": { feed: [] },
  };
}

function fixtureAI() {
  return { run: async (_model, { text }) => ({ data: text.map(() => [1, ...Array(383).fill(0)]) }) };
}

function lemmyPost(id, url, { published = START, community = "games", host = "lemmy.world", visibility = "Public" } = {}) {
  return {
    post: { id, url, name: "A community discussion", embed_title: "Harbor council restores the seawall",
      ap_id: `https://${host}/post/${id}`, published: new Date(published).toISOString(), nsfw: false, removed: false, deleted: false },
    community: { name: community, actor_id: `https://${host}/c/${community}`, visibility, nsfw: false, removed: false, deleted: false },
    counts: { comments: 7 },
  };
}

function blueskyPost(did, key, url, { indexedAt = START, quote = false, replies = 5 } = {}) {
  const external = { $type: "app.bsky.embed.external#view", external: {
    uri: url, title: "Harbor council restores the seawall", description: "The agreement protects the port.",
  } };
  return { post: {
    uri: `at://${did}/app.bsky.feed.post/${key}`, cid: "bafyreig2fjxi3rptqdgylg7e5hmjl6mcke7rn2b6cugzlqq3i4zu6rq52q",
    author: { did, handle: "harbor.example.org" }, record: { $type: "app.bsky.feed.post", text: "A community discussion", createdAt: new Date(indexedAt).toISOString() },
    embed: quote ? { $type: "app.bsky.embed.recordWithMedia#view", record: { record: { $type: "app.bsky.embed.record#viewNotFound" } }, media: external } : external,
    indexedAt: new Date(indexedAt).toISOString(), replyCount: replies, repostCount: 1, likeCount: 2, labels: [],
  } };
}

test("public refresh repairs stored article titles and keeps discussions on links with missing titles", async (t) => {
  const article = "https://paper.example/rent-cap";
  const blocked = "https://paper.example/unknown";
  const discussion = lemmyPost(80, article);
  discussion.post.embed_title = "Access Denied";
  discussion.post.name = "Council approves a citywide rent cap";
  const other = lemmyPost(81, blocked);
  other.post.embed_title = "Just a moment...";
  other.post.name = "www.paper.example";
  t.mock.method(Date, "now", () => START);
  mockFeeds(t, () => ({
    "hn.algolia.com": { hits: [] }, "lobste.rs": [], "public.api.bsky.app": { feed: [] },
    "lemmy.world": { posts: [discussion, other] },
  }));
  const { db, refresh, request } = await service(t, { AI: fixtureAI() });
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("paper.example/rent-cap"));
  const id = Buffer.from(hash).toString("hex").slice(0, 32);
  await db.prepare("INSERT INTO pages VALUES (?, ?, 'Access Denied', 'paper.example', 'px-captcha')").bind(id, article).run();

  const first = await (await refresh()).json();
  assert.equal(first.stats.newEmbeddings, 1);
  assert.equal(first.stats.inputCharacters, discussion.post.name.length);
  const index = await (await request()).json();
  assert.deepEqual(index.topics.map(({ label }) => label), [discussion.post.name]);
  assert.equal(await db.prepare("SELECT title FROM pages WHERE id = ?").bind(id).first("title"), discussion.post.name);
  assert.deepEqual(index.pages.find(({ key }) => key.endsWith("/unknown")), {
    key: "paper.example/unknown", topicIds: [], posts: [["lemmy:81", 7]],
  });
  const coverage = async () => (await (await request("/api/topics/coverage?id=" + index.topics[0].id)).json()).links[0];
  assert.equal((await coverage()).title, discussion.post.name);

  discussion.post.embed_title = "City council approves rent cap for two years";
  discussion.post.embed_description = "The council voted to limit rent increases for two years.";
  await refresh();
  assert.equal((await coverage()).title, discussion.post.embed_title);
  assert.equal(await db.prepare("SELECT description FROM pages WHERE id = ?").bind(id).first("description"), discussion.post.embed_description);
  discussion.post.embed_title = "Access Denied";
  await refresh();
  const link = await coverage();
  assert.equal(link.title, "City council approves rent cap for two years");
  assert.deepEqual(link.posts.map(({ id, title }) => [id, title]), [["lemmy:80", discussion.post.name]]);
});

test("a new discussion on an old link cannot turn it into coverage of a new event", async (t) => {
  let now = START;
  const title = "Harbor ferry resumes service after storms";
  let feeds = publicPosts(now, "old-crossing", title);
  t.mock.method(Date, "now", () => now);
  mockFeeds(t, () => feeds);
  const { refresh, request } = await service(t, { AI: fixtureAI() });
  await refresh();

  now += 12 * DAY;
  feeds = publicPosts(now, "old-crossing", title, 2);
  const fresh = publicPosts(now, "new-crossing", title, 3)["hn.algolia.com"].hits[0];
  feeds["hn.algolia.com"].hits.push(fresh);
  await refresh();
  const { pages } = await (await request()).json();
  const old = pages.find(({ key }) => key.endsWith("/old-crossing"));
  const current = pages.find(({ key }) => key.endsWith("/new-crossing"));
  assert.deepEqual(old.posts.map(([id]) => id).sort(), ["hn:1", "hn:2", "lobsters:1", "lobsters:2"]);
  assert(current.topicIds.length > 0);
  assert(!old.topicIds.some((id) => current.topicIds.includes(id)));
});

test("a refresh keeps the verified photo for the same topic when a new lookup is unavailable", () => {
  const topic = { id: "story:steam", kind: "story", label: "Valve announces Steam Machine preorders" };
  const image = {
    url: "https://upload.wikimedia.org/wikipedia/commons/thumb/0/00/Steam.jpg/640px-Steam.jpg",
    source: "https://commons.wikimedia.org/wiki/File:Steam.jpg",
    credit: "Fixture author · CC BY 4.0",
    subject: "Steam Machine",
  };
  const pages = [{ url: "https://example.org/steam", topicIds: [topic.id] }];
  const previous = buildTopicsIndex({
    generatedAt: new Date(START).toISOString(), topics: [{ ...topic, image }], pages,
  });
  const snapshot = { generatedAt: new Date(START + DAY).toISOString(), pages };
  const refresh = (label) => JSON.parse(buildTopicsIndex({ ...snapshot, topics: [{ ...topic, label }] }, previous).body).topics[0];
  assert.deepEqual(refresh(topic.label).image, image);
  assert.equal(refresh("Valve delays a headset").image, undefined);
});

test("a numbered installment cannot inherit an image of another title in the series", () => {
  const topic = { id: "story:gta-vi", kind: "story", label: "Grand Theft Auto VI earns $3B on its first day" };
  const image = {
    url: "https://upload.wikimedia.org/wikipedia/commons/thumb/0/00/Vice_City.jpg/640px-Vice_City.jpg",
    source: "https://commons.wikimedia.org/wiki/File:Grand_Theft_Auto_Vice_City.jpg",
    credit: "Fixture author · CC BY 4.0",
    subject: "Grand Theft Auto",
  };
  const result = buildTopicsIndex({
    generatedAt: new Date(START).toISOString(),
    topics: [{ ...topic, image }],
    pages: [{ url: "https://example.org/news/gta-vi", topicIds: [topic.id] }],
  });
  assert.equal(JSON.parse(result.body).topics[0].image, undefined);
});

test("a subject phrase, matching headline, and repeated coverage publish one story", () => {
  const topics = groupPages([
    {
      id: "wired", domain: "wired.example", title: "Internet Archive Staffers Are Unionizing",
      postedAt: START, posts: [{ id: "hn:1" }, { id: "lobsters:2" }],
    },
    {
      id: "union", domain: "union.example", title: "Internet Archive Staffers Announce They Are Unionizing",
      postedAt: START, posts: [{ id: "hn:3" }],
    },
  ]);

  assert.deepEqual(topics, [{
    id: "story:union", label: "Internet Archive Staffers Are Unionizing", kind: "story",
    aliases: ["Internet Archive Staffers"], pageIds: ["wired", "union"],
  }]);
});

test("the compact index consolidates overlapping retained subject aliases and preserves their links", () => {
  const sharedKeys = ["one.example/link", "two.example/link", "three.example/link", "four.example/link"];
  const previousKeys = [...sharedKeys, "older.example/link"];
  const previous = {
    body: JSON.stringify({
      version: 1, generatedAt: new Date(START - DAY).toISOString(),
      topics: [{ id: "topic:riemann", label: "Riemann", kind: "topic" }],
      pages: previousKeys.map((key) => ({ key, topicIds: ["topic:riemann"] })),
    }),
    page_timestamps: JSON.stringify(previousKeys.map(() => START - DAY)),
  };
  const currentKeys = [...sharedKeys, "newer.example/link"];
  const result = buildTopicsIndex({
    generatedAt: new Date(START).toISOString(),
    topics: [
      { id: "topic:riemann-hypothesis", label: "Riemann Hypothesis", kind: "topic" },
      { id: "topic:navier-stokes", label: "Navier Stokes", kind: "topic" },
    ],
    pages: currentKeys.map((key) => ({
      url: "https://" + key,
      topicIds: ["topic:riemann-hypothesis", "topic:navier-stokes"],
    })),
  }, previous);
  const { topics, pages } = JSON.parse(result.body);
  assert.deepEqual(topics, [
    { id: "topic:riemann-hypothesis", label: "Riemann Hypothesis", kind: "topic", aliases: ["Riemann"] },
    { id: "topic:navier-stokes", label: "Navier Stokes", kind: "topic" },
  ]);
  assert.equal(pages.length, 6);
  assert(pages.every(({ topicIds }) => topicIds.includes("topic:riemann-hypothesis")));
  assert.deepEqual(pages.at(-1), { key: "older.example/link", topicIds: ["topic:riemann-hypothesis"] });
  assert.equal(JSON.parse(result.page_timestamps).at(-1), START - DAY);
});

test("a subject alias cannot join a retained bucket to a specific current story", () => {
  const subject = { id: "topic:iran-war", label: "Iran War", kind: "topic" };
  const story = { id: "story:ceasefire", label: "Iran war enters third week after failed ceasefire talks", kind: "story" };
  const previous = {
    body: JSON.stringify({
      version: 1, generatedAt: new Date(START - DAY).toISOString(), topics: [subject, story],
      pages: [
        { key: "history.example/ceasefire", topicIds: [story.id, subject.id] },
        { key: "history.example/background", topicIds: [subject.id] },
        { key: "history.example/insurance", topicIds: [subject.id] },
      ],
    }),
    page_timestamps: JSON.stringify([START - DAY, START - DAY, START - DAY]),
  };
  const result = buildTopicsIndex({
    generatedAt: new Date(START).toISOString(), topics: [{ ...story, aliases: [subject.label] }],
    pages: ["first.example/ceasefire", "second.example/ceasefire"].map((key) => ({
      url: "https://" + key, topicIds: [story.id],
    })),
  }, previous);
  const index = JSON.parse(result.body);
  assert.equal(index.version, 1);
  assert.deepEqual(index.topics.find(({ id }) => id === story.id), { ...story, aliases: [subject.label] });
  assert.deepEqual(index.pages.filter(({ topicIds }) => topicIds.includes(story.id)).map(({ key }) => key),
    ["first.example/ceasefire", "second.example/ceasefire", "history.example/ceasefire"]);
  assert.deepEqual(index.pages.find(({ key }) => key === "history.example/insurance").topicIds, [subject.id]);
});

test("refresh removes empty search phrases from retained automatic stories and respects reviewed titles", () => {
  const automatic = {
    id: "story:habitat", kind: "story", label: "Study finds warblers change course in fog",
    aliases: ["Warbler Migration", "Study Finds", "Has Been", "Researchers Reveal"],
  };
  const reviewed = { id: "story:review-title", kind: "story", label: "Has Been", curated: true, aliases: ["Study Finds"] };
  const topics = [automatic, reviewed];
  const pages = topics.map(({ id, curated }, index) => ({
    key: "archive.example/" + index, topicIds: [id], ...(curated ? { reviewed: true } : {}),
  }));
  const previous = {
    body: JSON.stringify({ version: 1, generatedAt: new Date(START - DAY).toISOString(), topics, pages }),
    page_timestamps: JSON.stringify(pages.map(() => START - DAY)),
  };
  const result = JSON.parse(buildTopicsIndex({ generatedAt: new Date(START).toISOString(), topics: [], pages: [] }, previous).body);
  assert.deepEqual(result.topics, [{ ...automatic, aliases: ["Warbler Migration"] }, reviewed]);
  assert.deepEqual(result.pages, pages);
});

test("corrected status stories cannot inherit a different country's earlier headline as a search alias", () => {
  const pages = [
    { id: "canada", title: "Canada has lost its measles elimination status" },
    { id: "us", title: "The U.S. has lost its measles elimination status" },
  ].map((page) => ({ ...page, domain: page.id + ".example", url: "https://" + page.id + ".example/story", postedAt: START }));
  const previous = buildTopicsIndex({
    generatedAt: new Date(START - DAY).toISOString(),
    topics: [{ id: "story:canada", kind: "story", label: pages[1].title }],
    pages: pages.map((page) => ({ ...page, topicIds: ["story:canada"] })),
  });
  const topics = groupPages(pages);
  const current = buildTopicsIndex({
    generatedAt: new Date(START).toISOString(), topics,
    pages: pages.map((page) => ({ ...page, topicIds: topics.filter(({ pageIds }) => pageIds.includes(page.id)).map(({ id }) => id) })),
  }, previous);
  const published = JSON.parse(current.body);
  assert.deepEqual(published.topics.map(({ label, aliases = [] }) => [label, aliases]), pages.map(({ title }) => [title, []]));
  assert.deepEqual(published.pages.map(({ topicIds }) => topicIds), pages.map(({ id }) => ["story:" + id]));
});

test("the cold public API returns the versioned empty snapshot and a bodyless HEAD", async (t) => {
  const { request } = await service(t);
  const response = await request();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { version: 1, generatedAt: null, topics: [], pages: [] });

  const head = await request("/api/topics", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("cache-control"), "no-store");
  assert.equal(head.headers.get("content-type"), response.headers.get("content-type"));
  assert.equal(await head.text(), "");
});

test("legacy snapshot projects normalized keys before the first refresh and seeds retained assignments", async (t) => {
  const now = START + 8 * DAY;
  t.mock.method(Date, "now", () => now);
  mockFeeds(t, () => publicPosts(now, "fresh"));
  const { db, request, refresh } = await service(t, { AI: fixtureAI() });
  const legacy = {
    generatedAt: new Date(START).toISOString(), sources: [], stats: {},
    topics: [
      { id: "story:one", label: "A public story", kind: "story", pageIds: ["a", "b"] },
      { id: "coverage:two", label: "Public coverage", kind: "coverage", pageIds: ["a"] },
    ],
    pages: [
      { id: "a", url: "HTTPS://EXAMPLE.org:8443/something/?z=4&b=2&b=1&a=hello%20world&UTM_medium=x&fbclid=y&gclid=z&mc_cid=1&MC_EID=2#section", topicIds: ["story:one", "coverage:two"] },
      { id: "b", url: "http://Example.com:80/", topicIds: ["story:one"] },
      { id: "c", url: "https://public.example/no-assignment", topicIds: [] },
      { id: "d", url: "https://reader:password@example.org/private", topicIds: ["story:one"] },
      { id: "e", url: "file:///Users/reader/private", topicIds: ["story:one"] },
    ],
  };
  await db.prepare("INSERT INTO public_index VALUES (1, ?, ?)").bind(START, JSON.stringify(legacy)).run();
  const response = await request();
  assert.equal(response.status, 200);
  const compact = await response.json();
  assert.deepEqual(compact, {
    version: 1,
    generatedAt: legacy.generatedAt,
    topics: [
      { id: "story:one", label: "A public story", kind: "story" },
      { id: "coverage:two", label: "Public coverage", kind: "coverage" },
    ],
    pages: [
      { key: "example.com", topicIds: ["story:one"] },
      { key: "example.org:8443/something?a=hello+world&b=2&b=1&z=4", topicIds: ["story:one", "coverage:two"] },
    ],
  });

  assert.equal((await refresh()).status, 200);
  const promoted = await (await request()).json();
  assert.equal(promoted.generatedAt, new Date(now).toISOString());
  assert.equal(promoted.pages[0].key, "example.org:8443/fresh");
  assert.deepEqual(promoted.pages.slice(1), compact.pages);
});

test("the public API preserves validators and suppresses HEAD and 304 bodies", async (t) => {
  const { request, scheduled } = await service(t, { AI: fixtureAI() });
  t.mock.method(Date, "now", () => START);
  mockFeeds(t, () => publicPosts(START, "topics"));
  await scheduled();

  const response = await request();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control"), /public, max-age=120/);
  const etag = response.headers.get("etag");
  assert.match(etag, /^(?:W\/)?"[^"]+"$/);

  const head = await request("/api/topics", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("etag"), etag);
  assert.equal(head.headers.get("cache-control"), response.headers.get("cache-control"));
  assert.equal(await head.text(), "");
  const unchangedHead = await request("/api/topics", { method: "HEAD", headers: { "If-None-Match": etag } });
  assert.equal(unchangedHead.status, 304);
  assert.equal(await unchangedHead.text(), "");

  const strong = etag.replace(/^W\//, "");
  for (const ifNoneMatch of [strong, ' "obsolete", W/' + strong, "*"]) {
    const conditional = await request("/api/topics", { headers: { "If-None-Match": ifNoneMatch } });
    assert.equal(conditional.status, 304);
    assert.equal(conditional.headers.get("etag"), etag);
    assert.equal(conditional.headers.get("cache-control"), response.headers.get("cache-control"));
    assert.equal(await conditional.text(), "");
  }
  const current = await request("/api/topics", { headers: { "If-None-Match": '"old"' } });
  assert.equal(current.status, 200);
  assert.deepEqual(await current.json(), await response.json());
});

test("public refresh retains known assignments and counts until they age out of the index", async (t) => {
  let now = START;
  let feeds = publicPosts(now, "older/?gclid=tracking", "Older public article");
  t.mock.method(Date, "now", () => now);
  mockFeeds(t, () => feeds);
  const { db, request, refresh } = await service(t, { AI: fixtureAI() });
  const first = await refresh();
  assert.equal(first.status, 200);
  assert.equal((await first.json()).stats.newEmbeddings, 1);

  const initial = await (await request()).json();
  assert.equal(initial.pages.length, 1);
  assert.equal(initial.pages[0].key, "example.org:8443/older");
  assert.deepEqual(initial.topics.map(({ label, kind }) => ({ label, kind })), [
    { label: "Older public article", kind: "coverage" },
  ]);
  assert.deepEqual(initial.pages[0].topicIds, [initial.topics[0].id]);
  assert.deepEqual(initial.pages[0].posts, [["hn:1", 2], ["lobsters:1", 3]]);

  const repeated = await refresh();
  assert.equal((await repeated.json()).stats.reusedEmbeddings, 1);

  now = START + 8 * DAY;
  feeds = publicPosts(now, "newer/?utm_source=tracking", "Newer public article", 2);
  assert.equal((await refresh()).status, 200);
  const next = await (await request()).json();
  assert.deepEqual(next.pages.map(({ key }) => key), ["example.org:8443/newer", "example.org:8443/older"]);
  assert.deepEqual(next.pages[0].posts, [["hn:2", 2], ["lobsters:2", 3]]);
  assert.deepEqual(next.pages[1].posts, [["hn:1", 2], ["lobsters:1", 3]]);
  assert.deepEqual(next.topics.find(({ id }) => id === initial.topics[0].id), initial.topics[0]);
  const legacy = JSON.parse((await db.prepare("SELECT body FROM public_index WHERE id = 1").first()).body);
  assert.deepEqual(legacy.pages.map(({ url }) => url), ["https://example.org:8443/newer/"]);

  now = START + 31 * DAY;
  feeds = publicPosts(now, "latest", "Latest public article", 3);
  assert.equal((await refresh()).status, 200);
  const expired = await (await request()).json();
  assert.deepEqual(expired.pages.map(({ key }) => key), ["example.org:8443/latest", "example.org:8443/newer"]);
  assert(!expired.topics.some(({ id }) => id === initial.topics[0].id));
});

test("partial coverage refreshes keep old discussions and accept the latest count for a known thread", () => {
  const topic = { id: "story:orbit", label: "A weather satellite reaches orbit", kind: "story" };
  const link = { url: "https://science.example/satellite", topicIds: [topic.id] };
  const first = buildTopicsIndex({ generatedAt: new Date(START).toISOString(), topics: [topic], pages: [{
    ...link, posts: [{ id: "hn:1", comments: 12 }, { id: "lobsters:2", comments: 7 }],
  }] });
  const { pages } = JSON.parse(buildTopicsIndex({ generatedAt: new Date(START + DAY).toISOString(), topics: [topic], pages: [{
    ...link, posts: [{ id: "hn:1", comments: 9 }, { id: "lemmy:3", comments: 4 }],
  }] }, first).body);
  assert.deepEqual(Object.fromEntries(pages[0].posts), { "hn:1": 9, "lobsters:2": 7, "lemmy:3": 4 });
});

test("a refresh restores counts missing from an older saved public index", async (t) => {
  let now = START;
  let feeds = publicPosts(now, "older", "Earlier public link");
  t.mock.method(Date, "now", () => now);
  mockFeeds(t, () => feeds);
  const { db, refresh, request } = await service(t, { AI: fixtureAI() });
  await refresh();
  const index = await (await request()).json();
  delete index.pages[0].posts;
  await db.prepare("UPDATE topics_index SET body = ? WHERE id = 1").bind(JSON.stringify(index)).run();
  now += 8 * DAY;
  feeds = publicPosts(now, "newer", "New public link", 2);
  await refresh();
  const { pages } = await (await request()).json();
  assert.deepEqual(pages.find(({ key }) => key.endsWith("/older")).posts, [["hn:1", 2], ["lobsters:1", 3]]);
});

test("a public story keeps its ID as links arrive and leave the live window", () => {
  const original = { id: "story:2", label: "Satellite launch sends a new weather station into orbit", kind: "story" };
  const incoming = { ...original, id: "story:1", label: "A weather satellite enters orbit after its launch" };
  const publish = (time, topic, paths, previous) => buildTopicsIndex({
    generatedAt: new Date(time).toISOString(), topics: [topic],
    pages: paths.map((path) => ({ url: "https://press.example/" + path, topicIds: [topic.id] })),
  }, previous);
  const seeded = publish(START, original, ["two", "three"]);
  const data = JSON.parse(seeded.body);
  data.topics.push(incoming);
  data.pages.push({ key: "press.example/one", topicIds: [incoming.id] });
  const first = { body: JSON.stringify(data), page_timestamps: JSON.stringify([START, START, START]) };
  const second = publish(START + DAY, incoming, ["one", "two", "three"], first);
  const third = publish(START + 2 * DAY, incoming, ["one", "three", "four"], second);
  for (const { body } of [second, third]) {
    const index = JSON.parse(body);
    assert.equal(index.topics.length, 1);
    assert.equal(index.topics[0].id, original.id);
    assert.equal(index.topics[0].label, incoming.label);
    assert(index.pages.every(({ topicIds }) => topicIds[0] === original.id));
    assert.equal(index.redirects[incoming.id], original.id);
  }
});

test("publisher sharing links keep one story address across headline changes and partial refreshes", () => {
  const paper = "www.nytimes.com/2026/11/22/climate/cop31-climate-summit-ends-climate.html";
  const guardian = "www.theguardian.com/news/2026/nov/22/bank-of-england-directors-cuba";
  const original = "U.N. Climate Talks Collapse in a Bitter Clash Over Fossil Fuels";
  const updated = "COP31 Talks Collapse in Turkey in a Clash Over Fossil Fuels";
  const bank = "Bank of England directors illegally profited from post-abolition enslavement in Cuba";
  const records = [
    [paper, "story:original", original],
    [paper + "?smid=ios-share", "story:original", original],
    [paper + "?smid=android-share", "story:replacement", updated],
    [paper + "?unlocked_article_code=gift", "story:gift", updated + " (Gift Article)"],
    [paper + "?edition=commentary&smid=ios-share", "story:edition", updated],
    [paper + "?smid=browser-share", "story:reviewed", updated],
    [guardian + "?CMP=Share_iOSApp_Other", "story:bank", bank],
    [guardian + "?CMP=Share_AndroidApp_Other", "story:other-bank", "Highly lucrative: " + bank],
    ["news.ycombinator.com/item?id=1", "story:one", original],
    ["news.ycombinator.com/item?id=2", "story:two", updated],
    ["shop.example/sale?smid=alpha", "story:seller-a", original],
    ["shop.example/sale?smid=beta", "story:seller-b", updated],
    [paper + "?smid=mail-share", "story:unrelated", "New survey counts migratory cranes in Iceland"],
    [paper + "?smid=operator-share", "story:curated", updated],
  ];
  const topics = [...new Map(records.map(([, id, label]) => [id, {
    id, kind: "story", label, ...(id === "story:curated" ? { curated: true } : {}),
  }])).values()];
  const pages = records.map(([key, id], position) => ({
    key, topicIds: [id], posts: [["hn:" + position, position]], ...(id === "story:reviewed" ? { reviewed: true } : {}),
  }));
  const previous = { body: JSON.stringify({ topics, pages }), page_timestamps: JSON.stringify(pages.map(() => START)) };
  const empty = { generatedAt: new Date(START + DAY).toISOString(), topics: [], pages: [] };
  const repaired = buildTopicsIndex(empty, previous);
  const published = JSON.parse(repaired.body);
  const ids = new Map(published.pages.map(({ key, topicIds }) => [key, topicIds]));
  assert.deepEqual(records.slice(0, 4).map(([key]) => ids.get(key)), Array(4).fill(["story:original"]));
  assert([original, updated].includes(published.topics.find(({ id }) => id === "story:original").label));
  assert.deepEqual([published.redirects["story:replacement"], published.redirects["story:gift"]], ["story:original", "story:original"]);
  assert.deepEqual(ids.get(records[6][0]), ids.get(records[7][0]));
  for (const [key, id] of [...records.slice(4, 6), ...records.slice(8)]) assert.deepEqual(ids.get(key), [id]);
  assert.deepEqual(new Map(published.pages.map(({ key, posts }) => [key, posts])), new Map(pages.map(({ key, posts }) => [key, posts])));
  assert(published.pages.find(({ key }) => key === records[5][0]).reviewed);
  assert(JSON.parse(repaired.page_timestamps).every((time) => time === START));

  const newcomer = { id: "story:aaa", kind: "story", label: updated };
  const next = JSON.parse(buildTopicsIndex({
    generatedAt: new Date(START + 2 * DAY).toISOString(), topics: [newcomer],
    pages: [{ url: "https://" + paper + "?unlocked_article_code=later", topicIds: [newcomer.id] }],
  }, repaired).body);
  assert.deepEqual(next.pages.find(({ key }) => key.endsWith("=later")).topicIds, ["story:original"]);
  assert.equal(next.redirects[newcomer.id], "story:original");
  assert.equal(next.redirects["story:gift"], "story:original");
});

test("a reviewed one-link topic keeps its address and title when it gains a second perspective", () => {
  for (const kind of ["story", "coverage"]) {
    const prior = { id: `${kind}:first`, kind, label: "A telescope finds a new cloud" };
    const expanded = { id: "story:second", kind: "story", label: "New observations reveal a dust cloud" };
    const editedLabel = "New telescope image shows the Orion dust cloud";
    const edit = { action: "edit", target: prior, changes: { label: editedLabel } };
    const first = buildTopicsIndex({ generatedAt: new Date(START).toISOString(), topics: [prior], pages: [
      { url: "https://press.example/first", topicIds: [prior.id] },
    ] }, undefined, [edit]);
    const next = JSON.parse(buildTopicsIndex({ generatedAt: new Date(START + DAY).toISOString(), topics: [expanded], pages: [
      { url: "https://press.example/first", topicIds: [expanded.id] },
      { url: "https://journal.example/second", topicIds: [expanded.id] },
    ] }, first, [edit]).body);
    const target = kind === "story" ? prior.id : expanded.id;
    assert.deepEqual(next.topics.map(({ id, label }) => ({ id, label })), [{ id: target, label: editedLabel }]);
    assert(next.pages.every(({ topicIds }) => topicIds[0] === target));
    assert.equal(next.redirects[kind === "story" ? expanded.id : prior.id], target);
  }
});

test("a story keeps its address when the live window changes its lead headline", () => {
  const titles = ["A weather satellite reaches orbit", "Weather satellite successfully reaches orbit",
    "New weather satellite reaches orbit after launch", "Weather satellite reaches orbit"];
  const pages = titles.map((title, index) => ({
    id: String(index), title, url: `https://site${index}.example/article`, domain: `site${index}.example`, postedAt: START, posts: [],
  }));
  const publish = (selected, generatedAt, previous) => {
    const [topic] = groupPages(selected);
    assert.equal(topic.pageIds.length, 3);
    return buildTopicsIndex({
      generatedAt: new Date(generatedAt).toISOString(), topics: [topic],
      pages: selected.map((page) => ({ ...page, topicIds: [topic.id] })),
    }, previous);
  };
  const first = publish(pages.slice(0, 3), START);
  const { topics, pages: indexed } = JSON.parse(publish(pages.slice(1), START + DAY, first).body);
  assert.deepEqual(topics.map(({ id, label }) => ({ id, label })), [{ id: "story:0", label: titles[3] }]);
  assert.equal(indexed.length, 4);
  assert(indexed.every(({ topicIds }) => topicIds[0] === "story:0"));
});

test("merging a source topic preserves an earlier reviewed split", () => {
  const source = { id: "story:source", kind: "story", label: "Coastal bridge plans advance" };
  const destination = { id: "story:dest", kind: "story", label: "Coastal bridge construction starts" };
  const separate = { id: "story:review-split", kind: "story", label: "Coastal bridge design options" };
  const keys = ["one", "two", "three", "four"].map((name) => "papers.example/" + name);
  const snapshot = { generatedAt: new Date(START).toISOString(), topics: [source, destination], pages: [
    ...keys.map((key) => ({ url: "https://" + key, topicIds: [source.id] })),
    { url: "https://destination.example/bridge", topicIds: [destination.id] },
  ] };
  const decisions = [
    { action: "split", keys: keys.slice(0, 2), target: separate },
    { action: "merge", keys, source, target: destination },
  ];
  const result = JSON.parse(buildTopicsIndex(snapshot, undefined, decisions).body);
  assert.deepEqual(result.pages.filter(({ topicIds }) => topicIds.includes(separate.id)).map(({ key }) => key), keys.slice(0, 2));
  assert.equal(result.redirects[source.id], destination.id);
  assert.equal(result.redirects[separate.id], undefined);
});

test("a merged topic's old title never overwrites the destination's title on replay", () => {
  const from = { id: "story:from", kind: "story", label: "City publishes preliminary bridge design" };
  const to = { id: "story:to", kind: "story", label: "City awards the bridge contract" };
  const source = { url: "https://article.example/design", topicIds: [from.id] };
  const destination = { url: "https://article.example/contract", topicIds: [to.id] };
  const decisions = [
    { action: "edit", target: from, changes: { label: "Bridge design documents released" } },
    { action: "merge", source: from, target: to, keys: ["article.example/design"] },
  ];
  const first = buildTopicsIndex({ generatedAt: new Date(START).toISOString(), topics: [from, to], pages: [source, destination] }, undefined, decisions);
  const result = JSON.parse(buildTopicsIndex({ generatedAt: new Date(START + DAY).toISOString(), topics: [to], pages: [destination] }, first, decisions).body);
  assert.deepEqual(result.topics.map(({ id, label }) => ({ id, label })), [to].map(({ id, label }) => ({ id, label })));
  assert.equal(result.redirects[from.id], to.id);
});

test("a reobserved discussion updates even outside the classifier's current window", async (t) => {
  let now = START;
  let feeds = publicPosts(now, "older", "Earlier public link");
  t.mock.method(Date, "now", () => now);
  mockFeeds(t, () => feeds);
  const { db, refresh, request } = await service(t, { AI: fixtureAI() });
  await refresh();
  const original = (await (await request()).json()).topics[0];
  const oldLobsters = feeds["lobste.rs"][0];
  now += DAY;
  feeds = publicPosts(now, "newer", "New public link", 2);
  const newest = feeds["hn.algolia.com"].hits[0];
  feeds["hn.algolia.com"].hits = Array.from({ length: 240 }, (_, index) => ({ ...newest, objectID: String(100 + index) }));
  feeds["lobste.rs"] = [{ ...oldLobsters, comment_count: 42 }];
  const checkCount = async (expected) => {
    assert.equal((await refresh()).status, 200);
    const { pages } = await (await request()).json();
    assert.equal(Object.fromEntries(pages.find(({ key }) => key.endsWith("/older")).posts)["lobsters:1"], expected);
    const result = await (await request("/api/topics/coverage?id=" + encodeURIComponent(original.id))).json();
    assert.equal(result.links[0].posts.find(({ id }) => id === "lobsters:1").comments, expected);
  };
  await checkCount(42);
  now += 60_000;
  delete feeds["lobste.rs"][0].comment_count;
  await checkCount(42);
  now += 60_000;
  feeds["lobste.rs"][0].comment_count = 0;
  await checkCount(0);
  now += 60_000;
  feeds["lobste.rs"][0].comment_count = 20;
  await db.prepare("CREATE TRIGGER fail_count_publish BEFORE UPDATE ON topics_index " +
    "BEGIN SELECT RAISE(ABORT, 'count publication unavailable'); END").run();
  await assert.rejects(refresh(), /count publication unavailable/);
  await db.prepare("DROP TRIGGER fail_count_publish").run();
  now += 60_000;
  feeds["lobste.rs"] = [];
  await checkCount(20);
});

test("public coverage resolves an older topic address and returns retained discussion links", async (t) => {
  let now = START;
  let feeds = publicPosts(now, "earlier", "Earlier public link");
  t.mock.method(Date, "now", () => now);
  mockFeeds(t, () => feeds);
  const { db, refresh, request } = await service(t, { AI: fixtureAI() });
  assert.equal((await refresh()).status, 200);
  const { topics: [original] } = await (await request()).json();
  now += 8 * DAY;
  feeds = publicPosts(now, "different", "Unrelated new link", 2);
  assert.equal((await refresh()).status, 200);
  const index = await (await request()).json();
  index.redirects = { "story:old-id": original.id };
  await db.prepare("UPDATE topics_index SET body = ? WHERE id = 1").bind(JSON.stringify(index)).run();
  const response = await request("/api/topics/coverage?id=story%3Aold-id");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
  const result = await response.json();
  assert.equal(result.version, 1);
  assert.equal(result.topic.id, original.id);
  assert.deepEqual(result.links.map(({ title, url }) => ({ title, url })), [{
    title: "Earlier public link", url: "https://example.org:8443/earlier",
  }]);
  assert.deepEqual(result.links[0].posts.map(({ id, url, comments }) => ({ id, url, comments })), [
    { id: "hn:1", url: "https://news.ycombinator.com/item?id=1", comments: 2 },
    { id: "lobsters:1", url: "https://lobste.rs/s/1", comments: 3 },
  ]);
  assert.equal((await request("/api/topics/coverage?id=story%3Aunknown")).status, 404);
});

test("public coverage publishes separate discussions discovered across public interest listings", async (t) => {
  t.mock.method(Date, "now", () => START);
  const article = "https://press.example.org/seawall";
  const shared = lemmyPost(321, article + "?utm_source=general");
  const community = lemmyPost(322, article + "#project", { community: "europe", host: "feddit.org" });
  const first = blueskyPost("did:plc:4gp6zkjn7ocnul2o5ppc4pzq", "3lb4qpgxs4p2h", article + "?fbclid=abc");
  const second = blueskyPost("did:web:news.example.org", "3lb4qpgxs4p2h", article, { quote: true, replies: 11 });
  t.mock.method(globalThis, "fetch", async (address) => {
    const url = new URL(address);
    if (url.hostname === "hn.algolia.com") return Response.json({ hits: [] });
    if (url.hostname === "lobste.rs") return Response.json([]);
    if (url.hostname === "lemmy.world") {
      switch (url.searchParams.get("community_name")) {
        case null: return Response.json({ posts: [shared] });
        case "games@lemmy.world": return Response.json({ posts: [shared] });
        case "europe@feddit.org": return Response.json({ posts: [community,
          lemmyPost(323, "https://press.example.org/private", { visibility: "LocalOnly" }),
          lemmyPost(324, undefined),
        ] });
        case "news@lemmy.world": return new Response(null, { status: 503 });
        default: return Response.json({ posts: [] });
      }
    }
    if (url.hostname === "public.api.bsky.app") {
      switch (url.searchParams.get("feed")?.split("/").at(-1)) {
        case "aaajaq4ut77am": return Response.json({ feed: [first] });
        case "verified-news": return Response.json({ feed: [first, second,
          blueskyPost("did:plc:4gp6zkjn7ocnul2o5ppc4pzq", "3lb4qpgxs4p2j", "https://bsky.app/profile/harbor.example.org"),
          blueskyPost("did:plc:4gp6zkjn7ocnul2o5ppc4pzq", "3lb4qpgxs4p2k", "https://press.example.org/old", { indexedAt: START - 8 * DAY }),
        ] });
        case "flipboard-biz": return Response.json({ feed: null });
        default: return Response.json({ feed: [] });
      }
    }
    return new Response(null, { status: 503 });
  });
  const { db, refresh, request } = await service(t, { AI: fixtureAI() });
  const updated = await refresh();
  assert.equal(updated.status, 200);
  const { sources, stats } = await updated.json();
  assert.deepEqual(sources.map(({ id, status, posts, fetchedPosts }) => ({ id, status, posts, fetchedPosts })), [
    { id: "hn", status: "ok", posts: 0, fetchedPosts: 0 },
    { id: "lobsters", status: "ok", posts: 0, fetchedPosts: 0 },
    { id: "lemmy", status: "partial", posts: 2, fetchedPosts: 2 },
    { id: "bsky", status: "partial", posts: 2, fetchedPosts: 2 },
  ]);
  assert.equal(stats.posts, 4);
  const index = await (await request()).json();
  assert.deepEqual(index.pages.map(({ key }) => key), ["press.example.org/seawall"]);
  const [page] = index.pages;
  const expected = [
    ["bsky:at://did:plc:4gp6zkjn7ocnul2o5ppc4pzq/app.bsky.feed.post/3lb4qpgxs4p2h", "https://bsky.app/profile/did:plc:4gp6zkjn7ocnul2o5ppc4pzq/post/3lb4qpgxs4p2h", 5],
    ["bsky:at://did:web:news.example.org/app.bsky.feed.post/3lb4qpgxs4p2h", "https://bsky.app/profile/did:web:news.example.org/post/3lb4qpgxs4p2h", 11],
    ["lemmy:321", "https://lemmy.world/post/321", 7],
    ["lemmy:322", "https://lemmy.world/post/322", 7],
  ];
  assert.deepEqual(new Map(page.posts), new Map(expected.map(([id, , comments]) => [id, comments])));
  const response = await request("/api/topics/coverage?id=" + encodeURIComponent(page.topicIds[0]));
  assert.equal(response.status, 200);
  const coverage = await response.json();
  assert.equal(coverage.links.length, 1);
  assert.equal(coverage.links[0].url, article);
  assert.deepEqual(coverage.links[0].posts.map(({ id, url, comments }) => [id, url, comments]), expected);
  assert.equal(coverage.links[0].posts.at(-1).community, "!europe@feddit.org");
  const snapshot = JSON.parse(await db.prepare("SELECT body FROM public_index WHERE id = 1").first("body"));
  assert.equal(snapshot.topics.find(({ id }) => id === page.topicIds[0]).sourceCount, 2);
});

test("a full classifier window still publishes broad listings and slow interest feeds", async (t) => {
  t.mock.method(Date, "now", () => START);
  const older = START - 3 * DAY;
  const general = publicPosts(older, "broad", "Broad public link");
  const few = lemmyPost(323, "https://press.example.org/europe", { published: older });
  const science = blueskyPost("did:web:journal.example.org", "3lb4qpgxs4p2h", "https://press.example.org/science", { indexedAt: older });
  let next = 1000;
  t.mock.method(globalThis, "fetch", async (address) => {
    const url = new URL(address);
    if (url.hostname === "lemmy.world") {
      switch (url.searchParams.get("community_name")) {
        case null: return Response.json({ posts: [lemmyPost(322, "https://press.example.org/broad", { published: older })] });
        case "europe@feddit.org": return Response.json({ posts: [few] });
        default: return Response.json({ posts: Array.from({ length: 35 }, () => lemmyPost(next++, "https://press.example.org/current")) });
      }
    }
    if (url.hostname === "public.api.bsky.app") {
      const target = url.searchParams.get("feed")?.split("/").at(-1);
      if (target === "for-science") return Response.json({ feed: [science] });
      const feed = Array.from({ length: 35 }, () => blueskyPost("did:web:news.example.org", `fixture-${next++}`, "https://press.example.org/current"));
      return Response.json({ feed });
    }
    if (Object.hasOwn(general, url.hostname)) return Response.json(general[url.hostname]);
    return new Response(null, { status: 503 });
  });
  const { refresh, request } = await service(t, { AI: fixtureAI() });
  const response = await refresh();
  assert.equal(response.status, 200);
  const { sources, stats } = await response.json();
  assert.equal(stats.posts, 240);
  assert.equal(sources.find(({ id }) => id === "lemmy").fetchedPosts, 102);
  assert.equal(sources.find(({ id }) => id === "bsky").fetchedPosts, 201);
  const { pages } = await (await request()).json();
  const visible = new Map(pages.map(({ key, posts }) => [key, new Map(posts)]));
  assert.deepEqual([...visible.get("example.org:8443/broad")], [["hn:1", 2], ["lobsters:1", 3]]);
  assert.equal(visible.get("press.example.org/broad").get("lemmy:322"), 7);
  assert.equal(visible.get("press.example.org/europe").get("lemmy:323"), 7);
  assert.equal(visible.get("press.example.org/science").get("bsky:at://did:web:journal.example.org/app.bsky.feed.post/3lb4qpgxs4p2h"), 5);
});

test("public coverage has a continuation for large topics without losing any links", async (t) => {
  const { db, request } = await service(t);
  const topic = { id: "story:large", label: "Public library restoration plan", kind: "story" };
  const publicURLs = Array.from({ length: 91 }, (_, position) => `https://press.example/restoration/${position}`);
  const rows = await Promise.all(publicURLs.map(async (url) => {
    const key = url.replace(/^https:\/\//, "");
    const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)));
    return { id: Buffer.from(bytes.subarray(0, 16)).toString("hex"), url, title: "Restoration coverage" };
  }));
  const index = buildTopicsIndex({ generatedAt: new Date(START).toISOString(), topics: [topic],
    pages: publicURLs.map((url) => ({ url, topicIds: [topic.id] })) });
  await db.batch([
    db.prepare("INSERT INTO topics_index VALUES (1, ?, ?, ?)").bind(START, index.body, index.page_timestamps),
    db.prepare("INSERT INTO pages SELECT value->>'id', value->>'url', value->>'title', 'press.example', '' FROM json_each(?)")
      .bind(JSON.stringify(rows)),
  ]);
  const address = "/api/topics/coverage?id=story%3Alarge";
  const links = [];
  let offset = 0;
  const first = await (await request(address)).json();
  assert(Number.isSafeInteger(first.nextOffset) && first.nextOffset > 0);
  for (let page = first; ; page = await (await request(address + "&offset=" + offset)).json()) {
    assert.equal(page.generatedAt, new Date(START).toISOString());
    links.push(...page.links.map(({ url }) => url));
    if (page.nextOffset === null) break;
    assert(page.nextOffset > offset);
    offset = page.nextOffset;
  }
  assert.equal(links.length, 91);
  assert.deepEqual(new Set(links), new Set(publicURLs));
  assert.equal((await request(address + "&offset=-1")).status, 400);
});

test("failed sources preserve the last complete publication while partial feeds still publish", async (t) => {
  let now = START;
  let feeds = publicPosts(now, "older");
  t.mock.method(Date, "now", () => now);
  mockFeeds(t, () => feeds);
  const { request, refresh } = await service(t, { AI: { run: async () => { throw new Error("offline"); } } });
  assert.equal((await refresh()).status, 200);
  const prior = await request();
  assert.equal((await prior.clone().json()).pages.length, 1);

  now = START + DAY;
  feeds = {};
  assert.equal((await refresh()).status, 503);
  const after = await request();
  assert.equal(after.headers.get("etag"), prior.headers.get("etag"));
  assert.equal(await after.text(), await prior.text());

  now = START + 8 * DAY;
  feeds = publicPosts(now, "newer", "Newer public article", 2);
  delete feeds["lemmy.world"];
  assert.equal((await refresh()).status, 200);
  const partial = await (await request()).json();
  assert.equal(partial.generatedAt, new Date(now).toISOString());
  assert.deepEqual(partial.pages.map(({ key }) => key), ["example.org:8443/newer", "example.org:8443/older"]);
});

test("the 4,000 page cap evicts the oldest indexed assignment", async (t) => {
  t.mock.method(Date, "now", () => START);
  mockFeeds(t, () => publicPosts(START, "current"));
  const { db, refresh, request } = await service(t, { AI: fixtureAI() });
  const previous = {
    version: 1,
    generatedAt: new Date(START - DAY).toISOString(),
    topics: [
      { id: "topic:retired", label: "Retired", kind: "topic" },
      { id: "topic:retained", label: "Retained", kind: "topic" },
    ],
    pages: Array.from({ length: 4_000 }, (_, index) => ({
      key: "indexed.example/" + index,
      topicIds: [index === 0 ? "topic:retired" : "topic:retained"],
    })),
  };
  const timestamps = previous.pages.map((_page, index) => START - DAY + index);
  await db.prepare("INSERT INTO topics_index VALUES (1, ?, ?, ?)")
    .bind(START - DAY, JSON.stringify(previous), JSON.stringify(timestamps)).run();

  assert.equal((await refresh()).status, 200);
  const next = await (await request()).json();
  assert.equal(next.pages.length, 4_000);
  assert.equal(next.pages[0].key, "example.org:8443/current");
  assert.equal(next.pages.at(-1).key, "indexed.example/1");
  assert(!next.pages.some(({ key }) => key === "indexed.example/0"));
  assert(!next.topics.some(({ id }) => id === "topic:retired"));
});

test("a failed compact write rolls back the legacy publication", async (t) => {
  let now = START;
  let feeds = publicPosts(now, "older");
  t.mock.method(Date, "now", () => now);
  mockFeeds(t, () => feeds);
  const { db, refresh, request } = await service(t, { AI: fixtureAI() });
  assert.equal((await refresh()).status, 200);
  const initial = await (await request()).text();
  const legacy = await db.prepare("SELECT body FROM public_index WHERE id = 1").first();

  await db.prepare("CREATE TRIGGER fail_topics_write BEFORE UPDATE ON topics_index " +
    "BEGIN SELECT RAISE(ABORT, 'compact publication unavailable'); END").run();
  now = START + DAY;
  feeds = publicPosts(now, "newer", "Newer public article", 2);
  await assert.rejects(refresh(), /compact publication unavailable/);
  assert.equal(await (await request()).text(), initial);
  assert.deepEqual(await db.prepare("SELECT body FROM public_index WHERE id = 1").first(), legacy);
  assert.deepEqual(await db.prepare("SELECT owner, expires_at FROM refresh_lease WHERE id = 1").first(), {
    owner: "", expires_at: 0,
  });
});

test("public POSTs and unauthorized refreshes cannot write the index or run inference", async (t) => {
  t.mock.method(globalThis, "fetch", async () => assert.fail("Unexpected feed fetch"));
  const { request } = await service(t, {
    REFRESH_TOKEN: undefined,
    AI: { run: async () => assert.fail("Unexpected AI request") },
  });
  assert.equal((await request("/api/topics", { method: "POST", body: "{}" })).status, 404);
  assert.equal((await request("/internal/refresh", { method: "POST" })).status, 404);
  assert.equal((await request("/internal/refresh", { method: "POST", headers: {
    Authorization: "Bearer " + REFRESH_TOKEN,
  } })).status, 404);
  assert.deepEqual(await (await request()).json(), { version: 1, generatedAt: null, topics: [], pages: [] });
});

test("link reports are private, authenticated, and counted once per account and link", async (t) => {
  const { accounts, request } = await service(t, {
    TOPIC_REPORT_RATE_LIMIT: { limit: async () => ({ success: true }) },
  });
  const schema = await readFile(new URL("../../account/migrations/0001_account.sql", import.meta.url), "utf8");
  await accounts.batch(schema.split(";").map((part) => part.trim()).filter(Boolean).map((part) => accounts.prepare(part)));
  const first = "a".repeat(43);
  const otherDevice = "b".repeat(43);
  const second = "c".repeat(43);
  const expired = "d".repeat(43);
  const now = Date.now();
  const sessions = await Promise.all([
    [first, "first-account", now + DAY],
    [otherDevice, "first-account", now + DAY],
    [second, "second-account", now + DAY],
    [expired, "second-account", now - DAY],
  ].map(async ([token, account, expiresAt]) => {
    const hash = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))).toString("base64url");
    return accounts.prepare("INSERT INTO sessions (token_hash, account_id, expires_at) VALUES (?, ?, ?)")
      .bind(hash, account, expiresAt);
  }));
  await accounts.batch([
    accounts.prepare("INSERT INTO accounts (id) VALUES ('first-account'), ('second-account')"),
    ...sessions,
  ]);
  const url = "https://example.org/a?edition=1";
  const origin = "https://backchnnl.app";
  const report = (token, payload, requestOrigin = origin) => request("/api/topic-reports", {
    method: "POST",
    headers: { Origin: requestOrigin, "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
    body: JSON.stringify(payload),
  });
  const preflight = await request("/api/topic-reports", { method: "OPTIONS", headers: { Origin: origin } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), origin);
  assert.equal((await report(null, { url })).status, 401);
  assert.equal((await report(expired, { url })).status, 401);
  assert.equal((await report(first, { url }, "https://another.example")).status, 403);
  assert.equal((await report(first, { url: "https://someone:secret@example.org/a" })).status, 400);
  assert.equal((await report(first, { url, suggestedTopic: "a".repeat(121) })).status, 400);
  assert.equal((await report(first, { url, suggestedTopic: "a".repeat(4096) })).status, 413);
  assert.equal((await report(first, { url: url + "&utm_source=feed#heading", topic: "Web" })).status, 204);
  const correction = { url, topic: "Web", suggestedTopic: "Browser APIs" };
  const responses = await Promise.all([report(otherDevice, correction), report(second, correction)]);
  assert.deepEqual(responses.map(({ status }) => status), [204, 204]);
  assert.equal((await request("/api/topic-reports")).status, 404);
  assert.equal((await request("/internal/topic-reports")).status, 404);
  const review = await (await request("/internal/topic-reports", {
    headers: { Authorization: "Bearer " + REFRESH_TOKEN },
  })).json();
  assert.deepEqual(review.reports.map(({ lastReportedAt, ...report }) => report), [{
    url, title: null, topic: "Web", suggestedTopic: "Browser APIs", count: 2,
  }]);
  assert(review.reports[0].lastReportedAt >= now);
  const next = await (await request("/internal/topic-reports?offset=1", {
    headers: { Authorization: "Bearer " + REFRESH_TOKEN },
  })).json();
  assert.deepEqual(next, { reports: [], nextOffset: null });
  assert.deepEqual(await (await request()).json(), { version: 1, generatedAt: null, topics: [], pages: [] });
});

test("operator decisions resolve reports and survive a fresh automatic classification", async (t) => {
  let now = START;
  t.mock.method(Date, "now", () => now);
  const independent = "Independent embassy announces flood assistance";
  const astronomy = "Space telescope photographs a new gas cloud";
  const ocean = "Research ship maps a new trench in the Pacific Ocean";
  const sources = [astronomy, astronomy, ocean, ocean, independent].map((title, position) => ({
    objectID: String(position + 1), title, url: `https://press${position}.example.org/article`,
    created_at: new Date(START).toISOString(), num_comments: position,
  }));
  mockFeeds(t, () => ({ "hn.algolia.com": { hits: sources } }));
  const { db, request, refresh } = await service(t, { AI: fixtureAI() });
  const headers = { Authorization: "Bearer " + REFRESH_TOKEN, "Content-Type": "application/json" };
  const review = (query = "?pending=1") => request("/internal/topic-reports" + query, { headers });
  const decide = (body, authed = true) => request("/internal/topic-reports", {
    method: "POST", headers: authed ? headers : { "Content-Type": "application/json" },
    body: JSON.stringify({ requestId: crypto.randomUUID(), ...body }),
  });
  const index = async () => (await request()).json();
  const pageKey = (url) => new URL(url).host + new URL(url).pathname;
  const assignments = (data, url) => data.pages.find(({ key }) => key === pageKey(url));
  await refresh();
  const first = await index();
  const [scopeA] = assignments(first, sources[0].url).topicIds;
  const [scopeB] = assignments(first, sources[2].url).topicIds;
  const [scopeC] = assignments(first, sources[4].url).topicIds;
  assert.notEqual(scopeA, scopeB);
  const article = async (id) => (await request("/api/topics/article?id=" + encodeURIComponent(id))).json();
  const before = await article(scopeB);
  assert.deepEqual(new Set(before.sources.map(({ url }) => url)), new Set([sources[2].url, sources[3].url]));
  assert.equal((await article(scopeC)).topic.id, scopeC);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pageKey(sources[0].url))));
  const pageId = Buffer.from(hash.subarray(0, 16)).toString("hex");
  await db.prepare("INSERT INTO topic_reports VALUES (?, 'test-reporter', ?, ?, ?, ?)")
    .bind(pageId, sources[0].url, astronomy, ocean, now - 1).run();
  assert.equal((await (await review()).json()).reports[0].topicId, scopeA);
  assert.equal((await decide({ action: "remove", url: sources[0].url }, false)).status, 401);
  assert.equal((await decide({ action: "move", url: "https://private.example/no-public-index", topicId: scopeB })).status, 404);
  const move = { action: "move", url: sources[0].url, topicId: scopeB, reportUrl: sources[0].url, requestId: crypto.randomUUID() };
  const accepted = await decide(move);
  assert.equal(accepted.status, 201);
  assert.deepEqual(await (await decide(move)).json(), await accepted.json());
  assert.deepEqual((await (await review()).json()).reports, []);
  assert.equal((await (await review("")).json()).reports.length, 1);
  assert.equal((await decide({ action: "remove", url: sources[3].url })).status, 201);
  const split = await decide({ action: "split", topicId: scopeA, urls: [sources[1].url], label: "Separate view of telescope gas cloud" });
  assert.equal(split.status, 201);
  const splitId = (await split.json()).topicId;
  const image = {
    url: "https://upload.wikimedia.org/wikipedia/commons/thumb/0/00/Pacific.jpg/640px-Pacific.jpg",
    source: "https://commons.wikimedia.org/wiki/File:Pacific.jpg", subject: "Pacific Ocean", credit: "Example · CC BY 4.0",
  };
  assert.equal((await decide({ action: "edit", topicId: scopeB, label: "Pacific trench mapping report", image })).status, 201);
  assert.equal((await decide({ action: "merge", topicId: scopeC, targetTopicId: scopeB })).status, 201);
  assert.equal((await decide({ action: "merge", topicId: scopeC, targetTopicId: scopeA })).status, 409);

  for (let attempt = 0; attempt < 2; attempt++) {
    now += 60_000;
    assert.equal((await refresh()).status, 200);
    const data = await index();
    assert.deepEqual(assignments(data, sources[0].url).topicIds, [scopeB]);
    assert.equal(assignments(data, sources[0].url).reviewed, true);
    assert.deepEqual(assignments(data, sources[1].url).topicIds, [splitId]);
    assert.deepEqual(assignments(data, sources[3].url).topicIds, []);
    assert.equal(assignments(data, sources[3].url).reviewed, true);
    assert.deepEqual(assignments(data, sources[4].url).topicIds, [scopeB]);
    assert.equal(data.redirects[scopeC], scopeB);
    const curated = data.topics.find(({ id }) => id === scopeB);
    assert.equal(curated.curated, true);
    assert.equal(curated.label, "Pacific trench mapping report");
    assert.deepEqual(curated.image, image);
    const detail = await (await request("/api/topics/coverage?id=" + encodeURIComponent(scopeC))).json();
    assert.equal(detail.topic.id, scopeB);
    assert.deepEqual(new Set(detail.links.map(({ url }) => url)), new Set([sources[0].url, sources[2].url, sources[4].url]));
    const merged = await article(scopeC);
    assert.equal(merged.topic.id, scopeB);
    assert.deepEqual(new Set(merged.sources.map(({ url }) => url)), new Set([sources[0].url, sources[2].url, sources[4].url]));
    assert.deepEqual((await article(splitId)).sources.map(({ url }) => url), [sources[1].url]);
  }
});

test("a corrected story can reuse an ID without inheriting the access page's links or aliases", () => {
  const old = { id: "story:anchor", kind: "story", label: "Access Denied", aliases: ["The earlier election"] };
  const reviewed = { id: "story:reviewed", kind: "story", label: "Save What Matters" };
  const earlier = [
    { key: "press.example/anchor", topicIds: [old.id], posts: [["hn:1", 8]] },
    { key: "press.example/unrelated", topicIds: [old.id], posts: [["hn:2", 13]] },
    { key: "press.example/empty", topicIds: [old.id] },
    { key: "briefly.co/first", topicIds: [reviewed.id] }, { key: "briefly.co/second", topicIds: [reviewed.id] },
  ];
  const previous = {
    body: JSON.stringify({ topics: [old, reviewed], pages: earlier, redirects: { "story:earlier-election": old.id } }),
    page_timestamps: JSON.stringify(earlier.map(() => START)),
  };
  const edit = { action: "edit", target: reviewed, changes: { label: "A collection selected by the editor" } };
  const saved = buildTopicsIndex({
    generatedAt: new Date(START + DAY).toISOString(),
    topics: [{ id: old.id, kind: "story", label: "Croatians rally in Zagreb over a hospital death" }],
    pages: ["press.example/anchor", "wire.example/zagreb"].map((key) => ({ url: "https://" + key, topicIds: [old.id] })),
  }, previous, [edit]);
  const index = JSON.parse(saved.body);
  assert.deepEqual(index.pages.filter(({ topicIds }) => topicIds.includes(old.id)).map(({ key }) => key),
    ["press.example/anchor", "wire.example/zagreb"]);
  assert.equal(index.topics.find(({ id }) => id === old.id).aliases, undefined);
  assert.equal(index.redirects?.["story:earlier-election"], undefined);
  const older = index.pages.findIndex(({ key }) => key.endsWith("/unrelated"));
  assert.deepEqual(index.pages[older], { key: "press.example/unrelated", topicIds: [], posts: [["hn:2", 13]] });
  assert.equal(JSON.parse(saved.page_timestamps)[older], START);
  assert(!index.pages.some(({ key }) => key.endsWith("/empty")));
  assert.deepEqual(index.pages.filter(({ topicIds }) => topicIds.includes(reviewed.id)).map(({ key }) => key),
    ["briefly.co/first", "briefly.co/second"]);
  assert.equal(index.topics.find(({ id }) => id === reviewed.id).label, edit.changes.label);
});

test("publication reconciles complete retained stories from their source rows outside the live window", async (t) => {
  let now = START + 8 * DAY;
  t.mock.method(Date, "now", () => now);
  mockFeeds(t, () => publicPosts(now, "current", "Local orchestra announces its winter season", 900));
  const { db, refresh, request } = await service(t, { AI: fixtureAI() });
  const certain = { id: "story:short", kind: "story", label: "FBI Criminal Database Hacked" };
  const reported = { id: "story:investigation", kind: "story", label: "FBI reportedly investigating apparent hack of its criminal database" };
  const other = { id: "story:other", kind: "story", label: certain.label };
  const boilerplate = { id: "story:tagline", kind: "story", label: "News You Can Trust" };
  const articles = [
    ["first.example/ncic", certain, "FBI's NCIC criminal database hacked, Trump confirms"],
    ["second.example/database", certain, certain.label],
    ["third.example/bbc", reported, reported.label],
    ["fourth.example/tribune", reported, "FBI investigating apparent hack of its key national criminal justice database, AP source says"],
    ["fifth.example/cnn", reported, "The FBI was hacked again", "The FBI was hacked again, this time the breach targeted its crime database"],
    ["sixth.example/email", other, "FBI investigating apparent hack of its email server"],
    ["seventh.example/email", other, "FBI investigating apparent hack of its email server"],
    ["press.example/council-opens-harbor-bridge", boilerplate, boilerplate.label, "Council opens the north harbor bridge"],
    ["press.example/ancient-mammoth-bones-unearthed", boilerplate, boilerplate.label],
  ];
  const pages = [];
  const statements = [];
  for (const [i, [key, topic, title, postTitle = title]] of articles.entries()) {
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
    const id = Buffer.from(hash).toString("hex").slice(0, 32);
    const post = "hn:" + i;
    statements.push(db.prepare("INSERT INTO pages VALUES (?, ?, ?, ?, '')").bind(id, "https://" + key, title, key.split("/")[0]),
      db.prepare("INSERT INTO posts (id, page_id, source, community, title, url, posted_at, comments) VALUES (?, ?, 'hn', '', ?, ?, ?, ?)")
        .bind(post, id, postTitle, "https://news.ycombinator.com/item?id=" + i, START, i + 3));
    pages.push({ key, topicIds: [topic.id], posts: [[post, i + 3]] });
  }
  const prior = { version: 1, generatedAt: new Date(START).toISOString(), topics: [certain, reported, other, boilerplate], pages,
    redirects: { "story:original-short": certain.id } };
  statements.push(db.prepare("INSERT INTO topics_index VALUES (1, ?, ?, ?)")
    .bind(START, JSON.stringify(prior), JSON.stringify(pages.map(() => START))));
  await db.batch(statements);
  let publishedId;
  for (let pass = 0; pass < 2; pass++, now += DAY) {
    const response = await refresh();
    assert.equal(response.status, 200);
    const { stats } = await response.json();
    assert.equal(stats.pages, 1);
    assert.equal(stats.newEmbeddings, pass === 0 ? 1 : 0);
    const index = await (await request()).json();
    const member = (key) => index.pages.find((page) => page.key === key);
    const fbi = new Set(articles.slice(0, 5).map(([key]) => member(key).topicIds[0]));
    assert.equal(fbi.size, 1, "both previously published addresses share all five incident reports");
    const [id] = fbi;
    assert([certain.id, reported.id].includes(id));
    if (pass) assert.equal(id, publishedId);
    publishedId = id;
    assert.match(index.topics.find((topic) => topic.id === id).label, /investigating apparent hack.*criminal.*database/i);
    assert.deepEqual(member(articles[5][0]).topicIds, [other.id]);
    assert.deepEqual(member(articles[6][0]).topicIds, [other.id]);
    assert(!index.topics.some((topic) => topic.id === boilerplate.id || topic.label === boilerplate.label));
    const bridge = index.topics.find((topic) => topic.label === "Council opens the north harbor bridge");
    assert.deepEqual(member(articles[7][0]).topicIds, [bridge?.id]);
    assert.deepEqual(member(articles[8][0]).topicIds, []);
    const times = JSON.parse(await db.prepare("SELECT page_timestamps FROM topics_index").first("page_timestamps"));
    for (const [i, { key, posts }] of pages.entries()) {
      const position = index.pages.findIndex((page) => page.key === key);
      assert.deepEqual(index.pages[position].posts, posts);
      assert.equal(times[position], START, "historical link " + i + " retains its expiry");
    }
    for (const address of [certain.id, reported.id, "story:original-short"]) {
      const detail = await (await request("/api/topics/coverage?id=" + encodeURIComponent(address))).json();
      assert.equal(detail.topic.id, id);
      assert.deepEqual(new Set(detail.links.map(({ url }) => url)), new Set(articles.slice(0, 5).map(([key]) => "https://" + key)));
    }
  }
});

test("bounded historical checks prioritize invalid headings and rotate complete older stories", () => {
  const topics = Array.from({ length: 11 }, (_, i) => ({
    id: "story:" + i, kind: "story", label: i ? "An observatory publishes finding " + i : "www.press.example",
  }));
  const pages = topics.flatMap(({ id }, i) => Array.from({ length: i % 3 + 2 }, (_, j) => ({
    key: `source.example/article-${i}-${j}`, topicIds: [id],
  })));
  topics.at(-1).curated = true;
  const timestamps = pages.map(() => START);
  const seen = new Set();
  for (let refresh = 0; refresh < 16; refresh++) {
    const selected = retainedEvidenceKeys({ topics, pages }, timestamps, START + refresh * 3 * 3_600_000, 8);
    assert(selected.length <= 8);
    assert(selected.includes("source.example/article-0-0"), "invalid story gets evidence at every opportunity");
    for (const [i, topic] of topics.entries()) {
      const group = pages.filter(({ topicIds }) => topicIds.includes(topic.id));
      const count = group.filter(({ key }) => selected.includes(key)).length;
      assert(count === 0 || count === group.length);
      if (count) seen.add(i);
    }
  }
  assert.deepEqual([...seen].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test("newly arrived coverage can corroborate a complete retained story on the same publication", () => {
  const label = "Space telescope photographs the Orion dust cloud";
  const sources = ["a", "b", "c", "d", "e"].map((id) => ({
    id, key: id + ".example/orion", domain: id + ".example", url: "https://" + id + ".example/orion",
    title: label, postedAt: START, posts: [{ id: "hn:" + id, title: label, comments: 10, postedAt: new Date(START).toISOString() }],
  }));
  const a = { id: "story:a", label, kind: "story" };
  const c = { id: "story:c", label, kind: "story" };
  const pages = sources.slice(0, 4).map(({ key }, position) => ({ key, topicIds: [position < 2 ? a.id : c.id] }));
  const previous = {
    body: JSON.stringify({ topics: [a, c], pages }), page_timestamps: JSON.stringify(pages.map(() => START)),
    sourcePages: sources.slice(0, 4),
  };
  const current = [sources[0], sources[4]];
  const published = JSON.parse(buildTopicsIndex({
    generatedAt: new Date(START + DAY).toISOString(), topics: [{ ...a, pageIds: current.map(({ id }) => id) }],
    pages: current.map((source) => ({ ...source, topicIds: [a.id] })),
  }, previous).body);
  assert.equal(published.topics.length, 1);
  assert.equal(published.pages.length, 5);
  const [stable] = published.topics;
  assert([a.id, c.id].includes(stable.id));
  assert(published.pages.every(({ topicIds }) => topicIds.length === 1 && topicIds[0] === stable.id));
  assert.equal(published.redirects[stable.id === a.id ? c.id : a.id], stable.id);

  const original = {
    body: JSON.stringify({ topics: [a], pages: pages.slice(0, 2) }), page_timestamps: JSON.stringify([START, START]),
    sourcePages: sources.slice(0, 2),
  };
  const arriving = sources.slice(2);
  const expanded = JSON.parse(buildTopicsIndex({
    generatedAt: new Date(START + DAY).toISOString(), topics: [{ ...c, pageIds: arriving.map(({ id }) => id) }],
    pages: arriving.map((source) => ({ ...source, topicIds: [c.id] })),
  }, original).body);
  assert.deepEqual(expanded.topics.map(({ id }) => id), [a.id], "new perspectives keep the already-published address");
  assert.equal(expanded.redirects[c.id], a.id);
});

const bridgeSources = [
  {
    url: "https://chronicle.example.org/river-bridge-repairs",
    title: "Council approves repairs for the river bridge",
    description: "City crews will replace the bridge deck. Work is scheduled to begin after the winter ferry season.",
  },
  {
    url: "https://transit.example.net/river-bridge-detour",
    title: "Transit agency publishes the detour for bridge repairs",
    description: "Bus service moves to the east road during repairs. The agency will keep both river stops open to passengers.",
  },
];

const bridgeReporting = [{ ...bridgeSources[0], description: "City crews will replace the bridge deck. " +
  "The river bridge repairs will use prefabricated panels so ferries can continue operating during construction." }, bridgeSources[1]];

function bridgeInference() {
  return { response: { sections: [{ heading: "The bridge repairs", paragraphs: [{ sentences: [
    { text: "City crews will replace the bridge deck.", evidence: [{ sourceId: "s1", quote: "crews will replace the bridge deck" }] },
    { text: "Bus service moves to the east road during repairs.", evidence: [{ sourceId: "s2", quote: "Bus service moves to the east road during repairs" }] },
  ] }] }], events: [] } };
}

async function articleFixture(t, { run = bridgeInference, sources = bridgeSources, publisherStatus = () => 200 } = {}) {
  let now = START;
  t.mock.method(Date, "now", () => now);
  const fetched = [];
  t.mock.method(globalThis, "fetch", async (address) => {
    const url = new URL(address);
    fetched.push(url.href);
    const page = sources.find((page) => page.url === url.href);
    if (!page) return new Response(null, { status: 404 });
    const status = publisherStatus(page);
    if (status !== 200) return new Response(null, { status });
    return new Response('<html><head><title>' + page.title + '</title><meta name="description" content="' +
      page.description + '"></head><body><article><p>' + page.description + '</p></article></body></html>',
    { headers: { "Content-Type": "text/html; charset=utf-8" } });
  });
  const { db, request } = await service(t, { AI: { run } });
  const topic = { id: "story:bridge-repairs", label: "River bridge repairs", kind: "story" };
  const path = "/api/topics/article?id=" + encodeURIComponent(topic.id);
  const index = { version: 1, generatedAt: new Date(now).toISOString(), topics: [topic],
    redirects: { "story:old-bridge": topic.id }, pages: [] };
  for (const [i, { url, title, description }] of sources.entries()) {
    const key = url.replace(/^https:\/\//, "");
    const id = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key))).toString("hex").slice(0, 32);
    index.pages.push({ key, topicIds: [topic.id], posts: [["hn:" + (41 + i), 5]] });
    await db.batch([
      db.prepare("INSERT INTO pages VALUES (?, ?, ?, ?, ?)").bind(id, url, title, new URL(url).hostname, description),
      db.prepare("INSERT INTO posts (id, page_id, source, community, title, url, posted_at, comments) VALUES (?, ?, 'hn', '', ?, ?, ?, 5)")
        .bind("hn:" + (41 + i), id, title, "https://news.ycombinator.com/item?id=" + (41 + i), START),
    ]);
  }
  const publish = () => {
    index.generatedAt = new Date(now).toISOString();
    return db.prepare("INSERT OR REPLACE INTO topics_index VALUES (1, ?, ?, ?)").bind(now, JSON.stringify(index),
      JSON.stringify(index.pages.map(() => now))).run();
  };
  await publish();
  return { request, path, db, index, publish, fetched, advance: (ms) => { now += ms; } };
}

test("topic articles are shared across readers, redirects, republishing and discussion activity", async (t) => {
  let runs = 0;
  const { db, request, path, index, publish, advance, fetched } = await articleFixture(t, {
    run: () => { runs++; return bridgeInference(); },
  });
  const original = await request("/api/topics/article?id=story%3Aold-bridge");
  assert.equal(original.status, 200);
  assert.equal(original.headers.get("access-control-allow-origin"), "*");
  const first = await original.json();
  assert.equal(first.topic.id, "story:bridge-repairs");
  assert.equal(first.method, "synthesis");
  assert.equal(runs, 1);
  assert.deepEqual(new Set(first.sources.map(({ url }) => url)), new Set(bridgeSources.map(({ url }) => url)));
  const downloads = fetched.length;

  advance(3 * 3_600_000);
  index.pages.reverse();
  index.pages.find(({ key }) => key.startsWith("chronicle.")).posts[0][1] = 17;
  await publish();
  await db.prepare("UPDATE posts SET comments = 17 WHERE id = 'hn:41'").run();
  const warm = await request(path);
  const same = await warm.json();
  assert.equal(same.generatedAt, first.generatedAt);
  assert.deepEqual(same.sections, first.sections);
  assert.equal(same.sources.find(({ url }) => url === bridgeSources[0].url).discussions[0].comments, 17);
  assert.equal(runs, 1);
  assert.equal(fetched.length, downloads);
  const revalidated = await request(path, { headers: { "If-None-Match": warm.headers.get("etag") } });
  assert.equal(revalidated.status, 304);
  assert.equal(await revalidated.text(), "");

  await db.prepare("UPDATE pages SET description = description || ' Funding is secured.' WHERE url = ?").bind(bridgeSources[0].url).run();
  const revised = await (await request(path)).json();
  assert.equal(runs, 2);
  assert.notEqual(revised.generatedAt, first.generatedAt);
});

test("only current published topic IDs can initiate article generation", async (t) => {
  let runs = 0;
  const { request, fetched, path, db, index, publish } = await articleFixture(t, {
    run: () => { runs++; return bridgeInference(); },
  });
  for (const id of ["story:unknown", "topic:unknown", "local:bridge", "https://private.example.org/page"]) {
    assert.equal((await request("/api/topics/article?id=" + encodeURIComponent(id))).status, 404);
  }
  assert.equal((await request(path, { method: "POST", body: "arbitrary evidence" })).status, 404);
  assert.equal((await request(path + "&url=https://other.example.org/")).status, 400);
  assert.equal((await request(path + "&prompt=write+anything")).status, 400);
  assert.deepEqual(fetched, []);
  assert.equal(runs, 0);

  const members = index.pages;
  index.pages = [{ key: "no-row.example.org/orphan", topicIds: ["story:bridge-repairs"] }];
  await publish();
  const missing = await request(path);
  assert.equal(missing.status, 503);
  assert(Number(missing.headers.get("retry-after")) > 0);
  assert.deepEqual(fetched, []);
  index.pages = members.slice(0, 1);
  await publish();
  const repaired = await request(path);
  assert.equal(repaired.status, 200);
  assert.deepEqual((await repaired.json()).sources.map(({ url }) => url), [bridgeSources[0].url]);
  await db.prepare("DELETE FROM topics_index").run();
  assert.equal((await request(path)).status, 404);
});

test("simultaneous topic article opens take one D1 lease and return a bounded pending response", { timeout: 15_000 }, async (t) => {
  const entered = Promise.withResolvers();
  const gate = Promise.withResolvers();
  let runs = 0;
  const { request, path } = await articleFixture(t, {
    run: async () => { runs++; entered.resolve(); await gate.promise; return bridgeInference(); },
  });
  t.after(() => gate.resolve());
  const work = [];
  const context = { waitUntil: (promise) => work.push(promise) };
  const first = await request(path, undefined, context);
  try {
    assert.equal(first.status, 202);
    assert(Number(first.headers.get("retry-after")) > 0);
    await entered.promise;
    const concurrent = await Promise.all([request(path, undefined, context), request("/api/topics/article?id=story%3Aold-bridge", undefined, context)]);
    assert.deepEqual(concurrent.map(({ status }) => status), [202, 202]);
    assert.equal(runs, 1);
  } finally {
    gate.resolve();
    await Promise.all(work);
  }
  const warm = await request(path);
  assert.equal(warm.status, 200);
  assert.equal((await warm.json()).method, "synthesis");
  assert.equal(runs, 1);
});

test("an article finishing after a published split cannot return or overwrite withdrawn evidence", { timeout: 15_000 }, async (t) => {
  const entered = Promise.withResolvers();
  const gate = Promise.withResolvers();
  let runs = 0;
  const { request, path, index, publish, advance } = await articleFixture(t, {
    run: async () => { if (++runs === 1) { entered.resolve(); await gate.promise; } return bridgeInference(); },
  });
  t.after(() => gate.resolve());
  const pending = request(path);
  const started = await Promise.race([entered.promise.then(() => true), pending.then(() => false)]);
  assert.equal(started, true, "the old membership must actually be generating");
  advance(1_000);
  index.pages[1].topicIds = [];
  await publish();
  const fresh = await request(path);
  assert.equal(fresh.status, 200);
  assert.deepEqual((await fresh.json()).sources.map(({ url }) => url), [bridgeSources[0].url]);
  gate.resolve();
  const superseded = await pending;
  assert.equal(superseded.status, 202);
  const warm = await (await request(path)).json();
  assert.deepEqual(warm.sources.map(({ url }) => url), [bridgeSources[0].url]);
});

test("a temporary model outage serves cited public coverage and retries after the backoff", async (t) => {
  let runs = 0;
  const { request, path, advance } = await articleFixture(t, {
    sources: bridgeReporting,
    run: () => { if (++runs === 1) throw new Error("model temporarily unavailable"); return bridgeInference(); },
  });
  const degraded = await request(path);
  assert.equal(degraded.status, 200);
  const delay = Number(degraded.headers.get("retry-after"));
  assert(delay > 0);
  const fallback = await degraded.json();
  assert.equal(fallback.method, "coverage");
  assert(fallback.sections.some(({ paragraphs }) => paragraphs.some(({ sourceIds }) => sourceIds.length)));
  assert.equal((await (await request(path)).json()).generatedAt, fallback.generatedAt);
  assert.equal(runs, 1);
  advance(delay * 1000 + 10);
  const recovered = await request(path);
  assert.equal(recovered.status, 200);
  assert.equal((await recovered.json()).method, "synthesis");
  assert.equal(recovered.headers.get("retry-after"), null);
  assert.equal(runs, 2);
});

test("blocked originals replace the previous headline-only article with a cacheable source dossier", async (t) => {
  const { request, path, db, fetched, index } = await articleFixture(t, {
    publisherStatus: () => 403, run: () => assert.fail("Blocked originals cannot support inference"),
  });
  const { id, label } = index.topics[0];
  const sources = bridgeSources.map(({ url, title }, i) => ({ id: "s" + (i + 1), url, title, publisher: new URL(url).hostname,
    excerpt: "", publishedAt: null, sharedAt: new Date(START).toISOString(), discussions: [] }));
  const paragraphs = sources.map(({ id, title, publisher }) => ({
    text: "A public listing shared “" + title + "” from " + publisher + ".", sourceIds: [id],
  }));
  const legacy = { version: 1, topic: { id, label }, method: "coverage", generatedAt: new Date(START - DAY).toISOString(),
    sources, sections: [{ heading: "Shared coverage", paragraphs }],
    timeline: paragraphs.map((paragraph) => ({ ...paragraph, kind: "shared", date: new Date(START).toISOString() })) };
  const briefV2Revision = "eb8e635206cb12e277eba96a9d2596e6";
  await db.prepare("INSERT INTO topic_articles (topic_id, revision, body, expires_at) VALUES (?, ?, ?, ?)")
    .bind(id, briefV2Revision, JSON.stringify(legacy), START + 30 * DAY).run();

  const response = await request(path);
  assert.equal(response.status, 200);
  const dossier = await response.json();
  assert.equal(dossier.method, "coverage");
  assert.equal(dossier.version, 1);
  assert.notEqual(dossier.generatedAt, legacy.generatedAt);
  assert.deepEqual(dossier.sections, []);
  assert.deepEqual(dossier.timeline, []);
  assert.deepEqual(dossier.sources.map(({ url, title }) => ({ url, title })), bridgeSources.map(({ url, title }) => ({ url, title })));
  assert(dossier.sources.every(({ sharedAt, discussions }) => sharedAt && discussions.length));
  assert.equal(response.headers.get("retry-after"), null);
  assert.equal(fetched.length, 2);
  const warm = await request(path, { headers: { "If-None-Match": response.headers.get("etag") } });
  assert.equal(warm.status, 304);
  assert.equal(fetched.length, 2);
});

test("unavailable publishers leave the source dossier readable until their reporting is accessible", async (t) => {
  let status = 503;
  const { request, path, advance, fetched } = await articleFixture(t, { publisherStatus: () => status });
  const response = await request(path);
  assert.equal(response.status, 200);
  const dossier = await response.json();
  assert.equal(dossier.method, "coverage");
  assert.deepEqual(dossier.sections, []);
  assert.deepEqual(dossier.timeline, []);
  assert.equal(dossier.sources.length, 2);
  const delay = Number(response.headers.get("retry-after"));
  assert(delay > 0);
  assert.equal((await (await request(path)).json()).generatedAt, dossier.generatedAt);
  assert.equal(fetched.length, 2);
  advance(delay * 1000 + 10);
  status = 200;
  const available = await request(path);
  assert.equal(available.status, 200);
  assert.equal(available.headers.get("retry-after"), null);
  const article = await available.json();
  assert.equal(article.method, "synthesis");
  assert(article.sections[0].paragraphs.some(({ text }) => text.includes("will replace the bridge deck")));
});

test("partial publisher access returns a cited brief and keeps the blocked original in the sources", async (t) => {
  const { request, path } = await articleFixture(t, {
    sources: bridgeReporting,
    publisherStatus: (source) => source.url === bridgeSources[0].url ? 200 : 403,
    run: () => assert.fail("One short passage does not support a full synthesis"),
  });
  const response = await request(path);
  assert.equal(response.status, 200);
  const brief = await response.json();
  const readable = brief.sources.find(({ url }) => url === bridgeSources[0].url);
  assert(brief.sources.some(({ url }) => url === bridgeSources[1].url));
  assert.equal(brief.method, "coverage");
  const paragraphs = brief.sections.flatMap(({ paragraphs }) => paragraphs);
  assert.equal(paragraphs.length, 1);
  assert.deepEqual(paragraphs[0].sourceIds, [readable.id]);
  assert.match(paragraphs[0].text, /prefabricated panels/);
  assert.deepEqual(brief.timeline, []);
});

test("the article returns twelve distinct published discussions with their individual counts", async (t) => {
  const { db, request, path, index, publish } = await articleFixture(t, { sources: bridgeSources.slice(0, 1), publisherStatus: () => 403 });
  const threads = Array.from({ length: 14 }, (_, i) => {
    const source = i % 2 ? "hn" : "lobsters";
    const key = String(200 + i);
    const url = source === "hn" ? "https://news.ycombinator.com/item?id=" + key : "https://lobste.rs/s/" + key;
    return { id: source + ":" + key, source, title: "Bridge discussion " + key, url, postedAt: START + i * 1000, comments: 13 - i };
  });
  const mirror = { ...threads.at(-1), id: "hn:duplicate", postedAt: START + 15_000 };
  const published = [...threads, mirror];
  await db.prepare(`INSERT INTO posts (id, page_id, source, community, title, url, posted_at, comments)
    SELECT j.value->>'id', p.id, j.value->>'source', '', j.value->>'title', j.value->>'url', j.value->>'postedAt', j.value->>'comments'
    FROM json_each(?) AS j JOIN pages AS p WHERE p.url = ?`)
    .bind(JSON.stringify(published), bridgeSources[0].url).run();
  index.pages[0].posts = published.map(({ id, comments }) => [id, comments]);
  await publish();
  const article = await (await request(path)).json();
  const discussions = article.sources[0].discussions.map(({ source, url, comments }) => ({ source, url, comments }));
  assert.deepEqual(discussions, threads.slice(-12).reverse().map(({ source, url, comments }) => ({ source, url, comments })));
});

test("publisher sharing variants contribute one indexed article and preserve each public discussion", async (t) => {
  const base = "https://www.nytimes.com/2026/11/20/world/river-bridge-repairs-begin.html";
  const sources = ["?smid=first", "", "?unlocked_article_code=public"].map((suffix) => ({ ...bridgeSources[0], url: base + suffix }));
  const { request, path, db } = await articleFixture(t, { sources });
  await db.prepare("INSERT INTO posts (id, page_id, source, community, title, url, posted_at, comments) " +
    "SELECT 'hn:999', id, 'hn', '', 'Not published', 'https://news.ycombinator.com/item?id=999', ?, 1 FROM pages WHERE url = ?")
    .bind(START + 10_000, base).run();
  const response = await request(path);
  assert.equal(response.status, 200);
  const article = await response.json();
  assert.deepEqual(article.sources.map(({ url }) => url), [base]);
  assert.deepEqual(new Set(article.sources[0].discussions.map(({ url }) => url)),
    new Set([41, 42, 43].map((id) => "https://news.ycombinator.com/item?id=" + id)));
});

test("an expired article lease can be reclaimed without its late writer replacing the winner", { timeout: 15_000 }, async (t) => {
  const entered = Promise.withResolvers();
  const gate = Promise.withResolvers();
  let runs = 0;
  const { request, path, advance } = await articleFixture(t, {
    run: async () => { if (++runs === 1) { entered.resolve(); await gate.promise; } return bridgeInference(); },
  });
  t.after(() => gate.resolve());
  const abandoned = request(path);
  await entered.promise;
  advance(60_000);
  const replacement = await (await request(path)).json();
  gate.resolve();
  assert.equal((await (await abandoned).json()).generatedAt, replacement.generatedAt);
  assert.equal((await (await request(path)).json()).generatedAt, replacement.generatedAt);
  assert.equal(runs, 2);
});

test("fresh public discussion metadata cannot push an article over its response byte limit", async (t) => {
  const { request, path, db } = await articleFixture(t);
  const article = await (await request(path)).json();
  for (const source of article.sources) source.discussions = [];
  const limit = 192 * 1024;
  const paragraph = article.sections[0].paragraphs[0];
  paragraph.text += "x".repeat(limit - Buffer.byteLength(JSON.stringify(article)) - 10);
  await db.prepare("UPDATE topic_articles SET body = ?").bind(JSON.stringify(article)).run();
  const response = await request(path);
  assert.equal(response.status, 200);
  const data = await response.arrayBuffer();
  assert(data.byteLength <= limit);
  assert.equal(JSON.parse(new TextDecoder().decode(data)).sources.length, 2);
});

test("article storage outages preserve the published index and return a retryable article status", async (t) => {
  const { request, path, db } = await articleFixture(t);
  await db.prepare("DROP TABLE topic_articles").run();
  assert.equal((await request()).status, 200);
  const response = await request(path);
  assert.equal(response.status, 503);
  assert(Number(response.headers.get("retry-after")) > 0);
});

test("a public index refresh prunes old article revisions and remains usable during cache maintenance", async (t) => {
  t.mock.method(Date, "now", () => START);
  mockFeeds(t, () => publicPosts(START, "fresh"));
  const { db, refresh, request } = await service(t, { AI: fixtureAI() });
  await db.prepare("INSERT INTO topic_articles (topic_id, revision, expires_at) VALUES ('story:gone', 'old', ?)").bind(START - 1).run();
  assert.equal((await refresh()).status, 200);
  assert.equal(await db.prepare("SELECT COUNT(*) FROM topic_articles").first("COUNT(*)"), 0);
  await db.prepare("DROP TABLE topic_articles").run();
  assert.equal((await refresh()).status, 200);
  assert((await (await request()).json()).topics.length);
});

test("corroboration joins separately indexed coverage of the same result until a published review excludes it", async (t) => {
  const sources = [
    { title: "Chuck Hubbard defeats Rep. Virginia Foxx after a recount in their North Carolina House race",
      url: "https://apnews.com/article/chuck-hubbard-virginia-foxx-north-carolina-23732afcd78a853e98acd9b72d0cbd14", description: "" },
    { title: "Republican chair of the House Rules Committee loses reelection, bringing Democrats’ majority to 259 | CNN Politics",
      url: "https://www.cnn.com/2026/11/22/politics/virginia-foxx-loses-reelection-chuck-hubbard", description: "" },
  ];
  const { request, path, index, publish, advance } = await articleFixture(t, { sources });
  index.topics[0].label = sources[0].title;
  index.topics.push({ id: "story:cnn", label: sources[1].title, kind: "story" });
  index.pages[1].topicIds = ["story:cnn"];
  await publish();
  const corroborated = await (await request(path)).json();
  assert.deepEqual(corroborated.sources.map(({ url }) => url), sources.map(({ url }) => url));
  advance(1000);
  index.pages[1].topicIds = [index.topics[0].id];
  await publish();
  const assigned = await (await request(path)).json();
  assert.deepEqual(assigned.sources.map(({ url }) => url), corroborated.sources.map(({ url }) => url));
  assert.notEqual(assigned.generatedAt, corroborated.generatedAt);
  index.pages[1].topicIds = ["story:cnn"];
  index.pages[1].reviewed = true;
  await publish();
  const reviewed = await (await request(path)).json();
  assert.deepEqual(reviewed.sources.map(({ url }) => url), [sources[0].url]);
});

test("warm article requests can use the durable source selection without transferring the entire public index", async (t) => {
  const { request, db, path } = await articleFixture(t);
  assert.equal((await request(path)).status, 200);
  let fullIndexReads = 0;
  const env = { TOPICS_DB: { prepare(sql) {
    if (/SELECT (?:generated_at, )?body FROM (?:topics_index|public_index)/i.test(sql)) fullIndexReads++;
    return db.prepare(sql);
  } } };
  const warm = await worker.fetch(new Request("https://topics.test/api/topics/article?id=story%3Aold-bridge"), env);
  assert.equal(warm.status, 200);
  assert.equal((await warm.json()).method, "synthesis");
  assert.equal(fullIndexReads, 0);
});

test("a publication winning the final cache write cannot leak an article from just before a reviewed split", async (t) => {
  const { db, index, path, publish, request } = await articleFixture(t);
  let published = false;
  const env = { AI: { run: bridgeInference }, TOPICS_DB: { prepare(sql) {
    const statement = db.prepare(sql);
    if (!sql.startsWith("UPDATE topic_articles SET body")) return statement;
    return { bind(...params) {
      const bound = statement.bind(...params);
      return { async first() {
        if (!published) {
          published = true;
          index.pages[1].topicIds = [];
          index.pages[1].reviewed = true;
          await publish();
        }
        return bound.first();
      } };
    } };
  } } };
  const raced = await worker.fetch(new Request("https://topics.test" + path), env);
  assert.equal(published, true);
  assert.equal(raced.status, 202);
  const fresh = await (await request(path)).json();
  assert.deepEqual(fresh.sources.map(({ url }) => url), [bridgeSources[0].url]);
});
