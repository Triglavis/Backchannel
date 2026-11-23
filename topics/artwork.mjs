const WIKIPEDIA = "https://en.wikipedia.org/w/api.php";
const WIKIDATA = "https://www.wikidata.org/w/api.php";
const COMMONS = "https://commons.wikimedia.org/w/api.php";
const USER_AGENT = "BackchannelTopicsBot/1.0 (https://github.com/twalichiewicz/Backchannel/issues)";
const DAY = 86_400_000;
const POSITIVE_TTL = 7 * DAY;
const NEGATIVE_TTL = 2 * DAY;
const CACHE_VERSION = "v2:";
const MAX_LOOKUPS = 24;
const MAX_COMMONS_SEARCHES = 8;
const COMMONS_BATCH_SIZE = 8;
const NON_ARTWORK = /\b(?:logo|logos|logotype|icon|icons|favicon|word ?mark|emblem|flag|seal|coat of arms|signature|banner|branding|placeholder)\b/i;
const NON_SUBJECT_FILE = /\b(?:newspapers?|newsprint|stock (?:photo|image)|advertisement|signage|title card|trailer \d+ date|release date)\b/i;
const ORGANIZATION = /\b(?:company|corporation|conglomerate|organisation|organization|government agency)\b/i;
const FACILITY = /\b(?:headquarters|campus|offices?|facades?|research facility)\b/i;
const GEOGRAPHIC_SUBJECT = /^(?:[a-z.]+ ){0,3}(?:city|town|borough|county|village|municipality|suburb|country|province|island|territory|state in|state of)\b/i;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/svg+xml"]);
const COMMONS_IMAGE_INFO = {
  action: "query", prop: "imageinfo", iiprop: "url|size|mime|extmetadata", iiurlwidth: "640",
  iiextmetadatafilter: "Artist|Attribution|ImageDescription|LicenseShortName|LicenseUrl|NonFree",
};
const CONTEXT_STOP = new Set("also american based born cited company corporation first former from known made modern named official only other recent since state states their that this type united used using with world".split(" "));
const NAME_CONNECTORS = new Set("a an and at for in of on the to".split(" "));
const NAME_INTRODUCTIONS = new Set("at by for from in into on to with within".split(" "));
const HEADLINE_ACTIONS = new Set(("accuses announces are arrives beats buys claims debuts earns employees engineers faces files founders " +
  "has is launches plans publishes releases researchers reveals risks staffers sues threatens unveils vows workers").split(" "));
const CONCEPT_STOP = new Set(("about across after also before build between business company could during finally first from firms group " +
  "into latest most outside overseas people recent report source than that their then this through under until were when where while will with would").split(" "));
const ENTITIES = { amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: '"', rsquo: "’", lsquo: "‘", ndash: "–", mdash: "—" };

function titleKey(value) {
  return value.normalize("NFKC").replace(/[_\s]+/g, " ").trim().toLowerCase();
}

function words(value) {
  return titleKey(value).match(/[\p{L}\p{N}]+/gu) || [];
}

function phrase(value) {
  return words(value).join(" ");
}

function includesPhrase(text, subject) {
  return (" " + text + " ").includes(" " + subject + " ");
}

export function topicArtworkFitsEdition(label, image) {
  const subject = phrase(image.subject);
  const headline = " " + phrase(label) + " ";
  const name = " " + subject + " ";
  const start = headline.indexOf(name);
  if (!subject || start < 0) return true;
  const edition = /^(?:(?:part|version) )?(ii|iii|iv|v|vi|vii|viii|ix|x|xi|xii|v?\d{1,3}) /.exec(headline.slice(start + name.length))?.[1];
  if (!edition) return true;
  try {
    const file = decodeURIComponent(new URL(image.source).pathname);
    return includesPhrase(phrase(file), subject + " " + edition);
  } catch {
    return false;
  }
}

