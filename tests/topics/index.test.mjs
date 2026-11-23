import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { groupPages } from "../../topics/grouping.mjs";
import { buildTopicsIndex } from "../../topics/index.mjs";
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
    await db.batch(sql.split(";").map((part) => part.trim()).filter(Boolean).map((part) => db.prepare(part)));
  }
  const accounts = await runtime.getD1Database("ACCOUNTS_DB");
  const env = { TOPICS_DB: db, ACCOUNTS_DB: accounts, REFRESH_TOKEN, ...options };
  const request = (path = "/api/topics", init) => worker.fetch(new Request("https://topics.test" + path, init), env);
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
    objectID: String(position + 1), title, url: `https://press${position}.example/article`,
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
  }
});
