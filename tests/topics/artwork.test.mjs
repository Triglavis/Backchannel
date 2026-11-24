import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { addTopicArtwork } from "../../topics/artwork.mjs";
import { buildTopicsIndex } from "../../topics/index.mjs";
import worker from "../../topics/worker.mjs";

const now = Date.parse("2026-11-21T12:00:00Z");
const photo = {
  url: "https://upload.wikimedia.org/wikipedia/commons/thumb/1/12/Steam_Machine.jpg/640px-Steam_Machine.jpg",
  source: "https://commons.wikimedia.org/wiki/File:Steam_Machine.jpg",
  credit: "Example Photographer · CC BY-SA 4.0",
  subject: "Steam Machine",
};

async function database(t) {
  const runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script: "export default { fetch: () => new Response() };",
    d1Databases: { TOPICS_DB: "topics-test" },
  }));
  t.after(() => runtime.dispose());
  const db = await runtime.getD1Database("TOPICS_DB");
  const migrations = new URL("../../topics/migrations/", import.meta.url);
  for (const file of (await readdir(migrations)).sort()) {
    const sql = await readFile(new URL(file, migrations), "utf8");
    await db.exec(sql.replaceAll("\n", " "));
  }
  return db;
}

function commonsPhoto(title = "File:Steam Machine.jpg", author = '<a href="/wiki/User:Example">Example Photographer</a>') {
  const filename = title.slice("File:".length).replaceAll(" ", "_");
  return {
    pageid: 482,
    ns: 6,
    title,
    imagerepository: "local",
    imageinfo: [{
      size: 529_733, width: 1280, height: 960, mime: "image/jpeg",
      thumbwidth: 640, thumbheight: 480, thumbmime: "image/jpeg",
      thumburl: "https://upload.wikimedia.org/wikipedia/commons/thumb/1/12/" + filename + "/640px-" + filename + "?utm_source=commons.wikimedia.org",
      descriptionurl: "https://commons.wikimedia.org/wiki/File:" + filename,
      extmetadata: {
        Artist: { value: author },
        ImageDescription: { value: "A photo of the Steam Machine." },
        LicenseShortName: { value: "CC BY-SA 4.0" },
        LicenseUrl: { value: "https://creativecommons.org/licenses/by-sa/4.0" },
      },
    }],
  };
}

test("the version one index publishes topic artwork and retains it with the topic", () => {
  const pages = [{ url: "https://example.org/steam", topicIds: ["topic:steam-machine"] }];
  const topic = { id: "topic:steam-machine", kind: "topic", label: "Steam Machine", image: photo };
  const live = buildTopicsIndex({ generatedAt: new Date(now).toISOString(), topics: [topic], pages });
  const liveIndex = JSON.parse(live.body);
  assert.equal(liveIndex.version, 1);
  assert.deepEqual(liveIndex.topics, [topic]);
  assert.deepEqual(liveIndex.pages, [{ key: "example.org/steam", topicIds: [topic.id] }]);

  const retained = buildTopicsIndex({ generatedAt: new Date(now + 86_400_000).toISOString(), topics: [], pages: [] }, live);
  assert.deepEqual(JSON.parse(retained.body).topics, [topic]);
});

test("new assignments leave old generic topic aliases and imagery on historical members only", () => {
  const former = {
    id: "topic:steam", kind: "topic", label: "Steam",
    aliases: ["Valve announces Steam Machine preorders"], image: photo,
  };
  const dates = new Date(now).toISOString();
  const previous = {
    body: JSON.stringify({ version: 1, generatedAt: dates, topics: [former], pages: [
      { key: "publisher.example/new", topicIds: [former.id] },
      { key: "publisher.example/archived", topicIds: [former.id] },
    ] }),
    page_timestamps: JSON.stringify([now, now]),
  };
  const live = { id: "story:preorders", kind: "story", label: "Valve announces Steam Machine preorders" };
  const index = JSON.parse(buildTopicsIndex({
    generatedAt: new Date(now + 1).toISOString(), topics: [live],
    pages: [{ url: "https://publisher.example/new", topicIds: [live.id] }],
  }, previous).body);
  assert.deepEqual(index.topics, [live, former]);
  assert.deepEqual(index.pages, [
    { key: "publisher.example/new", topicIds: [live.id] },
    { key: "publisher.example/archived", topicIds: [former.id] },
  ]);
});