function titleCandidate(value) {
  return typeof value === "string" && value.length >= 3 && value.length <= 140 &&
    !/[\p{Cc}|#{}\[\]<>]|:\/\//u.test(value) && /\p{L}/u.test(value);
}

function fileCandidate(value) {
  return typeof value === "string" && value.length <= 255 && !/[\p{Cc}|#<>]/u.test(value) &&
    /\.(?:jpe?g|png|webp|svg)$/i.test(value) && !NON_ARTWORK.test(phrase(value));
}

function plainText(value) {
  if (typeof value !== "string" || value.length > 8_000) return "";
  return value.replace(/<\/?(?:p|div|li|ul|ol|br)\b[^>]*>/gi, " ").replace(/<[^>]*>/g, "")
    .replace(/&(#\d+|#x[\da-f]+|[a-z]+);/gi, (entity, name) => {
      if (!name.startsWith("#")) return Object.hasOwn(ENTITIES, name) ? ENTITIES[name] : entity;
      const point = name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      return point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : "";
    })
    .replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, " ").replace(/\s+/g, " ").trim();
}

function trustedURL(value, hosts, path) {
  if (typeof value !== "string" || value.length > 1_024) return null;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && !url.username && !url.password && !url.port &&
      hosts.includes(url.hostname) && path.test(url.pathname)) {
      url.search = "";
      url.hash = "";
      return url.href;
    }
  } catch {}
  return null;
}

function freeLicense(metadata) {
  if (String(metadata.NonFree?.value).toLowerCase() === "true") return "";
  const name = plainText(metadata.LicenseShortName?.value);
  if (name === "Public domain" || name === "CC0") return name;
  const match = /^CC BY(-SA)? ([1-4]\.\d)(?: [a-z][a-z ]{1,24})?$/i.exec(name);
  if (!match) return "";
  const url = metadata.LicenseUrl?.value;
  const path = "/licenses/by" + (match[1] ? "-sa" : "") + "/" + match[2];
  try {
    const parsed = new URL(url);
    return ["https:", "http:"].includes(parsed.protocol) && parsed.host === "creativecommons.org" &&
      (parsed.pathname === path || parsed.pathname.startsWith(path + "/")) ? name : "";
  } catch {
    return "";
  }
}

function commonsArtwork(page) {
  const filename = typeof page.title === "string" && page.title.startsWith("File:") && page.title.slice(5);
  const info = fileCandidate(filename) && page.ns === 6 && page.imagerepository === "local" && page.imageinfo?.[0];
  if (!info || !IMAGE_TYPES.has(info.mime) || !info.extmetadata) return null;
  const width = info.thumbwidth ?? info.width;
  const height = info.thumbheight ?? info.height;
  if (!Number.isInteger(width) || !Number.isInteger(height) ||
    width < 320 || height < 160 || width > 1_000 || width / height > 3 || height / width > 3) return null;
  const url = trustedURL(info.thumburl || (info.size <= 600_000 ? info.url : null),
    ["upload.wikimedia.org", "thumb.wikimedia.org"], /^\/wikipedia\/commons\/.+\.(?:jpe?g|png|webp)$/i);
  const source = trustedURL(info.descriptionurl, ["commons.wikimedia.org"], /^\/wiki\/File:.+/);
  const license = freeLicense(info.extmetadata);
  const author = plainText(info.extmetadata.Attribution?.value) || plainText(info.extmetadata.Artist?.value);
  if (!url || !source || !license || !author || author.length > 280) return null;
  return {
    url, source, credit: author + " · " + license, filename: phrase(filename),
    description: phrase(plainText(info.extmetadata.ImageDescription?.value)),
  };
}

async function api(endpoint, parameters, signal, query) {
  const url = new URL(endpoint);
  url.search = new URLSearchParams({ format: "json", ...parameters });
  const options = { headers: { "User-Agent": USER_AGENT }, redirect: "manual", signal };
  if (query) {
    options.method = "POST";
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify({ query });
  } else {
    url.searchParams.set("formatversion", "2");
    url.searchParams.set("maxlag", "5");
  }
  try {
    const response = await fetch(url, options);
    if (!response.ok) return null;
    const body = await response.json();
    return body.error || body.errors?.length ? null : body;
  } catch {
    return null;
  }
}

