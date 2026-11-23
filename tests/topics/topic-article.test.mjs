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
    assert.equal(article.sections.length, 1);
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
