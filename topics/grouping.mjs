import { topicPageEvidence } from "./feeds.mjs";

const STOP_WORDS = new Set((
  "a an as at by in is it of on or so to up via vs about above after again also among and another are back been before being below both but can could did does doing down each " +
  "even ever every first for from get getting had has have having here how into its just last less like made make making " +
  "he she many may might more most much must new next nor not now off once one only other our out over own really same say says " +
  "see should since some still such than that the their them then there these they this those through time too under " +
  "until use used uses using very want was way well were what when where which while who why will with without would years " +
  "you your today tomorrow yesterday developer developers tech update updates released release better now introducing guide"
).split(/\s+/));
const EVENT_WINDOW = 3 * 86_400_000;
const GENERIC_SUBJECT_WORDS = new Set((
  "announces announcement arrives build building companies company faces finally firm firms group hastily launches launching " +
  "look offers plan plans shows stock shares staffers starts threatens unveiled unveils workers works"
).split(/\s+/));
const SUBJECT_QUALIFIERS = new Set(["extended", "generalized", "modified", "strong", "weak"]);
const MARKET_WORDS = new Set(["dow", "ipo", "market", "nasdaq", "share", "stock", "wall", "street"]);
const PRICE_DECLINES = new Set(["bust", "decline", "dip", "dive", "drop", "fall", "fell", "plunge", "selloff", "sink", "slide", "slump", "tank", "tumble", "wipeout"]);
const EVENT_ACTIONS = new Map([
  ["blockade", "blockade"], ["blockad", "blockade"],
  ["airstrike", "strike"], ["bomb", "strike"], ["strike", "strike"],
  ["armistice", "ceasefire"], ["ceasefire", "ceasefire"],
  ["breach", "breach"], ["hack", "breach"],
  ["disruption", "outage"], ["downtime", "outage"], ["outage", "outage"], ["unavailable", "outage"],
]);
const GENERAL_EVENT_WORDS = new Set([
  "affect", "agency", "alleg", "allegation", "apparent", "case", "claim", "confirm", "incident",
  "investigation", "key", "possible", "report", "reportedly", "source", "suffer", "suspect", "target", "warn",
]);
const SCOPES = new Map([
  ["federal", "national"], ["national", "national"], ["nationwide", "national"],
  ["state", "state"], ["statewide", "state"], ["local", "local"], ["municipal", "local"],
]);
const QUALIFIED_CLAIM = /\b(?:alleg(?:e[ds]?|edly)|apparent(?:ly)?|possibly|possible|reportedly|suspected|unconfirmed|claims? (?:to|that|(?:a )?proof)|sources? says?)\b/i;
const CLAIM_WORDS = new Set(["apparent", "alleg", "allege", "reportedly", "possible", "possibly", "suspect", "unconfirm"]);
const EMPHATIC_DETAILS = new Set(["confirm", "definitive", "entire", "historic", "huge", "largest", "massive", "prove", "record", "unprecedented"]);
const INSTRUCTIONAL = /\b(?:how to|(?:tutorial|guide) (?:on|to)|walkthrough)\b|^\p{L}+ing\b.*\b(?:using|with|in)\b/iu;

function titleWords(title) {
  return title.match(/[\p{L}\p{N}]+/gu) || [];
}

function useful(word) {
  return word.length >= 2 && !STOP_WORDS.has(word) && /\p{L}/u.test(word);
}

function facts(page) {
  const words = titleWords(page.title);
  const lower = words.map((word) => word.toLowerCase());
  return { ...page, words, lower, terms: new Set(lower.filter(useful)), numbers: lower.filter((word) => /^\d+$/.test(word)).join(" ") };
}

function sharedCount(left, right) {
  let count = 0;
  for (const term of left) if (right.has(term)) count++;
  return count;
}

function similarity(left, right) {
  if (!left.vector || !right.vector) return 0;
  let sum = 0;
  for (let index = 0; index < left.vector.length; index++) sum += left.vector[index] * right.vector[index];
  return sum;
}

