import assert from "node:assert/strict";
import test from "node:test";
import * as articleModule from "../../topics/article.mjs";

const { buildTopicArticle } = articleModule;
const now = "2026-11-23T12:00:00.000Z";
const topic = { id: "story:harbor", label: "Harbor footbridge repairs" };
const bridge = {
  url: "https://harbor.example.org/bridge-repairs", title: "Bridge crew returns",
  description: "A commenter thinks the council has already sold the bridge.",
  postedAt: "2026-11-22T16:00:00Z",
  posts: [{ url: "https://news.ycombinator.com/item?id=9", source: "hn", title: "A new bridge?", comments: 4,
    postedAt: "2026-11-22T10:00:00Z" }],
};
const ferry = { url: "https://coast.example.org/ferry", title: "Harbor ferry extension", posts: [],
  postedAt: Date.parse("2026-11-21T10:00:00Z") };
const bridgeDeck = "Harbor crews will replace the eastern deck before the footbridge can reopen.";
const ferryHours = "The ferry will keep its evening service until repairs at the footbridge are finished.";
const bridgeTitle = "Harbor crews to replace eastern bridge deck";
const ferryTitle = "Ferry extends evening service through bridge repairs";
const bridgeHTML = `<meta property="og:site_name" content="Harbor Gazette"><meta content="${bridgeTitle}" property="og:title">
  <meta name="description" content="${bridgeDeck}"><meta property="article:published_time" content="2026-11-20T15:00:00-05:00">
  <article><p>On November 19, 2026, engineers closed the footbridge after inspecting its eastern deck.</p></article>`;
const ferryHTML = `<script type="application/ld+json">${JSON.stringify({ "@graph": [
  { "@type": "Organization", name: "Other Company", datePublished: "1999-10-03" },
  { "@type": "NewsArticle", headline: ferryTitle, description: ferryHours, publisher: { "@type": "Organization", name: "Coast Ledger" },
    datePublished: "2026-11-21", dateModified: "2026-11-22T20:00:00Z" },
] })}</script>`;
const html = (body) => new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8" } });
const fetcher = async (url) => html(String(url) === bridge.url ? bridgeHTML : ferryHTML);
const point = (text, sourceId, quote) => ({ text, evidence: [{ sourceId, quote }] });
const draft = () => ({
  sections: [{ heading: "Repairs and the crossing", paragraphs: [{ sentences: [
    point("The eastern deck needs replacing before the harbor footbridge can reopen.", "s1", bridgeDeck),
    point("The ferry is keeping evening service through the footbridge repairs.", "s2", ferryHours),
  ] }] }],
  events: [{ date: "2026-11-19", ...point("Engineers closed the footbridge after inspecting the eastern deck.", "s1",
    "On November 19, 2026, engineers closed the footbridge after inspecting its eastern deck.") }],
});
async function generate(options, pages = [bridge, ferry]) {
  const statuses = [];
  const article = await buildTopicArticle(topic, pages, { now, ...options, onStatus: (status) => statuses.push(status) });
  assert.equal(statuses.length, 1);
  return { article, status: statuses[0] };
}

test("writes a cited brief from two publisher documents and dates the event separately from publication and sharing", async () => {
  let input;
  const ai = { async run(model, options) {
    assert.match(model, /@cf\/.+instruct/);
    input = options;
    return { response: draft() };
  } };
  const { article, status } = await generate({ fetcher, ai });
  assert.equal(status, "synthesis");
  assert.equal(article.version, 1);
  assert.deepEqual(article.topic, topic);
  assert.equal(article.generatedAt, now);
  assert.equal(article.method, "synthesis");
  assert.deepEqual(article.sections, [{ heading: "Repairs and the crossing", paragraphs: [{
    text: "The eastern deck needs replacing before the harbor footbridge can reopen. The ferry is keeping evening service through the footbridge repairs.",
    sourceIds: ["s1", "s2"], citations: [{ sourceId: "s1", excerpt: bridgeDeck }, { sourceId: "s2", excerpt: ferryHours }],
  }] }]);
  assert.deepEqual(article.sources[0], {
    id: "s1", url: bridge.url, title: bridgeTitle, publisher: "Harbor Gazette", excerpt: bridgeDeck,
    publishedAt: "2026-11-20T20:00:00.000Z", sharedAt: "2026-11-22T10:00:00.000Z",
    discussions: [{ title: "A new bridge?", source: "hn", url: bridge.posts[0].url, comments: 4 }],
  });
  assert.equal(article.sources[1].publisher, "Coast Ledger");
  assert.deepEqual(article.timeline.map(({ kind, date, sourceIds }) => [kind, date, sourceIds]), [
    ["event", "2026-11-19T00:00:00.000Z", ["s1"]],
  ]);
  assert.match(input.messages.at(-1).content, /Harbor crews/);
  assert.match(article.timeline[0].citations[0].excerpt, /November 19, 2026, engineers closed/);
  assert.doesNotMatch(input.messages.at(-1).content, /sold the bridge|ycombinator|https?:\/\/|new bridge\?/i);
  assert.equal(input.response_format.type, "json_schema");
  assert(input.max_tokens <= 2600);
});

test("rejects ungrounded prose and preserves the attributed source excerpts", async (t) => {
  const cases = [
    ["unknown source", (s) => { s.evidence[0].sourceId = "s99"; }],
    ["quote from the other source", (s) => { s.evidence[0].quote = ferryHours; }],
    ["missing quote", (s) => { s.evidence = []; }],
    ["unsupported vote total", (s) => { s.text += " The board approved 23 changes."; }],
    ["unrelated claim with a real quote", (s) => { s.text = "The mayor bought beachfront property."; }],
    ["invented link", (s) => { s.text += " See https://different.example.org."; }],
  ];
  for (const [name, change] of cases) await t.test(name, async () => {
    const invalid = draft();
    change(invalid.sections[0].paragraphs[0].sentences[0]);
    const { article, status } = await generate({ fetcher, ai: { run: async () => ({ response: invalid }) } });
    assert.equal(status, "rejected");
    assert.equal(article.method, "coverage");
    assert(article.sections.every(({ paragraphs }) => paragraphs.every(({ citations }) =>
      citations.every(({ sourceId, excerpt }) => (sourceId === "s1" ? bridgeHTML : ferryHTML).includes(excerpt)))));
    assert.equal(article.sections[0].paragraphs.length, 1);
    assert(article.sections[0].paragraphs[0].citations.length);
    assert.doesNotMatch(JSON.stringify(article.sections), /23 changes|beachfront|different\.example/);
    assert(article.timeline.every(({ kind }) => kind === "event"));
  });
});

test("drops an invented or misdated event while preserving a supported brief", async () => {
  const badDate = draft();
  badDate.events[0].date = "2026-11-22";
  const { article, status } = await generate({ fetcher, ai: { run: async () => ({ response: JSON.stringify(badDate) }) } });
  assert.equal(status, "synthesis");
  assert(article.timeline.every(({ kind, date }) => kind === "event" && date !== "2026-11-22T00:00:00.000Z"));
});

test("listing titles and submitter descriptions cannot stand in for publisher reporting", async () => {
  const { article, status } = await generate({ fetcher: async () => html("<title>Just a moment...</title>"),
    ai: { run() { assert.fail("headline-only sources cannot produce a synthesis"); } } });
  assert.equal(status, "insufficient");
  assert.equal(article.method, "coverage");
  assert.equal(article.sources[0].publishedAt, null);
  assert.match(article.sources[0].excerpt, /public listing/i);
  assert.match(article.sources[0].excerpt, /A commenter thinks/);
  assert.deepEqual(article.sections, []);
  assert.deepEqual(article.timeline, []);
  assert.deepEqual(article.sources.map(({ sharedAt }) => sharedAt), ["2026-11-22T10:00:00.000Z", "2026-11-21T10:00:00.000Z"]);
});

test("classifies transient publisher and inference failures for bounded Worker retries", async () => {
  const { status } = await generate({ fetcher: async () => new Response(null, { status: 503 }) });
  assert.equal(status, "unavailable");
  const { article, status: modelStatus } = await generate({ fetcher, ai: { run() { throw Error("temporarily busy"); } } });
  assert.equal(modelStatus, "unavailable");
  assert.equal(article.method, "coverage");
  assert.equal(article.sources[1].excerpt, ferryHours);
});

test("multiple share URLs and threads preserve one original document and its earliest observed date", async () => {
  const url = "https://www.nytimes.com/2026/11/19/city/crews-repair-harbor-footbridge.html";
  let requests = 0;
  const { article, status } = await generate({ fetcher: async () => { requests++; return html(bridgeHTML); } }, [
    { ...bridge, url: url + "?smid=one", firstPostedAt: "2026-11-19T12:00:00Z" },
    { ...bridge, url: url + "?unlocked_article_code=two", posts: [...bridge.posts,
      { url: "https://lobste.rs/s/abcd/bridge", title: "Bridge repairs", source: "lobsters", comments: null }] },
  ]);
  assert.equal(article.sources.length, 1);
  assert.equal(article.sources[0].discussions.length, 2);
  assert.equal(article.sources[0].sharedAt, "2026-11-19T12:00:00.000Z");
  assert.equal(requests, 1);
  assert.notEqual(status, "synthesis");
});

