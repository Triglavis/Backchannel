import { canonicalURL, fetchFeeds, topicPageEvidence, usableTopicTitle } from "./feeds.mjs";
import { groupPages } from "./grouping.mjs";
import { buildTopicsIndex, resolvePublishedTopic, retainedEvidenceKeys, RETENTION_MS } from "./index.mjs";
import { addTopicArtwork } from "./artwork.mjs";
import { ARTICLE_PIPELINE_VERSION, MAX_ARTICLE_SOURCES, articleDiscussionKey, articleDiscussions, articleFetchKeys,
  articleSourceKey, buildTopicArticle, isArticlePublisher } from "./article.mjs";
import { articleMembers } from "./article-membership.mjs";
import { prepareTopicDecision } from "./decisions.mjs";
import { serveTopicReviewPage } from "./review-page.mjs";

const MODEL = "@cf/baai/bge-small-en-v1.5";
const DAYS = 7;
const WINDOW_LIMIT = 240;
const GENERAL_WINDOW_LIMIT = WINDOW_LIMIT / 2;
const INTEREST_WINDOW_PER_FEED = 4;
const COVERAGE_PAGE_SIZE = 48;
const COVERAGE_PAGE_BYTES = 4 * 1024 * 1024;
const ARTICLE_BYTES = 192 * 1024;
const ARTICLE_SELECTION_VERSION = ARTICLE_PIPELINE_VERSION + "/public-discussion-rank-v2";
const ARTICLE_THREAD_BATCH = 4096;
const ARTICLE_LOOKUP_BYTES = 1024 * 1024;
const ARTICLE_LEASE_MS = 45_000;
const ARTICLE_WAIT_MS = 900;
const ARTICLE_RETRY_MS = 15 * 60_000;
const ARTICLE_DAILY_BUDGET = 250;
const UTC_DAY_MS = 86_400_000;
const ARTICLE_HEADERS = {
  "Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": "ETag, Retry-After",
  "Content-Type": "application/json; charset=utf-8", "X-Content-Type-Options": "nosniff",
};
const MAX_NEW_EMBEDDINGS = 200;
const EMBEDDING_BATCH_SIZE = 32;
const DIMENSIONS = 384;
const LEASE_MS = 300_000;
const SOURCES_UNAVAILABLE = "sources-unavailable";
const EMPTY_INDEX = JSON.stringify({ version: 1, generatedAt: null, topics: [], pages: [] });
const REPORT_ORIGIN = "https://backchnnl.app";
const REPORT_BODY_LIMIT = 4096;
const REPORT_PROOF_TTL_MS = 5 * 60_000;
const REPORT_RETENTION_MS = 90 * UTC_DAY_MS;
const DECISION_BODY_LIMIT = 512 * 1024;
const REVIEW_HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const REPORT_HEADERS = {
  "Access-Control-Allow-Origin": REPORT_ORIGIN,
  "Access-Control-Allow-Methods": "POST",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Cache-Control": "no-store",
};
const utf8 = new TextEncoder();

function batches(items, size) {
  const result = [];
  for (let start = 0; start < items.length; start += size) result.push(items.slice(start, start + size));
  return result;
}

async function fingerprint(value) {
  const bytes = await crypto.subtle.digest("SHA-256", utf8.encode(value));
  return Array.from(new Uint8Array(bytes).subarray(0, 16), (part) => part.toString(16).padStart(2, "0")).join("");
}

function iso(value) {
  return new Date(value).toISOString();
}

async function saveFeedItems(db, feeds) {
  const changedAt = Date.now();
  const pages = new Map();
  const posts = new Map();
  for (const { items } of feeds) {
    for (const { page, post } of items) {
      let saved = pages.get(page.key);
      if (!saved) {
        saved = { ...page, id: await fingerprint(page.key), alternateTitles: [], posts: [] };
        pages.set(page.key, saved);
      } else if (page.title && page.title !== saved.title) {
        saved.alternateTitles.push(page.title);
      }
      if (!saved.description && page.description) saved.description = page.description;
      saved.posts.push(post);
      const comments = post.comments ?? posts.get(post.id)?.comments ?? null;
      posts.set(post.id, { ...post, key: page.key, pageId: saved.id, comments });
    }
  }
  if (!pages.size) return posts;
  const incoming = [...pages.values()];
  const { results } = await db.prepare("SELECT id, title, description FROM pages WHERE id IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify(incoming.map(({ id }) => id))).all();
  const stored = new Map(results.map((page) => [page.id, page]));
  for (const page of incoming) {
    const prior = stored.get(page.id);
    if (!prior) continue;
    page.alternateTitles.push(prior.title);
    if (usableTopicTitle(prior.description, page.domain)) page.description = prior.description;
  }
  const rows = topicPageEvidence(incoming).map(({ id, url, title, domain, description }) => ({ id, url, title, domain, description }));
  const statements = batches(rows, 50).map((entries) => db.prepare(
    "INSERT INTO pages (id, url, title, domain, description) " +
    "SELECT value->>'id', value->>'url', value->>'title', value->>'domain', value->>'description' FROM json_each(?) WHERE true " +
    "ON CONFLICT(id) DO UPDATE SET title = excluded.title, description = excluded.description " +
    "WHERE pages.title <> excluded.title OR pages.description <> excluded.description"
  ).bind(JSON.stringify(entries)));
  statements.push(...batches([...posts.values()], 50).map((entries) => db.prepare(
    "INSERT INTO posts (id, page_id, source, community, title, url, posted_at, comments, changed_at) " +
    "SELECT value->>'id', value->>'pageId', value->>'source', value->>'community', value->>'title', value->>'url', " +
    "value->>'postedAt', COALESCE(value->>'comments', known.comments, 0), ? FROM json_each(?) " +
    "LEFT JOIN posts AS known ON known.id = value->>'id' WHERE true " +
    "ON CONFLICT(id) DO UPDATE SET page_id = excluded.page_id, title = excluded.title, comments = excluded.comments, changed_at = excluded.changed_at " +
    "WHERE posts.page_id <> excluded.page_id OR posts.title <> excluded.title OR posts.comments <> excluded.comments"
  ).bind(changedAt, JSON.stringify(entries))));
  if (statements.length) await db.batch(statements);
  return posts;
}

function preferredPostIds(feeds) {
  const general = feeds.filter(({ target }) => !target).flatMap(({ items }) => items.map(({ post }) => post));
  general.sort((left, right) => right.postedAt - left.postedAt || left.id.localeCompare(right.id));
  const ids = new Set([...new Set(general.map(({ id }) => id))].slice(0, GENERAL_WINDOW_LIMIT));
  for (const { target, items } of feeds) {
    if (!target) continue;
    for (const { post } of items.slice(0, INTEREST_WINDOW_PER_FEED)) ids.add(post.id);
  }
  return [...ids].slice(0, MAX_NEW_EMBEDDINGS);
}

async function recentPages(db, since, feeds) {
  const ids = preferredPostIds(feeds);
  const { results } = await db.prepare(`
    WITH preferred(id) AS (SELECT value FROM json_each(?)), chosen(id, priority) AS (
      SELECT id, 0 FROM preferred
      UNION ALL
      SELECT id, 1 FROM (
        SELECT id FROM posts WHERE posted_at >= ? AND id NOT IN (SELECT id FROM preferred)
        ORDER BY posted_at DESC, id LIMIT ?
      )
    )
    SELECT p.id, p.url, p.title, p.domain, p.description,
      (SELECT MIN(posted_at) FROM posts WHERE page_id = p.id) AS first_posted_at, s.id AS post_id, s.source,
      s.community, s.title AS post_title, s.url AS post_url, s.posted_at, s.comments
    FROM chosen JOIN posts AS s ON s.id = chosen.id JOIN pages AS p ON p.id = s.page_id
    ORDER BY chosen.priority, s.posted_at DESC, s.id
  `).bind(JSON.stringify(ids), since, WINDOW_LIMIT - ids.length).all();
  const pages = new Map();
  for (const row of results) {
    if (!pages.has(row.id)) pages.set(row.id, {
      id: row.id, url: row.url, title: row.title, domain: row.domain, description: row.description,
      postedAt: row.posted_at, firstPostedAt: row.first_posted_at, publishedAt: null, topicIds: [], posts: [],
    });
    pages.get(row.id).posts.push({
      id: row.post_id, source: row.source, community: row.community, title: row.post_title, url: row.post_url,
      postedAt: iso(row.posted_at), comments: row.comments,
    });
  }
  return topicPageEvidence([...pages.values()]);
}

function packVector(values) {
  if (!Array.isArray(values) || values.length !== DIMENSIONS) throw new Error("Unexpected embedding dimensions");
  const magnitude = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(magnitude) || magnitude === 0) throw new Error("Invalid embedding values");
  const vector = Float32Array.from(values, (value) => value / magnitude);
  return { vector, packed: btoa(String.fromCharCode(...new Uint8Array(vector.buffer))) };
}