test("current aliases lead a deduplicated list capped at the public reader limit", () => {
  const topic = { id: "story:one", label: "Current story title", kind: "story" };
  const generatedAt = new Date(now).toISOString();
  const assignments = [{ key: "publisher.example/story", topicIds: [topic.id] }];
  const previous = {
    body: JSON.stringify({ version: 1, generatedAt, pages: assignments, topics: [{
      ...topic, label: "Former title", aliases: ["RECENT alias", ...Array.from({ length: 30 }, (_, index) => "Old alias " + index)],
    }] }),
    page_timestamps: JSON.stringify([now]),
  };
  const index = JSON.parse(buildTopicsIndex({
    generatedAt, topics: [{ ...topic, aliases: ["Recent alias", "Current story title"] }],
    pages: assignments.map(({ key, topicIds }) => ({ url: "https://" + key, topicIds })),
  }, previous).body);
  assert.equal(index.topics[0].aliases.length, 24);
  assert.deepEqual(index.topics[0].aliases.slice(0, 3), ["Recent alias", "Former title", "Old alias 0"]);
});

test("subject artwork skips wordmarks and ambiguous or uncorroborated matches", async (t) => {
  const db = await database(t);
  const titles = {
    "Internet Archive": { title: "Internet Archive", pageimage: "Internet Archive logo.svg", pageprops: { wikibase_item: "Q461" } },
    Mercury: { title: "Mercury", pageimage: "Mercury.jpg", pageprops: { disambiguation: "" } },
    Rust: { title: "Rust", pageimage: "Rust on iron.jpg", terms: { description: ["type of iron oxide"] } },
    Anthropic: {
      title: "Anthropic", pageimage: "Slack offices.jpg", pageprops: { wikibase_item: "Q116758847" },
      terms: { description: ["artificial intelligence corporation"] },
    },
  };
  t.mock.method(globalThis, "fetch", async (address, options) => {
    const url = new URL(address);
    if (url.hostname === "en.wikipedia.org") return Response.json({ query: { pages: url.searchParams.get("titles").split("|")
      .map((title, pageid) => ({ ns: 0, pageid: pageid + 1, ...(titles[title] || { title, missing: true }) })) } });
    if (url.hostname === "www.wikidata.org") {
      assert.equal(url.searchParams.get("action"), "wbgraphql");
      assert.equal(options.method, "POST");
      return Response.json({ data: { itemsById: [
        { id: "Q461", images: [
          { rank: "DEPRECATED", value: { content: "Outdated Internet Archive.jpg" } },
          { rank: "NORMAL", value: { content: "Internet Archive servers.jpg" } },
        ], logos: [] },
        { id: "Q116758847", images: [], logos: [] },
      ] } });
    }
    assert.equal(url.hostname, "commons.wikimedia.org");
    const files = url.searchParams.get("titles").split("|");
    assert.deepEqual(files.sort(), ["File:Internet Archive servers.jpg", "File:Rust on iron.jpg", "File:Slack offices.jpg"]);
    return Response.json({ query: { pages: files.map((file) => {
      const item = commonsPhoto(file);
      item.imageinfo[0].extmetadata.ImageDescription.value = file.replace(/^File:|\.jpg$/g, "");
      return item;
    }) } });
  });
  const snapshot = {
    topics: [
      { id: "story:union", label: "Internet Archive Staffers Are Unionizing", kind: "story", pageIds: ["a", "b"], subjectTitles: ["Internet Archive"] },
      { id: "topic:mercury", label: "Mercury", kind: "topic", pageIds: ["c"] },
      { id: "topic:rust", label: "Rust", kind: "topic", pageIds: ["d"] },
      { id: "topic:anthropic", label: "Anthropic", kind: "topic", pageIds: ["e"] },
    ],
    pages: [
      { id: "a", title: "Internet Archive Staffers Are Unionizing" },
      { id: "b", title: "Workers at the Internet Archive vote to unionize" },
      { id: "c", title: "Mercury photos from the Solar System" },
      { id: "d", title: "Rust compiler accepts a new programming syntax" },
      { id: "e", title: "Artificial intelligence company Anthropic" },
    ],
  };
  await addTopicArtwork(db, snapshot, now);
  assert.deepEqual(snapshot.topics.map(({ image }) => image?.subject), ["Internet Archive", undefined, undefined, undefined]);
  assert.equal(snapshot.topics[0].image.source, "https://commons.wikimedia.org/wiki/File:Internet_Archive_servers.jpg");
});