test("only fetches published public article URLs and never follows an off-site or private redirect", async () => {
  const urls = [];
  const fetcher = async (url, options) => {
    urls.push(String(url));
    assert.equal(options.redirect, "manual");
    const headers = new Headers(options.headers);
    assert.equal(headers.has("cookie") || headers.has("authorization"), false);
    return new Response(null, { status: 302, headers: { location: String(url) === bridge.url
      ? "https://metadata.google.internal/secret" : "https://redirect.example.org/new-story" } });
  };
  const unsafe = ["http://127.0.0.1/private", "http://0x7f000001/secret", "http://[::1]/thing", "https://printer.local/path",
    "https://guest:password@real.example.org/x", "https://public.example.org:8080/x", "data:text/plain,hello"];
  const { article } = await generate({ fetcher }, [...unsafe.map((url) => ({ ...bridge, url })), bridge, ferry,
    { url: bridge.posts[0].url, title: "Ask HN", description: "This is the submitter's post", posts: bridge.posts }]);
  assert.deepEqual(urls.sort(), [bridge.url, ferry.url].sort());
  assert.equal(article.sources.length, 3);
});

test("clips metadata reads and emitted excerpts and omits raw markup, scripts, and modified-only dates", async () => {
  let cancelled = false;
  let reads = 0;
  const body = new ReadableStream({
    pull(controller) {
      const title = '<!--<meta property="og:title" content="Wrong title">--><script>const f = \'<meta property="og:title" content="Injected title">\';</script>';
      const meta = '<meta name="description" content="The eastern &amp; western piers will reopen once ' + 'the frame is secured '.repeat(90) + '"><meta property="article:modified_time" content="2026-10-10">';
      const prefix = reads++ === 0 ? title + meta + "<title>New harbor crossing</title>" : "";
      controller.enqueue(new TextEncoder().encode(prefix + " ".repeat(96 * 1024)));
      if (reads > 16) { controller.close(); }
    }, cancel() { cancelled = true; },
  });
  const { article } = await generate({ fetcher: async () => new Response(body, { headers: { "content-type": "text/html" } }) }, [bridge]);
  assert(cancelled);
  assert(reads < 16);
  assert.equal(article.sources[0].title, "New harbor crossing");
  assert.equal(article.sources[0].publishedAt, null);
  assert.match(article.sources[0].excerpt, /eastern & western/);
  assert(article.sources[0].excerpt.length <= 280);
  assert.doesNotMatch(JSON.stringify(article), /<meta|Injected title|Wrong title/);
});

test("uses article paragraphs beyond the publisher's presentation code and discards timestamp-only bylines", async () => {
  const report = '<meta property="og:type" content="article"><meta property="og:title" content="Harbor deck reopens">';
  const byline = '<meta property="og:description" content="Alex RiversNov 22, 2026, 10:00 AM ET">';
  const published = '<meta property="article:published_time" content="2026-11-21T12:15:00+0000">';
  const body = '<div data-module="ArticleBody"><p>Alex Rivers Nov 22, 2026, 10:00 AM ET</p><p>Both harbor piers reopened after engineers finished repairing the bridge deck.</p></div>';
  const page = '<style>' + "a { color: gray } ".repeat(33_000) + "</style>" + report + byline + published + body;
  const { article } = await generate({ fetcher: async () => html(page) }, [bridge]);
  assert.equal(article.sources[0].publishedAt, "2026-11-21T12:15:00.000Z");
  assert.equal(article.sources[0].excerpt, "Both harbor piers reopened after engineers finished repairing the bridge deck.");
  assert(!JSON.stringify(article).includes("Rivers"));
});

test("the central claim must draw on an article passage even if the title is genuine", async () => {
  const onlyHeadlines = draft();
  onlyHeadlines.sections[0].paragraphs[0].sentences = [
    point("Harbor crews plan to replace the eastern deck.", "s1", bridgeTitle),
    point("The ferry extends evening service through the bridge repairs.", "s2", ferryTitle),
  ];
  const result = await generate({ fetcher, ai: { run: async () => ({ response: onlyHeadlines }) } });
  assert.equal(result.status, "rejected");
});

test("a real sentence cannot be followed by an unsupported claim using the same evidence", async () => {
  const invalid = draft();
  invalid.sections[0].paragraphs[0].sentences[0].text += " Volunteers stole equipment.";
  const result = await generate({ fetcher, ai: { run: async () => ({ response: invalid }) } });
  assert.equal(result.status, "rejected");
});

test("a news roundup contributes attributed facts without advertising its own coverage", async () => {
  const roundup = '<meta property="og:title" content="Footbridge closes after harbor inspection"><meta property="og:site_name" content="Press Digest">' +
    '<meta property="og:description" content="How Harbor Gazette and Coast Ledger are reporting this story, with a timeline of each update and links to every original article.">' +
    '<article><p>Compiled from 3 independent publishers Harbor Gazette · Coast Ledger · Daily Bulletin.</p>' +
    '<p>The harbor footbridge closed after inspectors found cracks in its eastern deck.</p></article>';
  let input;
  const { article } = await generate({ fetcher: async (u) => html(String(u) === bridge.url ? roundup : ferryHTML),
    ai: { run: async (_, options) => { input = options.messages[1].content; return {}; } } });
  assert.match(article.sources[0].excerpt, /cracks in its eastern deck/);
  assert.equal(article.sections[0].paragraphs.length, 1);
  assert.doesNotMatch(article.sections[0].paragraphs[0].text, /Compiled from|timeline of each update/);
  assert.match(input, /roundup/i);
  assert.doesNotMatch(input, /Compiled from|timeline of each update/);
});

test("a completed transaction headline cannot override a cited report that says closing is still expected", async () => {
  const contract = "Orchard has bought up another distributor. The company agreed to pay $3.68 billion for Cedar.";
  const pending = "Cedar agreed to sell its distribution unit to Orchard for $3.68 billion. The deal is set to close in early 2027.";
  const documents = ['<title>Orchard buys Cedar</title><meta name="description" content="' + contract + '">',
    '<title>Orchard to buy Cedar for $3.68 billion</title><meta name="description" content="' + pending + '">'];
  const model = (text) => ({ run: async () => ({ response: { sections: [{ heading: "The agreement", paragraphs: [{ sentences: [
    { text, evidence: [{ sourceId: "s1", quote: "Orchard has bought up another distributor" },
      { sourceId: "s2", quote: "Cedar agreed to sell its distribution unit to Orchard for $3.68 billion" }] },
  ] }] }], events: [] } }) });
  const fetcher = async (url) => html(documents[String(url) === bridge.url ? 0 : 1]);
  const invalid = await generate({ fetcher, ai: model("Orchard has acquired Cedar for $3.68 billion.") });
  assert.equal(invalid.status, "rejected");
  const valid = await generate({ fetcher, ai: model("Orchard has agreed to acquire the Cedar distribution unit for $3.68 billion.") });
  assert.equal(valid.status, "synthesis");
});

test("a pending target is excluded from the buyer's holdings while the supported agreement, prices and second source survive", async () => {
  const agreement = "Intuit agreed to sell marketing subsidiary Mailchimp to Bending Spoons for $3.68 billion. The deal is expected to close in early 2027.";
  const price = "Intuit paid $12 billion for Mailchimp in 2021 and is unloading it for less than one-third of that price.";
  const portfolio = "The Bending Spoons portfolio also contains AOL, Eventbrite and Vimeo.";
  const history = "Bending Spoons has become a clearinghouse for web properties and picked up AOL, Eventbrite, Airtable and Miro last year.";
  const fetcher = async (url) => html("<title>The Mailchimp agreement</title><article>" +
    (url === bridge.url ? [history] : [agreement, price, portfolio]).map((p) => "<p>" + p + "</p>").join("") + "</article>");
  const ref = (text, sourceId, passage) => ({ text, evidence: [{ sourceId, passage }] });
  const agreementPoint = ref("Intuit agreed to sell Mailchimp to Bending Spoons for $3.68 billion.", "s2", "p1");
  const pricePoint = ref("Intuit paid $12 billion for Mailchimp in 2021, more than the agreed sale price.", "s2", "p2");
  const background = { text: "Bending Spoons has a portfolio that includes AOL, Eventbrite, Airtable, and Miro, in addition to Mailchimp.",
    evidence: [{ sourceId: "s1", passage: "p1" }, { sourceId: "s2", passage: "p3" }] };
  const section = (heading, sentence) => ({ heading, paragraphs: [{ sentences: [sentence] }] });
  const first = [section("The agreement", agreementPoint), section("Earlier purchase", pricePoint)];
  const run = (sentences) => generate({ fetcher, ai: { run: async () => ({ response: { sections: sentences, events: [] } }) } });
  const result = await run([...first, section("The portfolio", background)]);
  assert.equal(result.status, "synthesis");
  const points = result.article.sections.flatMap((s) => s.paragraphs);
  assert.deepEqual(points.slice(0, 2).map((p) => p.text), [agreementPoint.text, pricePoint.text]);
  assert.doesNotMatch(points.slice(2).map((p) => p.text).join(" "), /Mailchimp/);
  assert.deepEqual([...new Set(points.flatMap((p) => p.sourceIds))].sort(), ["s1", "s2"]);

  // The unsalvageable ownership claim can be dropped when an independent source already supports the brief.
  const historical = ref("Bending Spoons picked up AOL and Eventbrite last year.", "s1", "p1");
  const owned = { ...background, text: "Bending Spoons now owns Mailchimp and has a portfolio of web properties." };
  const trimmed = await run([...first, section("Prior holdings", historical), section("Present ownership", owned)]);
  assert.equal(trimmed.status, "synthesis");
  assert.deepEqual(trimmed.article.sections.map((s) => s.heading), ["The agreement", "Earlier purchase", "Prior holdings"]);
  assert.equal((await run([...first, section("Present ownership", owned)])).status, "rejected");
});