function unpackVector(encoded) {
  const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
  return new Float32Array(bytes.buffer);
}

async function embedPages(env, pages) {
  const db = env.TOPICS_DB;
  const inputs = await Promise.all(pages.map(async (page) => {
    const input = [page.title, page.description].filter(Boolean).join("\n");
    return { page, input, revision: await fingerprint(input) };
  }));
  const cached = new Map();
  for (const cluster of batches(inputs, 70)) {
    const { results } = await db.prepare(
      "SELECT page_id, revision, vector FROM embeddings WHERE model = ? AND page_id IN (" + cluster.map(() => "?").join(",") + ")"
    ).bind(MODEL, ...cluster.map(({ page }) => page.id)).all();
    for (const row of results) cached.set(row.page_id + "/" + row.revision, row.vector);
  }
  const missing = [];
  for (const entry of inputs) {
    const encoded = cached.get(entry.page.id + "/" + entry.revision);
    if (encoded) entry.page.vector = unpackVector(encoded);
    else missing.push(entry);
  }
  const stats = { newEmbeddings: 0, reusedEmbeddings: inputs.length - missing.length, inputCharacters: 0, embeddingStatus: "ok" };
  for (const cluster of batches(missing.slice(0, MAX_NEW_EMBEDDINGS), EMBEDDING_BATCH_SIZE)) {
    try {
      const { data } = await env.AI.run(MODEL, { text: cluster.map(({ input }) => input) });
      if (!Array.isArray(data) || data.length !== cluster.length) throw new Error("Unexpected embedding batch size");
      const rows = cluster.map(({ page, revision }, index) => ({ page, revision, ...packVector(data[index]) }));
      await db.prepare(
        "INSERT OR IGNORE INTO embeddings (page_id, model, revision, vector) " +
        "SELECT value->>'id', ?, value->>'revision', value->>'packed' FROM json_each(?)"
      ).bind(MODEL, JSON.stringify(rows.map(({ page, revision, packed }) => ({ id: page.id, revision, packed })))).run();
      for (const { page, vector } of rows) page.vector = vector;
      stats.newEmbeddings += rows.length;
      stats.inputCharacters += cluster.reduce((total, { input }) => total + input.length, 0);
    } catch (error) {
      stats.embeddingStatus = "unavailable";
      console.warn("Embedding batch unavailable", error.message);
      break;
    }
  }
  return { ...stats, pendingEmbeddings: missing.length - stats.newEmbeddings };
}

function summarizeSources(feeds, pages) {
  const sources = new Map();
  for (const { id, name, status, items } of feeds) {
    if (!sources.has(id)) sources.set(id, { id, name, total: 0, successful: 0, fetched: new Set(), posts: 0 });
    const source = sources.get(id);
    source.total++;
    if (status === "ok") source.successful++;
    for (const { post } of items) source.fetched.add(post.id);
  }
  for (const page of pages) for (const { source } of page.posts) {
    const summary = sources.get(source);
    if (summary) summary.posts++;
  }
  return [...sources.values()].map(({ id, name, total, successful, fetched, posts }) => ({
    id, name, posts,
    status: successful === total ? "ok" : successful ? "partial" : "unavailable",
    fetchedPosts: fetched.size,
  }));
}

function buildSnapshot(feeds, pages, embeddings) {
  const byPage = new Map(pages.map((page) => [page.id, page]));
  const topics = groupPages(pages).map((topic) => ({
    ...topic,
    sourceCount: new Set(topic.pageIds.flatMap((id) => byPage.get(id).posts.map((post) => post.source))).size,
  })).sort((left, right) =>
    Number(right.kind === "topic") - Number(left.kind === "topic") ||
    right.sourceCount - left.sourceCount ||
    right.pageIds.length - left.pageIds.length ||
    left.label.localeCompare(right.label)
  );
  const sources = summarizeSources(feeds, pages);
  for (const topic of topics) for (const id of topic.pageIds) byPage.get(id).topicIds.push(topic.id);
  return {
    generatedAt: iso(Date.now()),
    sources,
    stats: {
      ...embeddings, model: MODEL, pages: pages.length, topics: topics.length,
      posts: sources.reduce((count, source) => count + source.posts, 0),
    },
    topics,
    pages: pages.map(({ vector, postedAt, firstPostedAt, ...page }) => page),
  };
}

async function readPreviewIndex(db) {
  const preview = await db.prepare("SELECT generated_at, body FROM public_index WHERE id = 1").first();
  if (!preview) return null;
  return { generated_at: preview.generated_at, ...buildTopicsIndex(JSON.parse(preview.body)) };
}

async function publishIndexes(env, snapshot, owner, observations, pages) {
  const db = env.TOPICS_DB;
  const previous = await db.prepare("SELECT generated_at, body, page_timestamps FROM topics_index WHERE id = 1").first() ||
    await readPreviewIndex(db);
  const generatedAt = Date.parse(snapshot.generatedAt);
  const { results } = await db.prepare("SELECT decision FROM topic_decisions WHERE decision->>'action' <> 'dismiss' ORDER BY id").all();
  const recovered = await recoverPublishedPages(db, previous, generatedAt);
  const since = Math.max(1, previous?.generated_at || 0, generatedAt - RETENTION_MS);
  const changed = await db.prepare(`SELECT s.id, p.url, s.comments FROM posts AS s
    JOIN pages AS p ON p.id = s.page_id WHERE s.changed_at >= ?`).bind(since).all();
  for (const { id, url, comments } of changed.results) {
    const page = canonicalURL(url);
    if (page) observations.set(id, { key: page.key, comments });
  }
  const index = buildTopicsIndex({ ...snapshot, pages }, recovered, results.map(({ decision }) => JSON.parse(decision)), observations);
  const now = Date.now();
  const [, published] = await db.batch([
    db.prepare(
      "INSERT INTO public_index (id, generated_at, body) " +
      "SELECT 1, ?, ? FROM refresh_lease WHERE id = 1 AND owner = ? AND expires_at > ? " +
      "ON CONFLICT(id) DO UPDATE SET generated_at = excluded.generated_at, body = excluded.body"
    ).bind(generatedAt, JSON.stringify(snapshot), owner, now),
    db.prepare(
      "INSERT INTO topics_index (id, generated_at, body, page_timestamps) " +
      "SELECT 1, ?, ?, ? FROM refresh_lease WHERE id = 1 AND owner = ? AND expires_at > ? " +
      "ON CONFLICT(id) DO UPDATE SET generated_at = excluded.generated_at, body = excluded.body, " +
      "page_timestamps = excluded.page_timestamps"
    ).bind(generatedAt, index.body, index.page_timestamps, owner, now),
  ]);
  if (!published.meta.changes) throw new Error("Refresh lease expired before publication");
}

