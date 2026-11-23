import assert from "node:assert/strict";
import test from "node:test";
import { groupPages } from "../../topics/grouping.mjs";

const NOW = Date.parse("2026-11-21T07:30:00Z");

function page(id, title, options = {}) {
  return { id, title, domain: id + ".example", postedAt: NOW, posts: [{ id: "hn:" + id }], ...options };
}

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