test("a bounded source note can preserve the event at the end of a short sentence", async () => {
  const fact = "The harbor crews, who spent the winter monitoring progress on both concrete piers while specialist teams reinforced the steel beneath the eastern span, reopened the footbridge on Friday.";
  const { article } = await generate({ fetcher: async () => html('<title>Harbor reopens</title><meta name="description" content="' + fact + '">') }, [bridge]);
  assert.equal(article.sources[0].excerpt, fact);
});

test("one richly documented article can produce an explicitly attributed brief even with several discussions", async () => {
  const page = bridgeHTML.replace("</article>", "<p>During repairs the council will operate a shuttle between the harbor entrances, with extra stops at the market and the docks so that workers can make their evening connections.</p></article>");
  const response = { sections: [{ heading: "The eastern deck", paragraphs: [{ sentences: [
    point("The Harbor Gazette reports that the eastern deck must be replaced before the footbridge reopens.", "s1", bridgeDeck),
  ] }] }], events: [] };
  const result = await generate({ fetcher: async () => html(page), ai: { run: async () => ({ response }) } }, [bridge]);
  assert.equal(result.status, "synthesis");
  assert.equal(result.article.sources.length, 1);
  assert.doesNotMatch(JSON.stringify(result.article.sections), /independen|several|multiple/);
  response.sections[0].paragraphs[0].sentences[0].text = "The eastern deck must be replaced before the footbridge reopens.";
  const unattributed = await generate({ fetcher: async () => html(page), ai: { run: async () => ({ response }) } }, [bridge]);
  assert.equal(unattributed.status, "rejected");
});

test("a publisher's share timestamp cannot authorize an impossible publication date", async () => {
  const { article } = await generate({ fetcher: async () => html(bridgeHTML.replace("2026-11-20T15:00:00-05:00", "2026-02-31T15:00:00Z")) }, [bridge]);
  assert.equal(article.sources[0].publishedAt, null);
  assert(article.timeline.every(({ kind }) => kind === "event"));
});

test("passage citations resolve to the server's verbatim text and never to a model-created identifier", async () => {
  const direct = draft();
  const claims = direct.sections[0].paragraphs[0].sentences;
  claims[0].evidence = [{ sourceId: "s1", passage: "p1" }];
  claims[1].evidence = [{ sourceId: "s2", passage: "p1" }];
  const ai = { run: async () => ({ response: direct }) };
  assert.equal((await generate({ fetcher, ai })).status, "synthesis");
  claims[0].evidence[0].passage = "p99";
  assert.equal((await generate({ fetcher, ai })).status, "rejected");
});

test("a rejected thin draft gets one bounded correction before falling back", async () => {
  const thin = draft();
  thin.sections[0].paragraphs[0].sentences.pop();
  let requests = 0;
  const ai = { run: async (_, input) => {
    if (++requests === 1) return { response: thin };
    assert.match(input.messages.at(-1).content, /second|two|multiple/i);
    return { response: draft() };
  } };
  assert.equal((await generate({ fetcher, ai })).status, "synthesis");
  assert.equal(requests, 2);
});

test("the source note on a claim quotes the referenced passage instead of the original's generic description", async () => {
  const full = draft();
  full.sections[0].paragraphs[0].sentences[0] = {
    text: "Engineers closed the footbridge after inspecting its eastern deck.",
    evidence: [{ sourceId: "s1", passage: "p2" }],
  };
  const { article } = await generate({ fetcher, ai: { run: async () => ({ response: full }) } });
  assert.match(article.sections[0].paragraphs[0].citations[0].excerpt, /engineers closed the footbridge/);
  assert.equal(article.sources[0].excerpt, bridgeDeck);
});

test("a copied headline welded to a publisher byline cannot become the article excerpt", async () => {
  const report = '<meta property="og:title" content="' + bridgeTitle + '"><meta property="og:description" content="' +
    bridgeTitle + ' Casey Ray, Harbor TIMESMon, November 23, 2026 at 3:33 PM UTC Harbor...">' +
    '<article><p>' + bridgeDeck + '</p></article>';
  const { article } = await generate({ fetcher: async () => html(report) }, [bridge]);
  assert.equal(article.sources[0].excerpt, bridgeDeck);
});

test("different dated milestones in one passage cannot exchange event dates", async () => {
  const page = bridgeHTML.replace("inspecting its eastern deck.</p>", "inspecting its eastern deck. On November 20, 2026, the ferry operator extended evening service.</p>");
  const mix = draft();
  mix.events[0].date = "2026-11-20";
  mix.events[0].evidence = [{ sourceId: "s1", passage: "p2" }];
  const { article } = await generate({ fetcher: async (url) => html(String(url) === bridge.url ? page : ferryHTML),
    ai: { run: async () => ({ response: mix }) } });
  assert.equal(article.method, "synthesis");
  assert.equal(article.timeline.filter((entry) => entry.kind === "event").length, 0);
});

test("the coverage brief leads with one publisher-backed finding, and keeps bare headlines and dates in Sources", async () => {
  const subject = { id: "story:singer", label: "Jordan Wells, Harbor Choir conductor, wins music prize" };
  const fact = "Jordan Wells, conductor of the Harbor Choir, won the national music prize for choral composition.";
  const pages = ["paper", "arts", "threads", "museum"].map((host) => ({
    url: "https://" + host + ".example.org/story", title: "Link label about Jordan Wells " + host, postedAt: now, posts: [],
  }));
  const documents = [
    '<title>Harbor Choir conductor awarded national prize</title><meta name="description" content="' + fact + '">',
    '<title>Prize jury recognizes Harbor Choir director</title><article><p>' + fact + '</p></article>',
    null,
    '<title>Jordan Wells, curator of the local museum, wins prize</title><article><p>Jordan Wells won the heritage prize for curating the museum exhibition about local mines.</p></article>',
  ];
  const fetcher = async (url) => {
    const doc = documents[pages.findIndex((page) => page.url === String(url))];
    return doc ? html(doc) : new Response(null, { status: 403 });
  };
  const article = await buildTopicArticle(subject, pages, { fetcher, now });
  assert.equal(article.method, "coverage");
  assert.equal(article.sources.length, 4);
  assert.equal(article.sections.length, 1);
  const [paragraph] = article.sections[0].paragraphs;
  assert.equal(article.sections[0].paragraphs.length, 1);
  assert.match(paragraph.text, /national music prize/);
  assert.deepEqual(paragraph.sourceIds, ["s1", "s2"]);
  assert.deepEqual(paragraph.citations.map((entry) => entry.sourceId), ["s1", "s2"]);
  assert.doesNotMatch(JSON.stringify(article.sections), /local mines|Link label|listed as|link to/i);
  assert.deepEqual(article.timeline, []);
  const wrongOnly = await buildTopicArticle(subject, [pages[3]], { fetcher, now });
  assert.deepEqual(wrongOnly.sections, []);
});

test("publication, sharing and repeated undated death notices never become event milestones", async () => {
  const subject = { id: "story:obituary", label: "Tom Jackson, Broncos star and ESPN legend, dies at 75" };
  const pages = ["league", "broadcast", "sports"].map((host, i) => ({ url: "https://" + host + ".example.org/jackson",
    title: "Broncos and ESPN veteran Tom Jackson dies at 75", postedAt: "2026-11-2" + i + "T12:00:00Z", posts: [] }));
  const source = '<title>Tom Jackson, former Broncos player and ESPN analyst, dies at 75</title>' +
    '<meta property="article:published_time" content="2026-11-22T12:00:00Z"><article><p>Tom Jackson, a former Broncos linebacker and longtime ESPN analyst, died at 75, the team announced.</p></article>';
  const article = await buildTopicArticle(subject, pages, { fetcher: async () => html(source), now });
  assert.equal(article.sections[0].paragraphs.length, 1);
  assert.match(article.sections[0].paragraphs[0].text, /Broncos linebacker/);
  assert.deepEqual(article.timeline, []);
  assert(article.sources.every(({ publishedAt }) => publishedAt === "2026-11-22T12:00:00.000Z"));
  const blocked = await buildTopicArticle(subject, pages, { fetcher: async () => new Response(null, { status: 403 }), now });
  assert.equal(blocked.sources.length, 3);
  assert.deepEqual(blocked.sections, []);
  assert.deepEqual(blocked.timeline, []);
});

test("a roundup comparing near-identical headlines cannot outrank the publisher's actual account", async () => {
  const subject = { id: "story:jackson", label: "Tom Jackson, Broncos star and ESPN legend, dies at 75" };
  const pages = ["digest", "league"].map((host) => ({ url: "https://" + host + ".example.org/jackson", posts: [] }));
  const roundup = '<title>Latest reports on Tom Jackson</title><meta property="og:site_name" content="Sports Digest">' +
    '<meta name="description" content="How several outlets are reporting this story, with a timeline of each update.">' +
    '<article><p>ABC News emphasises “Tom Jackson, Broncos star and ESPN legend, dies at 75”. CBS News leads with “Tom Jackson, former Broncos star, dies at 75”.</p></article>';
  const publisher = '<title>Denver remembers its former linebacker</title><meta property="og:site_name" content="League News">' +
    '<article><p>Tom Jackson, an All-Pro linebacker for the Broncos and an ESPN broadcaster, died Friday at the age of 75, Denver announced.</p></article>';
  const article = await buildTopicArticle(subject, pages, { now, fetcher: async (url) => html(String(url) === pages[0].url ? roundup : publisher) });
  const [paragraph] = article.sections.flatMap((section) => section.paragraphs);
  assert.deepEqual(paragraph.sourceIds, ["s2"]);
  assert.match(paragraph.text, /Denver announced/);
  assert.doesNotMatch(JSON.stringify(article.sections), /leads with|emphasises|Sports Digest/);
});

