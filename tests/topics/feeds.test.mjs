import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import { fetchFeeds } from "../../topics/feeds.mjs";

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