async function refresh(env) {
  const db = env.TOPICS_DB;
  const owner = crypto.randomUUID();
  const now = Date.now();
  const lease = await db.prepare(
    "UPDATE refresh_lease SET owner = ?, expires_at = ? WHERE id = 1 AND expires_at <= ? RETURNING id"
  ).bind(owner, now + LEASE_MS, now).first();
  if (!lease) return null;
  try {
    const since = now - DAYS * 86_400_000;
    const feeds = await fetchFeeds(since);
    if (feeds.every(({ status }) => status !== "ok")) return { status: SOURCES_UNAVAILABLE };
    const observations = await saveFeedItems(db, feeds);
    const pages = await recentPages(db, since, feeds);
    const embeddings = await embedPages(env, pages.filter((page) => page.title));
    const snapshot = buildSnapshot(feeds, pages, embeddings);
    try {
      await addTopicArtwork(db, snapshot, now);
    } catch (error) {
      console.warn("Topic artwork unavailable", error.message);
    }
    await publishIndexes(env, snapshot, owner, observations, pages);
    try {
      await db.batch([
        db.prepare("DELETE FROM topic_articles WHERE expires_at <= ?").bind(now),
        db.prepare("DELETE FROM topic_article_selections WHERE generation <> (SELECT generation FROM topic_article_publication WHERE id = 1)"),
        db.prepare("DELETE FROM topic_article_budget WHERE day < ?").bind(Math.floor(now / UTC_DAY_MS) - 1),
      ]);
    } catch (error) {
      console.warn("Topic article cleanup unavailable", error.message);
    }
    console.log("Topics refresh", JSON.stringify({ ...snapshot.stats, sources: snapshot.sources }));
    return { generatedAt: snapshot.generatedAt, sources: snapshot.sources, stats: snapshot.stats };
  } finally {
    await db.prepare("UPDATE refresh_lease SET expires_at = 0, owner = '' WHERE id = 1 AND owner = ?").bind(owner).run();
  }
}

function authorized(request, token) {
  const provided = request.headers.get("Authorization") || "";
  if (!token || provided.length !== token.length + 7 || !provided.startsWith("Bearer ")) return false;
  let difference = 0;
  for (let index = 0; index < token.length; index++) {
    difference |= provided.charCodeAt(index + 7) ^ token.charCodeAt(index);
  }
  return difference === 0;
}

async function serveIndex(request, db) {
  const current = await db.prepare("SELECT generated_at, body FROM topics_index WHERE id = 1").first();
  const stored = current || await readPreviewIndex(db);
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers": "ETag",
    "Cache-Control": "no-store",
  };
  if (stored) {
    headers["Cache-Control"] = "public, max-age=120, stale-while-revalidate=600";
    const validator = '"topics-v1-' + (current ? "" : "preview-") + stored.generated_at + '"';
    headers.ETag = "W/" + validator;
    const validators = (request.headers.get("If-None-Match") || "").split(",")
      .map((value) => value.trim().replace(/^W\//, ""));
    if (validators.includes(validator) || validators.includes("*")) return new Response(null, { status: 304, headers });
  }
  return new Response(request.method === "HEAD" ? null : (stored?.body ?? EMPTY_INDEX), { headers });
}

async function readPublishedTopics(db) {
  const stored = await db.prepare("SELECT body FROM topics_index WHERE id = 1").first() || await readPreviewIndex(db);
  return stored ? JSON.parse(stored.body) : null;
}

async function coverageRows(db, ids) {
  const { results } = await db.prepare(`
    WITH wanted AS (SELECT value AS id FROM json_each(?)), threads AS (
      SELECT s.*, ROW_NUMBER() OVER (PARTITION BY s.page_id ORDER BY s.posted_at DESC, s.id) AS rank
      FROM posts AS s JOIN wanted ON wanted.id = s.page_id
    )
    SELECT p.id AS page_id, p.url, p.title, p.domain, s.id AS post_id,
      s.url AS post_url, s.title AS post_title, s.source, s.community, s.posted_at, s.comments
    FROM wanted JOIN pages AS p ON p.id = wanted.id
    LEFT JOIN threads AS s ON s.page_id = p.id AND s.rank <= ?
    ORDER BY p.id, s.posted_at DESC, s.id
  `).bind(JSON.stringify(ids), WINDOW_LIMIT).all();
  return results;
}

async function recoverPublishedPages(db, previous, now) {
  if (!previous) return null;
  const index = JSON.parse(previous.body);
  const timestamps = JSON.parse(previous.page_timestamps);
  const missing = index.pages.filter((page, position) => !page.posts?.length && timestamps[position] >= now - RETENTION_MS);
  if (missing.length) {
    const ids = await Promise.all(missing.map(({ key }) => fingerprint(key)));
    const pages = new Map(ids.map((id, index) => [id, missing[index]]));
    for (const { page_id, post_id, comments } of await coverageRows(db, ids)) {
      if (post_id) (pages.get(page_id).posts ??= []).push([post_id, comments]);
    }
  }
  const keys = retainedEvidenceKeys(index, timestamps, now);
  const recovered = missing.length ? { ...previous, body: JSON.stringify(index) } : previous;
  if (!keys.length) return recovered;
  const ids = await Promise.all(keys.map(fingerprint));
  const indexedKeys = new Map(ids.map((id, position) => [id, keys[position]]));
  const { results } = await db.prepare(`
    SELECT p.id, p.url, p.title, p.domain, p.description,
      (SELECT MIN(posted_at) FROM posts WHERE page_id = p.id) AS firstPostedAt, (
      SELECT json_group_array(json_object('title', title, 'postedAt', posted_at)) FROM (
        SELECT title, posted_at FROM posts WHERE page_id = p.id ORDER BY posted_at DESC, id LIMIT 8
      )
    ) AS threads
    FROM json_each(?) AS wanted JOIN pages AS p ON p.id = wanted.value
  `).bind(JSON.stringify(ids)).all();
  const sourcePages = results.filter(({ firstPostedAt }) => Number.isFinite(firstPostedAt)).map(({ threads, ...page }) => {
    const posts = JSON.parse(threads);
    return { ...page, key: indexedKeys.get(page.id), postedAt: posts[0].postedAt, posts };
  });
  return { ...recovered, sourcePages };
}

async function serveTopicCoverage(url, db) {
  const headers = { "Access-Control-Allow-Origin": "*", "X-Content-Type-Options": "nosniff" };
  const offset = Number(url.searchParams.get("offset") ?? 0);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    return Response.json({ error: "Invalid coverage offset" }, { status: 400, headers: { ...headers, "Cache-Control": "no-store" } });
  }
  const index = await readPublishedTopics(db);
  const topic = resolvePublishedTopic(index, url.searchParams.get("id"));
  if (!topic) return Response.json({ error: "Topic not found" }, { status: 404, headers: { ...headers, "Cache-Control": "no-store" } });
  const indexed = index.pages.filter(({ topicIds }) => topicIds.includes(topic.id));
  const ids = await Promise.all(indexed.slice(offset, offset + COVERAGE_PAGE_SIZE).map(({ key }) => fingerprint(key)));
  const stored = new Map();
  for (const row of ids.length ? await coverageRows(db, ids) : []) {
    if (!stored.has(row.page_id)) stored.set(row.page_id, {
      id: row.page_id, url: row.url, title: row.title, domain: row.domain, postedAt: row.posted_at === null ? null : iso(row.posted_at), posts: [],
    });
    if (row.post_id) stored.get(row.page_id).posts.push({
      id: row.post_id, url: row.post_url, title: row.post_title, source: row.source, community: row.community,
      postedAt: iso(row.posted_at), comments: row.comments,
    });
  }
  const links = new Map(topicPageEvidence([...stored.values()]).map(({ id, ...link }) => [id, link]));
  const page = [];
  let position = offset;
  let bytes = 4096;
  for (const id of ids) {
    const link = links.get(id);
    if (link) {
      link.title ||= link.url;
      const size = utf8.encode(JSON.stringify(link)).byteLength + 1;
      if (page.length && bytes + size > COVERAGE_PAGE_BYTES) break;
      bytes += size;
      page.push(link);
    }
    position++;
  }
  return Response.json({ version: 1, topic, links: page, generatedAt: index.generatedAt, nextOffset: position < indexed.length ? position : null }, {
    headers: { ...headers, "Cache-Control": "public, max-age=120, stale-while-revalidate=600" },
  });
}

