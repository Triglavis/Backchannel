const MAX_TEXT = 260;
const INTEREST_FETCH_LIMIT = 20;
const FEED_CONCURRENCY = 4;
const LEMMY_COMMUNITIES = [
  "world@lemmy.world", "europe@feddit.org", "politics@lemmy.world", "news@lemmy.world",
  "technology@lemmy.world", "games@lemmy.world",
];
const BLUESKY_FEEDS = [
  "at://did:plc:3sn6bogankaicebzdb7liro3/app.bsky.feed.generator/aaajaq4ut77am",
  "at://did:plc:7mtqkeetxgxqfyhyi2dnyga2/app.bsky.feed.generator/aaadhh6hwvaca",
  "at://did:plc:kkf4naxqmweop7dv4l2iqqf5/app.bsky.feed.generator/verified-news",
  "at://did:plc:cndfx4udwgvpjaakvxvh7wm5/app.bsky.feed.generator/flipboard-biz",
  "at://did:plc:cndfx4udwgvpjaakvxvh7wm5/app.bsky.feed.generator/flipboard-tech",
  "at://did:plc:opm7kjzippurg433jh7rt4ax/app.bsky.feed.generator/aaacvdfm2b4ig",
  "at://did:plc:2hwwem55ce6djnk6bn62cstr/app.bsky.feed.generator/aaaotdzmoni2q",
  "at://did:plc:lcn5zsz2e7kjwoe4ldf3chr5/app.bsky.feed.generator/aaanstr6k5dvo",
  "at://did:plc:jfhpnnst6flqway4eaeqzj2a/app.bsky.feed.generator/for-science",
  "at://did:plc:xqbbs34shcevzm326a4rvftn/app.bsky.feed.generator/aaabre5ak5ddi",
  "at://did:plc:egtk4i4s3a2cykq3pa5nrkqr/app.bsky.feed.generator/aaaarylo7rb2e",
];

const FEEDS = [
  {
    id: "hn",
    name: "Hacker\u00a0News",
    feed: "https://hn.algolia.com/api/v1/search_by_date?tags=story&numericFilters=points%3E5&hitsPerPage=65",
    entries: (data) => data.hits.map((item) => {
      const discussion = "https://news.ycombinator.com/item?id=" + encodeURIComponent(item.objectID);
      return {
        id: item.objectID, postTitle: item.title, page: item.url || discussion, discussion,
        description: item.story_text, postedAt: item.created_at, comments: item.num_comments,
      };
    }),
  },
  {
    id: "lobsters",
    name: "Lobsters",
    feed: "https://lobste.rs/hottest.json",
    entries: (data) => data.map((item) => ({
      id: item.short_id, postTitle: item.title, page: item.url || item.comments_url,
      discussion: item.comments_url, description: item.description_plain,
      postedAt: item.created_at, comments: item.comment_count,
    })),
  },
  lemmyFeed(),
  ...LEMMY_COMMUNITIES.map(lemmyFeed),
  ...BLUESKY_FEEDS.map((target) => ({
    id: "bsky",
    name: "Bluesky",
    target,
    feed: "https://public.api.bsky.app/xrpc/app.bsky.feed.getFeed?" + new URLSearchParams({ feed: target, limit: INTEREST_FETCH_LIMIT }),
    entries: blueskyEntries,
  })),
];

function lemmyFeed(target) {
  const query = new URLSearchParams({ sort: "Active", type_: "All", limit: target ? INTEREST_FETCH_LIMIT : 50 });
  if (target) query.set("community_name", target);
  return {
    id: "lemmy",
    name: "Lemmy",
    target,
    feed: "https://lemmy.world/api/v3/post/list?" + query,
    entries: (data) => lemmyEntries(data, target),
  };
}