test("named subjects of multi-link stories get the first artwork lookups", async (t) => {
  const db = await database(t);
  const singles = Array.from({ length: 38 }, (_, i) => ({
    id: "solo:" + i, label: "How an ordinary article headline reads without a named subject " + i, pageIds: ["solo:" + i],
  }));
  const story = {
    id: "story:archive", label: "Internet Archive Staffers Are Unionizing", pageIds: ["a", "b"],
    kind: "story", subjectTitles: ["Internet Archive"],
  };
  let titles;
  t.mock.method(globalThis, "fetch", async (address) => {
    const url = new URL(address);
    titles = url.searchParams.get("titles").split("|");
    return Response.json({ query: { pages: titles.map((title) => ({ ns: 0, title, missing: true })) } });
  });
  await addTopicArtwork(db, {
    topics: [...singles, story],
    pages: [
      ...singles.map(({ id, label }) => ({ id, title: label })),
      { id: "a", title: story.label },
      { id: "b", title: "Internet Archive employees vote to form a union" },
    ],
  }, now);
  assert.deepEqual(titles, ["Internet Archive", story.label]);
});

test("a repeated object in independent headlines takes precedence over a named person", async (t) => {
  const db = await database(t);
  const label = "Trump Threatens Tax on US Companies Building Data Centers Overseas";
  const snapshot = {
    topics: [{ id: "story:tax", label, pageIds: ["a", "b", "c"], kind: "story", subjectTitles: ["Donald Trump"] }],
    pages: [
      { id: "a", title: label },
      { id: "b", title: "Trump threatens ban on US firms building AI data centres overseas" },
      { id: "c", title: "Trump says he will penalize businesses that build data centers overseas" },
    ],
  };
  t.mock.method(globalThis, "fetch", async (address) => {
    const url = new URL(address);
    const titles = url.searchParams.get("titles").split("|");
    if (url.hostname === "en.wikipedia.org") return Response.json({ query: { pages: titles.map((title) => {
      if (title === "Data center") return { pageid: 1, ns: 0, title, pageimage: "Data Center Exterior.jpg" };
      if (title === "Donald Trump") return { pageid: 2, ns: 0, title, pageimage: "Donald Trump Portrait.jpg" };
      return { ns: 0, title, missing: true };
    }) } });
    return Response.json({ query: { pages: titles.map((title) => commonsPhoto(title)) } });
  });
  await addTopicArtwork(db, snapshot, now);
  assert.equal(snapshot.topics[0].image?.subject, "Data center");
});

test("positive and negative results are cached and an outage preserves earlier subject artwork", async (t) => {
  const db = await database(t);
  const initial = {
    topics: [
      { id: "steam", label: "Steam Machine", pageIds: ["steam"], kind: "topic" },
      { id: "new", label: "New Valve Product", pageIds: ["new"], kind: "topic" },
    ],
    pages: [{ id: "steam", title: "Steam Machine" }, { id: "new", title: "New Valve Product" }],
  };
  let available = true;
  const calls = [];
  t.mock.method(globalThis, "fetch", async (address) => {
    const url = new URL(address);
    calls.push(url.hostname);
    if (!available) return new Response(null, { status: 503 });
    if (url.hostname === "en.wikipedia.org") return Response.json({ query: { pages: [
      { pageid: 1, ns: 0, title: "Steam Machine", pageimage: "Steam_Machine.jpg" },
      { ns: 0, title: "New Valve Product", missing: true },
    ] } });
    return Response.json({ query: { pages: [commonsPhoto()] } });
  });
  const first = structuredClone(initial);
  await addTopicArtwork(db, first, now);
  assert.deepEqual(first.topics.map(({ image }) => image), [photo, undefined]);

  const cached = structuredClone(initial);
  await addTopicArtwork(db, cached, now + 3_600_000);
  assert.deepEqual(cached.topics.map(({ image }) => image), [photo, undefined]);
  assert.deepEqual(calls, ["en.wikipedia.org", "commons.wikimedia.org"]);

  available = false;
  const stale = structuredClone(initial);
  await addTopicArtwork(db, stale, now + 8 * 86_400_000);
  assert.deepEqual(stale.topics.map(({ image }) => image), [photo, undefined]);
  assert.deepEqual(calls, ["en.wikipedia.org", "commons.wikimedia.org", "en.wikipedia.org"]);

  available = true;
  await addTopicArtwork(db, structuredClone(initial), now + 8 * 86_400_000 + 1);
  assert.deepEqual(calls.slice(-2), ["en.wikipedia.org", "commons.wikimedia.org"]);
});

