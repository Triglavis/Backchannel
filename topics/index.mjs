import { canonicalURL } from "./feeds.mjs";
import { coalesceTopics, relatedStoryTitles } from "./grouping.mjs";
import { topicArtworkFitsEdition } from "./artwork.mjs";
import { applyTopicDecisions } from "./decisions.mjs";

export const RETENTION_MS = 30 * 86_400_000;
const MAX_PAGES = 4_000;
const MAX_ALIASES = 24;
const MAX_POSTS_PER_PAGE = 240;
// D1 limits the entire row to 2 MB.
const MAX_INDEX_BYTES = 1_800_000;
const utf8 = new TextEncoder();

function jsonBytes(value) {
  return utf8.encode(JSON.stringify(value)).byteLength;
}

function compactPosts(posts) {
  const counts = new Map();
  for (const { id, comments } of posts) {
    if (typeof id !== "string" || !/^[^:\s]+:\S+$/.test(id)) continue;
    const count = Number.isFinite(comments) ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(comments))) : 0;
    counts.set(id, Math.max(counts.get(id) || 0, count));
  }
  return [...counts];
}

function mergePosts(current, previous) {
  const counts = new Map(compactPosts(current || []));
  for (const [id, count] of previous || []) {
    if (!counts.has(id)) counts.set(id, count);
  }
  return [...counts].slice(0, MAX_POSTS_PER_PAGE);
}

function topicMembers(assignments) {
  const members = new Map();
  for (const { key, topicIds } of assignments.values()) {
    for (const id of topicIds) {
      if (!members.has(id)) members.set(id, new Set());
      members.get(id).add(key);
    }
  }
  return members;
}

