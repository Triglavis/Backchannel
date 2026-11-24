import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import { fetchFeeds } from "../../topics/feeds.mjs";
import { groupPages } from "../../topics/grouping.mjs";

test("repeated site taglines cannot join unrelated articles or overwrite their discussion headlines", () => {
  const page = (id, path, title, thread = title) => ({
    id, url: "https://paper.example/" + path, domain: "paper.example", title,
    postedAt: 1800000000000, posts: [{ id: "lemmy:" + id, title: thread }],
  });
  const pages = [
    page("housing", "council-approves-rent-cap", "Stories that stay with you", "City council adopts rent cap"),
    page("sports", "azpilicueta-reflects-on-chelsea-defeat", "Stories that stay with you"),
    page("domain", "world/123", "www.paper.example"),
    page("login", "world/456", "Access to this page has been denied"),
    page("essay", "criticism", "Access Denied: An oral history of censorship"),
    page("syndicated", "local/seawall-reopens", "Harbor seawall reopens"),
    page("reprint", "regional/seawall-reopens-after-repairs", "Harbor seawall reopens"),
  ];
  const groups = groupPages(pages);
  assert.deepEqual(groups.map(({ label, pageIds }) => [label, [...pageIds].sort()]).sort(), [
    ["Access Denied: An oral history of censorship", ["essay"]],
    ["City council adopts rent cap", ["housing"]],
    ["Harbor seawall reopens", ["reprint", "syndicated"]],
  ]);
});

test("the Worker requests the same public interest listings as the userscript", async (t) => {
  const script = await readFile(new URL("../../HNewhere.user.js", import.meta.url), "utf8");
  const [, declaration] = script.match(/^[\t ]*const TOPIC_FEEDS = (\{[\s\S]*?^[\t ]*\});/m);
  const catalog = runInNewContext(`(${declaration})`);
  const expected = new Set(["hn", "lobsters", "lemmy"]);
  for (const topic of Object.values(catalog)) {
    for (const name of topic.lemmy || []) expected.add("lemmy:" + name);
    for (const uri of topic.bsky || []) expected.add("bsky:" + uri);
  }
  const requests = [];
  let active = 0;
  let concurrent = 0;
  t.mock.method(globalThis, "fetch", async (address, options) => {
    const url = new URL(address);
    requests.push({ url, options });
    concurrent = Math.max(concurrent, ++active);
    await setTimeout(5);
    active--;
    return Response.json(url.hostname === "lobste.rs" ? [] : { hits: [], posts: [], feed: [] });
  });
  await fetchFeeds(0);
  const actual = requests.map(({ url, options }) => {
    const headers = new Headers(options?.headers);
    assert.equal(options?.method ?? "GET", "GET");
    assert.equal(headers.has("Authorization"), false);
    assert.equal(headers.has("Cookie"), false);
    if (url.origin === "https://lemmy.world" && url.pathname === "/api/v3/post/list") {
      assert.equal(url.searchParams.get("sort"), "Active");
      assert.equal(url.searchParams.get("type_"), "All");
      const community = url.searchParams.get("community_name");
      if (!community) return "lemmy";
      assert.equal(url.searchParams.get("limit"), "20");
      return "lemmy:" + community;
    }
    if (url.origin === "https://public.api.bsky.app" && url.pathname === "/xrpc/app.bsky.feed.getFeed") {
      assert.equal(url.searchParams.get("limit"), "20");
      return "bsky:" + url.searchParams.get("feed");
    }
    if (url.origin === "https://hn.algolia.com" && url.pathname === "/api/v1/search_by_date") return "hn";
    if (url.origin === "https://lobste.rs" && url.pathname === "/hottest.json") return "lobsters";
    assert.fail("Unexpected public listing: " + url);
  });
  assert.deepEqual(actual.sort(), [...expected].sort());
  assert(concurrent <= 6, `observed ${concurrent} concurrent fetches`);
});