test("Commons search finds a licensed depiction when a software subject has a wordmark or unusable lead", async (t) => {
  const db = await database(t);
  const calls = [];
  t.mock.method(globalThis, "fetch", async (address, options) => {
    const url = new URL(address);
    calls.push([url.hostname, options.redirect, url.searchParams.get("gsrsearch")]);
    if (url.hostname === "en.wikipedia.org") return Response.json({ query: { pages: [{
      ns: 0, pageid: 1, title: "GrapheneOS", pageimage: "GrapheneOS Logo.svg", pageprops: { wikibase_item: "Q85764357" },
      terms: { description: ["Android-based mobile operating system"] },
    }] } });
    if (url.hostname === "www.wikidata.org") return Response.json({ data: { itemsById: [{
      id: "Q85764357", images: [{ rank: "NORMAL", value: { content: "GrapheneOS Android 17.png" } }],
    }] } });
    if (url.hostname !== "commons.wikimedia.org") return new Response(null, { status: 400 });
    const metadata = (title, index, description, license) => {
      const page = commonsPhoto(title, "Example Photographer");
      page.index = index;
      page.imageinfo[0].extmetadata.ImageDescription.value = description;
      if (license) page.imageinfo[0].extmetadata.LicenseShortName.value = license;
      return page;
    };
    if (!url.searchParams.has("generator")) return Response.json({ query: { pages: [
      metadata("File:GrapheneOS Android 17.png", 1, "Latest GrapheneOS home screen", "MIT"),
    ] } });
    return Response.json({ batchcomplete: true, query: { pages: [
      metadata("File:GrapheneOS Screenshot.png", 5, "Home screen of GrapheneOS, with its default apps"),
      metadata("File:GrapheneOS Logo.png", 1, "The GrapheneOS logo"),
      metadata("File:Newspaper stack.jpg", 2, "An article about GrapheneOS was published in a newspaper"),
      metadata("File:Different home screen.png", 3, "Home screen of another operating system"),
      metadata("File:GrapheneOS Android 17.png", 4, "Latest GrapheneOS home screen", "MIT"),
    ] } });
  });
  const headline = "Phone manufacturers are said to be shunning GrapheneOS";
  const snapshot = {
    topics: [{ id: "story:os", label: headline, kind: "story", pageIds: ["a"] }],
    pages: [{ id: "a", url: "https://publisher.example/grapheneos", title: headline }],
  };
  await addTopicArtwork(db, snapshot, now);
  assert.equal(snapshot.topics[0].image?.subject, "GrapheneOS");
  assert.equal(snapshot.topics[0].image.source, "https://commons.wikimedia.org/wiki/File:GrapheneOS_Screenshot.png");
  assert.equal(snapshot.topics[0].image.credit, "Example Photographer · CC BY-SA 4.0");
  assert(calls.every(([host, redirect]) => host !== "publisher.example" && redirect === "manual"));
  assert(calls.some(([host, , search]) => host === "commons.wikimedia.org" && search?.includes("haswbstatement:P180=Q85764357")));
});