async function subjectImages(ids, signal) {
  const body = await api(WIKIDATA, { action: "wbgraphql" }, signal, `query {
    itemsById(ids: ${JSON.stringify(ids)}) {
      id
      images: statements(propertyId: "P18") { rank value { ... on CommonsMediaValue { content } } }
      logos: statements(propertyId: "P154") { value { ... on CommonsMediaValue { content } } }
      arms: statements(propertyId: "P94") { value { ... on CommonsMediaValue { content } } }
    }
  }`);
  if (!Array.isArray(body?.data?.itemsById)) return null;
  return new Map(body.data.itemsById.filter(Boolean).map(({ id, images, logos, arms }) => [id, {
    images: (images || []).filter(({ rank }) => rank !== "DEPRECATED")
      .sort((left, right) => Number(right.rank === "PREFERRED") - Number(left.rank === "PREFERRED"))
      .map(({ value }) => value?.content).filter(fileCandidate).slice(0, 2),
    symbols: [...(logos || []), ...(arms || [])].map(({ value }) => value?.content).filter(fileCandidate).map(titleKey),
  }]));
}

function evidenceFor(subject) {
  const canonical = phrase(subject.name);
  const requested = phrase(subject.requested);
  return subject.aliases.some((alias) => phrase(alias) === requested) ? [...new Set([requested, canonical])] : [canonical];
}

function artworkResult(asset, subject) {
  const { url, source, credit } = asset;
  return { image: { url, source, credit, subject: subject.name }, description: subject.description, aliases: subject.aliases };
}

async function searchCommons(query, signal) {
  const body = await api(COMMONS, {
    ...COMMONS_IMAGE_INFO, generator: "search", gsrnamespace: "6", gsrlimit: "6", gsrsearch: query,
  }, signal);
  if (Array.isArray(body?.query?.pages)) {
    return body.query.pages.sort((left, right) => left.index - right.index).map(commonsArtwork).filter(Boolean);
  }
  return body?.batchcomplete ? [] : null;
}

function searchMatch(asset, names, organization, depicted) {
  if (NON_SUBJECT_FILE.test(asset.filename)) return false;
  const namedInFile = names.some((name) => includesPhrase(asset.filename, name));
  const namedInDescription = names.some((name) => includesPhrase(asset.description, name));
  if (organization && !FACILITY.test(asset.filename + " " + asset.description)) return false;
  return depicted ? namedInFile || namedInDescription : namedInFile && namedInDescription;
}