const FIRST_ARTICLE_SHARE = `(SELECT MIN(s.posted_at) FROM posts AS s WHERE s.page_id = p.id
  AND (w.threads IS NULL OR s.id IN (SELECT value FROM json_each(w.threads))))`;

async function firstArticleShares(db, pages) {
  const ids = await Promise.all(pages.map(({ key }) => fingerprint(key)));
  const wanted = pages.map(({ posts }, i) => [ids[i], posts?.map(([id]) => id) ?? null]);
  const { results } = await db.prepare(`
    WITH wanted AS (SELECT key AS ordinal, value->>0 AS id, value->>1 AS threads FROM json_each(?))
    SELECT w.ordinal, ${FIRST_ARTICLE_SHARE} AS shared FROM wanted AS w JOIN pages AS p ON p.id = w.id
  `).bind(JSON.stringify(wanted)).all();
  return new Map(results.filter(({ shared }) => Number.isFinite(shared)).map(({ ordinal, shared }) => [pages[ordinal].key, shared]));
}

async function articleCandidates(db, index, topic) {
  const eligible = await articleMembers(index, topic, (pages) => firstArticleShares(db, pages));
  const members = eligible.map((page) => ({ ...page, family: articleSourceKey("https://" + page.key) })).filter(({ family }) => family)
    .sort((a, b) => a.family.localeCompare(b.family) || a.key.length - b.key.length || a.key.localeCompare(b.key));
  const ids = await Promise.all(members.map(({ key }) => fingerprint(key)));
  const stored = new Map();
  for (const batch of batches(ids, 512)) {
    const { results } = await db.prepare("SELECT p.id, p.url FROM json_each(?) AS ids JOIN pages AS p ON p.id = ids.value")
      .bind(JSON.stringify(batch)).all();
    for (const { id, url } of results) stored.set(id, url);
  }
  const families = new Map();
  const byPage = new Map();
  for (const [i, { key, family, topicIds, posts }] of members.entries()) {
    const id = ids[i], url = stored.get(id);
    if (!url || canonicalURL(url)?.key !== key) continue;
    if (!families.has(family)) families.set(family, { id: families.size, key: family, threads: new Map() });
    const group = families.get(family);
    const candidate = { id, url, family: group.id, threads: [], discussionOnly: !isArticlePublisher(url), priority: topicIds.includes(topic.id) ? 0 : 1 };
    byPage.set(id, { candidate, group, key, host: new URL(url).host, allowed: posts && new Set(posts.map(([id]) => id)) });
  }
  const remember = (entry, post) => {
    const key = articleDiscussionKey(post);
    if (!key) return;
    const { group, candidate } = entry;
    if (key === entry.key || (key.startsWith(entry.host + "/") && articleSourceKey(post.url) === group.key)) candidate.discussionOnly = true;
    if (!group.threads.has(key)) group.threads.set(key, group.threads.size);
    candidate.threads.push([post.id, group.threads.get(key)]);
  };
  const published = new Set([...byPage.values()].flatMap(({ allowed }) => allowed ? [...allowed] : []));
  for (const batch of batches([...published], ARTICLE_THREAD_BATCH)) {
    let offset = 0;
    while (offset < batch.length) {
      const { results } = await db.prepare(`
        WITH matches AS (
          SELECT ids.key AS ordinal, s.id, s.page_id, s.url, s.source, row_number() OVER by_id AS position,
            SUM(length(CAST(s.id || s.page_id || s.url || s.source AS BLOB)) + 96) OVER by_id AS bytes
          FROM json_each(?) AS ids JOIN posts AS s ON s.id = ids.value WINDOW by_id AS (ORDER BY ids.key)
        )
        SELECT ordinal, id, page_id, url, source FROM matches WHERE bytes <= ? OR position = 1 ORDER BY ordinal
      `).bind(JSON.stringify(batch.slice(offset)), ARTICLE_LOOKUP_BYTES).all();
      if (!results.length) break;
      for (const post of results) {
        const entry = byPage.get(post.page_id);
        if (entry?.allowed?.has(post.id)) remember(entry, post);
      }
      offset += results.at(-1).ordinal + 1;
    }
  }
  const legacy = [...byPage].filter(([, entry]) => !entry.allowed).map(([id]) => id);
  if (legacy.length) {
    let cursor = 0;
    while (true) {
      const { results } = await db.prepare(`
        SELECT s.rowid, s.id, s.page_id, s.url, s.source FROM json_each(?) AS pages JOIN posts AS s ON s.page_id = pages.value
        WHERE s.rowid > ? ORDER BY s.rowid LIMIT ?
      `).bind(JSON.stringify(legacy), cursor, 512).all();
      for (const post of results) remember(byPage.get(post.page_id), post);
      if (results.length < 512) break;
      cursor = results.at(-1).rowid;
    }
  }
  return [...byPage.values()].map(({ candidate }) => candidate);
}

function articleThreadQuery(db, candidates, query) {
  const chunks = [];
  let rows = [], bytes = 2;
  for (const [ordinal, { id, url, family, threads, priority, discussionOnly }] of candidates.entries()) {
    for (const group of threads.length ? batches(threads, 512) : [[]]) {
      const row = JSON.stringify([ordinal, id, url, family, group, priority, +discussionOnly]);
      const size = utf8.encode(row).byteLength + 1;
      if (rows.length && bytes + size > ARTICLE_LOOKUP_BYTES) {
        chunks.push("[" + rows.join(",") + "]");
        rows = [];
        bytes = 2;
      }
      rows.push(row);
      bytes += size;
    }
  }
  chunks.push("[" + rows.join(",") + "]");
  const inputs = chunks.map(() => "SELECT value FROM json_each(?)").join(" UNION ALL ");
  return db.prepare(`WITH inputs AS (${inputs}), wanted AS MATERIALIZED (
    SELECT i.value->>0 AS ordinal, p.id, p.domain, i.value->>3 AS family, i.value->>4 AS threads,
      i.value->>5 AS priority, i.value->>6 AS discussion_only
    FROM inputs AS i JOIN pages AS p ON p.id = i.value->>1 AND p.url = i.value->>2
  ), copies AS (
    SELECT w.family, s.id, s.posted_at, s.comments,
      MIN(s.posted_at) OVER (PARTITION BY w.family, thread.value->>1) AS first_shared,
      ROW_NUMBER() OVER (PARTITION BY w.family, thread.value->>1 ORDER BY s.changed_at DESC, s.posted_at DESC, s.id) AS copy
    FROM wanted AS w CROSS JOIN json_each(w.threads) AS thread CROSS JOIN posts AS s ON s.id = thread.value->>0 AND s.page_id = w.id
  ), ${query}`).bind(...chunks);
}