function phraseLabel(words) {
  return words.map((word) => word[0].toUpperCase() + word.slice(1)).join(" ");
}

const TOPIC_ORDER = { story: 0, topic: 1, coverage: 2 };

function labelKey(label) {
  return label.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

function relatedTopics(left, right, shared) {
  if (left.curated || right.curated) return false;
  const sameKind = left.kind === right.kind;
  const exact = left.phrase === right.phrase;
  if (left.kind === "coverage" || right.kind === "coverage") {
    return !sameKind && (exact || (left.kind !== "topic" && right.kind !== "topic" && relatedHeadlines(left, right)));
  }
  const aliasesMatch = left.aliasKeys.has(right.labelKey) || right.aliasKeys.has(left.labelKey);
  if (sameKind && left.kind === "topic" && aliasesMatch) return true;
  const largest = Math.max(left.pageIds.length, right.pageIds.length);
  if (shared !== largest && (!sameKind || shared < 2 || shared / largest < 0.75)) return false;

  const [shorter, longer] = left.lower.length <= right.lower.length ? [left, right] : [right, left];
  return exact || aliasesMatch || (shared >= 2 && shorter.terms.size >= (sameKind ? 1 : 2) &&
    (" " + longer.phrase + " ").includes(" " + shorter.phrase + " ")) ||
    (left.kind === "story" && right.kind === "story" && relatedHeadlines(left, right));
}

function relatedHeadlines(left, right) {
  const shared = sharedCount(left.terms, right.terms);
  return left.numbers === right.numbers && shared >= 3 &&
    shared / (left.terms.size + right.terms.size - shared) >= 0.72;
}

export function relatedStoryTitles(left, right) {
  return relatedHeadlines(facts({ title: left.normalize("NFKC") }), facts({ title: right.normalize("NFKC") }));
}

export function coalesceTopics(topics) {
  const byPage = new Map();
  const ranked = topics.map((topic) => {
    const { lower, terms, numbers } = facts({ title: topic.label.normalize("NFKC") });
    const entry = {
      ...topic, lower, terms, numbers, phrase: lower.join(" "), labelKey: labelKey(topic.label),
      aliasKeys: new Set((topic.aliases || []).map(labelKey)),
    };
    for (const id of entry.pageIds) {
      if (!byPage.has(id)) byPage.set(id, []);
      byPage.get(id).push(entry);
    }
    return entry;
  }).sort((left, right) => TOPIC_ORDER[left.kind] - TOPIC_ORDER[right.kind] ||
    right.terms.size - left.terms.size || right.lower.length - left.lower.length || left.id.localeCompare(right.id));
  const canonicalIds = new Map();
  const merged = new Map();
  for (const topic of ranked) {
    if (canonicalIds.has(topic.id)) continue;
    canonicalIds.set(topic.id, topic.id);
    // Compare original memberships before adding the links from any aliases.
    const neighbors = new Map();
    for (const page of topic.pageIds) for (const candidate of byPage.get(page)) {
      if (!canonicalIds.has(candidate.id)) neighbors.set(candidate, (neighbors.get(candidate) || 0) + 1);
    }
    const pages = new Set(topic.pageIds);
    const labels = [...(topic.aliases || [])];
    for (const [candidate, shared] of neighbors) {
      if (!relatedTopics(topic, candidate, shared)) continue;
      canonicalIds.set(candidate.id, topic.id);
      for (const page of candidate.pageIds) pages.add(page);
      labels.push(candidate.label, ...(candidate.aliases || []));
    }
    const aliases = new Map(labels.map((label) => [labelKey(label), label]));
    aliases.delete(topic.labelKey);
    merged.set(topic.id, {
      id: topic.id, label: topic.label, kind: topic.kind,
      ...(aliases.size ? { aliases: [...aliases.values()] } : {}), pageIds: [...pages],
    });
  }
  return { topics: topics.filter(({ id }) => merged.has(id)).map(({ id }) => merged.get(id)), canonicalIds };
}

function eventWord(word) {
  let stem = word.normalize("NFKD").replace(/\p{M}/gu, "");
  if (stem.length >= 5) {
    if (stem.endsWith("ies")) stem = stem.slice(0, -3) + "y";
    else if (/[^isu]s$/.test(stem)) stem = stem.slice(0, -1);
    else if (stem.length >= 7 && stem.endsWith("ing")) stem = stem.slice(0, -3);
    else if (stem.endsWith("ized") || stem.endsWith("ised")) stem = stem.slice(0, -1);
    else if (stem.endsWith("ed")) stem = stem.slice(0, -2);
  }
  if (stem === "centre") return "center";
  if (stem === "criminal") return "crime";
  if (["investigat", "investigate", "inquiry", "probe"].includes(stem)) return "investigation";
  return stem;
}

function eventWords(words) {
  return words.map((word) => word.toLowerCase()).filter(useful).map(eventWord);
}

function eventDetail(term) {
  return !EVENT_ACTIONS.has(term) && !GENERAL_EVENT_WORDS.has(term) && !SCOPES.has(term);
}

function incidentEvidence(words) {
  const capitals = words.filter((word) => /^\p{Lu}/u.test(word)).length;
  const titleCase = capitals > words.length * 0.6;
  const names = new Set();
  const objects = new Set();
  const scopes = new Map();
  const modifiers = new Map();
  const terms = words.map((word) => eventWord(word.toLowerCase()));
  for (const [i, word] of words.entries()) {
    const term = terms[i];
    if ((term === "in" || term === "at" || term === "near") && objects.has(terms[i - 1])) {
      const start = terms[i + 1] === "the" ? i + 2 : i + 1;
      const place = [];
      for (const part of words.slice(start, start + 3)) {
        if (!/^\p{Lu}/u.test(part) || !useful(part.toLowerCase())) break;
        place.push(part.toLowerCase());
      }
      if (place.length) scopes.set("location of " + terms[i - 1], place.join(" "));
      continue;
    }
    if (!useful(word.toLowerCase())) continue;
    if (SCOPES.has(term)) {
      for (const next of terms.slice(i + 1, i + 4)) {
        if (!useful(next) || !eventDetail(next)) break;
        scopes.set(next, SCOPES.get(term));
      }
    } else if (eventDetail(term)) {
      const next = terms[i + 1];
      const initialSubject = !capitals && i <= 1 && (next === "s" || GENERAL_EVENT_WORDS.has(next) || EVENT_ACTIONS.has(next));
      if (initialSubject || (/^\p{Lu}/u.test(word) && (!titleCase || i === 0 || /\p{Lu}.*\p{Lu}/u.test(word)))) names.add(term);
      else {
        objects.add(term);
        const prior = terms[i - 1];
        if (objects.has(prior)) modifiers.set(term, prior);
      }
    }
  }
  return { names, objects, scopes, modifiers };
}

function offeringStage(title) {
  const stage = /\b(fil|pric|clos|announc)(?:e[ds]?|ing|ement)\s+(?:of\s+|for\s+)?(?:(?:its|the|an?)\s+)?(?:IPO|initial public offering)\b/i.exec(title);
  return stage ? stage[1].toLowerCase() + "ing" : "";
}

function eventPage(page) {
  const title = page.title.replace(/^(?:Ask|Show|Tell|Launch) HN:\s*/i, "").replace(/\s+\(gift (?:article|link)\)\s*$/i, "").trim() || page.title;
  const posts = page.posts || [];
  const item = facts({ ...page, title, posts });
  const normalized = title.replace(/\bU\.S\./gi, "US").replace(/\bsell[ -]off\b/gi, "selloff");
  const words = titleWords(normalized);
  const terms = eventWords(words);
  const marketMove = terms.some((term) => MARKET_WORDS.has(term)) && terms.some((term) => PRICE_DECLINES.has(term));
  const marketNames = new Set(marketMove ? words.filter((word) => /^\p{Lu}\p{Ll}/u.test(word))
    .map((word) => eventWord(word.toLowerCase()))
    .filter((term) => !MARKET_WORDS.has(term) && !PRICE_DECLINES.has(term) && useful(term)) : []);
  const eventTerms = new Set(marketMove ? terms.map((term) => {
    if (term === "share") return "stock";
    return PRICE_DECLINES.has(term) ? "decline" : term;
  }) : terms);
  if (marketMove && eventTerms.has("ipo")) eventTerms.add("stock");
  const versions = Array.from(normalized.matchAll(/\b(?:v|version\s+)(\d+(?:\.\d+)*)\b|(?<![$.\d])\b(\d+\.\d+(?:\.\d+)*)(?![\w.%]|\s+(?:thousand|million|billion|percent)\b)/gi),
    ([, explicit, dotted]) => explicit || dotted);
  const actions = new Set(terms.map((term) => EVENT_ACTIONS.get(term)).filter(Boolean));
  const details = eventWords(words.filter((word) => /^\p{Ll}/u.test(word))).filter(eventDetail);
  const context = [...new Set([page.description, ...posts.map((post) => post.title)].filter((text) => text && text !== title))];
  const contextWords = context.map(titleWords);
  const otherWords = contextWords.flat();
  const contextTerms = new Set(eventWords(otherWords).filter((term) => !eventTerms.has(term)));
  const headline = incidentEvidence(words);
  const incident = [headline];
  if (actions.size && !headline.objects.size && eventTerms.size <= 3) {
    for (const passage of contextWords) {
      if (!eventWords(passage).some((term) => actions.has(EVENT_ACTIONS.get(term)))) continue;
      const excerpt = incidentEvidence(passage);
      if (!excerpt.names.size || sharedCount(headline.names, excerpt.names)) incident.push(excerpt);
    }
  }
  const headlineTerms = new Set([...eventTerms].map((term) => EVENT_ACTIONS.get(term) || term));
  const contextEvidence = new Set([...contextTerms].map((term) => EVENT_ACTIONS.get(term) || term));
  const namedEvidence = new Set([...headline.names, ...eventWords(otherWords.filter((word) => /^\p{Lu}/u.test(word)))]);
  for (const number of item.lower.filter((word) => /^\d+$/.test(word))) headlineTerms.add(number);
  for (const number of otherWords.filter((word) => /^\d+$/.test(word))) contextEvidence.add(number);
  const eventAt = [page.publishedAt, page.firstPostedAt, page.postedAt]
    .map((value) => typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN).find(Number.isFinite);
  const years = new Set(Array.from(title.matchAll(/\b(?:in|during)\s+(?:\p{L}+\s+)?((?:19|20)\d{2})\b|[[(]((?:19|20)\d{2})[)\]]\s*$/giu),
    ([, described, dated]) => described || dated));
  return {
    ...item, eventTerms, actions, details, contextTerms, marketMove, marketNames, versions, heading: item.lower.join(" "),
    names: headline.names, incident, stage: offeringStage(title), eventAt, years, instructional: INSTRUCTIONAL.test(title),
    headlineTerms, contextEvidence, namedEvidence, qualified: QUALIFIED_CLAIM.test(title),
  };
}

function corroboratedHeadline(left, right, shared) {
  const [short, full] = left.eventTerms.size <= right.eventTerms.size ? [left, right] : [right, left];
  if (short.eventTerms.size > 3 || full.eventTerms.size < 4) return false;
  let confirmed = 0;
  for (const term of full.eventTerms) if (eventDetail(term) && short.contextTerms.has(term)) confirmed++;
  return confirmed >= 2 && (shared + confirmed) / full.eventTerms.size >= 0.5;
}

function matchingObjects(left, right) {
  let best = 0;
  for (const a of left.incident) for (const b of right.incident) {
    if ([...a.scopes].some(([noun, scope]) => b.scopes.has(noun) && b.scopes.get(noun) !== scope)) continue;
    const shared = sharedCount(a.objects, b.objects);
    if (shared === 1 && [...a.modifiers].some(([noun, modifier]) => b.modifiers.has(noun) && b.modifiers.get(noun) !== modifier)) continue;
    best = Math.max(best, shared);
  }
  return best;
}

function eventScore(left, right) {
  if (left.versions.length && right.versions.length && !left.versions.some((version) => right.versions.includes(version))) return 0;
  if (left.years.size && right.years.size && !sharedCount(left.years, right.years)) return 0;
  const shared = sharedCount(left.eventTerms, right.eventTerms);
  if (Math.abs(left.eventAt - right.eventAt) > EVENT_WINDOW &&
    !(left.instructional && right.instructional && shared >= 4 && shared / Math.max(left.eventTerms.size, right.eventTerms.size) >= 0.7)) return 0;
  if (left.heading === right.heading && left.eventTerms.size >= 2) return 2;
  if (left.domain === right.domain) return 0;
  if (left.stage && right.stage && left.stage !== right.stage) return 0;

  const matchesAction = sharedCount(left.actions, right.actions);
  if ((left.actions.size || right.actions.size) && !matchesAction) return 0;
  if (matchesAction && left.names.size && right.names.size) {
    if (!sharedCount(left.names, right.names)) return 0;
    const common = matchingObjects(left, right);
    if (!common) return 0;
    if (common >= 2) return 0.95;
  }
  if (shared < 2) return 0;
  if (corroboratedHeadline(left, right, shared)) return 0.8;
  if (shared < 3) return 0;
  const overlap = shared / (left.eventTerms.size + right.eventTerms.size - shared);
  const contained = shared / Math.min(left.eventTerms.size, right.eventTerms.size);
  if (left.marketMove && right.marketMove && left.marketNames.size && right.marketNames.size) {
    if (![...left.marketNames].some((name) => right.marketNames.has(name))) return 0;
    if (left.eventTerms.has("stock") && right.eventTerms.has("stock") && overlap >= 0.24) return overlap + 0.25;
  }
  if (overlap >= 0.64 || (shared >= 4 && overlap >= 0.36 && contained >= 0.6)) return overlap + 0.5;
  if (overlap >= 0.24 && (left.details.some((term) => right.eventTerms.has(term)) ||
    right.details.some((term) => left.eventTerms.has(term))) && similarity(left, right) >= 0.88) return overlap + 0.25;
  return 0;
}

function storyClusters(items) {
  const clusters = items.map((_page, index) => [index]);
  const scores = items.map(() => new Float32Array(items.length));
  const edges = [];
  for (let left = 0; left < items.length; left++) for (let right = left + 1; right < items.length; right++) {
    const score = eventScore(items[left], items[right]);
    if (!score) continue;
    scores[left][right] = scores[right][left] = score;
    edges.push({ left, right, score });
  }
  edges.sort((left, right) => right.score - left.score);
  for (const { left, right } of edges) {
    const first = clusters[left];
    const second = clusters[right];
    // One article can mention two events. Require agreement across the cluster.
    if (first === second || first.some((a) => second.some((b) => !scores[a][b]))) continue;
    const merged = [...first, ...second];
    for (const index of merged) clusters[index] = merged;
  }
  return [...new Set(clusters)].map((indices) => indices.map((index) => items[index]));
}

function namedSubjects(items) {
  const phrases = new Map();
  for (const item of items) {
    const titleCase = item.words.filter((word) => /^\p{Lu}/u.test(word)).length > item.words.length * 0.6;
    for (let start = 0; start + 1 < item.words.length; start++) for (const size of [2, 3, 4]) {
      if (start + size > item.words.length) break;
      const lower = item.lower.slice(start, start + size);
      if (SUBJECT_QUALIFIERS.has(item.lower[start - 1]) ||
        lower.some((word) => !useful(word) || GENERIC_SUBJECT_WORDS.has(word))) continue;
      const visible = item.words.slice(start, start + size);
      const key = lower.join(" ");
      const phrase = phrases.get(key) || { key, label: phraseLabel(visible), pages: new Map(), named: false };
      phrase.pages.set(item.id, item);
      if (!titleCase && /^\p{Lu}\p{Ll}/u.test(visible[0]) && /^\p{Ll}/u.test(visible.at(-1))) phrase.named = true;
      phrases.set(key, phrase);
    }
  }
  return [...phrases.values()].filter(({ named, pages }) => named && new Set([...pages.values()].map(({ heading }) => heading)).size >= 2)
    .sort((left, right) => right.pages.size - left.pages.size || right.key.length - left.key.length || left.key.localeCompare(right.key));
}

function leadPages(pages) {
  if (pages.length === 1) return pages;
  const evidence = new Map();
  const namedSources = new Map();
  for (const page of pages) {
    for (const term of page.namedEvidence) namedSources.set(term, (namedSources.get(term) || 0) + 1);
    for (const term of page.headlineTerms) evidence.set(term, (evidence.get(term) || 0) + 1);
    for (const term of page.contextEvidence) {
      if (!page.headlineTerms.has(term)) evidence.set(term, (evidence.get(term) || 0) + 0.65);
    }
  }
  return pages.map((page) => {
    let support = page.qualified ? 1 : 0;
    for (const term of page.headlineTerms) {
      if (CLAIM_WORDS.has(term)) continue;
      const fraction = (evidence.get(term) - 1) / (pages.length - 1);
      support += fraction - 0.5 * (1 - fraction);
      if ((page.names.has(term) && namedSources.get(term) > 1) || page.actions.has(term)) support += 0.5 * fraction;
      if (!fraction && (EMPHATIC_DETAILS.has(term) || /^\d+$/.test(term))) support -= 0.5;
    }
    if (/(?:\.{3}|…)$/.test(page.title)) support -= 1;
    return { page, support };
  }).sort((left, right) => right.support - left.support ||
    left.page.id.localeCompare(right.page.id)).map(({ page }) => page);
}

function storyGroup(cluster, subjects) {
  const pages = leadPages(cluster);
  const lead = pages[0];
  const pageIds = pages.map(({ id }) => id);
  const kind = pages.length === 1 && lead.posts.length > 1 ? "coverage" : "story";
  const subjectTitles = subjects.filter(({ pages: matches }) => pageIds.filter((id) => matches.has(id)).length >= 2)
    .slice(0, 2).map(({ label }) => label);
  const aliases = new Set(pages.length > 1 ? subjectTitles : subjects.filter(({ pages: matches }) => matches.has(lead.id))
    .slice(0, 2).map(({ label }) => label));
  if (pages.length > 1) for (const size of [4, 3, 2]) {
    const words = lead.words.slice(0, size);
    if (words.length !== size || !words.every((word) => /^\p{Lu}/u.test(word) && useful(word.toLowerCase()))) continue;
    const lower = lead.lower.slice(0, size).join(" ");
    if (pages.every((page) => page.words.length > size && page.lower.slice(0, size).join(" ") === lower)) {
      aliases.add(phraseLabel(words));
      break;
    }
  }
  return {
    id: kind + ":" + [...pageIds].sort()[0], label: lead.title, kind,
    ...(aliases.size ? { aliases: [...aliases] } : {}), ...(subjectTitles.length ? { subjectTitles } : {}), pageIds,
  };
}

export function groupPages(pages) {
  const items = topicPageEvidence(pages).filter(({ title }) => title).map(eventPage).sort((left, right) => left.id.localeCompare(right.id));
  const subjects = namedSubjects(items);
  return storyClusters(items).map((cluster) => storyGroup(cluster, subjects));
}