test("the coverage timeline can still identify separate, explicitly dated developments in the source text", async () => {
  const subject = { id: "story:footbridge", label: "Harbor footbridge repairs" };
  const page = '<title>Harbor bridge inspection</title><article><p>On November 18, 2026, harbor engineers closed the footbridge to inspect the deck.</p>' +
    '<p>On November 21, 2026, the harbor authority reopened the footbridge after the repairs.</p></article>';
  const article = await buildTopicArticle(subject, [bridge], { now, fetcher: async () => html(page) });
  assert.deepEqual(article.timeline.map(({ kind, date }) => [kind, date]), [
    ["event", "2026-11-18T00:00:00.000Z"], ["event", "2026-11-21T00:00:00.000Z"],
  ]);
  assert.match(article.timeline[1].citations[0].excerpt, /reopened the footbridge/);
});

test("a source retains twelve distinct selected discussions in their original order", () => {
  const posts = Array.from({ length: 14 }, (_, i) => ({ source: "hn", title: "Thread " + i,
    url: "https://news.ycombinator.com/item?id=" + (100 + i), comments: i }));
  const discussions = articleModule.articleDiscussions([posts[0], posts[0], ...posts.slice(1)]);
  assert.deepEqual(discussions.map(({ url }) => url), posts.slice(0, 12).map(({ url }) => url));
});

test("a readable original keeps its substantive lead when the rest of the topic is blocked", async () => {
  const subject = { id: "story:river", label: "River bridge repairs" };
  const live = '<title>Council approves repairs for the river bridge</title><meta name="description" content="City crews will replace the bridge deck. Work is scheduled to begin after the winter ferry season.">';
  const article = await buildTopicArticle(subject, [bridge, ferry], { now,
    fetcher: async (url) => String(url) === bridge.url ? html(live) : new Response(null, { status: 403 }) });
  assert.equal(article.sources.length, 2);
  assert.equal(article.sections[0].paragraphs.length, 1);
  assert.match(article.sections[0].paragraphs[0].text, /replace the bridge deck/);
  assert.deepEqual(article.sections[0].paragraphs[0].sourceIds, ["s1"]);
});

test("an office or initials do not separate the winning candidate from the person defeated", async () => {
  const label = "Chuck Hubbard defeats Rep. Virginia Foxx after a recount in their North Carolina House race";
  const whole = "Democrat Chuck Hubbard will unseat long-time GOP Rep. Virginia Foxx in North Carolina’s 5th Congressional District after Foxx conceded the race Sunday.";
  const page = '<title>Hubbard defeats Foxx in North Carolina</title><article><p>' + whole + '</p></article>';
  const article = await buildTopicArticle({ id: "story:district", label }, [bridge], { now, fetcher: async () => html(page) });
  const [lead] = article.sections.flatMap(({ paragraphs }) => paragraphs);
  assert(lead.text.includes(whole));
  assert.match(lead.citations[0].excerpt, /Chuck Hubbard will unseat long-time GOP Rep\. Virginia Foxx/);
  const named = "U.S. Rep. A. J. Carter defeated Dr. Erin Walker in the county election.";
  const second = await buildTopicArticle({ id: "story:county", label: "Carter defeats Walker in county election" }, [ferry],
    { now, fetcher: async () => html('<title>County election result</title><article><p>' + named + '</p></article>') });
  assert(second.sections[0].paragraphs[0].text.includes(named));
});

test("a datelined image caption, including one showing a person moving, is never a milestone", async () => {
  const topic = { id: "story:summit", label: "U.N. climate talks collapse over fossil fuels" };
  const lead = "Countries failed to reach a major climate agreement after weeks of talks over fossil fuels.";
  const caption = "COP31 President Murat Kurum, center, leaves a closing plenary session at the U.N. Climate Summit, Sunday, Nov. 22, 2026, in Antalya, Turkey.";
  const page = '<title>Climate talks end without a main agreement</title><article><p>' + lead + '</p><div class="credit-caption"><div class="caption-wrap">' +
    '<p>' + caption + '<b class="credit">AP Photo</b></p></div></div><p>Climate Summit, Sunday, Nov. 22, 2026, in Antalya, Turkey.</p></article>';
  const article = await buildTopicArticle(topic, [bridge], { now, fetcher: async () => html(page) });
  assert(article.sections[0].paragraphs[0].text.includes(lead));
  assert.deepEqual(article.timeline, []);
});

test("documented substance determines an event's date when a neighboring caption gives a different date", async () => {
  const page = bridgeHTML.replace("inspecting its eastern deck.</p>", "inspecting its eastern deck. Harbor footbridge inspection, Nov. 20, 2026, in Eastport.</p>");
  const fabricated = draft();
  fabricated.events[0] = { date: "2026-11-20", text: "Harbor engineers inspected the eastern footbridge deck.", evidence: [{ sourceId: "s1", passage: "p2" }] };
  const { article } = await generate({ fetcher: async (url) => html(String(url) === bridge.url ? page : ferryHTML),
    ai: { run: async () => ({ response: fabricated }) } });
  assert.equal(article.method, "synthesis");
  assert.deepEqual(article.timeline, []);
});

test("prioritizes a named original behind duplicate links and uses its real article body instead of the ad or its reprint", async () => {
  const org = { id: "story:arts", label: "Aster Orchestra releases the Harbor Quartet programme" };
  const base = "https://aster.org/concerts/harbor-quartet-summer-programme";
  const credit = "Director Simon Dana said the quartet chose the archive recordings to document the original brass arrangement.";
  const detail = "Aster Orchestra commissioned four brass players to rehearse the harbor suite in the old auditorium before the public concert.";
  const original = '<title>Harbor quartet summer programme</title><meta property="og:site_name" content="Aster"><article class="ad-300"></article>' +
    '<article><div class="article-body"><p>' + detail + '</p><p>' + credit +
    '</p><p>The performers have scheduled an additional open rehearsal for their audience on the waterfront.</p></div></article>';
  const copied = '<title>Harbor quartet summer programme</title><meta property="og:site_name" content="Reprint">' +
    '<article><p>Aster Orchestra asked four brass players to rehearse the harbor suite in the old auditorium before the public concert.</p>' +
    '<p>Director Simon Dana said the quartet chose the archive recordings to document the original brass arrangement in full.</p></article>';
  const pages = Array.from({ length: 8 }, (_, i) => ({ url: "https://desk" + i + ".example.org/" +
    (i < 3 ? "harbor-quartet-summer-programme" : "district-report-" + i), title: i < 3 ? "Harbor quartet summer programme" : "Local arts report " + i, posts: [] }));
  pages.push({ url: base, title: "The orchestra’s summer season", posts: [] });
  const fetched = [];
  let input;
  const article = await buildTopicArticle(org, pages, { now, fetcher: async (url) => {
    fetched.push(String(url));
    return html(url === base ? original : /desk[0-2]\./.test(url) ? copied : '<title>Arts notice</title>');
  }, ai: { run: async (_, options) => { input = JSON.parse(options.messages[1].content); return { response: { sections: [{ heading: "The programme", paragraphs: [
    { sentences: [{ text: "Aster reports that Simon Dana chose the archive recordings to document the brass arrangement.", evidence: [{ sourceId: "s9", quote: credit }] }] },
  ] }], events: [] } }; } } });
  assert(fetched.includes(base));
  assert(fetched.length <= 8);
  assert.equal(article.sources.length, 9);
  assert.equal(article.method, "synthesis");
  assert.deepEqual(input.documents.map(({ id }) => id), ["s9"]);
  assert.match(JSON.stringify(input.documents), /original brass arrangement/);
  assert.deepEqual(article.sections[0].paragraphs[0].sourceIds, ["s9"]);
});

test("a price comparison alone does not establish a realized loss, and a failed main agreement is scoped to that agreement", async () => {
  const cases = [
    { a: "The company agreed to sell the division for less than a third of its original purchase price.", b: "The earlier purchase price was $12 billion, while the pending sale is valued at $3.68 billion.",
      bad: "The company will take a significant loss on the sale of the division.", good: "The division's proposed sale price is less than a third of its original purchase price." },
    { a: "Negotiators failed to reach a major agreement on the transition away from fossil fuels.", b: "Several decisions were adopted despite the failure of the main agreement at the climate talks.",
      bad: "Negotiators at the climate talks ended the summit without a deal.", good: "Negotiators at the climate talks failed to reach a major deal on the transition away from fossil fuels." },
  ];
  for (const item of cases) {
    const make = (text) => ({ sections: [{ heading: "The outcome", paragraphs: [{ sentences: [
      { text, evidence: [{ sourceId: "s1", passage: "p1" }, { sourceId: "s2", passage: "p1" }] },
    ] }] }], events: [] });
    const fetcher = async (url) => html('<title>Public account of the decision</title><article><p>' + (String(url) === bridge.url ? item.a : item.b) + '</p></article>');
    assert.equal((await generate({ fetcher, ai: { run: async () => ({ response: make(item.bad) }) } })).status, "rejected");
    assert.equal((await generate({ fetcher, ai: { run: async () => ({ response: make(item.good) }) } })).status, "synthesis");
  }
});