async function lookupArtwork(titles, signal) {
  const wiki = (await api(WIKIPEDIA, {
    action: "query", titles: titles.join("|"), redirects: "1", prop: "pageprops|pageimages|pageterms",
    ppprop: "disambiguation|wikibase_item", piprop: "name", pilicense: "free", wbptterms: "description|alias",
  }, signal))?.query;
  const results = new Map();
  if (!Array.isArray(wiki?.pages)) return results;
  const redirects = new Map((wiki.redirects || []).filter(({ tofragment }) => !tofragment)
    .map(({ from, to }) => [titleKey(from), titleKey(to)]));
  const pages = new Map(wiki.pages.map((page) => [titleKey(page.title), page]));
  const subjects = [];
  for (const title of titles) {
    const key = titleKey(title);
    const page = pages.get(redirects.get(key) || key);
    if (!page || page.ns !== 0 || page.missing || page.invalid || Object.hasOwn(page.pageprops || {}, "disambiguation")) {
      results.set(key, null);
      continue;
    }
    const name = page.title;
    const lead = fileCandidate(page.pageimage) ? page.pageimage : null;
    const item = /^Q\d+$/.test(page.pageprops?.wikibase_item || "") ? page.pageprops.wikibase_item : null;
    const aliases = (page.terms?.alias || []).filter(titleCandidate).slice(0, 24);
    const description = page.terms?.description?.[0] || "";
    const fallback = item && (!lead || !includesPhrase(phrase(lead), phrase(name)));
    subjects.push({ key, name, requested: title, description, aliases, lead, item, fallback });
  }

  const entities = [...new Set(subjects.filter(({ fallback }) => fallback).map(({ item }) => item))];
  const claims = entities.length && await subjectImages(entities, signal);
  const files = new Map();
  for (const subject of subjects) {
    const { images = [], symbols = [] } = (subject.fallback && claims?.get(subject.item)) || {};
    subject.files = new Map();
    for (const name of [subject.lead, ...images]) {
      if (!name || symbols.includes(titleKey(name))) continue;
      const title = "File:" + name;
      const key = titleKey(title);
      subject.files.set(key, images.includes(name));
      files.set(key, title);
    }
  }

  const verified = new Map();
  const names = [...files.values()];
  for (let start = 0; start < names.length && !signal.aborted; start += COMMONS_BATCH_SIZE) {
    const batch = names.slice(start, start + COMMONS_BATCH_SIZE);
    const commons = (await api(COMMONS, {
      ...COMMONS_IMAGE_INFO, titles: batch.join("|"),
    }, signal))?.query;
    if (!Array.isArray(commons?.pages)) break;
    for (const file of batch) verified.set(titleKey(file), null);
    for (const file of commons.pages) verified.set(titleKey(file.title), commonsArtwork(file));
  }

  const searches = new Map();
  let searchAvailable = true;
  for (const subject of subjects) {
    const { key, item, fallback, files, description } = subject;
    const names = evidenceFor(subject);
    let asset = null;
    for (const [file, depictsSubject] of files) {
      const verifiedFile = verified.get(file);
      if (!verifiedFile || (!depictsSubject && !names.some((name) =>
        includesPhrase(verifiedFile.filename, name) || includesPhrase(verifiedFile.description, name)))) continue;
      asset = verifiedFile;
      break;
    }
    let searched = !item;
    if (!asset && item) {
      const organization = ORGANIZATION.test(description);
      const depicts = "haswbstatement:P180=" + item;
      const exact = 'intitle:"' + names[0] + '"' + (organization ? ' intitle:"headquarters"' : "");
      const strategies = organization ? [exact, depicts] : [depicts, exact];
      for (let index = 0; index < strategies.length; index++) {
        const strategy = strategies[index];
        if (!searches.has(strategy)) {
          if (!searchAvailable || searches.size >= MAX_COMMONS_SEARCHES || signal.aborted) break;
          const matches = await searchCommons("filetype:bitmap " + strategy + " -intitle:logo -intitle:icon -intitle:wordmark", signal);
          searches.set(strategy, matches);
          if (!matches) searchAvailable = false;
        }
        const matches = searches.get(strategy);
        if (!matches) break;
        asset = matches.find((file) => searchMatch(file, names, organization, strategy === depicts));
        if (asset) break;
        searched = index === strategies.length - 1;
      }
    }
    if (asset || (searched && (!fallback || claims) && [...files.keys()].every((file) => verified.has(file)))) {
      results.set(key, asset ? artworkResult(asset, subject) : null);
    }
  }
  return results;
}

function matchesSubject(title, { image, description, aliases = [] }, context) {
  const requested = phrase(title);
  const verified = phrase(image.subject);
  const named = context.some((text) => includesPhrase(text, requested));
  const alias = named && aliases.some((name) => phrase(name) === requested);
  if (!alias && requested !== verified && (!includesPhrase(verified, requested) ||
    !context.some((text) => includesPhrase(text, verified)))) return false;
  if (verified.includes(" ") || /[a-z][A-Z]|\d/.test(image.subject) ||
    (named && (ORGANIZATION.test(description) || GEOGRAPHIC_SUBJECT.test(description)))) return true;
  return words(description).some((term) => term.length >= 4 && !CONTEXT_STOP.has(term) && term !== verified &&
    context.some((text) => includesPhrase(text, term)));
}