function lemmyEntries(data, target) {
  if (!Array.isArray(data.posts)) throw new Error("Missing posts listing");
  const listing = target ? data.posts.slice(0, INTEREST_FETCH_LIMIT) : data.posts;
  return listing.flatMap((item) => {
    const { post, community, counts } = item || {};
    if (!post || !community || post.nsfw || post.deleted || post.removed ||
      community.nsfw || community.deleted || community.removed || (community.visibility && community.visibility !== "Public")) return [];
    const link = webURL(post.url);
    if (target && (!link || link.pathname.startsWith("/pictrs/"))) return [];
    const host = webURL(community.actor_id)?.hostname;
    return [{
      id: post.id, title: post.embed_title, postTitle: post.name, page: post.url || post.ap_id,
      discussion: "https://lemmy.world/post/" + post.id,
      community: "!" + community.name + (host ? "@" + host : ""),
      description: post.embed_description || post.body, postedAt: post.published, comments: counts?.comments,
    }];
  });
}

function blueskyEntries(data) {
  if (!Array.isArray(data.feed)) throw new Error("Missing feed listing");
  return data.feed.slice(0, INTEREST_FETCH_LIMIT).flatMap((item) => {
    const post = item?.post;
    const external = post?.embed?.external || post?.embed?.media?.external;
    const page = webURL(external?.uri);
    if (!page || page.hostname === "bsky.app" || page.hostname.endsWith(".bsky.app")) return [];
    const address = typeof post.uri === "string" && /^at:\/\/(did:[a-z]+:[A-Za-z0-9._:%-]+)\/app\.bsky\.feed\.post\/([A-Za-z0-9._:~-]{1,512})$/.exec(post.uri);
    if (!address || address[2] === "." || address[2] === "..") return [];
    return [{
      id: post.uri, title: external.title, postTitle: external.title || page.hostname, page: page.href,
      discussion: "https://bsky.app/profile/" + address[1] + "/post/" + encodeURIComponent(address[2]),
      description: external.description, postedAt: post.indexedAt, comments: post.replyCount,
    }];
  });
}

function text(value, limit = MAX_TEXT) {
  return typeof value === "string"
    ? value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, limit)
    : "";
}

function webURL(value) {
  try {
    const url = new URL(value);
    if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password && url.href.length <= 2_048) return url;
  } catch {}
  return null;
}

export function canonicalURL(value) {
  const url = webURL(value);
  if (!url) return null;
  url.hash = "";
  for (const key of new Set(url.searchParams.keys())) {
    if (/^(utm_.+|fbclid|gclid|mc_cid|mc_eid)$/i.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  const key = url.host + url.pathname.replace(/\/$/, "") + url.search;
  return { key, url: url.href, domain: url.hostname.replace(/^www\./, "") };
}

const NON_ARTICLE_TITLES = new Set([
  "access denied", "access to this page has been denied", "request blocked", "request rejected",
  "page not found", "this page not found", "just a moment", "attention required", "checking your browser",
  "verify you are human", "verify that you are human", "enable javascript and cookies to continue",
  "log in", "sign in", "log in to continue", "sign in to continue", "subscribe to continue", "untitled", "click here", "read more", "px-captcha",
]);
const HTTP_ERROR_TITLE = /^(?:error\s+)?(?:401|403|404|429|503)(?:\s*[-:–—]?\s*(?:error|unauthorized|forbidden|access denied|(?:page )?not found|too many requests|service unavailable))?$/iu;

export function usableTopicTitle(value, domain = "") {
  if (typeof value !== "string") return false;
  const title = value.normalize("NFKC").trim();
  if (!/[\p{L}\p{N}]/u.test(title) || /^(?:https?:\/\/|www\.)\S+$/iu.test(title)) return false;
  const key = title.toLowerCase().replace(/^[\s–—-]+|[\s.!…]+$/gu, "");
  const host = domain.toLowerCase().replace(/^www\./, "");
  if (key === host || key === host.split(".")[0] || /^[\w.-]+\.(?:com|org|net|edu|gov|co|news|io)\/?$/u.test(key)) return false;
  if (host === "briefly.co" && (key === "save what matters" || key === "curate feeds | make collections | customize email briefs")) return false;
  const heading = key.split(/\s+\|\s+/u)[0].replace(/[.!…]+$/u, "");
  return !NON_ARTICLE_TITLES.has(heading) && !HTTP_ERROR_TITLE.test(heading);
}

const SLUG_STOP_WORDS = new Set("about after and are for from has into that the their this with you your".split(" "));
function headlineWords(value) {
  return new Set((value.toLowerCase().match(/[\p{L}]{3,}/gu) || []).filter((word) => !SLUG_STOP_WORDS.has(word)));
}

function articleSlugWords(url) {
  try {
    const leaf = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).at(-1) || "");
    return /[-_]/u.test(leaf) ? headlineWords(leaf) : new Set();
  } catch {
    return new Set();
  }
}

