import { articleSourceKey } from "./article.mjs";
import { canonicalURL } from "./feeds.mjs";

const EVENT_WINDOW = 3 * 86_400_000;
const MAX_ANCHORS = 32;
const MAX_CANDIDATES = 32;
const MAX_ADDITIONS = 8;
const UNCONFIRMED = /\?|\b(?:might|may|could|would|will|if|risks?|faces?|allegedly|rumou?red|denies|hoax)\b/i;
const FAILED_TALKS = /\b(?:talks|negotiations?|summit|conference|agreement)\s+(?:(?:has|have|finally)\s+)*(?:collaps(?:e[sd]?)|(?:breaks?|broke|broken) down|(?:falls?|fell|fallen) apart|end(?:s|ed)? (?:without|with no) (?:an? )?(?:agreement|deal)|fail(?:s|ed)? to (?:reach|secure|agree on) (?:an? )?(?:agreement|deal))\b|\bcollapse of (?:[\p{L}\p{N}.-]+ ){0,4}(?:talks|negotiations?|summit)\b/iu;
const FAILED_MEETING = /\b[a-z]{1,10}\d{1,3}\s+(?:(?:ends?|ended) (?:without|with no) (?:an? )?(?:agreement|deal)|(?:(?:is|was|has been) )?declared a failure)\b/i;
const ELECTION_WIN = /\b(?:defeats|defeated|unseats|unseated|beats)\b/i;
const ELECTION_LOSS = /\b(?:loses?|lost) (?:the |their |his |her )?(?:re ?election|race|seat)|\bconcedes? (?:the race )?to\b/;
const PERSON = /(?:^|\s)(\p{Lu}[\p{Ll}’'-]+\s+\p{Lu}[\p{Ll}’'-]+)$/u;
const ROLE_WORDS = /\b(?:rep(?:resentative)?|sen(?:ator)?|gop|democrat(?:ic)?|republican|longtime|incumbent)\b\.?/gi;
const IDENTITY_NOISE = new Set("after age analyst and article broadcaster dead death died dies former great hall legacy legend legends life longtime news obituary old player star story the years".split(" "));
const POSITIONS = /\b(?:quarterback|linebacker|midfielder|goalkeeper|pitcher|catcher)\b/i;
const TEAM_ROLE = /\b([\p{L}]+)(?:[’']s?)?\s+(?:All-Pro\s+)?(?:star|great|legend|linebacker|quarterback|midfielder|goalkeeper|pitcher|catcher)\b/giu;
const MONTHS = "jan feb mar apr may jun jul aug sep oct nov dec".split(" ");

function words(text) {
  return text.normalize("NFKC").toLowerCase().replace(/[’']s\b/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function meeting(title, slug) {
  if (!FAILED_TALKS.test(title) && !(FAILED_MEETING.test(title) && /\b(?:talks|negotiations?|summit|declaration)\b/i.test(title))) return null;
  const series = new Set((title + " " + slug).toLowerCase().match(/\b[a-z]{1,10}\d{1,3}\b/g));
  if (series.size !== 1) return null;
  const before = /\b([\p{L}\d]+)\s+(?:change\s+)?(?:talks|negotiations?|summit|conference|agreement)\b/iu.exec(title)?.[1]?.toLowerCase();
  const agenda = before && !series.has(before) && !/^(?:a|an|the|un|global|international|longest)$/.test(before) ? before : "";
  return { kind: "meeting", series: [...series][0], agenda, details: new Set(words(title + " " + slug).split(" ")) };
}

function election(title, slug) {
  const headline = words(title);
  if (!/\b(?:election|reelection|recount|(?:house|senate|governor|mayoral|parliamentary) (?:race|seat))\b/.test(headline) ||
      /\b(?:polls?|polling|debate|primar(?:y|ies)|lawsuit|policy)\b/.test(headline) ||
      !(ELECTION_WIN.test(headline) || ELECTION_LOSS.test(headline))) return null;
  const office = /\b(house|senate|governor|mayor|parliament)\b/.exec(headline)?.[0];
  const result = ELECTION_WIN.exec(title);
  let pair;
  if (result) {
    const winner = PERSON.exec(title.slice(0, result.index).trim())?.[1];
    const loser = /^(\p{Lu}[\p{Ll}’'-]+\s+\p{Lu}[\p{Ll}’'-]+)/u.exec(title.slice(result.index + result[0].length).replace(ROLE_WORDS, "").trim())?.[1];
    if (winner && loser) pair = [words(winner), words(loser)];
  }
  return { kind: "election", office, pair, fragments: [headline, slug] };
}

function obituary(title, slug) {
  const death = /\b(?:dead|died|dies)\s+(?:at (?:the age of |age )?|aged?\s+)(\d{1,3})\b/i.exec(title);
  let name, age;
  if (death) {
    const before = title.slice(0, death.index).trim();
    const subject = before.endsWith(",") && /^([\p{Lu}][\p{Ll}’'-]+(?:\s+[\p{Lu}][\p{Ll}’'-]+){1,3})\s*,/u.exec(before) ||
      PERSON.exec(before);
    if (!subject) return null;
    name = words(subject[1]);
    age = death[1];
  } else {
    const tribute = /^(?:the )?life and legacy of (?:the (?:late|great) )?(.+?)[:.]?$/i.exec(title);
    const subject = tribute && PERSON.exec(tribute[1]);
    const stated = /\b(?:dead|died|dies) (?:at |age )*(\d{1,3})\b/.exec(slug);
    if (!subject || !stated) return null;
    name = words(subject[1]);
    if (!(" " + slug + " ").includes(" " + name + " ")) return null;
    age = stated[1];
  }
  const identity = new Set(words(title + " " + slug).split(" ").filter(word => word.length > 2 && !IDENTITY_NOISE.has(word) &&
    !name.split(" ").includes(word) && /^\p{L}+$/u.test(word)));
  const team = [...title.matchAll(TEAM_ROLE)].map(match => match[1]).find(value => /^\p{Lu}\p{Ll}/u.test(value) && !IDENTITY_NOISE.has(value.toLowerCase()));
  return { kind: "obituary", name, age, identity, team: team?.toLowerCase(), position: POSITIONS.exec(title)?.[0].toLowerCase() };
}

function claim(title, key) {
  const headline = title.normalize("NFKC").split(/\s+[|｜]\s+/)[0].trim();
  if (UNCONFIRMED.test(headline) || !/\b(?:talks|negotiations?|summit|conference|declaration|agreement|defeated|defeats|unseated|unseats|beats|loses|lost|concedes|dead|died|dies|legacy)\b/i.test(headline)) return null;
  const page = canonicalURL("https://" + key);
  if (!page) return null;
  const leaf = new URL(page.url).pathname.split("/").filter(Boolean).at(-1) || "";
  let slug;
  try { slug = words(decodeURIComponent(leaf)); } catch { return null; }
  return meeting(headline, slug) || election(headline, slug) || obituary(headline, slug);
}

function confirmsPair([winner, loser], claim) {
  if (claim.pair) return claim.pair[0] === winner && claim.pair[1] === loser;
  return claim.fragments.some(fragment => {
    const text = " " + fragment + " ";
    const a = text.indexOf(" " + winner + " "), b = text.indexOf(" " + loser + " ");
    if (a < 0 || b < 0) return false;
    return a < b ? ELECTION_WIN.test(text.slice(a + winner.length + 1, b)) :
      ELECTION_LOSS.test(text.slice(b + loser.length + 1, a));
  });
}

function matches(left, right) {
  if (!left || !right || left.kind !== right.kind) return false;
  if (left.kind === "meeting") {
    if (left.series !== right.series) return false;
    if (left.agenda && right.agenda) return left.agenda === right.agenda;
    const general = left.agenda ? right : left, specific = left.agenda ? left : right;
    if (!specific.agenda || general.details.has(specific.agenda)) return true;
    const details = [...left.details].filter(word => word.length > 3 && right.details.has(word) &&
      word !== left.series && !/^(?:talks|negotiations?|conference|summit|agreement|declared|failure|deal|collapse[ds]?|reached|reach|failed)$/.test(word));
    return details.length >= 2;
  }
  if (left.kind === "obituary") return left.name === right.name && left.age === right.age &&
    (!left.team || !right.team || left.team === right.team) &&
    (!left.position || !right.position || left.position === right.position) &&
    [...left.identity].filter(word => right.identity.has(word)).length >= 2;
  if (left.office && right.office && left.office !== right.office) return false;
  return left.pair ? confirmsPair(left.pair, right) : right.pair && confirmsPair(right.pair, left);
}

function articleDay(key) {
  const date = /\/((?:19|20)\d{2})[/-](\d{2}|[a-z]{3})[/-](\d{2})(?:[/-]|$)/i.exec(key.split(/[?#]/, 1)[0]);
  if (!date) return null;
  const month = /^\d+$/.test(date[2]) ? Number(date[2]) : MONTHS.indexOf(date[2].toLowerCase()) + 1;
  const time = Date.UTC(Number(date[1]), month - 1, Number(date[3]));
  return month >= 1 && month <= 12 && new Date(time).getUTCDate() === Number(date[3]) ? time : null;
}

export async function articleMembers(index, topic, firstSharedDates) {
  const formal = index.pages.filter(({ topicIds }) => topicIds.includes(topic.id));
  if (!formal.length || formal.length > MAX_ANCHORS || topic.curated || topic.kind === "topic") return formal;
  const anchors = formal.map(({ key }) => claim(topic.label, key));
  if (anchors.some(anchor => !anchor)) return formal;
  const byId = new Map(index.topics.map(record => [record.id, record]));
  const restricted = new Set(index.topics.filter(record => record.curated).map(record => record.id));
  for (const page of index.pages) {
    if (page.reviewed || page.topicIds.some(id => byId.get(id)?.curated)) {
      for (const id of page.topicIds) restricted.add(id);
    }
  }
  if (restricted.has(topic.id)) return formal;
  const publishers = new Set(formal.map(({ key }) => canonicalURL("https://" + key)?.domain));
  const plausible = [];
  for (const page of index.pages) {
    if (page.reviewed || page.topicIds.includes(topic.id) || page.topicIds.some(id => restricted.has(id))) continue;
    const owner = page.topicIds.map(id => byId.get(id)).find(record => record?.kind === "story" || record?.kind === "coverage");
    if (!owner) continue;
    const other = claim(owner.label, page.key);
    if (!anchors.every(anchor => matches(anchor, other))) continue;
    const url = "https://" + page.key;
    const domain = canonicalURL(url)?.domain;
    if (!domain || publishers.has(domain) || !articleSourceKey(url)) continue;
    const affiliation = other.kind === "obituary" && anchors.some(anchor => anchor.identity.has(domain.split(".")[0]));
    const descriptive = new URL(url).pathname.split(/[-_]/).length >= 3;
    plausible.push({ page, domain, id: owner.id, rank: Number(affiliation) * 2 + Number(descriptive) });
  }
  plausible.sort((a, b) => b.rank - a.rank || a.page.key.localeCompare(b.page.key));
  const represented = new Set();
  const primary = [], otherReports = [];
  for (const candidate of plausible) {
    (represented.has(candidate.id) ? otherReports : primary).push(candidate);
    represented.add(candidate.id);
  }
  const shortlist = [...primary, ...otherReports].slice(0, MAX_CANDIDATES);
  if (!shortlist.length) return formal;
  const dates = await firstSharedDates([...formal, ...shortlist.map(({ page }) => page)]);
  const anchorDates = formal.map(({ key }) => dates.get(key)).filter(Number.isFinite);
  if (!anchorDates.length) return formal;
  const first = Math.min(...anchorDates);
  const published = formal.map(({ key }) => articleDay(key)).filter(Number.isFinite);
  const eventAt = published.length ? Math.min(...published) : first;
  const result = [...formal];
  const selectedStories = new Set();
  for (const { page, domain, id } of shortlist) {
    if (publishers.has(domain) || selectedStories.has(id)) continue;
    const date = dates.get(page.key);
    if (!Number.isFinite(date) || Math.abs(first - date) > EVENT_WINDOW ||
        Math.abs(eventAt - (articleDay(page.key) ?? date)) > EVENT_WINDOW) continue;
    result.push(page);
    publishers.add(domain);
    selectedStories.add(id);
    if (result.length === formal.length + MAX_ADDITIONS) break;
  }
  return result;
}
