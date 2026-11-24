import assert from "node:assert/strict";
import test from "node:test";
import { articleMembers } from "../../topics/article-membership.mjs";

const shared = Date.parse("2026-11-22T15:00:00Z");
const day = 86_400_000;
const summit = ["U.N. Climate Talks Collapse in a Bitter Clash Over Fossil Fuels", "www.nytimes.com/2026/11/22/climate/cop31-climate-summit-ends-climate.html"];
const bbc = ["COP31 climate talks fail to reach deal amid fossil fuel and money rows", "www.bbc.com/news/articles/cqwy06zrd26lo"];
const guardian = ["Cop31 climate talks break down as key deal rejected", "www.theguardian.com/environment/2026/nov/22/cop31-climate-talks-set-to-end-in-deep-division-as-key-deal-rejected"];
const alJazeera = ["‘Disappointing’: Delegates react after COP31 climate talks end without deal", "www.aljazeera.com/news/2026/11/22/countries-react-after-cop31-climate-talks-end-in-collapse"];
const truthout = ["COP31 Declared a Failure as Declaration Text Excludes Mention of Fossil Fuels", "truthout.org/video/cop31-declared-a-failure-as-declaration-text-excludes-mention-of-fossil-fuels"];
const election = ["Chuck Hubbard defeats Rep. Virginia Foxx after a recount in their North Carolina House race", "apnews.com/article/chuck-hubbard-virginia-foxx-north-carolina-23732afcd78a853e98acd9b72d0cbd14"];
const cnn = ["Republican chair of the House Rules Committee loses reelection, bringing Democrats’ majority to 259 | CNN Politics", "www.cnn.com/2026/11/22/politics/virginia-foxx-loses-reelection-chuck-hubbard"];

function edition(entries) {
  const topics = entries.map(([label], i) => ({ id: "story:" + i, label, kind: "story" }));
  const pages = entries.map(([, key], i) => ({ key, topicIds: [topics[i].id] }));
  return { topics, pages };
}

const dates = async (pages) => new Map(pages.map(({ key }) => [key, shared]));
const keys = (pages) => pages.map(({ key }) => key).sort();

test("finds published coverage of the failed numbered summit and excludes preliminary, different and hypothetical outcomes", async () => {
  const index = edition([summit, bbc, guardian, alJazeera, truthout,
    ["EU rejects deal as longest climate summit ever faces collapse", "www.theguardian.com/environment/live/2026/nov/22/cop31-climate-talks"],
    ["New COP31 draft deal tabled as countries race to salvage climate talks", "www.euronews.com/2026/11/22/new-cop31-draft-deal"],
    ["COP31 shipping talks collapse as member states reject an agreement", "maritime.example.org/cop31-shipping"],
    ["Could COP31 climate talks collapse without a fossil fuel pact?", "opinion.example.org/cop31-scenario"],
    ["COP32 climate talks collapse as countries reject an agreement", "news.example.org/cop32-result"],
    ["International UN talks on controlling use of autonomous weapons collapse", "defense.example.org/un-talks"],
    ["Talks on a COP31 carbon credit plan collapse in committee", "energy.example.org/cop31-carbon-prices"],
    ["Climate talks collapse in a bitter clash over fossil fuels", "archive.example.org/an-earlier-summit"],
  ]);
  assert.deepEqual(keys(await articleMembers(index, index.topics[0], dates)), keys(index.pages.slice(0, 5)));
});

test("confirms the same election result from both candidates and their roles, including a publisher slug", async () => {
  const index = edition([election, cnn,
    ["Virginia Foxx defeats Chuck Hubbard in their North Carolina House race", "reverse.example.org/foxx-hubbard"],
    ["Chuck Hubbard defeats John Smith in a North Carolina House race", "other.example.org/chuck-hubbard-defeats-john-smith"],
    ["Chuck Hubbard leads Virginia Foxx by 330 votes after recount", "poll.example.org/hubbard-foxx"],
    ["Chuck Hubbard could defeat Virginia Foxx in their North Carolina House race", "analysis.example.org/chuck-hubbard-defeats-virginia-foxx"],
    ["Chuck Hubbard defeats Virginia Foxx in a debate ahead of North Carolina House election", "debate.example.org/hubbard-foxx-election-debate"],
    ["Chuck Hubbard defeats Virginia Foxx on House procedural vote", "capitol.example.org/hubbard-foxx-house"],
    ["Chuck Hubbard defeats Virginia Foxx in North Carolina Senate race", "senate.example.org/hubbard-foxx"],
    ["House Democrats to start new Congress with largest majority this century", "www.ft.com/content/9d2983a7-196d-4164-a0c1-e262f32fd8c9"],
    ["Virginia Foxx dies at 75 after North Carolina House recount", "people.example.org/chuck-hubbard-defeats-virginia-foxx"],
    ["Virginia Foxx proposes election reform after recount", "policy.example.org/virginia-foxx-loses-reelection-chuck-hubbard"],
  ]);
  for (const target of index.topics.slice(0, 2)) {
    assert.deepEqual(keys(await articleMembers(index, target, dates)), keys(index.pages.slice(0, 2)));
  }
});

