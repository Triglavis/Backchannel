import assert from "node:assert/strict";
import test from "node:test";
import { groupPages } from "../../topics/grouping.mjs";
import { reinstatement, otherDevelopments } from "./leadership-fixture.mjs";

const NOW = Date.parse("2026-11-21T07:30:00Z");

function page(id, title, options = {}) {
  return { id, title, domain: id + ".example", postedAt: NOW, posts: [{ id: "hn:" + id }], ...options };
}

test("reinstatement reporting, reactions, and market consequences name one event", () => {
  const pages = [...reinstatement, ...otherDevelopments].map((title, i) => page(String(i), title, {
    vector: [1], domain: i === 1 || i === 5 ? "finance.example" : "paper" + i + ".example",
  }));
  pages.push(page("archive", reinstatement[0], { url: "https://archive.example/2022/11/21/reinstatement" }));
  const groups = groupPages(pages);
  const story = groups.find(({ pageIds }) => pageIds.includes("0"));
  assert.deepEqual(story.pageIds.toSorted(), reinstatement.map((_, i) => String(i)));
  assert([reinstatement[0], reinstatement[3]].includes(story.label), story.label);
  assert.equal(groups.length, 2 + otherDevelopments.length);
  assert.deepEqual(groupPages(pages.toReversed()), groups);
});

test("return to a named leadership role distinguishes the person, organization, office, and time", () => {
  const pages = [
    "Harbor Labs reinstates Mira Vale as chief executive",
    "Investors celebrate Mira Vale’s return to Harbor Labs",
    "Harbor Labs shares rise after Vale returns as CEO",
    "Harbor Labs brings Mira Vale back as CEO",
    "Mira Vale is back as Harbor Labs CEO",
    "Harbor Labs reinstates Mira Vale as CFO",
    "Meridian Labs brings Mira Vale back as CEO",
    "Harbor Labs reinstates Tara Vale as chief executive",
    "Harbor Labs reinstates Mira Vale as chief executive",
  ].map((title, i) => page(String(i), title, { publishedAt: i === 8 ? NOW - 7 * 86_400_000 : NOW }));
  pages.push(page("finance", "Mira Vale returns to Harbor Labs as chief financial officer"));
  const groups = groupPages(pages);
  const story = groups.find(({ pageIds }) => pageIds.includes("0"));
  assert.deepEqual(story.pageIds.toSorted(), ["0", "1", "2", "3", "4"]);
  assert.equal(groups.length, 5);
  assert.deepEqual(groups.find(({ pageIds }) => pageIds.includes("5")).pageIds.toSorted(), ["5", "finance"]);
});

test("a freight market reaction corroborates the grounding decision while a route approval stays separate", () => {
  const groups = groupPages([
    page("regulator", "FAA grounds Meridian cargo jets after engine failure"),
    page("market", "Freight prices climb after FAA grounds Meridian cargo jets"),
    page("route", "FAA authorizes Meridian cargo jets on new Chile route"),
  ]);
  assert.deepEqual(groups.map(({ pageIds }) => pageIds.toSorted()).sort(), [["market", "regulator"], ["route"]]);
});

test("cross-publisher paraphrases share a specific headline and one primary story", () => {
  const pages = [
    page("abc", "Donald Trump vows to tax US companies building data centres overseas"),
    page("ap", "US tech companies that build AI data centers in other countries will be penalized, Trump says"),
    page("bbc", "Trump threatens ban on US firms building AI data centres overseas"),
    page("newsweek", "Trump Threatens Tax on US Companies Building Data Centers Overseas"),
    page("wsj", "Trump Says He Will Penalize Companies That Build Data Centers Outside the U.S."),
    page("travel", "Trump announces a diplomatic visit to Tokyo"),
  ];
  const groups = groupPages(pages);
  assert.equal(groups.length, 2);
  const policy = groups.find(({ pageIds }) => pageIds.includes("abc"));
  assert.equal(policy.kind, "story");
  assert.deepEqual([...policy.pageIds].sort(), ["abc", "ap", "bbc", "newsweek", "wsj"]);
  assert.match(policy.label, /(?:tax|penali[sz]e|threatens)/i);
  assert.equal(policy.label, pages.find(({ id }) => id === policy.pageIds[0]).title);
  assert.deepEqual(policy.subjectTitles ?? [], []);
  assert.deepEqual(groups.find(({ pageIds }) => pageIds.includes("travel")).pageIds, ["travel"]);
  assert.deepEqual(groupPages([...pages].reverse()), groups);
});