test("a repeated organization in a possessive headline can use a photographed headquarters", async (t) => {
  const db = await database(t);
  const searched = [];
  t.mock.method(globalThis, "fetch", async (address) => {
    const url = new URL(address);
    if (url.hostname === "en.wikipedia.org") return Response.json({ query: { pages: url.searchParams.get("titles").split("|").map((title) =>
      title === "Nvidia" ? {
        ns: 0, pageid: 40, title, pageimage: "Nvidia logo.svg", pageprops: { wikibase_item: "Q182477" },
        terms: { description: ["American multinational technology company"] },
      } : { ns: 0, title, missing: true }) } });
    if (url.hostname === "www.wikidata.org") return Response.json({ data: { itemsById: [{ id: "Q182477", images: [] }] } });
    searched.push(url.searchParams.get("gsrsearch"));
    const page = commonsPhoto("File:NVIDIA Headquarters.jpg");
    page.index = 2;
    page.imageinfo[0].extmetadata.ImageDescription.value = "Nvidia headquarters in Santa Clara, California";
    const product = commonsPhoto("File:NVIDIA Graphics card.jpg");
    product.index = 1;
    product.imageinfo[0].extmetadata.ImageDescription.value = "Nvidia graphics card";
    return Response.json({ batchcomplete: true, query: { pages: [page, product] } });
  });
  const headline = "Nvidia's accounting is a focus of US SEC investigation";
  const snapshot = {
    topics: [{ id: "story:investigation", label: headline, kind: "story", pageIds: ["a", "b"] }],
    pages: [{ id: "a", title: headline }, { id: "b", title: "US SEC's Nvidia probe is examining potential accounting issues – sources" }],
  };
  await addTopicArtwork(db, snapshot, now);
  assert.equal(snapshot.topics[0].image?.subject, "Nvidia");
  assert.equal(snapshot.topics[0].image.source, "https://commons.wikimedia.org/wiki/File:NVIDIA_Headquarters.jpg");
  assert(searched.some((search) => search?.includes('intitle:"nvidia"') && search.includes('intitle:"headquarters"')));
});

test("a previous negative cache entry gets a new lookup without discarding an earlier image on outage", async (t) => {
  const db = await database(t);
  await db.batch([
    db.prepare("INSERT INTO topic_artwork VALUES (?, ?, ?)").bind("steam machine", JSON.stringify({ image: photo, description: "" }), now + 86_400_000),
    db.prepare("INSERT INTO topic_artwork VALUES (?, ?, ?)").bind("grapheneos", "null", now + 86_400_000),
  ]);
  const calls = [];
  t.mock.method(globalThis, "fetch", async (address) => {
    calls.push(new URL(address).searchParams.get("titles"));
    return new Response(null, { status: 503 });
  });
  const snapshot = {
    topics: [
      { id: "steam", label: "Steam Machine", pageIds: ["steam"], kind: "topic" },
      { id: "os", label: "GrapheneOS", pageIds: ["os"], kind: "topic" },
    ],
    pages: [{ id: "steam", title: "Steam Machine" }, { id: "os", title: "GrapheneOS" }],
  };
  await addTopicArtwork(db, snapshot, now);
  assert.deepEqual(snapshot.topics[0].image, photo);
  assert(calls.some((titles) => titles?.split("|").includes("GrapheneOS")));
});

test("artwork leaves incidental places, comparison products, and source-only headings empty", async (t) => {
  const db = await database(t);
  const wiki = new Map([
    ["New Jersey", { ns: 0, title: "New Jersey", pageimage: "New Jersey shorebird.jpg", terms: {
      description: ["state in the northeastern United States"],
    } }],
    ["DDR5", { ns: 0, title: "DDR5 SDRAM", pageimage: "DDR5 SDRAM module.jpg", terms: {
      description: ["type of synchronous dynamic random-access memory"], alias: ["DDR5"],
    } }],
    ["YouTube", { ns: 0, title: "YouTube", pageimage: "YouTube search results.jpg", terms: {
      description: ["online video sharing platform"],
    } }],
  ]);
  t.mock.method(globalThis, "fetch", async (address) => {
    const url = new URL(address);
    const titles = url.searchParams.get("titles").split("|");
    if (url.hostname === "en.wikipedia.org") return Response.json({ query: {
      redirects: [{ from: "DDR5", to: "DDR5 SDRAM" }],
      pages: titles.map((title) => wiki.get(title) || { ns: 0, title, missing: true }),
    } });
    return Response.json({ query: { pages: titles.map((title) => commonsPhoto(title)) } });
  });
  const headings = [
    "Ford, Honda, Stellantis, VW sue New Jersey to block vehicle repair law",
    "DDR6 RAM shrinks by 44% while delivering 4X DDR5's baseline bandwidth",
    "- YouTube",
  ];
  const snapshot = {
    topics: headings.map((label, id) => ({ id, label, kind: "story", pageIds: [id] })),
    pages: headings.map((title, id) => ({ id, title })),
  };
  await addTopicArtwork(db, snapshot, now);
  assert.deepEqual(snapshot.topics.map(({ image }) => image), [undefined, undefined, undefined]);
});