test("keeps reviewed assignments, curated topics and subject-only memberships authoritative", async () => {
  const index = edition([summit, bbc, guardian, alJazeera, truthout]);
  index.pages[1].reviewed = true;
  index.topics[2].curated = true;
  index.topics[3].kind = "topic";
  index.pages[4].topicIds.push(index.topics[2].id);
  const noLookup = () => assert.fail("no eligible additional publisher");
  assert.deepEqual(await articleMembers(index, index.topics[0], noLookup), [index.pages[0]]);
  assert.deepEqual(await articleMembers(index, index.topics[3], noLookup), [index.pages[3]]);
  index.pages[4].topicIds.pop();
  index.pages[0].reviewed = true;
  assert.deepEqual(await articleMembers(index, index.topics[0], noLookup), [index.pages[0]]);
});

test("connects dated death notices with the same person, age and professional identity", async () => {
  const index = edition([
    ["Tom Jackson, Broncos star and ESPN ‘Sunday NFL Countdown’ analyst, dead at 75", "www.cnyhomepage.com/news/national-news/tom-jackson-broncos-star-and-espn-sunday-nfl-countdown-analyst-dead-at-75"],
    ["Tom Jackson, Broncos star and ESPN legend, dies at 75", "www.nfl.com/news/tom-jackson-dies-age-75-broncos-star-orange-crush-espn"],
    ["Tom Jackson, former Broncos star and Hall of Fame broadcaster at ESPN, dies at 75 | CNN", "www.cnn.com/2026/11/22/sport/tom-jackson-dies-broncos-espn"],
    ["Tom Jackson, Former NFL Player And Longtime ESPN Analyst, Dead At 75 - TVLine", "www.tvline.com/2324393/tom-jackson-dead-espn-denver-broncos-obituary"],
    ["The life and legacy of the great Tom Jackson:", "www.espn.com/nfl/story/_/id/50561778/tom-jackson-broncos-star-espn-legend-dies-75"],
    ["Tom Watson, Broncos star and ESPN analyst, dead at 75", "golf.example.org/tom-watson"],
    ["Tom Jackson, Broncos star and ESPN analyst, dead at 82", "past.example.org/tom-jackson"],
    ["Tom Jackson, historian and director of the London Museum, dies at 75", "museum.example.org/tom-jackson"],
    ["Tom Jackson, Steelers star and ESPN NFL analyst, dead at 75", "sportswire.example.org/tom-jackson-nfl-espn"],
    ["Tom Jackson, Broncos star and ESPN analyst, retires at 75", "media.example.org/tom-jackson"],
    ["Tom Jackson, whose former Broncos teammate dies at 75, recalls their first game", "sports.example.org/tom-jackson"],
    ["What if Tom Jackson dies at 75?", "fiction.example.org/tom-jackson"],
  ]);
  assert.deepEqual(keys(await articleMembers(index, index.topics[0], dates)), keys(index.pages.slice(0, 5)));
});

test("a newly shared archive article cannot extend the current event", async () => {
  const index = edition([summit, bbc,
    ["COP31 climate talks collapse", "archive.example.org/2018/nov/22/cop31-talks"]]);
  assert.deepEqual(keys(await articleMembers(index, index.topics[0], dates)), keys(index.pages.slice(0, 2)));
});

test("only checks sharing dates for plausible published stories and excludes old or undated coverage", async () => {
  const index = edition([summit, bbc, guardian, alJazeera, truthout, ["Separate news", "elsewhere.example.org/separate"]]);
  const checked = async (pages) => {
    assert.deepEqual(keys(pages), keys(index.pages.slice(0, 5)));
    return new Map([[summit[1], shared], [bbc[1], shared - 4 * day], [guardian[1], shared + day],
      [truthout[1], shared + 4 * day]]);
  };
  assert.deepEqual(keys(await articleMembers(index, index.topics[0], checked)), [summit[1], guardian[1]].sort());
});

test("bounds additional publishers and keeps the source selection stable across unrelated index updates", async () => {
  const index = edition([summit, ...Array.from({ length: 40 }, (_, i) =>
    [bbc[0], "outlet" + i + ".example.org/2026/11/22/cop31-talks"])]);
  const boundedDates = async (pages) => {
    assert(pages.length <= 33);
    return dates(pages);
  };
  const expected = await articleMembers(index, index.topics[0], boundedDates);
  assert.equal(expected.length, 9);
  index.pages.reverse();
  index.pages.unshift({ key: "elsewhere.example.org/2026/11/22/cop31", topicIds: ["story:elsewhere"] });
  index.topics.push({ id: "story:elsewhere", kind: "story", label: "Hotels display the flags of summit delegates" });
  assert.deepEqual(await articleMembers(index, index.topics[0], boundedDates), expected);
});

test("uses one corroborated source from a separately published story and keeps every formal member", async () => {
  const index = edition([summit, bbc, guardian]);
  index.pages.push({ key: "copy.example.org/2026/11/22/cop31", topicIds: [index.topics[1].id] });
  const expanded = await articleMembers(index, index.topics[0], dates);
  assert.equal(expanded.filter(page => page.topicIds.includes(index.topics[1].id)).length, 1);
  const own = await articleMembers(index, index.topics[1], dates);
  assert.equal(own.filter(page => page.topicIds.includes(index.topics[1].id)).length, 2);
});