async function articleEvidence(db, wanted) {
  if (!wanted.length) return { pages: [], selected: [] };
  const { results } = await articleThreadQuery(db, wanted, `
    activity AS (
      SELECT family, MIN(first_shared) AS shared, COUNT(*) AS discussions,
        MIN(9007199254740991, TOTAL(CASE WHEN comments BETWEEN 0 AND 9007199254740991 AND typeof(comments) = 'integer' THEN comments END)) AS replies
      FROM copies WHERE copy = 1 GROUP BY family
    ), members AS (
      SELECT DISTINCT ordinal, id, domain, family, priority, discussion_only FROM wanted
    ), families AS (
      SELECT w.family, MIN(w.priority) AS priority, MIN(w.domain) AS domain, MAX(w.discussion_only) AS discussion_only,
        a.shared, COALESCE(a.discussions, 0) AS discussions, COALESCE(a.replies, 0) AS replies
      FROM members AS w LEFT JOIN activity AS a ON a.family = w.family GROUP BY w.family
    ), ranked AS (
      SELECT *, row_number() OVER (PARTITION BY discussion_only, domain ORDER BY replies DESC, discussions DESC, priority, shared DESC, family) AS publisher_rank
      FROM families
    ), picked AS (
      SELECT * FROM ranked ORDER BY discussion_only, publisher_rank, replies DESC, discussions DESC, priority, shared DESC, family LIMIT ${MAX_ARTICLE_SOURCES}
    ), variants AS (
      SELECT w.ordinal, w.id, f.family, f.shared, f.priority, f.discussion_only, f.replies, f.discussions,
        row_number() OVER (PARTITION BY w.family ORDER BY w.priority, w.ordinal) AS variant
      FROM picked AS f JOIN members AS w ON w.family = f.family
    )
    SELECT v.ordinal, v.family, v.shared, v.discussion_only, v.replies, v.discussions, p.url, p.domain, p.title, p.description
    FROM variants AS v JOIN pages AS p ON p.id = v.id WHERE v.variant <= 8
    ORDER BY v.priority, v.shared DESC, v.family, v.variant
  `).all();

  const pages = new Map();
  for (const { ordinal, family, shared, discussion_only, replies, discussions, url, domain, title, description } of results) {
    const member = wanted[ordinal];
    let page = pages.get(family);
    if (!page) {
      page = { url, domain, title, description, formal: member.priority === 0, discussionOnly: !!discussion_only,
        replyCount: replies, discussionCount: discussions, firstPostedAt: shared, postedAt: shared, alternateTitles: [], posts: [] };
      pages.set(family, page);
    } else {
      if (member.priority === 0) page.formal = true;
      page.alternateTitles.push(title);
      if (!usableTopicTitle(page.description, domain) && usableTopicTitle(description, domain)) page.description = description;
    }
  }
  const selected = wanted.filter(({ family }) => pages.has(family));
  if (!selected.length) return { pages: [], selected };
  const threads = await articleThreadQuery(db, selected, `
    ranked AS (
      SELECT family, id, row_number() OVER (PARTITION BY family ORDER BY posted_at DESC, id) AS rank FROM copies WHERE copy = 1
    )
    SELECT r.family, s.id, s.source, s.title, s.url, s.posted_at AS postedAt, s.comments
    FROM ranked AS r JOIN posts AS s ON s.id = r.id WHERE r.rank <= 12 ORDER BY r.family, r.rank
  `).all();
  for (const { family, ...post } of threads.results) {
    const page = pages.get(family);
    if (!page.posts.length) page.postedAt = post.postedAt;
    page.posts.push(post);
  }
  return { pages: topicPageEvidence([...pages.values()]), selected };
}

async function readArticleInput(db, id) {
  const lookup = await db.prepare(`
    SELECT g.generation, s.topic_id, s.label, s.members, EXISTS(SELECT 1 FROM topics_index WHERE id = 1) AS published,
      COALESCE((SELECT MAX(changed_at) FROM posts), 0) AS changed_at
    FROM topic_article_publication AS g LEFT JOIN topic_article_selections AS r ON r.request_id = ? AND r.generation = g.generation
    LEFT JOIN topic_article_selections AS s ON s.request_id = r.topic_id AND s.generation = g.generation WHERE g.id = 1
  `).bind(id).first();
  const cached = lookup.members && JSON.parse(lookup.members);
  let topic, pages;
  if (cached?.version === ARTICLE_SELECTION_VERSION && (cached.partialSince === undefined || cached.partialSince === lookup.changed_at)) {
    topic = { id: lookup.topic_id, label: lookup.label };
    ({ pages } = await articleEvidence(db, cached.pages));
  } else {
    const index = await readPublishedTopics(db);
    topic = resolvePublishedTopic(index, id);
    if (!topic) return null;
    const candidates = await articleCandidates(db, index, topic);
    const evidence = await articleEvidence(db, candidates);
    pages = evidence.pages;
    if (lookup.published && pages.length) {
      let members = JSON.stringify({ version: ARTICLE_SELECTION_VERSION, pages: candidates });
      if (utf8.encode(members).byteLength > ARTICLE_BYTES) {
        members = JSON.stringify({ version: ARTICLE_SELECTION_VERSION, pages: evidence.selected, partialSince: lookup.changed_at });
      }
      if (utf8.encode(members).byteLength <= ARTICLE_BYTES) {
        const addresses = [topic.id, ...Object.keys(index.redirects || {}).filter((alias) => index.redirects[alias] === topic.id)];
        await db.prepare(`
          INSERT INTO topic_article_selections (request_id, generation, topic_id, label, members)
          SELECT value, g.generation, ?, ?, CASE WHEN value = ? THEN ? ELSE 'null' END
          FROM json_each(?) JOIN topic_article_publication AS g WHERE g.id = 1 AND g.generation = ?
          ON CONFLICT(request_id) DO UPDATE SET generation = excluded.generation, topic_id = excluded.topic_id,
            label = excluded.label, members = excluded.members
        `).bind(topic.id, topic.label, topic.id, members, JSON.stringify(addresses), lookup.generation).run();
      }
    }
  }
  const revision = await fingerprint(JSON.stringify([ARTICLE_SELECTION_VERSION, topic.id, topic.label, articleFetchKeys(topic, pages),
    pages.map(({ url, title, domain, formal, description, firstPostedAt }) => [url, title, domain, formal, description, firstPostedAt])]));
  return { topic, pages, revision, generation: lookup.generation };
}

function articleStatus(status, retryAfter) {
  const headers = { ...ARTICLE_HEADERS, "Cache-Control": "no-store" };
  if (retryAfter) headers["Retry-After"] = String(retryAfter);
  const messages = {
    400: "One published topic ID is required", 404: "Topic not found", 429: "New briefs are temporarily at capacity",
    503: "Public coverage is temporarily unavailable",
  };
  return Response.json(status === 202 ? { status: "generating" } : { error: messages[status] }, { status, headers });
}

