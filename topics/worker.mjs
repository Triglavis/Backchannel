import { canonicalURL, fetchFeeds, topicPageEvidence, usableTopicTitle } from "./feeds.mjs";
import { groupPages } from "./grouping.mjs";
import { buildTopicsIndex, resolvePublishedTopic, retainedEvidenceKeys, RETENTION_MS } from "./index.mjs";
import { addTopicArtwork } from "./artwork.mjs";
import { prepareTopicDecision } from "./decisions.mjs";
import { serveTopicReviewPage } from "./review-page.mjs";

const MODEL = "@cf/baai/bge-small-en-v1.5";
const DAYS = 7;
const WINDOW_LIMIT = 240;
const GENERAL_WINDOW_LIMIT = WINDOW_LIMIT / 2;
const INTEREST_WINDOW_PER_FEED = 4;
const COVERAGE_PAGE_SIZE = 48;
const COVERAGE_PAGE_BYTES = 4 * 1024 * 1024;
const MAX_NEW_EMBEDDINGS = 200;
const EMBEDDING_BATCH_SIZE = 32;
const DIMENSIONS = 384;
const LEASE_MS = 300_000;
const SOURCES_UNAVAILABLE = "sources-unavailable";
const EMPTY_INDEX = JSON.stringify({ version: 1, generatedAt: null, topics: [], pages: [] });
const REPORT_ORIGIN = "https://backchnnl.app";
const REPORT_BODY_LIMIT = 4096;
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
    console.log("Topics refresh", JSON.stringify({ ...snapshot.stats, sources: snapshot.sources }));
    return { generatedAt: snapshot.generatedAt, sources: snapshot.sources, stats: snapshot.stats };
  } finally {
    await db.prepare("UPDATE refresh_lease SET expires_at = 0, owner = '' WHERE id = 1 AND owner = ?").bind(owner).run();
  }
}

function authorized(request, env) {
  const provided = request.headers.get("Authorization") || "";
  if (!env.REFRESH_TOKEN || provided.length !== env.REFRESH_TOKEN.length + 7 || !provided.startsWith("Bearer ")) return false;
  let difference = 0;
  for (let index = 0; index < env.REFRESH_TOKEN.length; index++) {
    difference |= provided.charCodeAt(index + 7) ^ env.REFRESH_TOKEN.charCodeAt(index);
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

async function topicReporter(request, db) {
  const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get("Authorization") || "")?.[1];
  if (!token) return null;
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  const sessionHash = btoa(String.fromCharCode(...hash)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  return db.prepare("SELECT account_id FROM sessions WHERE token_hash = ? AND expires_at > ?")
    .bind(sessionHash, Date.now()).first("account_id");
}

async function receiveTopicReport(request, env) {
  const origin = request.headers.get("Origin");
  if (origin && origin !== REPORT_ORIGIN) return topicReportStatus(403);
  if (request.method === "OPTIONS") return topicReportStatus(204);
  const account = await topicReporter(request, env.ACCOUNTS_DB);
  if (!account) return topicReportStatus(401);
  const reporter = await fingerprint("topic-report:" + account);
  if (!(await env.TOPIC_REPORT_RATE_LIMIT.limit({ key: reporter })).success) return topicReportStatus(429);
  const { status, payload } = await readTopicJSON(request, REPORT_BODY_LIMIT);
  if (status) return topicReportStatus(status);
  const page = typeof payload?.url === "string" && canonicalURL(payload.url);
  const { topic = "", suggestedTopic = "" } = payload ?? {};
  if (!page || typeof topic !== "string" || topic.length > 512 ||
    typeof suggestedTopic !== "string" || suggestedTopic.length > 120) return topicReportStatus(400);
  await env.TOPICS_DB.prepare(`
    INSERT INTO topic_reports (page_id, reporter_id, url, topic, suggested_topic, reported_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (page_id, reporter_id) DO UPDATE SET
      url = excluded.url, topic = excluded.topic, suggested_topic = excluded.suggested_topic, reported_at = excluded.reported_at
  `).bind(await fingerprint(page.key), reporter, page.url,
    topic.trim().replace(/\s+/g, " "), suggestedTopic.trim().replace(/\s+/g, " "), Date.now()).run();
  return topicReportStatus(204);
}

async function reviewTopicReports(db, url) {
  const offset = Number(url.searchParams.get("offset") ?? 0);
  if (!Number.isSafeInteger(offset) || offset < 0) return reviewError(400, "Invalid report offset");
  const pending = url.searchParams.get("pending") === "1";
  const limit = 100;
  const { results } = await db.prepare(`
    SELECT COALESCE(p.url, MIN(r.url)) AS url, p.title, r.topic, r.suggested_topic AS suggestedTopic,
      COUNT(*) AS count, MAX(r.reported_at) AS lastReportedAt
    FROM topic_reports AS r LEFT JOIN pages AS p ON p.id = r.page_id
    ${pending ? `WHERE NOT EXISTS (SELECT 1 FROM topic_decisions AS d
      WHERE d.report_page_id = r.page_id AND d.decided_at >= r.reported_at)` : ""}
    GROUP BY r.page_id, r.topic, r.suggested_topic
    ORDER BY count DESC, lastReportedAt DESC, r.page_id, r.topic, r.suggested_topic LIMIT ? OFFSET ?
  `).bind(limit + 1, offset).all();
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
      const ids = pages.get(canonicalURL(report.url)?.key) || [];
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
  if (!authorized(request, env)) return reviewError(401, "A valid operator token is required");
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
  if (Object.hasOwn(payload, "reportUrl") || payload.action === "dismiss") {
    const page = typeof payload.reportUrl === "string" && canonicalURL(payload.reportUrl);
    if (!page) return reviewError(400, "Choose a report to resolve");
    reportPageId = await fingerprint(page.key);
    const report = await db.prepare("SELECT page_id FROM topic_reports WHERE page_id = ? LIMIT 1").bind(reportPageId).first();
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
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    if (pathname === "/internal/review" && request.method === "GET") return serveTopicReviewPage();
    if (pathname === "/api/topics" && ["GET", "HEAD"].includes(request.method)) return serveIndex(request, env.TOPICS_DB);
    if (pathname === "/api/topics/coverage" && request.method === "GET") return serveTopicCoverage(url, env.TOPICS_DB);
    if (pathname === "/api/topic-reports" && ["OPTIONS", "POST"].includes(request.method)) {
      return receiveTopicReport(request, env);
    }
    if (pathname === "/internal/topic-reports") {
      if (request.method === "POST") return receiveTopicDecision(request, env, url);
      if (request.method === "GET" && authorized(request, env)) return reviewTopicReports(env.TOPICS_DB, url);
      if (request.method === "GET" && url.searchParams.get("pending") === "1") return reviewError(401, "A valid operator token is required");
    }
    if (pathname === "/internal/refresh" && request.method === "POST" && authorized(request, env)) {
      const result = await refresh(env);
      return Response.json(result || { status: "refresh-in-progress" }, {
        status: result?.status === SOURCES_UNAVAILABLE ? 503 : result ? 200 : 409,
        headers: { "Cache-Control": "no-store" },
      });
    }
    return new Response("Not found", { status: 404 });
  },
  async scheduled(_event, env) {
    const result = await refresh(env);
    if (result?.status === SOURCES_UNAVAILABLE) throw new Error("All public sources unavailable");
  },
};