test("embedding similarity supports a shared event while related entity news stays separate", () => {
  const vector = [1, 0];
  const pages = [
    page("outage", "Cloudflare suffers outage affecting its dashboards and API"),
    page("downtime", "Cloudflare dashboard and API unavailable during service disruption"),
    page("schema", "Cloudflare API gains schema validation for developer integrations"),
  ];
  assert.equal(groupPages(pages).length, 3);
  const groups = groupPages(pages.map((item) => ({ ...item, vector })));
  assert.equal(groups.length, 2);
  assert.deepEqual([...groups.find(({ pageIds }) => pageIds.includes("outage")).pageIds].sort(), ["downtime", "outage"]);
  assert.deepEqual(groups.find(({ pageIds }) => pageIds.includes("schema")).pageIds, ["schema"]);
});

test("market coverage distinguishes the sell-off from the IPO announcement", () => {
  const groups = groupPages([
    page("nbc", "Anthropic shares tank after IPO as the Nasdaq erases 2026 gains"),
    page("cnbc", "Nasdaq futures drop as Anthropic shares tumble"),
    page("yahoo", "Anthropic stock dives over 12% after rip-roaring IPO"),
    page("guardian", "Global stock markets slump as Anthropic's record IPO fails to stem AI sell-off"),
    page("ipo", "Anthropic announces closing of initial public offering"),
    page("other", "Globex shares fall after IPO"),
  ]);
  assert.equal(groups.length, 3);
  assert.deepEqual([...groups.find(({ pageIds }) => pageIds.includes("nbc")).pageIds].sort(),
    ["cnbc", "guardian", "nbc", "yahoo"]);
});

test("a recurring named subject remains searchable without replacing independent headlines", () => {
  const groups = groupPages([
    page("video", "The Riemann Hypothesis, Explained"),
    page("explainer", "Show HN: How deep is the Riemann hypothesis? An interactive explainer"),
    page("essay", "Why the Riemann hypothesis matters to modern number theory"),
    page("related", "Unforced Navier-Stokes Singularity and the Generalized Riemann Hypothesis"),
    page("slopstrap", "Slopstrap: Make your site look hastily vibecoded", { domain: "project.example" }),
    page("slopstrap-copy", "Slopstrap – Make your site look hastily vibecoded", { domain: "project.example" }),
    page("cooking", "A field guide to low-maintenance solar cooking"),
  ]);
  assert.equal(groups.length, 6);
  const riemann = groups.filter(({ aliases }) => aliases?.includes("Riemann Hypothesis"));
  assert.deepEqual(riemann.flatMap(({ pageIds }) => pageIds).sort(), ["essay", "explainer", "video"]);
  assert(riemann.every(({ label, pageIds }) => label !== "Riemann Hypothesis" && pageIds.length === 1));
  assert.match(groups.find(({ pageIds }) => pageIds.includes("slopstrap")).label, /^Slopstrap/);
  assert.equal(groups.find(({ pageIds }) => pageIds.includes("cooking")).label, "A field guide to low-maintenance solar cooking");
});