test("an exact country topic keeps its Wikimedia image without requiring geography terms from its members", async (t) => {
  const db = await database(t);
  const file = "File:Iran - Location Map (2013) - IRN - UNOCHA.svg";
  t.mock.method(globalThis, "fetch", async (address) => {
    const url = new URL(address);
    if (url.hostname === "en.wikipedia.org") return Response.json({ query: { pages: [{
      ns: 0, title: "Iran", pageprops: { wikibase_item: "Q794" }, pageimage: "Flag of Iran (official).svg",
      terms: { description: ["country in Western Asia"] },
    }] } });
    if (url.hostname === "www.wikidata.org") return Response.json({ data: { itemsById: [{
      id: "Q794", images: [{ rank: "NORMAL", value: { content: file.slice("File:".length) } }],
    }] } });
    const page = commonsPhoto(file);
    page.imageinfo[0].thumburl = "https://thumb.wikimedia.org/wikipedia/commons/thumb/8/84/Iran_-_Location_Map.svg/640px-Iran_-_Location_Map.svg.png";
    return Response.json({ query: { pages: [page] } });
  });
  const snapshot = {
    topics: [{ id: "topic:iran", label: "Iran", pageIds: ["a", "b"], kind: "topic" }],
    pages: [{ id: "a", title: "Diplomats return to Iran after a summit" }, { id: "b", title: "Flights across Iran resume" }],
  };
  await addTopicArtwork(db, snapshot, now);
  assert.equal(snapshot.topics[0].image?.subject, "Iran");
  assert.match(snapshot.topics[0].image?.url, /Iran_-_Location_Map/);
});

test("a scheduled refresh publishes Commons artwork with author and license for an exact public topic", async (t) => {
  const db = await database(t);
  t.mock.method(Date, "now", () => now);
  const requested = [];
  const reportedAt = new Date(now).toISOString();
  t.mock.method(globalThis, "fetch", async (address, options) => {
    const url = new URL(address);
    if (url.hostname === "hn.algolia.com") return Response.json({ hits: [{
      objectID: "1", title: "Steam Machine", url: "https://publisher.example/steam",
      created_at: reportedAt, num_comments: 11,
    }] });
    if (url.hostname === "lobste.rs") return Response.json([{
      short_id: "11", title: "Steam Machine", url: "https://publisher.example/steam",
      comments_url: "https://lobste.rs/s/11", created_at: reportedAt, comment_count: 7,
    }]);
    if (url.hostname === "lemmy.world") return Response.json({ posts: [] });
    if (url.hostname === "public.api.bsky.app") return Response.json({ feed: [] });
    requested.push([url, options]);
    if (url.hostname === "en.wikipedia.org") return Response.json({ query: { pages: [{
      pageid: 41754507, ns: 0, title: "Steam Machine", pageimage: "Steam_Machine.jpg",
      pageprops: { wikibase_item: "Q2192804" },
      terms: { description: ["Valve's video game console"] },
    }] } });
    if (url.hostname === "commons.wikimedia.org") return Response.json({ query: { pages: [commonsPhoto()] } });
    return new Response(null, { status: 503 });
  });
  const env = {
    TOPICS_DB: db,
    AI: { run: async (model, { text }) => {
      assert.equal(model, "@cf/baai/bge-small-en-v1.5");
      return { data: text.map(() => [1, ...Array(383).fill(0)]) };
    } },
  };
  await worker.scheduled({}, env);
  const index = await (await worker.fetch(new Request("https://topics.test/api/topics"), env)).json();
  assert.equal(index.version, 1);
  assert.deepEqual(index.topics.map(({ image }) => image), [photo]);
  assert(index.topics.every((topic) => !Object.hasOwn(topic, "illustration")));
  assert.equal((await worker.fetch(new Request("https://topics.test/api/topic-illustrations/" + "4d".repeat(32)), env)).status, 404);
  assert.deepEqual(index.pages[0].posts, [["hn:1", 11], ["lobsters:11", 7]]);
  assert.deepEqual(requested.map(([url]) => url.hostname), ["en.wikipedia.org", "commons.wikimedia.org"]);
  assert(requested.every(([, options]) => options.redirect === "manual"));
  assert.equal(requested[0][0].searchParams.get("pilicense"), "free");
  assert.equal(requested[0][0].searchParams.get("titles"), "Steam Machine");
  assert.match(new Headers(requested[0][1].headers).get("User-Agent"), /Backchannel.*https:\/\//);
});