test("most discussed originals survive both caps regardless of input order, while reprints and repeat publishers share the fetch budget", async () => {
  const cold = Array.from({ length: 13 }, (_, i) => ({
    url: "https://desk" + i + ".org/transport", title: "Local transport coverage " + i, posts: [],
  }));
  const post = (id, comments) => ({ source: "hn", url: "https://news.ycombinator.com/item?id=" + id, comments });
  const hot = { url: "https://reporter.org/repairs", title: "Harbor footbridge reconstruction contract approved", posts: [post(30, 49), post(20, 60)] };
  const copy = { ...hot, url: "https://syndicate.org/repairs", posts: [post(40, 98)] };
  const repeated = { ...hot, url: "https://reporter.org/another-piece", title: "Traffic disruption report",
    posts: [post(50, 63), post(50, 63)] };
  const aggregated = { url: "https://engineers.org/findings", title: "Bridge engineering inspection",
    replyCount: 105, discussionCount: 17, posts: [post(60, 2)] };
  const unranked = { url: "https://news.ycombinator.com/item?id=4", posts: [post(4, 900)] };
  const input = [...cold, copy, repeated, unranked, hot, aggregated];
  const select = async (pages) => {
    const fetched = [];
    const article = await buildTopicArticle(topic, pages, { now, fetcher: async (url) => {
      fetched.push(url);
      return html(url === hot.url ? bridgeHTML : "<title>Publisher notice</title>");
    } });
    assert.equal(article.sources.length, 12);
    assert.equal(fetched.length, 8);
    assert.deepEqual(fetched.slice(0, 2), [hot.url, aggregated.url]);
    assert(!fetched.includes(copy.url) && !fetched.includes(repeated.url) && !fetched.includes(unranked.url));
    const cited = article.sections[0].paragraphs[0].sourceIds[0];
    assert.equal(article.sources.find(({ id }) => id === cited).url, hot.url);
    assert.deepEqual(articleModule.articleFetchKeys(topic, pages), fetched.map((url) => new URL(url).host + new URL(url).pathname));
    return fetched;
  };
  assert.deepEqual(await select(input), await select(input.toReversed()));
});

test("a publisher's detailed public article yields a cited lead and additional facts even during a model outage", async () => {
  const lead = "Harbor engineers closed the footbridge after corrosion weakened the eastern deck.";
  const cost = "The city council approved $4.2 million to replace the damaged steel beams.";
  const access = "The ferry operator added two late crossings for hospital staff during the repairs.";
  const unrelated = "The city council purchased a fleet of private helicopters for the mayor.";
  const first = '<meta property="og:type" content="article"><title>Harbor footbridge repairs begin</title>' +
    '<article class="promo"><p>Read our collection of headlines from around the world.</p></article>' +
    '<main><div data-testid="article-body"><p>' + lead + '</p><p>' + cost + '</p>' +
    '<aside><p>' + unrelated + '</p></aside></div></main><footer><p>' + unrelated + '</p></footer>';
  const second = '<title>Ferry changes during harbor footbridge repairs</title><article><p>' + access + '</p></article>';
  const { article, status } = await generate({ fetcher: async (url) => html(url === bridge.url ? first : second), ai: { run() { throw Error("offline"); } } });
  assert.equal(status, "unavailable");
  const body = article.sections.flatMap(({ paragraphs }) => paragraphs);
  assert.equal(article.method, "coverage");
  for (const [fact, id] of [[lead, "s1"], [cost, "s1"], [access, "s2"]]) {
    const paragraph = body.find(({ text }) => text.includes(fact));
    assert(paragraph, fact);
    assert.deepEqual(paragraph.citations, [{ sourceId: id, excerpt: fact }]);
  }
  assert.doesNotMatch(JSON.stringify(body), /private helicopters|collection of headlines|commenter/i);
});