test("reports of a status change agree on the holder, the status and what happened", () => {
  const reports = [
    page("wire", "The U.S. has officially lost its measles elimination status"),
    page("paper", "The United States loses measles elimination status"),
    page("radio", "US has lost its measles elimination status"),
    page("bulletin", "USA loses official measles elimination status"),
    page("regional", "Measles is no longer considered eliminated in the US and Mexico"),
  ];
  const others = [
    page("canada", "Canada has officially lost its measles elimination status"),
    page("rubella", "The United States loses rubella elimination status"),
    page("regained", "The United States regains measles elimination status"),
    page("risk", "The United States could lose its measles elimination status"),
    page("negated", "The U.S. has not lost its measles elimination status"),
    page("background", "What measles elimination status means for the United States"),
    page("earlier", "US lost its measles elimination status in 1995"),
  ];
  const groups = groupPages([...reports, ...others].map((item) => ({ ...item, vector: [1] })));
  assert.deepEqual(groups.map(({ pageIds }) => [...pageIds].sort().join(" ")).sort(),
    ["canada", "bulletin paper radio regional wire", "rubella", "regained", "risk", "negated", "background", "earlier"].sort());
  const story = groups.find(({ pageIds }) => pageIds.includes("wire"));
  assert(reports.slice(0, -1).some(({ title }) => title === story.label), story.label);
  assert.deepEqual(groups.flatMap(({ aliases = [] }) => aliases).filter((label) => /\bloses$/i.test(label)), []);
});

test("a change in a park's designation keeps the place and qualification", () => {
  const groups = groupPages([
    page("park", "Redwood Park loses its dark-sky designation"),
    page("copy", "Redwood Park has lost its dark-sky designation"),
    page("other", "Juniper Park loses its dark-sky designation"),
    page("future", "Redwood Park is at risk of losing its dark-sky designation"),
    page("refuge", "Redwood Park loses its status as a bird refuge"),
    page("preserve", "Redwood Park loses its status as a nature preserve"),
  ]);
  assert.deepEqual(groups.map(({ pageIds }) => [...pageIds].sort().join(" ")).sort(),
    ["copy park", "future", "other", "preserve", "refuge"]);
});