function capitalizedWords(title) {
  return title.match(/[\p{L}\p{N}]+(?:['’\p{Pd}][\p{L}\p{N}]+)*/gu) || [];
}

function namedTitle(title) {
  const parts = capitalizedWords(title);
  return parts.length <= 6 && parts.every((part) => /^[\p{Lu}\p{N}]/u.test(part) || NAME_CONNECTORS.has(part));
}

function objectTerm(term) {
  const stem = term.toLowerCase().replace(/(?<=[^isu])s$/, "");
  return stem === "centre" ? "center" : stem;
}

function repeatedObjects(headlines) {
  const occurrences = new Map();
  for (const headline of headlines) {
    const tokens = capitalizedWords(headline);
    const seen = new Set();
    for (let start = 0; start + 1 < tokens.length; start++) {
      for (const size of [2, 3]) {
        const terms = tokens.slice(start, start + size);
        const stems = terms.map(objectTerm);
        if (terms.length !== size || terms.some((word) => CONCEPT_STOP.has(word.toLowerCase())) || stems.some((word) => !/^\p{L}{3,}$/u.test(word) ||
          NAME_CONNECTORS.has(word) || CONCEPT_STOP.has(word) || HEADLINE_ACTIONS.has(word) || /(?:ing|ed|ly)$/.test(word))) continue;
        const name = stems.join(" ");
        const entry = occurrences.get(name) || { name, count: 0, lowercase: false };
        if (!seen.has(name)) entry.count++;
        entry.lowercase ||= terms.every((term) => /^\p{Ll}+$/u.test(term));
        seen.add(name);
        occurrences.set(name, entry);
      }
    }
  }
  return [...occurrences.values()].filter(({ count, lowercase }) => lowercase && count >= Math.max(2, Math.ceil(headlines.length * 0.67)))
    .sort((left, right) => right.count - left.count || right.name.length - left.name.length)
    .slice(0, 2).map(({ name }) => name[0].toUpperCase() + name.slice(1));
}

function leadingSubject(heading) {
  const words = capitalizedWords(heading);
  if (/[a-z][A-Z]/.test(words[0] || "") && words.length > 1) return words[0];
  const boundary = words.findIndex((word, index) => index > 0 && HEADLINE_ACTIONS.has(word.toLowerCase()));
  if (boundary < 2 || boundary > 4) return null;
  const label = words.slice(0, boundary).join(" ");
  return namedTitle(label) ? label : null;
}

function modelFamily(word) {
  return /^([\p{L}][\p{L}\d-]*?\p{L})-?\d+$/u.exec(word)?.[1].toLowerCase();
}

function namedMentions(heading) {
  const tokens = capitalizedWords(heading);
  if (tokens.length < 2) return [];
  const names = tokens.map((token) => token.replace(/['’]s$/i, ""));
  const mentions = new Set();
  const model = modelFamily(names[0]);
  if (model && /^\p{Lu}/u.test(names[0])) mentions.add(names[0]);
  for (const [index, name] of names.entries()) {
    const before = names[index - 1] || "";
    if (!/^\p{Lu}|[a-z][A-Z]/u.test(name) || (index > 0 && model && modelFamily(name) === model)) continue;
    if (index > 0 && !/^\p{Lu}/u.test(before) && /^\p{Lu}/u.test(name)) {
      let end = index + 1;
      while (end < names.length && /^\p{Lu}/u.test(names[end]) && !HEADLINE_ACTIONS.has(names[end].toLowerCase())) end++;
      if (end > index + 1 && end <= index + 4) mentions.add(names.slice(index, end).join(" "));
    }
    if (name !== tokens[index] && !/^\p{Lu}+$/u.test(name)) {
      let start = index;
      while (start > 0 && index - start < 3 && /^\p{Lu}/u.test(names[start - 1])) start--;
      mentions.add(names.slice(start, index + 1).join(" "));
    }
    if (/[a-z][A-Z]/.test(name) || NAME_INTRODUCTIONS.has(before.toLowerCase())) mentions.add(name);
  }
  return [...mentions].filter(titleCandidate);
}

function storySubjects(topic, byPage) {
  const lead = leadingSubject(topic.label);
  const mentions = namedMentions(topic.label);
  if (topic.pageIds.length < 2) return [...new Set([lead, ...mentions])].filter(titleCandidate).slice(0, 2);
  const headings = new Map();
  for (const id of topic.pageIds) {
    const title = byPage.get(id)?.title;
    if (title) headings.set(phrase(title), title);
  }
  headings.set(phrase(topic.label), topic.label);
  const candidates = new Set([...repeatedObjects([...headings.values()]), ...(topic.subjectTitles || [])]);
  const titles = [...headings.keys()];
  if (lead) {
    const name = phrase(lead);
    const last = name.split(" ").at(-1);
    if (titles.length === 1 || titles.filter((title) => includesPhrase(title, name) || title.startsWith(last + " ")).length >= 2) {
      candidates.add(lead);
    }
  }
  const observed = new Set([...mentions, ...[...headings.values()].flatMap(namedMentions)]);
  for (const name of observed) {
    if (titles.filter((title) => includesPhrase(title, phrase(name))).length >= Math.min(2, titles.length)) candidates.add(name);
  }
  const leading = capitalizedWords(topic.label);
  for (const size of [4, 3, 2]) {
    const head = leading.slice(0, size);
    if (head.length !== size || head.some((part) => !/^\p{Lu}/u.test(part))) continue;
    const name = head.join(" ");
    if (titles.filter((title) => includesPhrase(title, phrase(name))).length >= 2) candidates.add(name);
  }
  return [...candidates].filter(titleCandidate).slice(0, 3);
}

export async function addTopicArtwork(db, snapshot, now) {
  const byPage = new Map(snapshot.pages.map((page) => [page.id, page]));
  const candidates = snapshot.topics.map((topic) => {
    const grouped = topic.pageIds.length >= 2;
    const subject = topic.kind === "topic";
    const label = titleCandidate(topic.label) && (subject || grouped || namedTitle(topic.label)) ? topic.label : null;
    return { topic, grouped, subject, label, suggestions: storySubjects(topic, byPage) };
  });
  const ranked = [
    ...candidates.flatMap(({ subject, grouped, label, suggestions }) => subject ? [label] : grouped ? suggestions : []),
    ...candidates.filter(({ grouped }) => grouped).map(({ label }) => label),
    ...candidates.filter(({ grouped, subject }) => !grouped && !subject).flatMap(({ suggestions }) => suggestions),
    ...candidates.map(({ label }) => label),
  ];
  const titles = new Map(ranked.filter(Boolean).map((title) => [titleKey(title), title]));
  if (!titles.size) return;

  const cache = new Map();
  const previousCache = new Map();
  const keys = [...titles.keys()].flatMap((key) => [CACHE_VERSION + key, key]);
  try {
    const { results } = await db.prepare(
      "SELECT title, result, expires_at FROM topic_artwork WHERE expires_at >= ? AND title IN (SELECT value FROM json_each(?))"
    ).bind(now - POSITIVE_TTL, JSON.stringify(keys)).all();
    for (const row of results) {
      const entry = { result: JSON.parse(row.result), expires: row.expires_at };
      if (row.title.startsWith(CACHE_VERSION)) cache.set(row.title.slice(CACHE_VERSION.length), entry);
      else if (entry.result) previousCache.set(row.title, entry);
    }
  } catch (error) {
    console.warn("Artwork cache read unavailable", error.message);
  }

  const cached = (key) => cache.get(key) || previousCache.get(key);
  const missing = [...titles].filter(([key]) => !(cached(key)?.expires > now)).slice(0, MAX_LOOKUPS).map(([, title]) => title);
  if (missing.length) {
    const found = await lookupArtwork(missing, AbortSignal.timeout(4_000));
    const entries = [...found].map(([title, result]) => {
      const entry = { result, expires: now + (result ? POSITIVE_TTL : NEGATIVE_TTL) };
      cache.set(title, entry);
      return { title: CACHE_VERSION + title, ...entry };
    });
    try {
      await db.batch([
        db.prepare("DELETE FROM topic_artwork WHERE expires_at < ?").bind(now - POSITIVE_TTL),
        db.prepare(`
          INSERT INTO topic_artwork (title, result, expires_at)
          SELECT value->>'title', value->'result', value->>'expires' FROM json_each(?) WHERE true
          ON CONFLICT(title) DO UPDATE SET result = excluded.result, expires_at = excluded.expires_at
          WHERE excluded.expires_at >= topic_artwork.expires_at OR topic_artwork.expires_at <= ?
        `).bind(JSON.stringify(entries), now),
      ]);
    } catch (error) {
      console.warn("Artwork cache write unavailable", error.message);
    }
  }

  for (const { topic, label, suggestions } of candidates) {
    const context = topic.pageIds.flatMap((id) => {
      const page = byPage.get(id);
      return page ? [phrase(page.title), phrase(page.description || "")] : [];
    });
    for (const title of [label, ...suggestions].filter(Boolean)) {
      const result = cached(titleKey(title))?.result;
      if (result && topicArtworkFitsEdition(topic.label, result.image) &&
        (title === label || !GEOGRAPHIC_SUBJECT.test(result.description)) && matchesSubject(title, result, context)) {
        topic.image = result.image;
        break;
      }
    }
  }
}