export function publisherArticleKey(value) {
  const url = webURL(value);
  if (!url) return "";
  const host = url.hostname.replace(/^www\./, "");
  if ((host !== "nytimes.com" && host !== "theguardian.com") || articleSlugWords(url.href).size < 3) return "";
  for (const key of new Set(url.searchParams.keys())) {
    if ((host === "nytimes.com" && /^(?:smid|unlocked_article_code)$/i.test(key)) ||
      (host === "theguardian.com" && key.toLowerCase() === "cmp" &&
        url.searchParams.getAll(key).every((value) => /^share[_-]/i.test(value)))) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  return url.host + url.pathname.replace(/\/$/, "") + url.search;
}

export function topicPageEvidence(pages) {
  const repeated = new Set();
  const paths = new Map();
  const candidates = pages.map((page) => [...new Set([page.title, ...(page.alternateTitles || []), ...(page.posts || []).map((post) => post.title)]
    .filter((title) => usableTopicTitle(title, page.domain)).map((title) => title.trim()))]);
  const siteKey = (page, title) => (page.domain || "") + "\n" + title.normalize("NFKC").toLowerCase();
  for (const [index, page] of pages.entries()) {
    const slug = articleSlugWords(page.url);
    if (slug.size < 3) continue;
    for (const title of candidates[index]) {
      const words = headlineWords(title);
      if (words.size > 8 || [...words].some((word) => slug.has(word))) continue;
      const key = siteKey(page, title);
      if (repeated.has(key)) continue;
      const others = paths.get(key) || [];
      if (others.some((other) => [...slug].filter((word) => !other.has(word)).length >= 2 &&
        [...other].filter((word) => !slug.has(word)).length >= 2)) repeated.add(key);
      else {
        others.push(slug);
        paths.set(key, others);
      }
    }
  }
  return pages.map((page, index) => ({
    ...page, title: candidates[index].find((title) => !repeated.has(siteKey(page, title))) || "",
    ...(page.description && !usableTopicTitle(page.description, page.domain) ? { description: "" } : {}),
  }));
}

function normalizeEntry(source, item, since) {
  const page = canonicalURL(item.page);
  const thread = webURL(item.discussion);
  const title = text(item.title);
  const description = text(item.description);
  const postedAt = Date.parse(item.postedAt);
  if (!item.id || !page || !thread || !Number.isFinite(postedAt) || postedAt < since) return null;
  const count = typeof item.comments === "number" || (typeof item.comments === "string" && item.comments.trim()) ? Number(item.comments) : NaN;
  const comments = Number.isFinite(count) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.trunc(count))) : null;
  return {
    page: { ...page, title: usableTopicTitle(title, page.domain) ? title : "",
      description: usableTopicTitle(description, page.domain) ? description : "" },
    post: {
      id: source + ":" + item.id, source, community: text(item.community, 100),
      title: text(item.postTitle) || title, url: thread.href, postedAt,
      comments,
    },
  };
}

async function fetchFeed({ id, name, target, feed, entries }, since) {
  try {
    const response = await fetch(feed, {
      signal: AbortSignal.timeout(12_000),
      headers: { Accept: "application/json", "User-Agent": "Backchannel Topics/1.0 (backchnnl.app)" },
    });
    if (!response.ok) throw new Error("HTTP " + response.status);
    const items = entries(await response.json()).map((item) => normalizeEntry(id, item, since)).filter(Boolean);
    return { id, name, target, status: "ok", items };
  } catch (error) {
    console.warn("Public feed unavailable", id, target || "general", error.message);
    return { id, name, target, status: "unavailable", items: [] };
  }
}

export async function fetchFeeds(since) {
  const results = [];
  for (let start = 0; start < FEEDS.length; start += FEED_CONCURRENCY) {
    results.push(...await Promise.all(FEEDS.slice(start, start + FEED_CONCURRENCY).map((feed) => fetchFeed(feed, since))));
  }
  return results;
}