test("reads past the opening of a flat schema.org articleBody and connects image references only to its cited article", async () => {
  const intro = "Harbor engineers closed the footbridge to rebuild the deck after inspecting each corroded joint.";
  const early = "The bridge project brought local steelworkers back to the harbor after a winter of delays.";
  const process = "Bridge workers measured the deck supports and placed braces beneath the damaged eastern span.";
  const last = "Harbor inspectors will publish the final load test before commuters can return to the bridge.";
  const first = '<script type="application/ld+json">' + JSON.stringify({ "@context": "https://schema.org", "@graph": [
    { "@type": "WebPage", "@id": bridge.url, mainEntity: { "@id": bridge.url + "#story" } },
    { "@type": "NewsArticle", "@id": bridge.url + "#story", mainEntityOfPage: { "@id": bridge.url },
      headline: "Harbor footbridge repairs begin", articleBody: [intro, early, process, early, last].join(" "),
      image: { "@id": bridge.url + "#main-image" }, publisher: { name: "Harbor Gazette" } },
    { "@type": "ImageObject", "@id": bridge.url + "#main-image", contentUrl: "/photos/harbor-span.jpg",
      caption: "Workers brace the eastern span.", width: 1200, height: 750 },
    { "@type": "NewsArticle", url: "https://another.org/fishing", headline: "Fishing update", image: "https://another.org/fish.jpg" },
  ] }) + '</script>';
  const other = '<meta property="og:site_name" content="Coast Ledger"><meta name="twitter:card" content="summary_large_image">' +
    '<meta property="og:image" content="https://cdn.coast.org/ferry.jpg"><meta property="og:image:alt" content="The ferry leaving the pier.">' + ferryHTML;
  let input;
  const { article, status } = await generate({ fetcher: async (url) => html(url === bridge.url ? first : other),
    ai: { run(_, options) {
      input = JSON.parse(options.messages[1].content);
      const source = input.documents.find(({ id }) => id === "s1");
      const end = Object.entries(source.passages).find(([, text]) => text.includes(last))?.[0];
      return { response: { sections: [{ heading: "Load tests and ferry crossings", paragraphs: [{ sentences: [
        { text: "Harbor inspectors will release a final load test before commuters return.", evidence: [{ sourceId: "s1", passage: end }] },
        point("The ferry is keeping evening service through the footbridge repairs.", "s2", ferryHours),
      ] }] }], events: [] } };
    } } });
  assert.match(JSON.stringify(input.documents), /publish the final load test/);
  assert.equal(status, "synthesis");
  assert.deepEqual(article.images, [
    { url: "https://harbor.example.org/photos/harbor-span.jpg", alt: "Workers brace the eastern span.", sourceId: "s1" },
    { url: "https://cdn.coast.org/ferry.jpg", alt: "The ferry leaving the pier.", sourceId: "s2" },
  ]);
  assert.doesNotMatch(JSON.stringify(input), /https?:\/\/|fishing|#main-image/);
});

test("only representative public HTTPS images associated with readable cited coverage can be displayed", async () => {
  const excluded = ["http://cdn.coast.org/deck.jpg", "https://printer.local/photo.jpg", "https://127.0.0.1/picture.jpg",
    "https://reader:secret@cdn.coast.org/story.jpg", "https://photos.coast.org:3000/bridge.jpg", "data:image/svg+xml,a",
    "https://cdn.coast.org/assets/news-logo.png", "https://cdn.coast.org/track/1x1.gif"];
  for (const src of excluded) {
    const { article } = await generate({ fetcher: async () => html('<meta property="og:image" content="' + src + '">' + bridgeHTML) }, [bridge]);
    assert.deepEqual(article.images, [], src);
  }
  const page = '<meta property="og:image" content="/logo.png"><meta property="og:image:width" content="64">' +
    '<meta property="og:image" content="/press/river.jpg"><meta property="og:image:width" content="1200">' + bridgeHTML;
  const { article } = await generate({ fetcher: async () => html(page) }, [bridge]);
  assert.deepEqual(article.images, [{ sourceId: "s1", url: "https://harbor.example.org/press/river.jpg", alt: "" }]);
  const unrelated = '<title>Weather forecast in the mountains</title><meta property="og:image" content="/weather.jpg">' +
    '<article><p>Climbers reached the summit at dawn after a cold night in the mountains.</p></article>';
  const sparse = await generate({ fetcher: async (url) => url === bridge.url ? new Response(null, { status: 403 }) : html(unrelated) });
  assert.deepEqual(sparse.article.images, []);
  assert.deepEqual(sparse.article.sections, []);
});

test("paywalled structured bodies, marked private snippets, and disallowed image previews stay outside reporting", async () => {
  const restricted = "Harbor engineers approved the secret underwater rail project after reviewing private documents.";
  const paid = '<script type="application/ld+json">' + JSON.stringify({ "@type": "NewsArticle", headline: bridgeTitle,
    isAccessibleForFree: "False", description: bridgeDeck, articleBody: restricted, image: "https://cdn.coast.org/secret.jpg" }) +
    '</script><article><div data-nosnippet><p>' + restricted + '</p></div></article>';
  const marked = '<title>Harbor footbridge repairs</title><meta name="robots" content="max-image-preview:none">' +
    '<meta property="og:image" content="/hero.jpg"><article><p>' + bridgeDeck + '</p><section data-nosnippet><p>' + restricted + '</p></section></article>';
  for (const doc of [paid, marked]) {
    const { article } = await generate({ fetcher: async () => html(doc) }, [bridge]);
    assert.doesNotMatch(JSON.stringify(article), /secret underwater/);
    assert.deepEqual(article.images, []);
    assert.match(JSON.stringify(article.sections), /eastern deck/);
  }
  const result = await generate({ fetcher: async () => new Response(bridgeHTML, { headers: { "content-type": "text/html", "x-robots-tag": "nosnippet" } }) }, [bridge]);
  assert.deepEqual(result.article.sections, []);
  assert.deepEqual(result.article.images, []);
});

test("syndicated copies sharing a third canonical URL cannot count as separate voices or supply multiple photos", async () => {
  const original = "https://wire.org/harbor-repairs";
  const sample = (heading, note, photo) => '<link rel="canonical" href="' + original + '"><title>' + heading +
    '</title><meta property="og:image" content="' + photo + '"><article><p>' + bridgeDeck + '</p><p>' + note + '</p></article>';
  const docs = [sample("Harbor repair crews move in", "Harbor engineers will inspect the joints when the tide recedes.", "/day-one.jpg"),
    sample("Deck replacement planned for November", "The ferry operators added an evening sailing for families on the eastern bank.", "/day-two.jpg")];
  const { article } = await generate({ fetcher: async (url) => html(docs[url === bridge.url ? 0 : 1]) });
  assert.deepEqual(article.sections[0].paragraphs[0].sourceIds, ["s1"]);
  assert.equal(article.images.length, 1);
  assert.equal(article.images[0].sourceId, "s1");
  assert.equal(article.sources.length, 2);
});

test("originals with the same summary but different firsthand details reach the synthesis together", async () => {
  const close = "Engineers closed the eastern span on November 19, 2026, after finding damaged steel.";
  const later = "Harbor crews will open a temporary walkway beside the ferry terminal on Friday.";
  const doc = (passage) => '<title>Harbor footbridge repair schedule</title><meta name="description" content="' +
    bridgeDeck + '"><article><p>' + passage + '</p></article>';
  const { article, status } = await generate({ fetcher: async (url) => html(doc(url === bridge.url ? close : later)),
    ai: { run: async () => ({ response: { sections: [{ heading: "Closing and alternate access", paragraphs: [{ sentences: [
      point("Engineers closed the eastern span after finding damaged steel.", "s1", close),
      point("Harbor crews plan a temporary walkway beside the ferry terminal.", "s2", later),
    ] }] }], events: [] } }) } });
  assert.equal(status, "synthesis");
  assert.deepEqual(article.sections[0].paragraphs[0].sourceIds, ["s1", "s2"]);
});

test("a temporary publisher failure keeps a partial synthesis retryable while readers retain its cited facts", async () => {
  const missing = { url: "https://letter.org/bridge", title: "Harbor repair drawings", replyCount: 800, posts: [] };
  const partial = await generate({ fetcher: async (url) => url === missing.url ? new Response(null, { status: 503 }) : fetcher(url),
    ai: { run: async () => ({ response: draft() }) } }, [bridge, ferry, missing]);
  assert.equal(partial.article.method, "synthesis");
  assert.equal(partial.status, "unavailable");
  const recovered = await generate({ fetcher: async (url) => url === missing.url ? html("<title>Public notice</title>") : fetcher(url),
    ai: { run: async () => ({ response: draft() }) } }, [bridge, ferry, missing]);
  assert.equal(recovered.status, "synthesis");
});

test("a short valid synthesis still carries specific unreported details from a well-documented original", async () => {
  const cost = "The city council approved $4.2 million to replace the damaged steel beams.";
  const crossings = "The ferry operator scheduled two extra crossings for hospital staff during the repairs.";
  const doc = bridgeHTML.replace("</article>", "<p>" + cost + "</p><p>" + crossings + "</p></article>");
  const answer = { sections: [{ heading: "Deck repairs", paragraphs: [{ sentences: [
    point("The Harbor Gazette reports that the eastern deck needs replacing before the footbridge reopens.", "s1", bridgeDeck),
  ] }] }], events: [] };
  const { article, status } = await generate({ fetcher: async () => html(doc), ai: { run: () => ({ response: answer }) } }, [bridge]);
  assert.equal(status, "synthesis");
  const paragraphs = article.sections.flatMap(({ paragraphs }) => paragraphs);
  assert.match(paragraphs[0].text, /needs replacing/);
  assert(paragraphs.some((p) => p.text.includes("$4.2 million") && p.citations.some((cite) => cite.excerpt === cost)));
  assert(paragraphs.every((p) => p.sourceIds.length));
});

test("site-wide social cards yield to the article's lead figure, with the publisher's own image description", async () => {
  const brand = '<meta property="og:site_name" content="NVIDIA Newsroom"><meta property="og:image" content="/media/sites/219/images/social-image.jpg">' +
    '<meta property="og:image:alt" content="NVIDIA Newsroom">';
  const figure = '<figure><picture><img src="/media/harbor-span.webp" alt="Steel supports beneath the old span."></picture></figure>';
  const { article } = await generate({ fetcher: async () => html(brand + bridgeHTML.replace("<article>", "<article>" + figure)) }, [bridge]);
  assert.deepEqual(article.images, [{ url: "https://harbor.example.org/media/harbor-span.webp", alt: "Steel supports beneath the old span.", sourceId: "s1" }]);
  const generic = await generate({ fetcher: async () => html(brand + bridgeHTML) }, [bridge]);
  assert.deepEqual(generic.article.images, []);
  const structured = '<script type="application/ld+json">' + JSON.stringify({ "@type": "NewsArticle", headline: bridgeTitle,
    image: "https://media.photos.org/harbor.webp" }) + '</script>';
  const described = await generate({ fetcher: async () => html(structured + '<meta property="og:image" content="https://media.photos.org/harbor.webp">' +
    '<meta property="og:image:alt" content="A crane lifts the first beam.">' + bridgeHTML) }, [bridge]);
  assert.equal(described.article.images[0].alt, "A crane lifts the first beam.");
});

test("live coverage contributes updates about this story when a longer article on the page covers another event", async () => {
  const cold = Array.from({ length: 6 }, (_, i) => '<p>Officers assigned a new patrol to the mountain district after survey number ' + i + '.</p>').join("");
  const budget = "Harbor officials approved a $7 million loan for the footbridge repairs at a council meeting.";
  const path = "Harbor staff opened an accessible footbridge detour for cyclists and wheelchair users.";
  const live = '<script type="application/ld+json">' + JSON.stringify({ "@type": "LiveBlogPosting", headline: "Harbor footbridge repairs",
    description: bridgeDeck }) + '</script><main><article>' + cold + '</article><article><p>' + budget + '</p></article>' +
    '<article><p>' + path + '</p></article></main>';
  const { article } = await generate({ fetcher: async () => html(live) }, [bridge]);
  const body = article.sections.flatMap(({ paragraphs }) => paragraphs).map(({ text }) => text).join(" ");
  assert.match(body, /\$7 million/);
  assert.match(body, /wheelchair users/);
  assert.doesNotMatch(body, /mountain district/);
});

test("follow-up paragraphs prefer new details in the original body to other publishers' opening recaps", async () => {
  const subject = { id: "story:maple", label: "Maple board reinstates Dana Shore as chief executive" };
  const announced = "Maple reinstated Dana Shore as chief executive after a board vote on Monday.";
  const restores = "Dana Shore was appointed to lead Maple again following a decision by the directors on Monday.";
  const returns = "The Maple board confirmed the return of Dana Shore to the role of chief executive.";
  const vote = "All nine directors signed the resolution after reviewing an independent audit.";
  const price = "Maple shares rose 18% after the board announced its decision.";
  const pages = [bridge, ferry, { url: "https://recorder.org/board", posts: [] }];
  const docs = [[announced, vote], [restores, price], [returns]];
  const article = await buildTopicArticle(subject, pages, { now, fetcher: async url => html('<title>' + subject.label +
    '</title><article>' + docs[pages.findIndex(p => p.url === url)].map(s=>'<p>'+s+'</p>').join('') + '</article>') });
  const details = article.sections.slice(1).flatMap(({ paragraphs }) => paragraphs).map(({ text }) => text);
  assert(details.some((text) => text.includes(vote)));
  assert(details.some((text) => text.includes(price)));
  assert(details.every((text) => !text.includes(restores) && !text.includes(returns) && !text.includes(announced)));
});

test("public discussion identity agrees with the displayed links and ignores unpublished or local inputs", () => {
  const post = { source: "hn", url: "https://news.ycombinator.com/item?id=19&utm_source=s" };
  assert.equal(articleModule.articleDiscussionKey(post), "news.ycombinator.com/item?id=19");
  for (const input of [{ ...post, source: " " }, { ...post, url: "https://intranet.local/board" }, undefined]) {
    assert.equal(articleModule.articleDiscussionKey(input), "");
    assert.deepEqual(articleModule.articleDiscussions([input]), []);
  }
});

test("the named primary announcement leads a live expert's speculation even when the analyst repeats the entire topic label", async () => {
  const subject = { id: "story:aster", label: "Aster reinstates Dana Shore as CEO, board says" };
  const primary = { url: "https://aster.org/news/leadership", posts: [] };
  const statement = "Aster reinstated Dana Shore as chief executive and a member of its board effective immediately.";
  const comment = "The Aster board must have been under enormous pressure to reinstate Dana Shore as CEO, says a former director.";
  const doc = (title, text) => '<title>' + title + '</title><article><p>' + text + '</p></article>';
  const article = await buildTopicArticle(subject, [bridge, primary], { now, fetcher: async url => html(
    url === primary.url ? doc("Aster leadership announcement", statement) : doc(subject.label, comment)) });
  assert(article.sections[0].paragraphs[0].text.includes(statement));
  assert.deepEqual(article.sections[0].paragraphs[0].sourceIds, ["s2"]);
});

test("a fallback never presents a completed sale or inferred loss contradicted by the specific transaction terms", async () => {
  const subject = { id: "story:sale", label: "Orchard buys the Orchard Bank division" };
  const agreement = "Orchard agreed to buy the bank division for $3 billion pending regulatory approval.";
  const schedule = "The companies expect the transaction to close next spring after the public review.";
  const claim = "Orchard bought the bank division and the seller will take a massive loss on its original purchase price.";
  const documents = ['<title>Orchard Bank sale terms</title><article><p>' + agreement + '</p><p>' + schedule + '</p></article>',
    '<title>Orchard buys the bank division</title><article><p>Orchard has a long history of buying similar businesses in the banking industry.</p><p>' + claim + '</p></article>'];
  const article = await buildTopicArticle(subject, [bridge, ferry], { now, fetcher: async url => html(documents[url === bridge.url ? 0 : 1]) });
  const output = article.sections.flatMap(({ paragraphs }) => paragraphs).map(({ text }) => text).join(" ");
  assert(output.includes(agreement));
  assert.doesNotMatch(output, /massive loss|bought the bank division/i);
});

test("an independent opening with a new price survives repeat-headline filtering, ahead of colour and calls to the reader", async () => {
  const subject = { id: "story:mill", label: "Orchard buys Harbor Mill for $3 billion" };
  const deal = "Orchard agreed to buy Harbor Mill for $3 billion subject to regulatory approval.";
  const price = "Harbor Mill cost $12 billion in 2021, four times the price in the Orchard deal.";
  const color = "There is an eerie quiet outside Harbor Mill on the day of the Orchard deal.";
  const ask = "When you visit Harbor Mill, please tell us how it felt to hear this announcement!";
  const page = (parts) => "<title>" + subject.label + "</title><article>" + parts.map(p=>"<p>"+p+"</p>").join("") + "</article>";
  const article = await buildTopicArticle(subject, [bridge, ferry], { now, fetcher: async url =>
    html(url === bridge.url ? page([deal, color, ask]) : page([price])) });
  const text = article.sections.flatMap(({ paragraphs })=>paragraphs).map(p=>p.text).join(" ");
  assert(text.includes(deal) && text.includes(price));
  assert.doesNotMatch(text, /eerie quiet|please tell us/);
});

test("abandoned quotations and dangling references stay out of supplemental reporting", async () => {
  const scope = { id: "story:alpha", label: "Harbor launches a browser for Linux" };
  const lead = "The Harbor browser is now available for Linux and macOS as a preview.";
  const detail = "Users can report broken sites from the browser's built-in feedback menu.";
  const orphan = "“We have every confidence that Harbor will lead the industry into a new era.";
  const dangling = "You can download it for Linux and macOS.";
  const source = '<title>Harbor browser preview for Linux</title><article>' + [lead, detail, orphan, dangling]
    .map(value=>'<p>'+value+'</p>').join('') + '</article>';
  const article = await buildTopicArticle(scope, [bridge], { now, fetcher: async () => html(source) });
  const body = article.sections.flatMap(s=>s.paragraphs).map(p=>p.text).join(" ");
  assert(body.includes(lead) && body.includes(detail));
  assert.doesNotMatch(body, /every confidence|download it/);
});

test("two articles from one publisher cannot satisfy the independent-source requirement when another publisher is available", async () => {
  const secondDesk = { url: "https://harbor.example.org/costs", posts: [] };
  const cost = "Harbor engineers approved a new steel order for the deck repairs.";
  const texts = new Map([[bridge.url, bridgeDeck], [secondDesk.url, cost], [ferry.url, ferryHours]]);
  const fetcher = async url => html('<meta property="og:site_name" content="' +
    (url === ferry.url ? "Coast Ledger" : "Harbor Gazette") + '"><title>Harbor repair notes</title><article><p>' + texts.get(url) + '</p></article>');
  const thin = { sections: [{ heading: "Replacing steel", paragraphs: [{ sentences: [
    point("The Harbor Gazette reports that the eastern deck must be replaced.", "s1", bridgeDeck),
    point("Engineers approved new steel for the deck repairs.", "s2", cost),
  ] }] }], events: [] };
  const ai = { run: async () => ({ response: thin }) };
  const mixed = await generate({ fetcher, ai }, [bridge, secondDesk, ferry]);
  assert.equal(mixed.status, "rejected");
  const singlePublisher = await generate({ fetcher, ai }, [bridge, secondDesk]);
  assert.equal(singlePublisher.status, "synthesis");
  thin.sections[0].paragraphs[0].sentences[0].text = "The eastern deck must be replaced.";
  assert.equal((await generate({ fetcher, ai }, [bridge, secondDesk])).status, "rejected");
});

test("a public share query preserves the canonical article's access and snippet limits", async () => {
  const restricted = "Harbor engineers confirmed that the confidential project would repair the eastern deck in June.";
  const page = { ...bridge, url: bridge.url + "?ref=frontpage" };
  const markup = '<link rel="canonical" href="' + bridge.url + '"><title>Harbor repair schedule</title>' +
    '<meta name="description" content="' + bridgeDeck + '"><script type="application/ld+json">' +
    JSON.stringify({ "@type": "NewsArticle", url: bridge.url, headline: "Harbor repair schedule", isAccessibleForFree: false, articleBody: restricted }) +
    '</script><article><p>' + restricted + '</p></article>';
  const paid = await generate({ fetcher: async () => html(markup) }, [page]);
  assert.doesNotMatch(JSON.stringify(paid.article), /confidential project/);
  const restrictedPreview = bridgeHTML + '<meta name="robots" content="max-snippet: 32">';
  const limited = await generate({ fetcher: async () => html(restrictedPreview) }, [bridge]);
  assert(limited.article.sources[0].excerpt.length <= 32);
  assert.deepEqual(limited.article.sections, []);
});

test("supplementing an acquisition story preserves named actors when another company was the subject in the source passage", async () => {
  const subject = { id: "story:sale", label: "Maple buys Cedar Maps" };
  const deal = "Cedar agreed to sell Cedar Maps to Maple for $3 billion pending regulatory approval.";
  const history = "Cedar paid $8 billion for its mapping division in 2020.";
  const named = "Maple filed the proposed agreement with regulators in October.";
  const prior = "Maple previously invested in smaller software businesses. ";
  const page = (parts) => "<title>" + subject.label + "</title><article>" + parts.map((p) => "<p>" + p + "</p>").join("") + "</article>";
  const answer = { sections: [{ heading: "Sale terms", paragraphs: [
    { sentences: [point("Cedar agreed to sell Cedar Maps to Maple for $3 billion.", "s1", deal)] },
    { sentences: [point("Cedar paid $8 billion for its mapping division in 2020.", "s2", history)] },
  ] }], events: [] };
  for (const opener of ["The company", "In September, the firm", "Last September the company", "The startup"]) {
    const orphan = opener + " bought Seaport Software for 10% of its former value.";
    const result = await buildTopicArticle(subject, [bridge, ferry], { now, ai: { run: () => ({ response: answer }) },
      fetcher: async (url) => html(url === bridge.url ? page([deal, prior + orphan, named]) : page([history])) });
    assert.equal(result.method, "synthesis");
    const details = result.sections.slice(1).flatMap(({ paragraphs }) => paragraphs);
    assert(details.every(({ text }) => !text.includes("Seaport Software")), opener);
    assert(details.some(({ text, citations }) => text.includes(named) && citations[0].excerpt === named));
  }
});

test("supplementary reporting on a release chooses concrete features ahead of the publisher's celebration", async () => {
  const subject = { id: "story:bird", label: "Ladybird is now in alpha" };
  const lead = "Alpha builds of Ladybird are available today for macOS and Linux.";
  const praise = "There’s still a mountain of work ahead of us, but I’m very happy that you can finally try Ladybird for yourself!";
  const updates = "The alpha is a rolling channel, and we’ll be pushing out automatic updates regularly.";
  const crashes = "After a crash, users can inspect the crash report and decide whether to send it.";
  const testing = "Ladybird supports WebDriver for automated testing and the Firefox DevTools protocol.";
  const source = '<meta property="og:site_name" content="Ladybird"><title>' + subject.label + "</title><article>" +
    [lead, praise, updates, testing, crashes].map((p) => "<p>" + p + "</p>").join("") + "</article>";
  const answer = { sections: [{ heading: "Alpha release", paragraphs: [
    { sentences: [point("Ladybird released alpha builds for Linux and macOS.", "s1", lead)] },
  ] }], events: [] };
  const article = await buildTopicArticle(subject, [bridge], { now, fetcher: async () => html(source), ai: { run: () => ({ response: answer }) } });
  assert.equal(article.method, "synthesis");
  const details = article.sections.slice(1).flatMap(({ paragraphs }) => paragraphs);
  assert(details.every(({ text }) => !text.includes("very happy")));
  assert.deepEqual(new Set(details.map(({ citations }) => citations[0].excerpt)), new Set([updates, testing, crashes]));
});

test("different live price reports yield one attributed closing figure alongside the earlier event and the direct account", async () => {
  const subject = { id: "story:rail", label: "Aster reinstates Dana Shore as CEO" };
  const announcement = "Aster reinstated Dana Shore as president and chief executive, effective immediately.";
  const close = "Shares of Aster closed up 31% following Shore’s reinstatement.";
  const unqualified = "Aster’s stock soared 35% on the news, following a sell-off on Friday.";
  const dated = "On Monday, Aster stock jumped 30%, lifting the entire market.";
  const departure = "Dana Shore resigned two weeks ago after an investigation by the board.";
  const account = "Mayor Casey Ray told Harbor Radio she called Aster’s directors to request a new vote.";
  const pages = ["aster", "markets", "radio", "journal"].map((name) => ({ url: "https://" + name + ".org/report", posts: [] }));
  const docs = [
    ["Aster board reinstates Dana Shore as CEO", [announcement]],
    ["Aster reinstates Dana Shore as CEO and shares rise", [close, departure]],
    ["Mayor describes her call to Aster directors", [account, unqualified]],
    ["Aster reinstates Dana Shore, market reacts", [dated]],
  ];
  const article = await buildTopicArticle(subject, pages, { now, fetcher: async (url) => {
    const [title, passages] = docs[pages.findIndex((page) => page.url === url)];
    return html("<title>" + title + "</title><article>" + passages.map((p) => "<p>" + p + "</p>").join("") + "</article>");
  } });
  const paragraphs = article.sections.flatMap(({ paragraphs }) => paragraphs);
  assert.deepEqual(paragraphs.filter(({ text }) => text.includes("%")).map(({ text }) => text), ['markets.org reports, “' + close + '”']);
  for (const fact of [departure, account]) assert(paragraphs.some(({ text, citations }) =>
    text.includes(fact) && citations.some(({ excerpt }) => excerpt === fact)), fact);
});

test("a day describing a different event cannot date an untimed stock observation or an archival caption", async () => {
  const subject = { id: "story:aster", label: "Aster reinstates Dana Shore" };
  const announcement = "Aster reinstated Dana Shore as president following a public vote.";
  const price = "Aster’s shares surged 35% on the news after a technology sell-off Friday.";
  const caption = "Dana Shore waits for a groundbreaking ceremony to begin in Eastport on June 16, 2026. (AP Photo/Casey Ray, File)";
  const article = await buildTopicArticle(subject, [bridge], { now, fetcher: async () =>
    html("<title>" + subject.label + "</title><article>" + [announcement, price, caption].map(p=>"<p>"+p+"</p>").join("") + "</article>") });
  assert.match(JSON.stringify(article.sections), /public vote/);
  assert.doesNotMatch(JSON.stringify([article.sections, article.timeline]), /35%|groundbreaking|AP Photo/);
});

test("the synthesis cannot attach an intraday high to the close or recount the same stock move as two developments", async () => {
  const subject = { id: "story:aster", label: "Aster shares rise after the bridge contract" };
  const high = "Aster shares rose as much as 35% in morning trading after the contract was signed.";
  const close = "Aster shares closed up 31% after the bridge contract was signed.";
  const relative = "Aster stock rose 30% after the board announced its decision.";
  const project = "The bridge contract covers electrical cable work on the western river crossing.";
  const fetcher = async (url) => html("<title>" + subject.label + "</title><article><p>" +
    (url === bridge.url ? high + "</p><p>" + close + "</p><p>" + relative : project) + "</p></article>");
  const valid = point("Aster shares ended trading 31% higher after the bridge contract.", "s1", close);
  const background = point("The bridge contract includes electrical work at the western river crossing.", "s2", project);
  for (const [market, expected] of [
    [[valid], "synthesis"],
    [[point("Aster shares rose 35% after the bridge contract.", "s1", high)], "coverage"],
    [[point("Aster closed 35% higher after the bridge contract.", "s1", high)], "coverage"],
    [[point("Aster stock rose 30% after the board announced its decision.", "s1", relative)], "coverage"],
    [[{ text: "Aster shares closed up 35% after the contract.", evidence: [{ sourceId: "s1", passage: "p1" }, { sourceId: "s1", passage: "p2" }] }], "coverage"],
    [[point("Aster shares rose 35% during morning trading.", "s1", high), valid], "coverage"],
  ]) {
    const answer = { sections: [{ heading: "Contract and trading", paragraphs: [...market, background].map(s=>({ sentences: [s] })) }], events: [] };
    const article = await buildTopicArticle(subject, [bridge, ferry], { now, fetcher, ai: { run: () => ({ response: answer }) } });
    assert.equal(article.method, expected, market.map(({ text }) => text).join(" / "));
    assert.equal(article.sections.flatMap(s=>s.paragraphs).filter(p=>p.text.includes("%")).length, 1);
  }
});

test("rewording an earlier departure does not crowd out a distinct cited interview", async () => {
  const subject = { id: "story:rail", label: "Aster reinstates Dana Shore as CEO" };
  const lead = "Aster reinstated Dana Shore as its chief executive after a vote on Monday.";
  const first = "Dana Shore resigned from the top job earlier this month after an internal review.";
  const copy = "Dana Shore will return as Aster’s CEO, in a reversal after she stepped down two weeks ago.";
  const interview = "Governor Nia Perry told Beacon Radio that she spoke directly with Aster’s directors about a second vote.";
  const pages = [bridge, ferry, {url:"https://beacon.org/news",posts:[]}];
  const docs = [[lead, first], [copy], [interview]];
  const article = await buildTopicArticle(subject, pages, { now, fetcher: async url => {
    const i=pages.findIndex(p=>p.url===url);
    return html("<title>" + (i === 2 ? "Governor speaks with Aster directors" : subject.label) + "</title><article>" +
      docs[i].map(p=>"<p>"+p+"</p>").join("") + "</article>");
  } });
  const claims=article.sections.flatMap(s=>s.paragraphs);
  assert.equal(claims.filter(p=>/resigned|stepped down/i.test(p.text)).length, 1);
  assert(claims.some(p=>p.text.includes(interview) && p.sourceIds[0] === "s3"));
});

test("price percentages stay with their issuer and cannot borrow a voter percentage or a different trading period", async () => {
  const subject = { id: "story:rail", label: "Aster and Meridian report rail contracts" };
  const lead = "Aster and Meridian won separate rail maintenance contracts after an open tender.";
  const close = "Aster stock closed 3% higher following the rail tender.";
  const other = "Meridian shares closed 7% lower following the rail tender.";
  const mixed = "After 10% of shareholders voted, Aster stock closed 3% higher and Meridian shares were flat.";
  const early = "Aster shares gained 8% in morning trading after the contract awards.";
  const doc = "<title>" + subject.label + "</title><article>" + [lead,mixed,close,other,early].map(p=>"<p>"+p+"</p>").join("") + "</article>";
  const report=await buildTopicArticle(subject, [bridge], { now, fetcher: async()=>html(doc) });
  const claims=report.sections.flatMap(s=>s.paragraphs);
  for(const detail of [close,other]) assert(claims.some(p=>p.text.includes(detail) && p.citations[0].excerpt===detail));
  assert(!claims.some(p=>/10%|8%/.test(p.text)));
  for(const [bad,quote] of [["Harbor Gazette reports Aster shares closed 10% higher.",mixed],["Harbor Gazette reports Aster shares gained 8% in afternoon trading.",early]]) {
    const response={sections:[{heading:"Market reaction",paragraphs:[{sentences:[point(bad,"s1",quote)]}]}],events:[]};
    const article=await buildTopicArticle(subject,[bridge],{now,fetcher:async()=>html('<meta property="og:site_name" content="Harbor Gazette">'+doc),ai:{run:()=>({response})}});
    assert.equal(article.method,"coverage",bad);
  }
});

test("an extensively reported event makes room for a distinct sourced response without filling a fourth slot on a sparse story", async () => {
  const subject = { id: "story:rail", label: "Aster reinstates Dana Shore as CEO" };
  const docs = [
    ["Aster reinstatement announcement", "Aster reinstated Dana Shore as chief executive following a board vote."],
    ["Aster shares surge after vote", "Shares of Aster closed up 31% following Shore’s reinstatement."],
    ["Dana Shore’s earlier departure", "Dana Shore stepped down two weeks ago while directors investigated the contract."],
    ["Governor called Aster directors", "Governor Ty Gray called Aster’s directors on Sunday to argue for a new vote."],
    ["Aster regulator questions decision", "The state regulator questioned Aster’s decision and requested the minutes of the vote."],
  ];
  const pages=docs.map((_,i)=>({url:"https://press"+i+".org/story",posts:[]}));
  const fetcher=async url=>{
    const [title,fact]=docs[pages.findIndex(p=>p.url===url)];return html("<title>"+title+"</title><article><p>"+fact+"</p></article>");
  };
  const rich=await buildTopicArticle(subject,pages,{now,fetcher});
  const paragraphs=rich.sections.flatMap(s=>s.paragraphs);
  for(const [,fact] of docs) assert(paragraphs.some(p=>p.text.includes(fact)),fact);
  assert(paragraphs.some(p=>p.text.startsWith("press4.org reports") && p.citations[0].excerpt===docs[4][1]));
  const sparse=await buildTopicArticle(subject,pages.slice(0,2),{now,fetcher});
  assert.equal(sparse.sections.flatMap(s=>s.paragraphs).length,2);
});