test("early and syndicated reports of one confirmed designation change share a concise source heading", () => {
  const first = Date.parse("2026-11-14T03:00:00Z");
  const announced = Date.parse("2026-11-17T19:00:00Z");
  const day = 86_400_000;
  const early = "US has lost measles elimination status, global health authorities say";
  const pages = [
    page("nature", "US loses measles elimination status: what it means for the world"),
    page("cbs", "The U.S. has lost measles elimination status. Here's what that means and who is most at risk."),
    page("science", "The U.S. just lost its measles elimination status. What now?"),
    page("regional", "Measles is no longer considered eliminated in the US and Mexico", { domain: "ap.example" }),
    page("followup", "US loses its measles-free status. Here's how the Trump administration has responded to outbreaks", { domain: "ap.example" }),
    page("wunc", early, { url: "https://radio.example/2026-11-14/authorities-report-the-loss", firstPostedAt: announced }),
    page("reaction", "‘I’m heartbroken’: experts dismayed as US loses long-held measles elimination status"),
    page("abc", "US officially loses measles elimination status as vaccination rates drop"),
    page("control", "US has officially lost control of measles"),
  ].map((item) => ({ ...item, postedAt: announced }));
  const other = [
    page("old", early, { publishedAt: announced - 15 * day }),
    page("reposted", early, { url: "https://archive.example/2019/nov/17/an-earlier-story", firstPostedAt: announced }),
    page("uncertain", "US could lose measles elimination status", { publishedAt: first }),
    page("investment", "US loses control of measles research funding", { publishedAt: announced }),
    page("provisional", "The US loses its provisional measles elimination status", { publishedAt: announced }),
  ];
  const groups = groupPages([...pages, ...other]);
  const story = groups.find(({ pageIds }) => pageIds.includes("wunc"));
  assert.deepEqual([...story.pageIds].sort(), pages.map(({ id }) => id).sort());
  assert.equal(groups.length, 1 + other.length);
  assert.match(story.label, /(?:U\.S\.|US).*measles(?:-free| elimination) status/i);
  assert.doesNotMatch(story.label, /what (?:now|it means)|here['’]s/i);
  assert(pages.some(({ title }) => title === story.label || title.startsWith(story.label + ".") || title.startsWith(story.label + ":")));
});

test("automatic search aliases omit reporting formulas and keep the full source headlines", () => {
  const pages = [
    page("birds", "Study finds warblers change course in fog"),
    page("heat", "Study finds insulation reduces heating costs"),
    page("water", "Researchers reveal a hidden aquifer"),
    page("space", "Researchers reveal signals from a pulsar"),
    page("named", "The Riemann hypothesis influences modern number theory"),
    page("proofs", "A guide to checking proofs of the Riemann hypothesis"),
  ];
  const groups = groupPages(pages);
  assert.deepEqual(groups.map(({ label }) => label).sort(), pages.map(({ title }) => title).sort());
  const searchable = groups.flatMap(({ aliases = [] }) => aliases);
  assert(searchable.includes("Riemann Hypothesis"));
  assert.deepEqual(searchable.filter((name) => /^(?:study finds|researchers reveal)$/i.test(name)), []);
});

test("coverage of a war and a related blockade stays with its own developments", () => {
  const groups = groupPages([
    page("talks", "Iran war enters third week after failed ceasefire talks"),
    page("ceasefire", "Ceasefire talks fail as Iran war enters third week"),
    page("tanker", "Iran widens Strait of Hormuz blockade after tanker seizure"),
    page("seizure", "Iran expands blockade of the Strait of Hormuz after seizing a tanker"),
    page("history", "A diplomatic history of the Iran war"),
    page("insurance", "How cargo insurance is responding to the Iran war"),
  ]);
  assert.deepEqual(groups.map(({ pageIds }) => [...pageIds].sort().join(" ")).sort(),
    ["ceasefire talks", "history", "insurance", "seizure tanker"]);
  assert(groups.every(({ kind }) => kind === "story"));
});

test("a corroborated short headline joins coverage of the FBI criminal database breach", () => {
  const publisherHeadline = "FBI reportedly investigating apparent hack of its criminal database";
  const groups = groupPages([
    page("cnn", "The FBI was hacked again", {
      description: "The FBI is investigating an apparent breach of its nationwide criminal information database.",
      posts: [
        { id: "hn:cnn", title: "The FBI was hacked again" },
        { id: "lemmy:cnn", title: "The FBI was hacked again, this time the breach targeted its crime database" },
      ],
    }),
    page("bbc", publisherHeadline),
    page("france24", "FBI Criminal Database Hacked"),
    page("email", "FBI investigates an apparent hack of its email server"),
    page("modernization", "FBI says its criminal database modernization project is behind schedule"),
  ].map((item) => ({ ...item, vector: [1] })));
  assert.deepEqual(groups.map(({ pageIds }) => [...pageIds].sort().join(" ")).sort(),
    ["bbc cnn france24", "email", "modernization"]);
  const breach = groups.find(({ pageIds }) => pageIds.includes("cnn"));
  assert.equal(breach.label, publisherHeadline);
  assert.equal(breach.pageIds[0], "bbc");
});

test("similar release headlines with different versions remain distinct stories", () => {
  const groups = groupPages([
    page("older", "Vim Classic 8.3.1 released with terminal fixes", { vector: [1] }),
    page("newer", "Vim Classic 8.4.0 released with terminal fixes", { vector: [1] }),
  ]);
  assert.equal(groups.length, 2);
  assert(groups.every(({ kind, pageIds }) => kind === "story" && pageIds.length === 1));
});

test("a subject suggested for story artwork is supported by multiple member headlines", () => {
  const groups = groupPages([
    page("proof", "Mathematicians find a missing step in the Riemann hypothesis proof"),
    page("review", "Peer review finds a missing step in the proof of the Riemann hypothesis"),
  ]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].subjectTitles, ["Riemann Hypothesis"]);
});

test("the five published FBI database reports agree on the incident across reporting angles", () => {
  const reports = [
    page("cnn", "The FBI was hacked again", { posts: [
      { title: "Trump downplays breach into FBI’s crime database while reviving complaints about agency’s Russia probe | CNN Politics" },
      { title: "The FBI was hacked again, this time the breach targeted its crime database" },
      { title: "The FBI was hacked again" },
    ] }),
    page("bbc", "FBI reportedly investigating apparent hack of its criminal database"),
    page("tribune", "FBI investigating apparent hack of its key national criminal justice database, AP source says"),
    page("ncic", "FBI's NCIC criminal database hacked, Trump confirms"),
    page("france24", "FBI Criminal Database Hacked"),
  ];
  const groups = groupPages(reports);
  assert.equal(groups.length, 1);
  assert.deepEqual([...groups[0].pageIds].sort(), ["bbc", "cnn", "france24", "ncic", "tribune"]);
  assert.match(groups[0].label, /FBI.*investigating apparent hack.*criminal.*database/i);
  assert.deepEqual(groupPages([...reports].reverse()), groups);
});

test("a representative headline names the spacecraft when another member's lead supports it", () => {
  const specific = "BepiColombo completes orbital insertion at Mercury";
  const groups = groupPages([
    page("short", "Orbital insertion at Mercury", { vector: [1], description: "The BepiColombo spacecraft has entered orbit around Mercury." }),
    page("esa", specific, { vector: [1] }),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].label, specific);
});

test("on fixed members the headline preserves claim status and omits a single source's added claim", () => {
  const report = "FBI investigating apparent hack of its criminal database";
  const groups = groupPages([
    page("terse", "FBI criminal database hacked"),
    page("report", report),
    page("angle", "FBI criminal database hacked, exposing millions of records", {
      description: "The article reports that millions of records were exposed.",
    }),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].label, report);
  assert.equal(groups[0].pageIds[0], "report");
});

test("an action and a named organization still need matching evidence about the affected object", () => {
  const article = page("investigation", "FBI investigating apparent hack of its national crime database", { vector: [1] });
  for (const title of [
    "FBI investigating apparent hack of its email server",
    "FBI investigating apparent hack of its state crime database",
    "FBI investigating apparent hack of its national fingerprint database",
    "RCMP investigating apparent hack of its national crime database",
    "FBI announces national crime database modernization",
    "FBI was hacked again",
  ]) {
    const unrelated = page("unrelated", title, { vector: [1] });
    assert.equal(groupPages([article, unrelated]).length, 2, title);
  }
  assert.equal(groupPages([
    page("crime", article.title.toLowerCase(), { vector: [1] }),
    page("email", "fbi investigating apparent hack of its email server", { vector: [1] }),
  ]).length, 2);
  assert.equal(groupPages([
    page("portland", "FBI investigating breach of hospital network in Portland", { vector: [1] }),
    page("boston", "FBI investigating breach of hospital network in Boston", { vector: [1] }),
  ]).length, 2);
  const unrelated = page("email", "FBI investigating apparent hack of its email server", { vector: [1] });
  const bridge = page("both", "FBI investigating apparent hack of its crime database and email server", { vector: [1] });
  assert(groupPages([article, bridge, unrelated]).every(({ pageIds }) =>
    !(pageIds.includes("investigation") && pageIds.includes("email"))));
});

test("an offering's pricing and closing announcements are distinct milestones", () => {
  const titles = [
    "Anthropic announces initial public offering", "Anthropic announces pricing of initial public offering",
    "Anthropic announces closing of initial public offering",
  ];
  assert.equal(groupPages(titles.map((title, i) => page(String(i), title, { vector: [1] }))).length, 3);
});

test("unverified scale in one policy headline gives way to a source-supported alternative", () => {
  const groups = groupPages([
    page("a", "Trump Threatens Massive Tax on US Companies Building Data Centers Overseas"),
    page("b", "Donald Trump vows to tax US companies building data centres overseas"),
    page("c", "US tech companies that build AI data centers in other countries will be penalized, Trump says"),
  ]);
  assert.equal(groups.length, 1);
  assert.doesNotMatch(groups[0].label, /massive/i);
  assert.match(groups[0].label, /Trump/i);
});

test("unusable titles stay unassigned while independent discussion and syndicated titles remain eligible", () => {
  const syndicated = "County council approves a flood barrier for the harbor";
  const posts = [{ id: "hn:1", title: "reuters.com" }, { id: "lemmy:2", title: "reuters.com" }];
  const groups = groupPages([
    page("missing", "reuters.com", { domain: "reuters.com", posts }),
    page("other", "Access Denied"),
    page("wire", "reuters.com", { domain: "reuters.com", posts: [{ id: "hn:3", title: syndicated }] }),
    page("copy", syndicated, { domain: "reuters.com" }),
  ]);
  assert.deepEqual(groups.map(({ label, pageIds }) => ({ label, ids: [...pageIds].sort() })),
    [{ label: syndicated, ids: ["copy", "wire"] }]);
  assert.equal(posts.length, 2);
});

test("gift-link notes are removed from topic headlines and matching, leaving the source and its dated title intact", () => {
  const title = "U.S. Tracked Alice Huang’s Contacts With China Spy Agency During Nvidia Affair";
  const articles = [title, title + " (Gift Article)", title + " (gift link)"].map((headline, index) =>
    page(String(index), headline, { domain: "nytimes.com", posts: [{ title: headline }] }));
  articles.push(page("historical", title + " (2024)", { domain: "nytimes.com" }));
  const groups = groupPages(articles);
  assert.deepEqual(groups.map(({ label, pageIds }) => [label, [...pageIds].sort()]),
    [[title, ["0", "1", "2"]], [title + " (2024)", ["historical"]]]);
  assert.equal(articles[1].title, title + " (Gift Article)");
  assert.equal(articles[2].posts[0].title, title + " (gift link)");
});

test("the event window uses available source dates when discussions resurface articles", () => {
  const title = "FBI criminal database hacked";
  const prior = NOW - 60 * 86_400_000;
  const current = page("current", title, { publishedAt: new Date(NOW).toISOString() });
  const old = page("old", title, { publishedAt: prior });
  const syndicated = page("copy", title, { postedAt: prior, publishedAt: new Date(NOW - 86_400_000).toISOString() });
  assert.equal(groupPages([current, old]).length, 2);
  assert.deepEqual(groupPages([current, syndicated]).map(({ pageIds }) => [...pageIds].sort()), [["copy", "current"]]);
  assert.equal(groupPages([current, page("rediscovered", title, { publishedAt: null, firstPostedAt: prior })]).length, 2);
  assert.equal(groupPages([current, page("undated", title, { publishedAt: null, firstPostedAt: null })]).length, 1);
  assert.equal(groupPages([
    page("2018", title + " in 2018"), page("2026", title + " in 2026"),
  ]).length, 2);
});

test("a specific question shared by independent explainers retains the technique and version", () => {
  const first = "How to verify Riemann hypothesis proofs with Lean 4.2";
  const groups = groupPages([
    page("guide", first, { publishedAt: NOW - 60 * 86_400_000 }),
    page("tutorial", "Verifying Riemann hypothesis proofs with Lean 4.2"),
    page("other", "Why the Riemann hypothesis matters to number theorists"),
    page("version", "How to verify Riemann hypothesis proofs with Lean 3.4"),
  ]);
  assert.deepEqual(groups.map(({ pageIds }) => [...pageIds].sort().join(" ")).sort(), ["guide tutorial", "other", "version"]);
  assert.match(groups.find(({ pageIds }) => pageIds.includes("guide")).label, /verif.*riemann.*lean 4\.2/i);
});
