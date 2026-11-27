import { canonicalURL } from "./feeds.mjs";

function cleanText(value, max) {
  if (typeof value !== "string" || value.length > max) return "";
  return value.trim().replace(/\s+/g, " ");
}

function reviewImage(value) {
  const { url, source, credit, subject } = value || {};
  const name = cleanText(subject, 160);
  const attribution = cleanText(credit, 512);
  if (!name || !attribution || typeof url !== "string" || url.length > 2048 || typeof source !== "string" || source.length > 2048) return null;
  try {
    const file = new URL(url);
    const details = new URL(source);
    if (file.username || file.password || file.search || file.hash || details.username || details.password || details.search || details.hash ||
      !["https://upload.wikimedia.org", "https://thumb.wikimedia.org"].includes(file.origin) || !file.pathname.startsWith("/wikipedia/commons/") ||
      details.origin !== "https://commons.wikimedia.org" || !details.pathname.startsWith("/wiki/File:")) return null;
    return { url: file.href, source: details.href, credit: attribution, subject: name };
  } catch {
    return null;
  }
}

function pageKey(url) {
  return typeof url === "string" ? canonicalURL(url)?.key : undefined;
}

export function prepareTopicDecision(payload, index, resolveTopic, requestId) {
  const { action } = payload;
  const accept = (fields = {}) => ({ decision: { action, ...fields } });
  const invalid = (error) => ({ status: 400, error });
  const missing = (error) => ({ status: 404, error });
  const conflict = (error) => ({ status: 409, error });
  if (action === "dismiss") return accept();
  if (action === "move" || action === "remove") {
    const key = pageKey(payload.url);
    if (!key) return invalid("Enter a valid public link");
    if (!index?.pages.some((page) => page.key === key)) return missing("This link is outside the published index");
    if (action === "remove") return accept({ keys: [key] });
    const target = resolveTopic(payload.topicId);
    return target ? accept({ keys: [key], target }) : missing("Choose a published topic");
  }
  if (!["edit", "merge", "split"].includes(action)) return invalid("Choose a review action");
  const source = resolveTopic(payload.topicId);
  if (!source) return missing("Choose a published topic");
  if (action === "edit") {
    const changes = {};
    if (Object.hasOwn(payload, "label")) {
      changes.label = cleanText(payload.label, 512);
      if (!changes.label) return invalid("Enter a title of up to 512 characters");
    }
    if (Object.hasOwn(payload, "image")) {
      changes.image = payload.image === null ? null : reviewImage(payload.image);
      if (payload.image !== null && !changes.image) return invalid("Use a Wikimedia\u00a0Commons image with attribution and a subject");
    }
    return Object.keys(changes).length ? accept({ target: source, changes }) : invalid("Enter a title or image change");
  }
  const members = new Set(index.pages.filter(({ topicIds }) => topicIds.includes(source.id)).map(({ key }) => key));
  if (action === "merge") {
    const target = resolveTopic(payload.targetTopicId);
    if (!target) return missing("Choose the destination topic");
    if (target.id === source.id) return conflict("Choose two different topics");
    return accept({ source, target, keys: [...members] });
  }
  const label = cleanText(payload.label, 512);
  if (!label || !Array.isArray(payload.urls) || !payload.urls.length || payload.urls.length > 240) {
    return invalid("Name the new topic and choose up to 240 links");
  }
  const keys = [...new Set(payload.urls.map(pageKey))];
  if (keys.includes(undefined)) return invalid("Choose valid public links");
  if (keys.length >= members.size || !keys.every((key) => members.has(key))) return conflict("Choose some of the source topic's current links");
  return accept({ keys, target: { id: "story:review-" + requestId, kind: "story", label } });
}

function curate(definitions, target, redirects) {
  const resolved = redirects.get(target.id);
  const current = definitions.get(target.id) || definitions.get(resolved) || target;
  const topic = { ...current, curated: true };
  definitions.set(topic.id, topic);
  return topic;
}

function setAssignment(assignment, topic) {
  assignment.topicIds = topic ? [topic.id] : [];
  assignment.reviewed = true;
}

function mergeAssignments(definitions, assignments, decision, target, redirects) {
  const anchors = new Set(decision.keys);
  const sourceIds = new Set([decision.source.id]);
  const overlaps = new Map();
  for (const key of anchors) {
    const entry = assignments.get(key);
    if (!entry || entry.reviewed) continue;
    for (const id of entry.topicIds) {
      const topic = definitions.get(id);
      if (id !== target.id && !topic?.curated && topic?.kind === decision.source.kind) overlaps.set(id, (overlaps.get(id) || 0) + 1);
    }
  }
  for (const [id, count] of overlaps) if (count >= 2 && count * 2 >= anchors.size) sourceIds.add(id);
  for (const assignment of assignments.values()) {
    if (assignment.topicIds.some((id) => sourceIds.has(id)) || (!assignment.reviewed && anchors.has(assignment.key))) setAssignment(assignment, target);
  }
  for (const id of sourceIds) if (id !== target.id) redirects.set(id, target.id);
  target.aliases = [...(target.aliases || []), decision.source.label, ...(decision.source.aliases || [])];
}

export function applyTopicDecisions(definitions, assignments, decisions, redirects) {
  const continuity = new Map(redirects);
  for (const decision of decisions) if (decision.action === "merge") continuity.delete(decision.source.id);
  const manualImages = new Map();
  for (const decision of decisions) {
    if (decision.action === "dismiss") continue;
    const target = decision.target ? curate(definitions, decision.target, continuity) : null;
    if (decision.action === "edit") {
      const { label, image } = decision.changes;
      if (label && label !== target.label) {
        target.aliases = [target.label, ...(target.aliases || [])];
        target.label = label;
      }
      if (image !== undefined) manualImages.set(target.id, image);
      continue;
    }
    if (decision.action === "merge") {
      mergeAssignments(definitions, assignments, decision, target, redirects);
      continue;
    }
    for (const key of decision.keys) {
      const assignment = assignments.get(key);
      if (assignment) setAssignment(assignment, target);
    }
  }
  return manualImages;
}
