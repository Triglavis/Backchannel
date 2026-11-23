import { publisherArticleKey, topicPageEvidence } from "./feeds.mjs";

const STOP_WORDS = new Set((
  "a an as at by in is it of on or so to up via vs about above after again also among and another are back been before being below both but can could did does doing down each " +
  "even ever every first for from get getting had has have having here how into its just last less like made make making " +
  "he she many may might more most much must new next nor not now off once one only other our out over own really same say says " +
  "see should since some still such than that the their them then there these they this those through time too under " +
  "until use used uses using very want was way well were what when where which while who why will with without would years " +
  "you your today tomorrow yesterday developer developers tech update updates released release better now introducing guide"
).split(/\s+/));
const EVENT_WINDOW = 3 * 86_400_000;
const CONFIRMED_STATUS_WINDOW = 14 * 86_400_000;
const GENERIC_SUBJECT_WORDS = new Set((
  "announces announcement arrives build building companies company faces finally firm firms group hastily launches launching " +
  "look offers plan plans shows stock shares staffers starts threatens unveiled unveils workers works"
).split(/\s+/));
const FUNCTION_WORDS = new Set("a an and are as at be been being by can could did do does for from had has have having in is it its may might of on or that the their this to was were will with would".split(" "));
const REPORTING_SOURCE = /^(?:analys[ie]s|data|evidence|experts?|findings?|officials?|papers?|polls?|reports?|research(?:ers?)?|results?|scientists?|stud(?:y|ies)|surveys?)$/;
const REPORTING_VERB = /^(?:claim(?:s|ed)?|conclud(?:es?|ed)|confirm(?:s|ed)?|finds?|found|indicat(?:es?|ed)|report(?:s|ed)?|reveal(?:s|ed)?|said|says?|show(?:s|ed|n)?|suggest(?:s|ed)?|warn(?:s|ed)?)$/;
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
const STATUS_NOUN = /\b(?:status|designation|classification|accreditation|certification|eligibility|membership|licen[cs]e)\b/i;
const STATUS_CHANGE = /\b(?:(?<loss>no longer|los(?:es?|ing|s)|lost|revok(?:es?|ed))|(?<restoration>regain(?:s|ed|ing)?|restor(?:es?|ed|ing))|(?<retention>retain(?:s|ed|ing)?|keep(?:s|ing)?|kept|maintain(?:s|ed|ing)?|still)|(?<gain>gain(?:s|ed|ing)?|earn(?:s|ed|ing)?|achiev(?:es?|ed|ing)))\b/i;
const CLASSIFIED = /\b(?:considered|deemed|classified|declared|designated|recognised|recognized|certified)\b/i;
const STATUS_FORECAST = /\b(?:could|may|might|will|would|if|unless|risks?|risking|expected|expects?|likely|potential(?:ly)?|poised|set to|about to|on the (?:brink|verge) of)\b/i;
const STATUS_UNCONFIRMED = /\b(?:allegedly|reportedly|possibl[ey]|suspected|believed|(?:may|might|could|appears? to) have)\b/i;
const STATUS_NOISE = new Set("status designation classification official officially formally consider deem classifi declar designat recognize recognise certifi".split(" "));
const EDITORIAL_FOLLOWUP = /[.!?:]\s+(?:(?:here['’]s|here (?:is|are))\s+(?:how|what|why|who)\b|what (?:now|next|it means|that means|happens next)\b)/i;
const MONTHS = "jan feb mar apr may jun jul aug sep oct nov dec".split(" ");

const OFFICE_TERMS = new Set("board chair chairman chairwoman chief company director executive firm officer president".split(" "));

const RETURN_ACTION = /\b(?:reinstat(?:e[ds]?|ement|ing)|returns?|returned|bring(?:s|ing)?|brought|back)\b/i;
const RETURN_ROLE = /\b(?:CEO|CFO|CTO|COO|chief (?:executive|financial|technology|operating)(?: officer)?|president|chair(?:man|woman|person)?|director|head coach|manager)\b/gi;
const RETURN_WORD = String.raw`\p{Lu}[\p{L}\p{M}\d]*(?:['-]\p{Lu}[\p{L}\p{M}\d]*)*`;
const RETURN_NAME = RETURN_WORD + "(?:\\s+(?:(?:of|and|the)\\s+)?" + RETURN_WORD + "){0,5}";
const RETURN_FIRST = new RegExp("^(" + RETURN_NAME + ")(?![\\p{L}\\d-])", "u");
const RETURN_LAST = new RegExp("(?:^|[^\\p{L}\\d'-])(" + RETURN_NAME + ")$", "u");
const RETURN_OWNER = new RegExp("(" + RETURN_NAME + ")(?:'s)?\\s+(?:'[^']{1,32}'\\s+)?(?:board|decision|denies|plans|considers|may|might|could|will|stock|shares|skyrockets?|surges?|soars?|rallies|jumps?|live updates)\\b", "gu");

export function leadershipReturn(title) {
  if (!RETURN_ACTION.test(title)) return null;
  const text = title.normalize("NFKC").replace(/[’‘]/g, "'")
    .replace(/\b(?:a|after|amid|and|as|at|back|before|board|by|chief|decision|for|from|get|has|have|in|is|it|live updates|of|on|says|shares|stock|the|to|with)\b/gi, (word) => word.toLowerCase());
  const action = /\breinstat(?:e[ds]?|ement|ing)\b/i.exec(text) || RETURN_ACTION.exec(text);
  const verb = action[0].toLowerCase();
  const before = text.slice(0, action.index).trimEnd();
  const after = text.slice(action.index + verb.length).trimStart();
  const first = (part) => RETURN_FIRST.exec(part)?.[1] || "";
  const last = (part) => RETURN_LAST.exec(part)?.[1] || "";
  let person = "", organization = "", tail = after;
  const subject = before.replace(/'s$|\s+(?:(?:has|have|had) been|is|was|gets?|got)$/i, "").trimEnd();
  if (/^reinstat(?:es?|ing)$/.test(verb) || /^(?:bring|brought)/.test(verb) || verb === "reinstated" && first(after)) {
    const object = after.replace(/^back\s+/i, "");
    const owner = first(object);
    const possessive = owner && object.slice(owner.length).startsWith("'s ");
    person = possessive ? first(object.slice(owner.length + 3)) : owner;
    organization = possessive ? owner : "";
    tail = person ? object.slice((possessive ? owner.length + 3 : 0) + person.length).trimStart() : after;
    if (/^(?:bring|brought)/.test(verb) && !/^back\b/i.test(after) && !/^back\b/i.test(tail)) return null;
    tail = tail.replace(/^back\s*/i, "");
    organization ||= last(subject);
  } else {
    person = last(subject);
    if (verb === "back" && !/^as\b/i.test(after)) return null;
    const owner = person && /'s\s*$/.exec(subject.slice(0, -person.length));
    if (owner) organization = last(subject.slice(0, owner.index));
  }
  if (!person) return null;
  if (/^return/.test(verb) && /^to\s+/i.test(after)) {
    const destination = after.replace(/^to\s+/i, "");
    organization = first(destination);
    tail = destination.slice(organization.length).trimStart();
    if (!organization || !before.endsWith("'s") && !/^as\s/i.test(tail) || /^(?:for|to)\s/i.test(tail)) return null;
  }
  const roleText = /^as\s+(?:(?:the|its|interim|acting|permanent)\s+)*/i.exec(tail);
  const office = roleText ? tail.slice(roleText[0].length).split(/\s+(?:after|amid|as|at|for|from|of|on|while|with)\b|[;:|.!?]/i)[0] : "";
  const roles = [...office.matchAll(RETURN_ROLE)].map(([word]) => {
    const role = word.toLowerCase();
    return ({ executive: "ceo", financial: "cfo", technology: "cto", operating: "coo" })[role.split(" ")[1]] || role;
  });
  if (roles.length) {
    const role = office.match(RETURN_ROLE)[0];
    const employer = office.slice(0, office.indexOf(role)).trim();
    organization ||= first(employer) || first(tail.replace(/^as\s+.+?\s+(?:of|at|for)\s+/i, ""));
  }
  organization ||= [...before.matchAll(RETURN_OWNER)].at(-1)?.[1] || (verb === "reinstatement" && [...after.matchAll(RETURN_OWNER)][0]?.[1]) || "";
  if (!organization || organization === person || /^return|^back/.test(verb) && !roles.length && !before.endsWith("'s")) return null;
  const roleClaim = before.split(/[;:!?]/).at(-1);
  const stated = !/\b(?:may|might|could|should|would|will|whether|if|unless|not|never|den(?:y|ies|ied)|reject(?:s|ed)?|against|urges?|asks?|wants?|hopes?|plans?|consider(?:s|ing)?|rumou?red|potential|possible)\b|n't\b/i.test(roleClaim) &&
    !/\?\s*$/.test(text) && !/\s+(?:if|unless|pending)\s/i.test(tail.split(/[,;:.!]/)[0]);
  const direct = [organization, person].some((name) => text.toLowerCase().startsWith(name.toLowerCase() + " ")) &&
    !/\b(?:after|as|on|live updates|return|shares|stock)\b|[;:]/i.test(subject);
  const year = /\b(?:in|during)\s+((?:19|20)\d{2})\b|[[(]((?:19|20)\d{2})[)\]]\s*$/.exec(text);
  return { person: person.toLowerCase(), organization: organization.toLowerCase(), roles, stated, direct,
    explicit: verb.startsWith("reinstat"), year: year && Number(year[1] || year[2]) };
}

export function sameLeadershipReturn(a, b) {
  if (!a || !b || !a.stated || !b.stated || a.organization !== b.organization ||
    a.year && b.year && a.year !== b.year ||
    a.roles.length && b.roles.length && !a.roles.some((role) => b.roles.includes(role))) return false;
  return a.person === b.person || !b.person.includes(" ") && a.person.endsWith(" " + b.person) ||
    !a.person.includes(" ") && b.person.endsWith(" " + a.person);
}

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

export function informativeTopicAlias(label, storyLabel) {
  const words = titleWords(label.toLowerCase());
  if (words.length < 2) return words.length > 0;
  const content = words.filter((word) => !FUNCTION_WORDS.has(word));
  if (!content.length || /^(?:loses|regains|retains|confirms|suggests|reveals)$/.test(words.at(-1))) return false;
  if (content.some((word) => REPORTING_VERB.test(word)) && content.every((word) => REPORTING_SOURCE.test(word) || REPORTING_VERB.test(word))) return false;
  return !storyLabel || !statusChange(eventSpelling(label)) || compatibleStoryTitles(storyLabel, label);
}

const TOPIC_ORDER = { story: 0, topic: 1, coverage: 2 };

function labelKey(label) {
  return label.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

function relatedTopics(left, right, shared) {
  if (left.curated || right.curated) return false;
  if (left.kind !== "topic" && right.kind !== "topic" && !compatibleStoryTitles(left.label, right.label)) return false;
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
  return compatibleStoryTitles(left, right) && relatedHeadlines(facts({ title: left.normalize("NFKC") }), facts({ title: right.normalize("NFKC") }));
}

export function coalesceTopics(topics) {
  const byPage = new Map();
  const ranked = topics.map((topic) => {
    const { lower, terms, numbers } = facts({ title: topic.label.normalize("NFKC") });
    const entry = {
      ...topic, lower, terms, numbers, phrase: lower.join(" "), labelKey: labelKey(topic.label),
      aliasKeys: new Set((topic.aliases || []).filter((alias) => topic.curated || informativeTopicAlias(alias)).map(labelKey)),
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

function eventSpelling(title) {
  return title.replace(/\bUnited States(?: of America)?\b|\bU\.S(?:\.A)?\b\.?|\bUSA\b/gi, "US")
    .replace(/\bsell[ -]off\b/gi, "selloff");
}

function statusHolders(text, beforeChange) {
  const words = text.match(/[\p{L}\p{N}]+|[,&:;.!?]/gu) || [];
  if (beforeChange) {
    while (words.length && (FUNCTION_WORDS.has(words.at(-1).toLowerCase()) || STATUS_FORECAST.test(words.at(-1)) ||
      STATUS_UNCONFIRMED.test(words.at(-1)) || /^(?:not|never|officially|already|just|finally|formally|yet|close|verge|brink)$/i.test(words.at(-1)))) words.pop();
    words.reverse();
  }
  const name = [];
  for (const word of words) {
    if (!/^\p{Lu}/u.test(word) && !/^(?:and|of|the|[,&])$/i.test(word)) break;
    name.push(/[,&]/.test(word) ? "and" : word.toLowerCase());
  }
  if (beforeChange) name.reverse();
  return new Set(name.join(" ").split(/\s*\band\b\s*/).map((part) => part.replace(/^the(?:\s+|$)/, "")).filter(Boolean));
}

function statusChange(title) {
  const change = STATUS_CHANGE.exec(title);
  if (!change) return null;
  const before = title.slice(0, change.index).replace(/n[’']t\b/gi, " not");
  const after = title.slice(change.index + change[0].length);
  const implicit = /^(?:no longer|still)$/i.test(change[0]) && CLASSIFIED.test(after);
  const noun = STATUS_NOUN.exec(title);
  const control = change.groups.loss && /\bofficially\b/i.test(before) && /^\s+control of\s+([^,;:.!?]+)/i.exec(after);
  if (!implicit && !noun && !control) return null;
  const place = /\b(?:in|across|for)\s+(?:the\s+)?(?=\p{Lu})/u.exec(after);
  const trailingHolders = place ? statusHolders(after.slice(place.index + place[0].length), false) : new Set();
  const subject = statusHolders(before, true);
  const holders = (implicit && trailingHolders.size) || !subject.size ? trailingHolders : subject;
  let detail;
  if (control) {
    detail = control[1] + " elimination";
  } else if (implicit) {
    detail = (trailingHolders.size ? before + " " : "") + after.slice(0, place?.index);
  } else if (noun.index < change.index) {
    detail = title.slice(0, change.index);
  } else {
    const end = noun.index + noun[0].length;
    detail = title.slice(change.index + change[0].length, end);
    const complement = /^\s+(of|for|as)\s+([^,;:.!?]+)/i.exec(title.slice(end));
    if (complement && !trailingHolders.size) {
      const namesRole = complement[1].toLowerCase() !== "as" || /^(?:an?|the)\s/i.test(complement[2]) ||
        !eventWords(titleWords(detail)).some((word) => !STATUS_NOISE.has(word));
      if (namesRole) detail += " " + complement[2];
    }
  }
  detail = detail.replace(/\b(?:long[ ‐‑–-]?(?:held|standing)|(?:decades?|years?|centur(?:y|ies))[ ‐‑–-]old)\b/gi, "");
  const attribute = new Set(eventWords(titleWords(detail.replace(/[-‐‑–]free\b/gi, " elimination"))).filter((word) => !STATUS_NOISE.has(word))
    .map((word) => word.replace(/ation$/, "at")));
  const kind = Object.keys(change.groups).find((key) => change.groups[key]);
  const forecast = STATUS_FORECAST.test(before) || /\b(?:if|unless|pending|subject to)\b/i.test(after.split(/[.;:!?]/, 1)[0]) ||
    /^\s*(?:is|are|has|have|does|do|can)\b.*\?\s*$/i.test(title);
  const certainty = STATUS_UNCONFIRMED.test(before) ? "unconfirmed" : forecast ? "prospective" : "stated";
  return { kind, holders, attribute, certainty, formal: !control, negated: /\b(?:not|never)\b/i.test(before) };
}

function sameStatusChange(left, right) {
  return Boolean(left && right && left.kind === right.kind && left.certainty === right.certainty && left.negated === right.negated &&
    sharedCount(left.holders, right.holders) && left.attribute.size && left.attribute.size === right.attribute.size &&
    sharedCount(left.attribute, right.attribute) === left.attribute.size);
}

export function compatibleStoryTitles(left, right) {
  if (left === right) return true;
  const aReturn = leadershipReturn(left), bReturn = leadershipReturn(right);
  if (aReturn || bReturn) return sameLeadershipReturn(aReturn, bReturn);
  const a = statusChange(eventSpelling(left));
  const b = statusChange(eventSpelling(right));
  return (!a && !b) || sameStatusChange(a, b);
}

function datedArticlePath(url) {
  const match = /\/((?:19|20)\d{2})[/-](\d{2}|[a-z]{3})[/-](\d{2})(?:[/-]|$)/i.exec((url || "").split(/[?#]/, 1)[0]);
  if (!match) return null;
  const month = /^\d+$/.test(match[2]) ? Number(match[2]) : MONTHS.indexOf(match[2].toLowerCase()) + 1;
  const day = Number(match[3]);
  const date = Date.UTC(Number(match[1]), month - 1, day);
  return month >= 1 && month <= 12 && new Date(date).getUTCDate() === day ? date : null;
}

function eventPage(page) {
  const title = page.title.replace(/^(?:Ask|Show|Tell|Launch) HN:\s*/i, "").replace(/\s+\(gift (?:article|link)\)\s*$/i, "").trim() || page.title;
  const posts = page.posts || [];
  const item = facts({ ...page, title, posts });
  const normalized = eventSpelling(title);
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
  const status = statusChange(normalized);
  const leadership = leadershipReturn(title);
  const eventAt = [page.publishedAt, (status || leadership) && datedArticlePath(page.url), page.firstPostedAt, page.postedAt]
    .map((value) => typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN).find(Number.isFinite);
  const years = new Set(Array.from(title.matchAll(/\b(?:in|during)\s+(?:\p{L}+\s+)?((?:19|20)\d{2})\b|[[(]((?:19|20)\d{2})[)\]]\s*$/giu),
    ([, described, dated]) => described || dated));
  return {
    ...item, articleKey: publisherArticleKey(page.url), heading: item.lower.join(" "),
    eventTerms, actions, details, contextTerms, marketMove, marketNames, versions,
    names: headline.names, incident, stage: offeringStage(title), status, leadership, hasOffice: Boolean(title.match(RETURN_ROLE)),
    eventAt, years, instructional: INSTRUCTIONAL.test(title),
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
  const matchingStatus = sameStatusChange(left.status, right.status);
  const elapsed = Math.abs(left.eventAt - right.eventAt);
  const sameHeadline = left.heading === right.heading && left.eventTerms.size >= 2;
  if (left.leadership && right.leadership || left.leadership?.explicit || right.leadership?.explicit ||
    left.leadership?.roles.length || right.leadership?.roles.length) {
    if (elapsed > EVENT_WINDOW) return 0;
    if (left.leadership?.year && !right.leadership?.year && left.leadership.year !== new Date(right.eventAt).getUTCFullYear() ||
      right.leadership?.year && !left.leadership?.year && right.leadership.year !== new Date(left.eventAt).getUTCFullYear()) return 0;
    if (sameLeadershipReturn(left.leadership, right.leadership)) {
      return 3 + Number(left.leadership.person === right.leadership.person) +
        Number(Boolean(left.leadership.roles.length && right.leadership.roles.length));
    }
    return sameHeadline ? 2 : 0;
  }
  if (left.status || right.status) {
    const [dated, other] = left.years.size ? [left, right] : [right, left];
    if (dated.years.size && !other.years.size && !dated.years.has(String(new Date(other.eventAt).getUTCFullYear()))) return 0;
    const confirmed = matchingStatus && (left.status.formal || right.status.formal) && left.status.certainty === "stated" && !left.status.negated;
    const window = confirmed ? CONFIRMED_STATUS_WINDOW : EVENT_WINDOW;
    if (elapsed > window) return 0;
    if (matchingStatus) return 1 + (Number.isFinite(elapsed) ? 1 - elapsed / window : 0);
    return sameHeadline ? 2 : 0;
  }
  if (elapsed > EVENT_WINDOW &&
    !(left.instructional && right.instructional && shared >= 4 && shared / Math.max(left.eventTerms.size, right.eventTerms.size) >= 0.7)) return 0;
  if (sameHeadline) return 2;
  if (left.domain === right.domain && (!left.articleKey || left.articleKey !== right.articleKey)) return 0;
  if (left.stage && right.stage && left.stage !== right.stage) return 0;
  if ((left.hasOffice || right.hasOffice) && sharedCount(left.names, right.names) >= 2 &&
    ![...left.eventTerms].some((term) => right.eventTerms.has(term) && !left.names.has(term) && !right.names.has(term) && !OFFICE_TERMS.has(term))) return 0;

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
  return [...phrases.values()].filter(({ named, key, pages }) =>
    named && informativeTopicAlias(key) && new Set([...pages.values()].map(({ heading }) => heading)).size >= 2)
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
  let lead = pages[0];
  let label = lead.title;
  if (pages.length > 1 && lead.status) {
    const candidates = pages.filter(({ status }) => status?.formal && status.holders.size &&
      [...status.holders].every((holder) => pages.every((page) => page.status?.holders.has(holder))));
    if (candidates.length) {
      const headings = candidates.map((page) => ({ page, text: page.title.split(EDITORIAL_FOLLOWUP, 1)[0].trim() }));
      headings.sort((a, b) => titleWords(a.text).length - titleWords(b.text).length);
      lead = headings[0].page;
      label = headings[0].text;
      pages.splice(pages.indexOf(lead), 1);
      pages.unshift(lead);
    }
  }
  if (pages.length > 1 && lead.leadership) {
    const reports = pages.filter(({ leadership }) => leadership?.direct && leadership.roles.length);
    reports.sort((a, b) => Number(b.leadership.explicit) - Number(a.leadership.explicit) || a.title.length - b.title.length);
    if (reports.length) {
      lead = reports[0];
      label = lead.title;
      pages.splice(pages.indexOf(lead), 1);
      pages.unshift(lead);
    }
  }
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
    if (informativeTopicAlias(lower) && pages.every((page) => page.words.length > size && page.lower.slice(0, size).join(" ") === lower)) {
      aliases.add(phraseLabel(words));
      break;
    }
  }
  if (label !== lead.title) aliases.add(lead.title);
  return {
    id: kind + ":" + [...pageIds].sort()[0], label, kind,
    ...(aliases.size ? { aliases: [...aliases] } : {}), ...(subjectTitles.length ? { subjectTitles } : {}), pageIds,
  };
}

export function groupPages(pages) {
  const items = topicPageEvidence(pages).filter(({ title }) => title).map(eventPage).sort((left, right) => left.id.localeCompare(right.id));
  const subjects = namedSubjects(items);
  return storyClusters(items).map((cluster) => storyGroup(cluster, subjects));
}