function readArticleRow(db, input) {
  return db.prepare(`SELECT body, lease_until, retry_at, expires_at FROM topic_articles WHERE topic_id = ? AND revision = ?
    AND (SELECT generation FROM topic_article_publication WHERE id = 1) = ?`)
    .bind(input.topic.id, input.revision, input.generation).first();
}

async function articleResponse(request, input, row) {
  const now = Date.now();
  if (!row?.body) {
    if (row?.retry_at > now) return articleStatus(503, Math.ceil((row.retry_at - now) / 1000));
    return articleStatus(202, 2);
  }
  const article = JSON.parse(row.body);
  const sources = new Map(input.pages.map((page) => [articleSourceKey(page.url), page]));
  let remaining = ARTICLE_BYTES - utf8.encode(row.body).byteLength;
  for (const source of article.sources) {
    source.discussions = [];
    for (const discussion of articleDiscussions(sources.get(articleSourceKey(source.url))?.posts || [])) {
      const bytes = utf8.encode(JSON.stringify(discussion)).byteLength + Number(source.discussions.length > 0);
      if (bytes > remaining) continue;
      source.discussions.push(discussion);
      remaining -= bytes;
    }
  }
  const body = JSON.stringify(article);
  const etag = '"' + await fingerprint(body) + '"';
  const headers = { ...ARTICLE_HEADERS, "Cache-Control": "public, no-cache", ETag: etag };
  if (row.retry_at > now || row.lease_until > now) {
    headers["Retry-After"] = String(Math.max(2, Math.ceil((row.retry_at - now) / 1000)));
  }
  const validators = (request.headers.get("If-None-Match") || "").split(",").map((value) => value.trim().replace(/^W\//, ""));
  if (validators.includes(etag) || validators.includes("*")) return new Response(null, { status: 304, headers });
  return new Response(body, { headers });
}

function reportingCoverage(article) {
  const paragraphs = article.sections.flatMap((section) => section.paragraphs);
  const sources = new Set(paragraphs.flatMap((paragraph) => paragraph.sourceIds));
  return [sources.size, Number(article.method === "synthesis"), paragraphs.length, article.images?.length || 0, article.timeline.length];
}

function keepStoredReporting(body, candidate) {
  const prior = reportingCoverage(JSON.parse(body)), next = reportingCoverage(candidate);
  for (let i = 0; i < prior.length; i++) {
    if (prior[i] !== next[i]) return prior[i] > next[i];
  }
  return true;
}

async function generateArticle(request, env, id, input, owner, claim) {
  const db = env.TOPICS_DB;
  let body = claim.body;
  let retry = true;
  try {
    const now = Date.now();
    const previous = await db.prepare(`SELECT body FROM topic_articles
      WHERE topic_id = ? AND revision <> ? AND body IS NOT NULL AND retry_at = 0 AND expires_at > ?
        AND json_extract(body, '$.generatedAt') < ?
      ORDER BY json_extract(body, '$.generatedAt') DESC, revision LIMIT 1`)
      .bind(input.topic.id, input.revision, now, iso(now)).first("body");
    let status;
    const article = await buildTopicArticle(input.topic, input.pages, {
      ai: env.AI, fetcher: fetch, now, previous: previous && JSON.parse(previous), onStatus: (value) => { status = value; },
    });
    for (const source of article.sources) source.discussions = [];
    const content = JSON.stringify(article);
    const hasParagraphs = article.sections.some(({ paragraphs }) => paragraphs.length);
    if (article.sources.length && (hasParagraphs || article.method === "coverage") && utf8.encode(content).byteLength <= ARTICLE_BYTES) {
      retry = status === "unavailable" || status === "rejected";
      if (!retry || !body || !keepStoredReporting(body, article)) body = content;
    }
  } catch (error) {
    console.warn("Topic article generation unavailable", error.name);
  }
  const current = await readArticleInput(db, id);
  if (!current || current.topic.id !== input.topic.id || current.revision !== input.revision) {
    await db.prepare("DELETE FROM topic_articles WHERE topic_id = ? AND revision = ? AND owner = ?")
      .bind(input.topic.id, input.revision, owner).run();
    return articleStatus(current ? 202 : 404, current ? 2 : 0);
  }
  const now = Date.now();
  const backoff = ARTICLE_RETRY_MS * 2 ** Math.min(5, claim.failures);
  const row = await db.prepare(`UPDATE topic_articles SET body = ?, owner = NULL, lease_until = 0,
    retry_at = ?, failures = ?, expires_at = ? WHERE topic_id = ? AND revision = ? AND owner = ? AND lease_until > ?
    AND (SELECT generation FROM topic_article_publication WHERE id = 1) = ?
    RETURNING body, lease_until, retry_at`)
    .bind(body, retry ? now + backoff : 0, retry ? claim.failures + 1 : 0, now + RETENTION_MS,
      input.topic.id, input.revision, owner, now, current.generation).first();
  if (!row) {
    await db.prepare("UPDATE topic_articles SET owner = NULL, lease_until = 0 WHERE topic_id = ? AND revision = ? AND owner = ?")
      .bind(input.topic.id, input.revision, owner).run();
  }
  return articleResponse(request, current, row || await readArticleRow(db, current));
}

async function serveTopicArticle(request, url, env, context) {
  if (url.searchParams.size !== 1 || !url.searchParams.has("id")) return articleStatus(400);
  const id = url.searchParams.get("id");
  if (id.length > 272 || !/^(?:topic|story|coverage):[^\s\x00-\x1f]+$/u.test(id)) return articleStatus(404);
  const db = env.TOPICS_DB;
  const input = await readArticleInput(db, id);
  if (!input) return articleStatus(404);
  if (!input.pages.length) return articleStatus(503, 60);
  const now = Date.now();
  const row = await readArticleRow(db, input);
  if (row && (row.lease_until > now || row.retry_at > now || (row.body && !row.retry_at))) {
    if (row.expires_at < now + RETENTION_MS / 2) {
      await db.prepare("UPDATE topic_articles SET expires_at = ? WHERE topic_id = ? AND revision = ?")
        .bind(now + RETENTION_MS, input.topic.id, input.revision).run();
    }
    return articleResponse(request, input, row);
  }

  const owner = crypto.randomUUID();
  const day = Math.floor(now / UTC_DAY_MS);
  const configuredBudget = Number(env.TOPIC_ARTICLE_DAILY_BUDGET ?? ARTICLE_DAILY_BUDGET);
  const budget = Number.isSafeInteger(configuredBudget) && configuredBudget >= 0 ? configuredBudget : ARTICLE_DAILY_BUDGET;
  const [{ results: [claim] }] = await db.batch([
    db.prepare(`INSERT INTO topic_articles (topic_id, revision, owner, lease_until, expires_at)
      SELECT ?, ?, ?, ?, ? FROM topic_article_publication WHERE id = 1 AND generation = ?
      AND COALESCE((SELECT generations FROM topic_article_budget WHERE day = ?), 0) < ?
      ON CONFLICT(topic_id, revision) DO UPDATE SET owner = excluded.owner, lease_until = excluded.lease_until, expires_at = excluded.expires_at
      WHERE topic_articles.lease_until <= ? AND topic_articles.retry_at <= ? AND (topic_articles.body IS NULL OR topic_articles.retry_at > 0)
      RETURNING body, failures`)
      .bind(input.topic.id, input.revision, owner, now + ARTICLE_LEASE_MS, now + RETENTION_MS, input.generation, day, budget, now, now),
    db.prepare(`INSERT INTO topic_article_budget (day, generations)
      SELECT ?, 1 FROM topic_articles WHERE topic_id = ? AND revision = ? AND owner = ?
      ON CONFLICT(day) DO UPDATE SET generations = generations + 1`).bind(day, input.topic.id, input.revision, owner),
  ]);
  if (!claim) {
    const current = await readArticleRow(db, input);
    if (current?.body || current?.lease_until > now || current?.retry_at > now) return articleResponse(request, input, current);
    const used = await db.prepare("SELECT generations FROM topic_article_budget WHERE day = ?").bind(day).first("generations") ?? 0;
    return used >= budget ? articleStatus(429, Math.ceil(((day + 1) * UTC_DAY_MS - now) / 1000)) : articleStatus(202, 2);
  }

  const generation = generateArticle(request, env, id, input, owner, claim).catch(articleStorageError);
  if (!context?.waitUntil) return generation;
  context.waitUntil(generation.then(() => {}));
  let timer;
  try {
    return await Promise.race([generation, new Promise((resolve) => {
      timer = setTimeout(() => resolve(articleStatus(202, 2)), ARTICLE_WAIT_MS);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

function articleStorageError(error) {
  console.warn("Topic article storage unavailable", error.message);
  return articleStatus(503, 60);
}

function topicReportStatus(status) {
  return new Response(null, { status, headers: REPORT_HEADERS });
}

async function readTopicJSON(request, limit) {
  if (Number(request.headers.get("Content-Length")) > limit) return { status: 413 };
  if (!request.body || request.headers.get("Content-Type")?.split(";", 1)[0].trim() !== "application/json") return { status: 400 };
  const reader = request.body.getReader();
  const bytes = new Uint8Array(limit);
  let size = 0;
  for (let part = await reader.read(); !part.done; part = await reader.read()) {
    if (size + part.value.byteLength > limit) {
      await reader.cancel();
      return { status: 413 };
    }
    bytes.set(part.value, size);
    size += part.value.byteLength;
  }
  try { return { payload: JSON.parse(new TextDecoder().decode(bytes.subarray(0, size))) }; }
  catch { return { status: 400 }; }
}

function decodeBase64URL(value) {
  return Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (character) => character.charCodeAt(0));
}

async function verifyTopicProof(token, secret, scope) {
  const match = typeof token === "string" && /^v1\.([A-Za-z0-9_-]{1,512})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!secret || !match) return null;
  const [, payload, signature] = match;
  try {
    const key = await crypto.subtle.importKey("raw", utf8.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    if (!await crypto.subtle.verify("HMAC", key, decodeBase64URL(signature), utf8.encode("v1." + payload))) return null;
    const proof = JSON.parse(new TextDecoder().decode(decodeBase64URL(payload)));
    const now = Date.now();
    return proof?.aud === "backchannel-topics" && proof.scope === scope &&
      typeof proof.sub === "string" && /^[a-f0-9]{32}$/.test(proof.sub) && Number.isSafeInteger(proof.exp) &&
      proof.exp > now && proof.exp <= now + REPORT_PROOF_TTL_MS ? proof : null;
  } catch { return null; }
}

async function topicReporter(request, env) {
  if (!env.TOPIC_REPORT_TOKEN_SECRET) return { status: 503 };
  const authorization = request.headers.get("Authorization") || "";
  let token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (/^[A-Za-z0-9_-]{43}$/.test(token) && env.ACCOUNTS) {
    try {
      const response = await env.ACCOUNTS.fetch(new Request(REPORT_ORIGIN + "/account/topic-report-token", {
        method: "POST", headers: { Authorization: authorization }, redirect: "error", signal: AbortSignal.timeout(5000),
      }));
      if (!response.ok) return { status: [401, 429].includes(response.status) ? response.status : 503 };
      token = (await response.json()).token;
    } catch { return { status: 503 }; }
  }
  const proof = await verifyTopicProof(token, env.TOPIC_REPORT_TOKEN_SECRET, "topic:report");
  return proof ? { proof } : { status: 401 };
}

async function deleteAccountReports(request, env) {
  const authorization = request.headers.get("Authorization") || "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const proof = await verifyTopicProof(token, env.TOPIC_REPORT_TOKEN_SECRET, "topic:report:delete");
  if (!proof) return new Response(null, { status: 401, headers: REVIEW_HEADERS });
  const db = env.TOPICS_DB;
  await db.batch([
    db.prepare(`INSERT INTO topic_report_revocations (reporter_id, revoked_until) VALUES (?, ?)
      ON CONFLICT (reporter_id) DO UPDATE SET revoked_until = MAX(revoked_until, excluded.revoked_until)`)
      .bind(proof.sub, Date.now() + REPORT_PROOF_TTL_MS),
    db.prepare("DELETE FROM topic_reports WHERE reporter_id = ?").bind(proof.sub),
  ]);
  return new Response(null, { status: 204, headers: REVIEW_HEADERS });
}

async function receiveTopicReport(request, env) {
  const origin = request.headers.get("Origin");
  if (origin && origin !== REPORT_ORIGIN) return topicReportStatus(403);
  if (request.method === "OPTIONS") return topicReportStatus(204);
  const { status: authStatus, proof } = await topicReporter(request, env);
  if (authStatus) return topicReportStatus(authStatus);
  const reporter = proof.sub;
  if (!(await env.TOPIC_REPORT_RATE_LIMIT.limit({ key: reporter })).success) return topicReportStatus(429);
  const { status, payload } = await readTopicJSON(request, REPORT_BODY_LIMIT);
  if (status) return topicReportStatus(status);
  const page = typeof payload?.url === "string" && canonicalURL(payload.url);
  const { topic = "", suggestedTopic = "" } = payload ?? {};
  if (!page || typeof topic !== "string" || topic.length > 512 ||
    typeof suggestedTopic !== "string" || suggestedTopic.length > 120) return topicReportStatus(400);
  const pageId = await fingerprint(page.key);
  const now = Date.now();
  if (proof.exp <= now) return topicReportStatus(401);
  const reportUrl = new URL(page.url);
  reportUrl.search = "";
  const stored = await env.TOPICS_DB.prepare(`
    INSERT INTO topic_reports (page_id, reporter_id, url, topic, suggested_topic, reported_at)
    SELECT ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (
      SELECT 1 FROM topic_report_revocations WHERE reporter_id = ? AND revoked_until > ?
    )
    ON CONFLICT (page_id, reporter_id) DO UPDATE SET
      url = excluded.url, topic = excluded.topic, suggested_topic = excluded.suggested_topic, reported_at = excluded.reported_at
  `).bind(pageId, reporter, reportUrl.href,
    topic.trim().replace(/\s+/g, " "), suggestedTopic.trim().replace(/\s+/g, " "), now, reporter, now).run();
  return topicReportStatus(stored.meta.changes ? 204 : 401);
}

async function reviewTopicReports(db, url) {
  const offset = Number(url.searchParams.get("offset") ?? 0);
  if (!Number.isSafeInteger(offset) || offset < 0) return reviewError(400, "Invalid report offset");
  const pending = url.searchParams.get("pending") === "1";
  const limit = 100;
  const { results } = await db.prepare(`
    SELECT ${pending ? "r.page_id AS reportPageId," : ""}
      COALESCE(p.url, MIN(r.url)) AS url, p.title, r.topic, r.suggested_topic AS suggestedTopic,
      COUNT(*) AS count, MAX(r.reported_at) AS lastReportedAt
    FROM topic_reports AS r LEFT JOIN pages AS p ON p.id = r.page_id
    WHERE r.reported_at > ?
    ${pending ? `AND NOT EXISTS (SELECT 1 FROM topic_decisions AS d
      WHERE d.report_page_id = r.page_id AND d.decided_at >= r.reported_at)` : ""}
    GROUP BY r.page_id, r.topic, r.suggested_topic
    ORDER BY count DESC, lastReportedAt DESC, r.page_id, r.topic, r.suggested_topic LIMIT ? OFFSET ?
  `).bind(Date.now() - REPORT_RETENTION_MS, limit + 1, offset).all();
  const nextOffset = results.length > limit ? offset + limit : null;
  const reports = results.slice(0, limit);
  if (pending && reports.length) {
    const index = await readPublishedTopics(db);
    const names = new Map();
    for (const topic of index?.topics || []) {
      const key = topic.label.trim().toLowerCase();
      names.set(key, names.has(key) ? null : topic.id);
    }
    const pages = new Map((index?.pages || []).map((page) => [page.key, page.topicIds]));
    for (const report of reports) {
      const key = canonicalURL(report.url)?.key;
      const ids = pages.get(key);
      if (!ids || await fingerprint(key) !== report.reportPageId) continue;
      const labelId = names.get(report.topic.trim().toLowerCase());
      if (ids.includes(labelId)) report.topicId = labelId;
      else if (ids.length === 1) report.topicId = ids[0];
    }
  }
  return Response.json({ reports, nextOffset }, { headers: REVIEW_HEADERS });
}

function reviewError(status, error) {
  return Response.json({ error }, { status, headers: REVIEW_HEADERS });
}

function reviewAccepted(requestId, decision) {
  return Response.json({ id: requestId, ...(decision.target ? { topicId: decision.target.id } : {}) }, {
    status: 201, headers: REVIEW_HEADERS,
  });
}

async function receiveTopicDecision(request, env, url) {
  if (!authorized(request, env.TOPIC_REVIEW_TOKEN)) return reviewError(401, "A valid operator token is required");
  const origin = request.headers.get("Origin");
  if (origin && origin !== url.origin) return reviewError(403, "Open the review page on the Topics host");
  const { payload, status } = await readTopicJSON(request, DECISION_BODY_LIMIT);
  if (status) return reviewError(status, status === 413 ? "This review is too large" : "Invalid review data");
  const requestId = payload?.requestId;
  if (typeof requestId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(requestId)) {
    return reviewError(400, "A review request ID is required");
  }
  const db = env.TOPICS_DB;
  const saved = () => db.prepare("SELECT decision FROM topic_decisions WHERE request_id = ?").bind(requestId).first("decision");
  const existing = await saved();
  if (existing) return reviewAccepted(requestId, JSON.parse(existing));
  let reportPageId = null;
  if (Object.hasOwn(payload, "reportPageId") || Object.hasOwn(payload, "reportUrl") || payload.action === "dismiss") {
    if (Object.hasOwn(payload, "reportPageId")) {
      if (typeof payload.reportPageId !== "string" || !/^[a-f0-9]{32}$/.test(payload.reportPageId)) return reviewError(400, "Choose a report to resolve");
      reportPageId = payload.reportPageId;
    } else {
      const page = typeof payload.reportUrl === "string" && canonicalURL(payload.reportUrl);
      if (!page) return reviewError(400, "Choose a report to resolve");
      reportPageId = await fingerprint(page.key);
    }
    if (["move", "remove"].includes(payload.action)) {
      const page = typeof payload.url === "string" && canonicalURL(payload.url);
      if (!page || await fingerprint(page.key) !== reportPageId) return reviewError(404, "This link is outside the published index");
    }
    const report = await db.prepare("SELECT page_id FROM topic_reports WHERE page_id = ? AND reported_at > ? LIMIT 1")
      .bind(reportPageId, Date.now() - REPORT_RETENTION_MS).first();
    if (!report) return reviewError(404, "This report is no longer available");
  }
  const index = payload.action === "dismiss" ? null : await readPublishedTopics(db);
  const result = prepareTopicDecision(payload, index, (id) => resolvePublishedTopic(index, id), requestId);
  if (!result.decision) return reviewError(result.status, result.error);
  const written = await db.prepare(`INSERT INTO topic_decisions (request_id, report_page_id, decided_at, decision)
    VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING decision`)
    .bind(requestId, reportPageId, Date.now(), JSON.stringify(result.decision)).first("decision");
  const final = written || await saved();
  return final ? reviewAccepted(requestId, JSON.parse(final)) : reviewError(409, "This topic already has an approved merge");
}

export default {
  async fetch(request, env, context) {
    const url = new URL(request.url);
    const { pathname } = url;
    if (pathname === "/sidebar-composer" && ["GET", "HEAD"].includes(request.method)) {
      const body = '<!doctype html><html lang="en"><meta charset="utf-8"><title>Backchannel Composer</title><body></body></html>';
      return new Response(request.method === "HEAD" ? null : body, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": "default-src 'none'; base-uri 'none'; form-action 'none'",
          "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
    if (pathname === "/internal/review" && request.method === "GET") return serveTopicReviewPage();
    if (pathname === "/api/topics" && ["GET", "HEAD"].includes(request.method)) return serveIndex(request, env.TOPICS_DB);
    if (pathname === "/api/topics/article" && request.method === "GET") return serveTopicArticle(request, url, env, context).catch(articleStorageError);
    if (pathname === "/api/topics/coverage" && request.method === "GET") return serveTopicCoverage(url, env.TOPICS_DB);
    if (pathname === "/api/topic-reports" && ["OPTIONS", "POST"].includes(request.method)) {
      return receiveTopicReport(request, env);
    }
    if (pathname === "/internal/account-reports" && request.method === "DELETE") return deleteAccountReports(request, env);
    if (pathname === "/internal/topic-reports") {
      if (request.method === "POST") return receiveTopicDecision(request, env, url);
      if (request.method === "GET" && authorized(request, env.TOPIC_REVIEW_TOKEN)) return reviewTopicReports(env.TOPICS_DB, url);
      if (request.method === "GET" && url.searchParams.get("pending") === "1") return reviewError(401, "A valid operator token is required");
    }
    if (request.method === "POST" && (
      (pathname === "/internal/refresh" && authorized(request, env.REFRESH_TOKEN)) ||
      (pathname === "/internal/publish-topics" && authorized(request, env.TOPIC_REVIEW_TOKEN))
    )) {
      const result = await refresh(env);
      return Response.json(result || { status: "refresh-in-progress" }, {
        status: result?.status === SOURCES_UNAVAILABLE ? 503 : result ? 200 : 409,
        headers: { "Cache-Control": "no-store" },
      });
    }
    return new Response("Not found", { status: 404 });
  },
  async scheduled(_event, env) {
    const now = Date.now();
    const [result] = await Promise.all([refresh(env), env.TOPICS_DB.batch([
      env.TOPICS_DB.prepare("DELETE FROM topic_reports WHERE reported_at <= ?").bind(now - REPORT_RETENTION_MS),
      env.TOPICS_DB.prepare("DELETE FROM topic_report_revocations WHERE revoked_until <= ?").bind(now),
    ])]);
    if (result?.status === SOURCES_UNAVAILABLE) throw new Error("All public sources unavailable");
  },
};