function aliasKey(label) {
  return label.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function appendAliases(topic, previous) {
  topic.aliases = [...(topic.aliases || []), previous.label, ...(previous.aliases || [])];
}

function retainStoryIds(definitions, retained, live) {
  const historical = topicMembers(retained);
  const current = topicMembers(live);
  const candidates = [];
  for (const [id, members] of historical) {
    const former = definitions.get(id);
    if (!former || former.kind === "topic" || id.startsWith("story:review-") || current.has(id)) continue;
    const overlaps = new Map();
    for (const key of members) for (const candidate of live.get(key)?.topicIds || []) {
      overlaps.set(candidate, (overlaps.get(candidate) || 0) + 1);
    }
    for (const [candidate, shared] of overlaps) {
      const topic = definitions.get(candidate);
      const size = current.get(candidate).size;
      if (!topic || topic.kind === "topic") continue;
      const exact = [former.label, ...(former.aliases || [])].some((label) => aliasKey(label) === aliasKey(topic.label));
      const contained = shared >= 2 && shared === Math.min(members.size, size);
      const corroborated = shared >= 2 && shared * 2 > Math.max(members.size, size) &&
        (exact || relatedStoryTitles(former.label, topic.label));
      const single = Math.min(members.size, size) === 1 && (former.curated || exact);
      if (contained || corroborated || single) candidates.push({ id, candidate, shared, similarity: shared / Math.max(members.size, size) });
    }
  }
  candidates.sort((a, b) => b.shared - a.shared || b.similarity - a.similarity || a.id.localeCompare(b.id));
  const replacements = new Map();
  const promotions = new Map();
  const matched = new Set();
  const reserved = new Set(current.keys());
  for (const { id, candidate } of candidates) {
    if (matched.has(candidate) || reserved.has(id) || (historical.get(candidate)?.size || 0) > 1) continue;
    const former = definitions.get(id);
    const generated = definitions.get(candidate);
    const promoted = former.kind === "coverage" && generated.kind === "story";
    const stableId = promoted ? candidate : id;
    const topic = { ...generated, id: stableId, kind: promoted ? generated.kind : former.kind };
    appendAliases(topic, former);
    if (!topic.image && former.image && !former.imageCurated && aliasKey(former.label) === aliasKey(topic.label)) topic.image = former.image;
    definitions.set(stableId, topic);
    definitions.delete(promoted ? id : candidate);
    if (promoted) promotions.set(id, stableId);
    else replacements.set(candidate, stableId);
    matched.add(candidate);
    reserved.add(id);
  }
  for (const assignment of live.values()) {
    assignment.topicIds = [...new Set(assignment.topicIds.map((id) => replacements.get(id) || id))];
  }
  for (const assignment of retained.values()) {
    assignment.topicIds = [...new Set(assignment.topicIds.map((id) => promotions.get(id) || id))];
  }
  return new Map([...replacements, ...promotions]);
}

function migrateRetainedTopics(definitions, retained, live) {
  const liveMembers = topicMembers(live);
  const replacements = new Map();
  for (const [id, previous] of topicMembers(retained)) {
    if (liveMembers.has(id)) continue;
    const shared = [...previous].filter((key) => live.has(key));
    const formerTopic = definitions.get(id);
    if (!formerTopic || formerTopic.curated || shared.length < previous.size * 0.75) continue;
    const matches = live.get(shared[0]).topicIds.filter((replacement) => {
      const currentTopic = definitions.get(replacement);
      const current = liveMembers.get(replacement);
      if (!currentTopic || (formerTopic.kind === "topic") !== (currentTopic.kind === "topic") ||
        shared.length < current.size * 0.75 || !shared.every((key) => current.has(key)) ||
        (shared.length < 2 && aliasKey(formerTopic.label) !== aliasKey(currentTopic.label))) return false;
      return coalesceTopics([
        { ...formerTopic, pageIds: [...previous] }, { ...currentTopic, pageIds: [...current] },
      ]).topics.length === 1;
    });
    if (matches.length !== 1) continue;
    const [replacement] = matches;
    const currentTopic = definitions.get(replacement);
    appendAliases(currentTopic, formerTopic);
    replacements.set(id, replacement);
  }
  for (const assignment of retained.values()) {
    assignment.topicIds = [...new Set(assignment.topicIds.map((id) => replacements.get(id) || id))];
  }
  return replacements;
}

function compactAliases(label, aliases) {
  const seen = new Set([aliasKey(label)]);
  return aliases.filter((alias) => {
    if (typeof alias !== "string" || alias.length > 512) return false;
    const key = aliasKey(alias);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, MAX_ALIASES);
}

export function resolvePublishedTopic(index, id) {
  if (!index || typeof id !== "string" || id.length > 272 || !/^(topic|story|coverage):\S+$/.test(id)) return null;
  const target = index.redirects && Object.hasOwn(index.redirects, id) ? index.redirects[id] : id;
  return index.topics.find((topic) => topic.id === target) || null;
}

export function buildTopicsIndex(snapshot, previous, decisions = [], threadUpdates = new Map()) {
  const generatedAt = snapshot.generatedAt;
  const now = Date.parse(generatedAt);
  const definitions = new Map(snapshot.topics.map(({ id, label, kind, aliases, image }) =>
    [id, { id, label, kind, aliases, image }]));
  const retained = new Map();
  const live = new Map();
  const redirects = new Map();

  if (previous) {
    const published = JSON.parse(previous.body);
    const timestamps = JSON.parse(previous.page_timestamps);
    for (const [id, target] of Object.entries(published.redirects || {})) redirects.set(id, target);
    for (const topic of published.topics) {
      const active = definitions.get(topic.id);
      if (active) {
        appendAliases(active, topic);
        if (!active.image && topic.image && !topic.imageCurated && aliasKey(active.label) === aliasKey(topic.label)) active.image = topic.image;
      } else {
        definitions.set(topic.id, topic);
      }
    }
    for (const [index, { key, topicIds, posts, reviewed }] of published.pages.entries()) {
      if (timestamps[index] >= now - RETENTION_MS) retained.set(key, { key, topicIds, posts, reviewed, timestamp: timestamps[index] });
    }
  }

  for (const { url, topicIds, posts } of snapshot.pages) {
    const page = canonicalURL(url);
    if (!page) continue;
    live.set(page.key, { key: page.key, topicIds, posts: mergePosts(posts, retained.get(page.key)?.posts), timestamp: now });
  }

  if (retained.size && live.size) {
    const stable = retainStoryIds(definitions, retained, live);
    const migrated = migrateRetainedTopics(definitions, retained, live);
    for (const [id, target] of [...stable, ...migrated]) redirects.set(id, target);
  }
  const assignments = new Map([...retained, ...live]);
  if (threadUpdates.size) {
    const observed = new Map();
    for (const [id, { key, comments }] of threadUpdates) {
      if (comments === null) continue;
      if (!observed.has(key)) observed.set(key, []);
      observed.get(key).push({ id, comments });
    }
    for (const assignment of assignments.values()) {
      const { key, posts } = assignment;
      const current = observed.get(key);
      const kept = posts?.filter(([id]) => !threadUpdates.has(id) || threadUpdates.get(id).key === key);
      if (current || kept?.length !== posts?.length) assignment.posts = mergePosts(current, kept);
    }
  }
  const manualImages = applyTopicDecisions(definitions, assignments, decisions, redirects);
  const members = topicMembers(assignments);
  const consolidated = coalesceTopics([...definitions.values()].filter(({ id }) => members.has(id))
    .map((topic) => ({ ...topic, pageIds: [...members.get(topic.id)] })));
  const topics = new Map(consolidated.topics.map(({ id, label, kind, aliases = [] }) => {
    const definition = definitions.get(id);
    const compacted = compactAliases(label, [...(definition.aliases || []), ...aliases]);
    const approved = manualImages.get(id);
    const automatic = definition.image && !definition.imageCurated && topicArtworkFitsEdition(label, definition.image);
    const image = approved || (automatic ? definition.image : null);
    return [id, { id, label, kind, ...(compacted.length ? { aliases: compacted } : {}), ...(image ? { image } : {}),
      ...(definition.curated ? { curated: true } : {}), ...(approved ? { imageCurated: true } : {}) }];
  }));
  const index = { version: 1, generatedAt, topics: [], pages: [] };
  const timestamps = [];
  const usedTopics = new Set();
  let bytes = jsonBytes(index) + 2;
  const newest = [...assignments.values()].sort((left, right) =>
    right.timestamp - left.timestamp || left.key.localeCompare(right.key));
  for (const { key, topicIds, posts, reviewed, timestamp } of newest.slice(0, MAX_PAGES)) {
    const resolved = [...new Set(topicIds.map((id) => consolidated.canonicalIds.get(id)).filter(Boolean))];
    if (!resolved.length && !reviewed) continue;
    const page = { key, topicIds: resolved };
    if (reviewed) page.reviewed = true;
    if (posts?.length) page.posts = posts;
    const newTopics = resolved.filter((id) => !usedTopics.has(id));
    const nextBytes = jsonBytes(page) + jsonBytes(timestamp) + 2 +
      newTopics.reduce((sum, id) => sum + jsonBytes(topics.get(id)) + 1, 0);
    if (bytes + nextBytes > MAX_INDEX_BYTES) break;
    bytes += nextBytes;
    index.pages.push(page);
    timestamps.push(timestamp);
    for (const id of newTopics) usedTopics.add(id);
  }
  index.topics = [...topics.values()].filter(({ id }) => usedTopics.has(id));
  for (const [id, target] of consolidated.canonicalIds) {
    if (id !== target) redirects.set(id, target);
  }
  const aliases = [];
  for (const [id, initial] of redirects) {
    if (usedTopics.has(id)) continue;
    let target = initial;
    const visited = new Set([id]);
    while (!usedTopics.has(target) && redirects.has(target) && !visited.has(target)) {
      visited.add(target);
      target = redirects.get(target);
    }
    if (!usedTopics.has(target)) continue;
    const bytesNeeded = jsonBytes(id) + jsonBytes(target) + (aliases.length ? 2 : 16);
    if (bytes + bytesNeeded > MAX_INDEX_BYTES) break;
    bytes += bytesNeeded;
    aliases.push([id, target]);
  }
  if (aliases.length) index.redirects = Object.fromEntries(aliases);
  return { body: JSON.stringify(index), page_timestamps: JSON.stringify(timestamps) };
}
