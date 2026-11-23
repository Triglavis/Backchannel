import assert from "node:assert/strict";
import test from "node:test";
import { frontPageHTML, launchApp, waitFor } from "./harness.mjs";

const catalogURL = "https://topics.backchnnl.app/api/topics";
const topicReportURL = "https://topics.backchnnl.app/api/topic-reports";
const catalogKey = "HNewhere:shared_topic_index";
const now = Math.floor(Date.now() / 1000);
const guide = {
	source: "hn", id: 9360, time: now - 60, descendants: 3,
	url: "https://framed.example.com/post/260?v=1",
	title: "A guide to fine-grained extension permissions",
};
const report = {
	source: "lemmy", id: 9361, time: now - 120, descendants: 2,
	url: "https://plain.example.org/post/261",
	title: "Extension access disappears after switching profiles",
};
const unrelated = {
	...guide, id: 9362, url: "https://plain.example.org/post/262",
	title: "The hillside observatory repairs its telescope",
};
const frontPageWithUnrelated = {
	"HNewhere:frontpage_feed:technology/hn/front/": {
		timestamp: now * 1000, stories: [guide, unrelated].map((story) => ({ ...story, topic: "technology" })),
	},
};
const imported = {
	...guide, url: guide.url + "&utm_source=bookmark-export#example",
};
const unknown = {
	url: "https://framed.example.com/post/260?v=2",
	title: "Imported link outside the public index",
};
const catalog = {
	version: 1, generatedAt: new Date().toISOString(),
	topics: [
		{ id: "topic:permissions", label: "Extension permissions", kind: "topic" },
		{ id: "topic:privacy", label: "Browser privacy", kind: "topic" },
	],
	pages: [
		{ key: "framed.example.com/post/260?v=1", topicIds: ["topic:permissions", "topic:privacy"] },
		{ key: "plain.example.org/post/261", topicIds: ["topic:permissions"] },
	],
};

function launchTopics({ status = 200, stored = {}, ...options } = {}) {
	const feed = (stories) => ({ timestamp: now * 1000, stories: stories.map((story) => ({ ...story, topic: "technology" })) });
	const pageKey = (each) => new URL(each.url).hostname + new URL(each.url).pathname + new URL(each.url).search;
	return launchApp({
		sharedStore: true,
		settings: {
			updateCheck: false, sourceRefreshMinutes: 0, sources: { hn: true, lemmy: true },
			frontPageMode: "topics", frontPageTopics: ["technology"],
		},
		values: {
			"HNewhere:app_panes": { list: true, discussion: true },
			"HNewhere:collection_filed": true,
			"HNewhere:collected_migrated": true,
			"HNewhere:collected": [imported, unknown].map((entry) => ({
				...entry, key: pageKey(entry), addedAt: now * 1000,
			})),
			"HNewhere:queue": [{ ...guide, key: pageKey(guide), addedAt: now * 1000 }],
			"HNewhere:frontpage_feed:technology/hn/front/": feed([guide]),
			"HNewhere:frontpage_feed:technology/lemmy/community/technology@lemmy.world": feed([report]),
			...stored,
		},
		extraStories: [{ ...guide, comments: 3 }],
		responses: [{ match: (url) => url === catalogURL, status, json: catalog }],
		...options,
	});
}

function rail(page, view) {
	return page.locator('#app-rail [data-app-view="' + view + '"]');
}

function topic(list, label) {
	return list.locator(".app-topic-row").filter({ hasText: label });
}

const topicPhoto = "https://upload.wikimedia.org/wikipedia/commons/thumb/0/00/Subject.jpg/250px-Subject.jpg";
const imageCredit = "https://commons.wikimedia.org/wiki/File:Subject.jpg";
const previewPNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64");

async function expectTopicPhoto(group, subject) {
	const picture = group.locator("img.app-topic-picture");
	await picture.waitFor();
	assert(await waitFor(() => picture.evaluate((node) => node.naturalWidth > 0)));
	assert.match(await picture.getAttribute("src"), /^data:image\/webp;base64,/);
	assert.match(await picture.getAttribute("title"), subject);
}

test("equivalent topics share one subject image and count each discussion once", async () => {
	const articlePreview = "https://framed.example.com/article-preview.png";
	const artwork = { url: topicPhoto, source: imageCredit, credit: "Example author · CC BY 4.0", subject: "Browser extension" };
	const first = "topic:permissions";
	const second = "topic:browser-extension-permissions";
	const fixture = {
		...catalog,
		topics: [
			{ ...catalog.topics[0], image: artwork },
			{ id: second, label: "Browser extension permissions", kind: "topic", image: { ...artwork, url: articlePreview } },
			{ ...catalog.topics[1], image: { ...artwork, url: articlePreview } },
		],
		pages: [
			{ ...catalog.pages[0], topicIds: [first, second, "topic:privacy"], posts: [["hn:9360", 100], ["lemmy:9999", 4]] },
			{ ...catalog.pages[1], topicIds: [first, second], posts: [["lemmy:9361", 100], ["lemmy:9999", 4], ["lobsters:abc", 40]] },
		],
	};
	const app = await launchTopics({
		stored: { "HNewhere:looks": {
			[catalog.pages[0].key]: { image: articlePreview, at: now * 1000 },
		} },
		responses: [
			{ match: (url) => url === catalogURL, json: fixture },
			{ match: (url) => url === report.url, headers: "content-type: text/html",
				text: '<html><head><meta property="og:image" content="' + articlePreview + '"></head></html>' },
		],
	});
	try {
		const { page, context } = app;
		await context.route(topicPhoto, (route) => route.fulfill({ contentType: "image/png", body: previewPNG }));
		await context.route(articlePreview, (route) => route.fulfill({ contentType: "image/png", body: previewPNG }));
		page.setDefaultTimeout(7000);
		await page.goto("https://backchnnl.app/");
		await page.getByRole("tab", { name: "Topics", exact: true }).click();
		const list = page.locator("#app-list-body");
		const merged = topic(list, /extension permissions/i);
		await merged.first().waitFor();
		assert.equal(await merged.count(), 1);
		assert.match(await merged.locator(".app-topic-name").textContent(), /^#/);
		await merged.getByText("9 comments across 3 discussions in 2 links", { exact: true }).waitFor();
		assert.equal(await topic(list, "Browser privacy").count(), 0);
		assert.equal(await list.getByRole("link", { name: guide.title, exact: true }).count(), 0);
		const image = merged.locator("img");
		await image.waitFor();
		assert.equal(await image.getAttribute("src"), topicPhoto);
		assert.equal(await image.getAttribute("referrerpolicy"), "no-referrer");
		assert(await waitFor(() => image.evaluate((node) => node.naturalWidth > 0)));
		assert.deepEqual(await image.evaluate((node) => [node.naturalWidth, node.getBoundingClientRect().width,
			node.getBoundingClientRect().height, getComputedStyle(node).objectFit]), [1, 54, 44, "cover"]);
		assert.equal(app.requests.filter(({ url }) => url === report.url).length, 0);
		await merged.click();
		await list.getByRole("link", { name: guide.title }).waitFor();
		await list.getByRole("link", { name: report.title }).waitFor();
		const heading = page.locator("#app-list-topic");
		assert.equal(await heading.getByRole("link", { name: /image credit/i }).count(), 0);
		assert.match(await heading.locator(".app-topic-picture").getAttribute("title"), /Example author/);
		await heading.getByText("9 comments across 3 discussions in 2 links", { exact: true }).waitFor();
		const firstLink = list.getByRole("link", { name: guide.title });
		await firstLink.click({ modifiers: ["Shift"] });
		await page.locator("#app-selection-actions").click();
		await page.getByRole("menuitem", { name: "Mark selected as read" }).click();
		await firstLink.waitFor({ state: "hidden" });
		await loadHiddenLinks(page).waitFor();
		await page.getByRole("button", { name: "Back to topics" }).click();
		await heading.waitFor({ state: "hidden" });
		await list.getByRole("link", { name: report.title, exact: true }).waitFor();
		assert.equal(await merged.count(), 0);
		assert.deepEqual(app.errors, []);
	} finally {
		await app.browser.close();
	}
});

test("saved topic counts use current public threads and update as the Queue refreshes", async () => {
	const fixture = {
		...catalog,
		pages: [
			{ ...catalog.pages[0], posts: [["hn:9360", 9]] },
			{ ...catalog.pages[1], posts: [["lemmy:9361", 21]] },
		],
	};
	const queue = [guide, report].map((entry, index) => ({
		...entry, descendants: 2, addedAt: now * 1000, key: catalog.pages[index].key,
	}));
	const app = await launchTopics({
		stored: {
			"HNewhere:queue": queue,
			"HNewhere:frontpage_feed:technology/hn/front/": { timestamp: now * 1000, stories: [] },
			"HNewhere:frontpage_feed:technology/lemmy/community/technology@lemmy.world": { timestamp: now * 1000, stories: [] },
		},
		extraStories: [{ ...guide, comments: 18 }],
		responses: [{ match: (url) => url === catalogURL, json: fixture }],
	});
	try {
		const { page } = app;
		page.setDefaultTimeout(7000);
		await page.goto("https://backchnnl.app/");
		await rail(page, "queue").click();
		await page.getByRole("tab", { name: "Topics", exact: true }).click();
		const group = topic(page.locator("#app-list-body"), "Extension permissions");
		await group.getByText("39 comments across 2 discussions in 2 links", { exact: true }).waitFor();
		await expectTopicPhoto(group, /source code/i);
		assert.deepEqual(app.errors, []);
	} finally {
		await app.browser.close();
	}
});

test("a broken exact topic image gives way to a subject photo and its credit", async () => {
	const fixture = { ...catalog, topics: [
		{ ...catalog.topics[0], image: {
			url: topicPhoto, source: imageCredit, credit: "Example author · CC BY 4.0", subject: "Browser extension",
		} },
		catalog.topics[1],
	] };
	const app = await launchTopics({ responses: [{ match: (url) => url === catalogURL, json: fixture }] });
	try {
		const { page, context } = app;
		page.setDefaultTimeout(5000);
		await context.route(topicPhoto, (route) => route.fulfill({ status: 404, body: "" }));
		await page.goto("https://backchnnl.app/");
		await page.getByRole("tab", { name: "Topics", exact: true }).click();
		const group = topic(page.locator("#app-list-body"), "Extension permissions");
		await expectTopicPhoto(group, /source code/i);
		await group.click();
		await expectTopicPhoto(page.locator("#app-list-topic"), /source code/i);
		assert.deepEqual(app.errors, []);
	} finally {
		await app.browser.close();
	}
});

test("topics always show an icon when a Commons photo is missing, repeated, or broken", async () => {
	const topics = [
		{ id: "story:trade", label: "First-day IPO trading for Oak Systems", kind: "story" },
		{ id: "story:reporting", label: "Market operators adopt new accounting rules", kind: "story" },
		{ id: "story:morning", label: "An unusual morning in Vardum", kind: "story", illustration: "4d".repeat(32) },
		{ id: "story:change", label: "What happened to Lintrest", kind: "story",
			image: { url: topicPhoto, source: imageCredit, credit: "Example author · CC BY 4.0", subject: "Lintrest" } },
	];
	const pages = [];
	const stories = [];
	for (const group of topics) {
		for (const suffix of ["first", "second"]) {
			const key = "sample.example.org/" + group.id.slice(6) + "/" + suffix;
			pages.push({ key, topicIds: [group.id] });
			stories.push({ ...guide, id: 9480 + stories.length, title: group.label + " (" + suffix + ")",
				url: "https://" + key, topic: "technology" });
		}
	}
	const app = await launchTopics({
		stored: {
			"HNewhere:app_browse_topics": true,
			"HNewhere:frontpage_feed:technology/hn/front/": { timestamp: now * 1000, stories },
			"HNewhere:frontpage_feed:technology/lemmy/community/technology@lemmy.world": { timestamp: now * 1000, stories: [] },
		},
		responses: [
			{ match: (url) => url === catalogURL, json: { ...catalog, topics, pages } },
			{ match: (url) => new URL(url).hostname === "en.wikipedia.org", status: 503 },
		],
	});
	try {
		const { page, context } = app;
		await context.route(topicPhoto, (route) => route.fulfill({ status: 404, body: "" }));
		await page.goto("https://backchnnl.app/");
		const list = page.locator("#app-list-body");
		for (const { label } of topics) await topic(list, label).waitFor();
		const broken = topic(list, topics[3].label);
		await broken.locator("img.app-topic-picture").waitFor({ state: "detached" });
		const pictures = list.locator(".app-topic-picture");
		assert.equal(await pictures.count(), 1);
		assert.match(await pictures.first().getAttribute("title"), /stock exchange/i);
		const unknown = topic(list, topics[2].label);
		for (const { label } of topics.slice(1)) {
			const icon = topic(list, label).locator(".app-topic-media .app-topic-icon svg");
			assert.equal(await icon.isVisible(), true);
		}
		assert.notEqual(await unknown.locator(".app-topic-icon").innerHTML(), await broken.locator(".app-topic-icon").innerHTML());
		assert.match(await unknown.locator(".app-topic-media").getAttribute("title"), /Vardum/);
		await unknown.click();
		await list.getByRole("link", { name: topics[2].label + " (first)", exact: true }).waitFor();
		assert.equal(await page.locator("#app-list-topic .app-topic-icon svg").isVisible(), true);
		assert.equal(await page.getByRole("link", { name: /image credit/i }).count(), 0);
		assert.deepEqual(app.errors, []);
	} finally {
		await app.browser.close();
	}
});

test("Reader gets a Wikipedia image for a locally grouped topic and caches its credit", async () => {
	const url = "https://thumb.wikimedia.org/wikipedia/commons/thumb/b/be/Flag_of_Iran_%28official%29.svg/250px-Flag_of_Iran_%28official%29.svg.png";
	const file = "File:Flag of Iran (official).svg";
	const source = "https://commons.wikimedia.org/wiki/File:Flag_of_Iran_(official).svg";
	const subject = "Iran";
	const historical = "File:Iran–Iraq War.jpg";
	const stories = [
		{ ...guide, url: "https://framed.example.com/post/271?key=private-query", title: "Iran war escalates after renewed air strikes", topic: "technology" },
		{ ...report, url: "https://plain.example.org/post/272", title: "Airstrikes intensify as Iran war enters a new phase", topic: "technology" },
	];
	const isQuery = (value, host, title) => {
		const request = new URL(value);
		return request.hostname === host && request.searchParams.get("titles")?.split("|").includes(title);
	};
	const app = await launchTopics({
		stored: {
			"HNewhere:app_browse_topics": true,
			"HNewhere:frontpage_feed:technology/hn/front/": { timestamp: now * 1000, stories },
			"HNewhere:frontpage_feed:technology/lemmy/community/technology@lemmy.world": { timestamp: now * 1000, stories: [] },
		},
		responses: [
			{ match: (url) => url === catalogURL, json: { ...catalog, topics: [], pages: [] } },
			{ match: (url) => isQuery(url, "en.wikipedia.org", subject), json: { query: { pages: [
				{ ns: 0, pageid: 14579, title: "Iran", pageimage: "Flag_of_Iran_(official).svg" },
				{ ns: 0, title: "List of wars involving Iran" },
			], redirects: [{ from: "Iran War", to: "List of wars involving Iran" }] } } },
			{ match: (url) => new URL(url).hostname === "en.wikipedia.org" && new URL(url).searchParams.get("gsrsearch") === "Iran War",
				json: { query: { pages: [{ ns: 0, index: 1, title: "Iran–Iraq War", pageimage: "Iran–Iraq_War.jpg" }] } } },
			{ match: (url) => isQuery(url, "commons.wikimedia.org", file), json: { query: { pages: [
				{ ns: 6, title: file, imagerepository: "local", imageinfo: [{
					thumburl: url + "?utm_source=commons.wikimedia.org", descriptionurl: source, thumbwidth: 240, thumbheight: 137,
					extmetadata: { Artist: { value: '<a href="/wiki/User:SiBr4">SiBr4</a>' }, LicenseShortName: { value: "Public domain" } },
				}] },
			] } } },
		],
	});
	try {
		const { page, context, requests } = app;
		let releaseImage;
		const waiting = new Promise((resolve) => { releaseImage = resolve; });
		await context.route(url, async (route) => {
			await waiting;
			await route.fulfill({ contentType: "image/png", body: previewPNG });
		});
		await page.goto("https://backchnnl.app/");
		const group = topic(page.locator("#app-list-body"), "Iran");
		await group.waitFor({ timeout: 5000 });
		const picture = group.locator(".app-topic-picture");
		await picture.waitFor({ timeout: 5000 });
		assert.equal(await picture.getAttribute("src"), url);
		assert.equal(await picture.getAttribute("data-loaded"), null);
		const icon = group.locator(".app-topic-icon svg");
		assert.equal(await icon.isVisible(), true);
		releaseImage();
		await picture.locator("xpath=self::*[@data-loaded]").waitFor();
		assert.equal(await icon.isVisible(), false);
		assert.equal(await picture.getAttribute("referrerpolicy"), "no-referrer");
		await group.click();
		const headingPhoto = page.locator("#app-list-topic img[data-loaded]");
		await headingPhoto.waitFor();
		assert.match(await headingPhoto.getAttribute("title"), /iran.*sibr4.*public domain/i);
		const toWikipedia = () => requests.filter(({ url }) => isQuery(url, "en.wikipedia.org", subject));
		assert.equal(toWikipedia().length, 1);
		assert.equal(toWikipedia()[0].anonymous, true);
		assert.doesNotMatch(decodeURIComponent(toWikipedia()[0].url), /private-query|framed\.example|renewed air strikes/);
		assert(await waitFor(() => app.store.has("HNewhere:wikipedia_topic_images")));
		assert.equal(requests.some(({ url }) => isQuery(url, "commons.wikimedia.org", historical)), false);
		await page.reload();
		await picture.locator("xpath=self::*[@data-loaded]").waitFor({ timeout: 5000 });
		assert.equal(toWikipedia().length, 1);
		assert.deepEqual(app.errors, []);
	} finally {
		await app.browser.close();
	}
});

test("prominent topics get article photos through Wikipedia search, differing filenames, and alternate files", async () => {
	const french = "French Revolution";
	const origins = "French Revolution Origins";
	const talks = "Iran Nuclear Talks";
	const ai = "Artificial intelligence research";
	const articles = [
		{ ns: 0, title: french, pageimage: "Prise_de_la_Bastille.jpg", images: [{ title: "File:French Revolution festival.jpg" }] },
		{ ns: 0, title: "Artificial intelligence", images: [{ title: "File:Artificial intelligence exhibition.jpg" }] },
		{ ns: 0, title: talks, missing: true },
	];
	const wikiImage = (name) => "https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/" + name.replaceAll(" ", "_") + "/250px-photo.jpg";
	const files = [
		["Prise de la Bastille.jpg", "Storming of the Bastille"],
		["French Revolution festival.jpg", "A festival during the French Revolution"],
		["Lausanne diplomats.jpg", "Diplomats in Lausanne"],
		["Artificial intelligence exhibition.jpg", "Visitors at an artificial intelligence exhibition"],
		["Unrelated conference.jpg", "An unrelated conference"],
	];
	const topics = [french, origins, talks, ai].map((label, index) => ({ label, id: "topic:fixture-" + index, kind: "topic" }));
	const stories = topics.flatMap(({ label }, index) => Array.from({ length: 3 }, (_, number) => ({
		...guide,
		id: 9700 + index * 10 + number,
		url: "https://sample.example.org/fixture/" + index + "/" + number,
		title: label + " coverage " + number,
		topic: "technology",
	})));
	const pages = stories.map(({ url }, index) => ({ key: new URL(url).host + new URL(url).pathname, topicIds: [topics[Math.floor(index / 3)].id] }));
	const wiki = (url) => new URL(url).hostname === "en.wikipedia.org";
	const app = await launchTopics({
		stored: {
			"HNewhere:app_browse_topics": true,
			"HNewhere:frontpage_feed:technology/hn/front/": { timestamp: now * 1000, stories },
			"HNewhere:frontpage_feed:technology/lemmy/community/technology@lemmy.world": { timestamp: now * 1000, stories: [] },
		},
		responses: [
			{ match: (url) => url === catalogURL, json: { ...catalog, topics, pages } },
			{ match: (url) => wiki(url) && new URL(url).searchParams.has("titles"), json: {
				query: { pages: articles, redirects: [{ from: origins, to: french }, { from: ai, to: "Artificial intelligence" }] },
			} },
			{ match: (url) => wiki(url) && new URL(url).searchParams.has("gsrsearch"), json: { query: { pages: [
				{ ns: 0, index: 1, title: "Nuclear disarmament", pageimage: "Unrelated_conference.jpg" },
				{ ns: 0, index: 2, title: "Iran nuclear deal", pageimage: "Lausanne_diplomats.jpg" },
			] } } },
			{ match: (url) => new URL(url).hostname === "commons.wikimedia.org", json: { query: { pages: files.map(([name, description]) => ({
				ns: 6, title: "File:" + name, imagerepository: "local", imageinfo: [{
					thumburl: wikiImage(name), descriptionurl: "https://commons.wikimedia.org/wiki/File:" + name.replaceAll(" ", "_"),
					thumbwidth: 240, thumbheight: 180,
					extmetadata: { Artist: { value: "Fixture artist" }, LicenseShortName: { value: "Public domain" },
						ImageDescription: { value: description } },
				}],
			})) } } },
		],
	});
	try {
		const { page, context } = app;
		await context.route(/^https:\/\/thumb\.wikimedia\.org\//, (route) => route.fulfill({ contentType: "image/png", body: previewPNG }));
		await page.goto("https://backchnnl.app/");
		const rows = page.locator("#app-list-body .app-topic-row");
		for (const [index, { label }] of topics.entries()) {
			const row = rows.filter({ has: page.locator(".app-topic-name", { hasText: new RegExp("^#" + label + "$") }) });
			const image = row.locator("img[data-loaded]");
			await image.waitFor({ timeout: 4500 });
			assert.equal(await image.getAttribute("src"), wikiImage(files[index][0]));
		}
		const searches = app.requests.filter(({ url }) => wiki(url) && new URL(url).searchParams.has("gsrsearch"));
		assert(searches.some(({ url }) => new URL(url).searchParams.get("gsrsearch") === talks));
		assert.equal(searches.some(({ url }) => decodeURIComponent(url).includes("sample.example.org")), false);
		assert.deepEqual(app.errors, []);
	} finally {
		await app.browser.close();
	}
});

test("a link path can disambiguate an ambiguous programming topic for imagery", async () => {
	const rust = { id: "story:rust-algorithms", label: "Persistent data algorithms in Rust", kind: "story" };
	const article = { ...guide, url: "https://framed.example.com/posts/algorithms-in-rust", title: "Algorithms for persistent data" };
	const fixture = { ...catalog, topics: [rust], pages: [
		{ key: "framed.example.com/posts/algorithms-in-rust", topicIds: [rust.id] },
		{ ...catalog.pages[1], topicIds: [rust.id] },
	] };
	const app = await launchTopics({
		stored: {
			"HNewhere:app_browse_topics": true,
			"HNewhere:frontpage_feed:technology/hn/front/": {
				timestamp: now * 1000, stories: [{ ...article, topic: "technology" }],
			},
		},
		responses: [{ match: (url) => url === catalogURL, json: fixture }],
	});
	try {
		const { page } = app;
		await page.goto("https://backchnnl.app/");
		await expectTopicPhoto(topic(page.locator("#app-list-body"), "Rust"), /rust source code/i);
		assert.deepEqual(app.errors, []);
	} finally {
		await app.browser.close();
	}
});

test("renamed shared topics preserve old filters and resolve in universal search", async () => {
	const title = "Extensions adopt new access controls";
	const oldLabel = "Extension permissions";
	const renamed = { id: "story:permissions", label: title, kind: "story", aliases: [oldLabel] };
	const fixture = {
		...catalog, topics: [renamed],
		pages: catalog.pages.map((item) => ({ ...item, topicIds: [renamed.id] })),
	};
	const app = await launchTopics({
		stored: {
			"HNewhere:settings": {
				updateCheck: false, sourceRefreshMinutes: 0, sources: { hn: true, lemmy: true },
				frontPageMode: "topics", frontPageTopics: ["technology"], hiddenTopics: [oldLabel],
			},
		},
		responses: [{ match: (url) => url === catalogURL, json: fixture }],
	});
	try {
		const { page } = app;
		page.setDefaultTimeout(7000);
		await page.goto("https://backchnnl.app/");
		const list = page.locator("#app-list-body");
		await list.getByText("No links match your topic filters.").waitFor();
		const settings = await openTopicFilters(page);
		await settings.getByRole("button", { name: "Show again, " + oldLabel }).click();
		await settings.getByRole("button", { name: "Close settings" }).click();
		await list.getByRole("link", { name: report.title }).waitFor();
		await page.locator("#app-rail-search").click();
		await page.locator("#app-search-input").fill(oldLabel);
		await page.getByRole("button", { name: "#" + title + " Front Pages · 2 links", exact: true }).click();
		await page.locator("#app-list-topic-title").getByText("#" + title, { exact: true }).waitFor();
		assert.deepEqual(app.errors, []);
	} finally {
		await app.browser.close();
	}
});

test("story groups stay separate when the same subject is used as a filter alias", async () => {
	const announcement = { id: "story:release", label: "Example Browser ships per-site permissions", kind: "story", aliases: ["Example Browser"] };
	const lawsuit = { id: "story:lawsuit", label: "Example Browser faces a patent lawsuit", kind: "story", aliases: ["Example Browser"] };
	const fixture = { ...catalog, topics: [announcement, lawsuit], pages: [
		{ ...catalog.pages[0], topicIds: [announcement.id] },
		{ ...catalog.pages[1], topicIds: [lawsuit.id] },
	] };
	const app = await launchTopics({ responses: [{ match: (url) => url === catalogURL, json: fixture }] });
	try {
		const { page } = app;
		await page.goto("https://backchnnl.app/");
		const list = page.locator("#app-list-body");
		for (const { title } of [guide, report]) {
			await list.getByRole("link", { name: title, exact: true }).waitFor({ timeout: 5000 });
		}
		assert(await waitFor(() => Boolean(app.store.get(catalogKey))));
		assert.equal(await page.getByRole("tab", { name: "Topics", exact: true }).count(), 0);
		assert.equal(await list.locator(".app-topic-row").count(), 0);
		assert.deepEqual(app.errors, []);
	} finally {
		await app.browser.close();
	}
});

async function openTopicFilters(page) {
	await page.locator("#settings-toggle").click();
	await page.getByRole("button", { name: "Filters", exact: true }).click();
	return page.getByRole("dialog", { name: "Settings" });
}

test("topic filters hide the tabs for a single link and can be undone after reload", async () => {
	const app = await launchTopics();
	try {
		const { page } = app;
		page.setDefaultTimeout(5000);
		const list = page.locator("#app-list-body");
		const guideLink = list.getByRole("link", { name: guide.title, exact: true });
		const reportLink = list.getByRole("link", { name: report.title, exact: true });
		await page.goto("https://backchnnl.app/");
		await guideLink.waitFor();
		await reportLink.waitFor();
		await rail(page, "collection").click();
		await guideLink.waitFor();

		const settings = await openTopicFilters(page);
		const search = settings.getByRole("searchbox", { name: "Search topics" });
		await search.fill("PRIV brows");
		const matches = settings.getByRole("group", { name: "Matching topics" });
		await matches.getByRole("button", { name: "Hide Browser privacy", exact: true }).click();
		const tags = settings.getByRole("group", { name: "Hidden topics", exact: true });
		await tags.getByRole("button", { name: "Show again, Browser privacy", exact: true }).waitFor();
		assert.equal(await search.inputValue(), "");
		assert.equal(await matches.isVisible(), false);
		await search.fill("no such topic");
		await settings.getByText("No matching topics.", { exact: true }).waitFor();
		await search.press("Escape");
		assert.equal(await search.inputValue(), "");
		assert.equal(await settings.isVisible(), true);
		await settings.getByRole("button", { name: "Close settings" }).click();
		assert(await waitFor(() => rail(page, "unread").locator(".rail-badge").textContent().then((count) => count === "1")));
		await guideLink.waitFor();
		await rail(page, "unread").click();
		await guideLink.waitFor({ state: "detached" });
		await reportLink.waitFor();

		assert.equal(await page.getByRole("tab", { name: "Topics", exact: true }).count(), 0);
		assert.equal(await list.locator(".app-topic-row").count(), 0);
		await page.getByRole("button", { name: "Mark all as read" }).click();
		assert(await waitFor(() => Number(app.store.get("HNewhere:seen_comments")?.["lemmy:9361"]) > 0));
		assert.equal(app.store.get("HNewhere:seen_comments")?.["hn:9360"], undefined);

		await rail(page, "source:hn").click();
		await list.getByText("No links match your topic filters.").waitFor();
		await rail(page, "collection").click();
		await guideLink.waitFor();
		await rail(page, "queue").click();
		await guideLink.waitFor();

		await page.reload();
		await list.getByText("No links match your topic filters.").waitFor();
		await openTopicFilters(page);
		await settings.getByRole("button", { name: "Show again, Browser privacy", exact: true }).click();
		await settings.getByRole("button", { name: "Show again, Browser privacy", exact: true }).waitFor({ state: "detached" });
		await settings.getByRole("button", { name: "Close settings" }).click();
		await guideLink.waitFor();
		assert.deepEqual(app.errors, []);
	} finally {
		await app.browser.close();
	}
});

test("Hidden links is managed in Filters and Settings search opens its new location", async () => {
	const app = await launchTopics({ stored: { "HNewhere:hidden_stories": [{
		key: "framed.example.com/post/260?v=1", url: guide.url, title: guide.title,
		site: "framed.example.com", hiddenAt: now * 1000,
	}] } });
	try {
		const { page } = app;
		page.setDefaultTimeout(5000);
		await page.goto("https://backchnnl.app/");
		const front = page.locator("#app-list-body");
		const hidden = front.getByRole("link", { name: guide.title, exact: true });
		await front.getByRole("link", { name: report.title, exact: true }).waitFor();
		assert.equal(await hidden.count(), 0);
		await page.locator("#settings-toggle").click();
		await page.getByRole("button", { name: "Sources", exact: true }).click();
		const settings = page.getByRole("dialog", { name: "Settings" });
		const links = settings.getByRole("listbox", { name: "Hidden links" });
		const heading = settings.locator("#app-settings-heading");
		const sourceHeadingMargin = await heading.evaluate((node) => getComputedStyle(node).marginBottom);
		assert.equal(await links.isVisible(), false);
		await settings.getByRole("button", { name: "Close settings" }).click();
		await page.locator("#app-rail-search").click();
		await page.locator("#app-search-input").fill("hidden links");
		await page.locator(".app-search-item", { hasText: "Hidden links" }).click();
		await links.getByText(guide.title, { exact: true }).click();
		assert.equal(await page.locator("#app-settings-modal").getAttribute("data-section"), "filters");
		const filters = settings.locator("#settings-topic-filters");
		assert.match(await filters.locator(":scope > :first-child").getAttribute("class"), /\bsettings-section-hint\b/);
		assert.equal(await filters.locator(":scope > .settings-section-hint").textContent(), "Choose which topics and links to hide from Front Pages.");
		assert.equal(await heading.evaluate((node) => getComputedStyle(node).marginBottom), sourceHeadingMargin);
		assert.equal(await filters.getByText("Hidden topics", { exact: true }).first()
			.evaluate((heading) => getComputedStyle(heading).borderTopWidth), "0px");
		await settings.getByRole("button", { name: "Show the chosen link again" }).click();
		await links.getByText("Nothing hidden yet.").waitFor();
		await settings.getByRole("button", { name: "Close settings" }).click();
		await hidden.waitFor();
		assert.deepEqual(app.errors, []);
	} finally {
		await app.browser.close();
	}
});

test("a broad topic filter also hides more specifically grouped links", async () => {
	const app = await launchTopics({
		stored: {
			"HNewhere:settings": {
				updateCheck: false, sourceRefreshMinutes: 0, sources: { hn: true, lemmy: true },
				frontPageMode: "topics", frontPageTopics: ["technology"], hiddenTopics: ["Technology"],
			},
		},
	});
	try {
		const { page } = app;
		page.setDefaultTimeout(5000);
		await page.goto("https://backchnnl.app/");
		const list = page.locator("#app-list-body");
		await list.getByText("No links match your topic filters.").waitFor();
		assert.equal(await list.locator(".app-row").count(), 0);
		assert.equal(app.requests.filter(({ url }) => url === catalogURL).length, 0);
		assert.equal(await page.getByRole("tab", { name: "Topics", exact: true }).count(), 0);
		assert.equal(await list.locator(".app-topic-row").count(), 0);
		assert.deepEqual(app.errors, []);
	} finally {
		await app.browser.close();
	}
});

test("indexed headlines still contribute inferred subjects to Filters", async () => {
	const headline = { ...guide, title: "The generational garbage collector", topic: "technology" };
	const storyTopic = { id: "story:collector", label: headline.title, kind: "story" };
	const fixture = { ...catalog, topics: [...catalog.topics, storyTopic], pages: [
		{ ...catalog.pages[0], topicIds: [storyTopic.id] }, catalog.pages[1],
	] };
	const app = await launchTopics({
		stored: { "HNewhere:frontpage_feed:technology/hn/front/": { timestamp: now * 1000, stories: [headline] } },
		responses: [{ match: (url) => url === catalogURL, json: fixture }],
	});
	try {
		const { page } = app;
		await page.goto("https://backchnnl.app/");
		const settings = await openTopicFilters(page);
		await settings.getByRole("searchbox", { name: "Search topics" }).fill("Programming");
		await settings.getByRole("button", { name: "Hide Programming", exact: true }).click({ timeout: 5000 });
		await settings.getByRole("button", { name: "Close settings" }).click();
		const list = page.locator("#app-list-body");
		await list.getByRole("link", { name: report.title, exact: true }).waitFor();
		assert.equal(await list.getByRole("link", { name: headline.title, exact: true }).count(), 0);
		assert.deepEqual(app.errors, []);
	} finally {
		await app.browser.close();
	}
});

test("an inferred topic stays hidden as its group shrinks and is editable from another tab", async () => {
	const first = { ...guide, topic: "technology", title: "Ceramic glazes for beginners" };
	const second = { ...report, topic: "technology", title: "Firing ceramic glazes without defects" };
	const feedKey = "HNewhere:frontpage_feed:technology/hn/front/";
	const otherFeedKey = "HNewhere:frontpage_feed:technology/lemmy/community/technology@lemmy.world";
	const feed = (stories) => ({ timestamp: now * 1000, stories });
	const app = await launchTopics({ status: 503, stored: { [feedKey]: feed([first]), [otherFeedKey]: feed([second]) } });
	try {
		const other = await app.context.newPage();
		for (const page of [app.page, other]) page.setDefaultTimeout(5000);
		await Promise.all([app.page, other].map((page) => page.goto("https://backchnnl.app/")));
		const list = (page) => page.locator("#app-list-body");
		await Promise.all([app.page, other].map((page) => list(page).getByRole("link", { name: first.title }).waitFor()));
		const topicLabel = "Ceramic Glazes";
		await app.page.getByRole("tab", { name: "Topics", exact: true }).click();
		const ceramics = topic(list(app.page), topicLabel);
		await ceramics.getByText(/in 2 links$/).waitFor();
		await expectTopicPhoto(ceramics, /glazed pottery/i);
		const restore = (settings) => settings.getByRole("button", { name: "Show again, " + topicLabel });
		const settings = await openTopicFilters(app.page);
		const search = settings.getByRole("searchbox", { name: "Search topics" });
		await search.fill("ceramic");
		await settings.getByRole("button", { name: "Hide " + topicLabel, exact: true }).waitFor();
		await search.press("Enter");
		await restore(settings).waitFor();

		const otherSettings = await openTopicFilters(other);
		await restore(otherSettings).waitFor();
		app.store.set(otherFeedKey, feed([]));
		await app.page.reload();
		await list(app.page).getByText("No links match your topic filters.").waitFor();
		assert.equal(await list(app.page).getByRole("link", { name: first.title }).count(), 0);
		assert.deepEqual(app.errors, []);
	} finally {
		await app.browser.close();
	}
});

test("Sidebar Front Pages applies topic filters and restores links from Settings", async () => {
	const app = await launchTopics({
		appHost: new URL(guide.url).hostname,
		stored: {
			"HNewhere:settings": {
				updateCheck: false, autoOpenSidebar: true, sourceRefreshMinutes: 0, sources: { hn: true, lemmy: true },
				frontPageMode: "topics", frontPageTopics: ["technology"], hiddenTopics: ["Browser privacy"],
			},
		},
	});
	try {
		const { page } = app;
		page.setDefaultTimeout(5000);
		await page.goto(guide.url);
		await page.locator("#comments-content .comment[data-comment-id]").first().waitFor();
		await page.locator("#browse-toggle .wordmark-root").click();
		const list = page.locator("#browse-list");
		const guideLink = list.getByRole("link", { name: guide.title, exact: true });
		await list.getByRole("link", { name: report.title, exact: true }).waitFor();
		assert.equal(await guideLink.count(), 0);

		const settings = await openTopicFilters(page);
		await settings.getByRole("button", { name: "Show again, Browser privacy", exact: true }).click();
		assert.equal(await settings.getByRole("listbox", { name: "Hidden links" }).isVisible(), true);
		await settings.getByRole("button", { name: "Close settings" }).click();
		await page.locator("#browse-tab-all").click();
		await guideLink.waitFor();
		assert.deepEqual(app.errors, []);
	} finally {
		await app.browser.close();
	}
});

test("public Topics scopes normal link rows and preserves their discussions and local-only imports", async () => {
	const app = await launchTopics();
	try {
		const { page } = app;
		page.setDefaultTimeout(5000);
		const list = page.locator("#app-list-body");
		const linksTab = page.getByRole("tab", { name: "All links", exact: true });
		const topicsTab = page.getByRole("tab", { name: "Topics", exact: true });
		const permissions = topic(list, "Extension permissions");
		const guideLink = list.getByRole("link", { name: guide.title, exact: true });
		const reportLink = list.getByRole("link", { name: report.title, exact: true });
		await page.goto("https://backchnnl.app/");
		await guideLink.waitFor();
		await topicsTab.waitFor();
		assert.equal(await linksTab.getAttribute("aria-selected"), "true");
		await linksTab.press("ArrowRight");
		await permissions.getByText(/in 2 links$/).waitFor();
		assert.equal(await topic(list, "Browser privacy").count(), 0);
		assert.equal(await topicsTab.getAttribute("aria-selected"), "true");
		assert(await topicsTab.evaluate((button) => button.getRootNode().activeElement === button));
		await permissions.click();
		await guideLink.waitFor();
		await reportLink.waitFor();
		await guideLink.click();
		await page.locator("#comments-content")
			.getByText("Comment 1 on " + guide.title, { exact: false }).waitFor();
		assert.equal(await page.getByRole("button", { name: "Mark all as read" }).isVisible(), true);

		await rail(page, "all").click();
		await permissions.getByText(/in 2 links$/).waitFor();
		await rail(page, "source:hn").click();
		await guideLink.waitFor();
		assert.equal(await reportLink.count(), 0);
		assert.equal(await permissions.count(), 0);
		assert.equal(await page.getByRole("button", { name: "Back to topics" }).isVisible(), false);

		await rail(page, "queue").click();
		await guideLink.waitFor();
		await rail(page, "collection").click();
		const saved = list.locator(".reader-collection-row");
		await saved.getByRole("link", { name: unknown.title, exact: true }).waitFor();
		await saved.getByRole("link", { name: guide.title, exact: true }).waitFor();
		assert.equal(await list.locator(".app-topic-row").count(), 0);
		await guideLink.click({ modifiers: ["Shift"] });
		assert(await waitFor(() => page.locator("#app-selection-count").textContent().then((value) => value === "1 selected")));
		assert.equal(await topicsTab.count(), 0);
		await page.getByRole("button", { name: "Close selection" }).click();
		assert.equal(await page.locator("#app-selection-bar").isVisible(), false);

		const requests = app.requests.filter(({ url }) => url.startsWith("https://topics.backchnnl.app"));
		assert.equal(requests.length, 1);
		assert.equal(requests[0].url, catalogURL);
		assert.equal(requests[0].method, "GET");
		assert.equal(requests[0].anonymous, true);
		assert.equal(requests[0].hasBody, undefined);
		assert.deepEqual(app.errors, []);
	} finally {
		await app.browser.close();
	}
});

test("Headlines is an opt-in pill in the Front Pages Interests picker", async () => {
	const general = { ...unrelated, source: "lemmy" };
	const another = { ...general, id: 9363, url: "https://plain.example.org/post/263", title: "City adds a new evening bus route" };
	const cached = (stories) => ({ timestamp: now * 1000, stories });
	const app = await launchTopics({ stored: {
		"HNewhere:frontpage_feed:/lemmy/front/": cached([general, another]),
		"HNewhere:frontpage_feed:world/lemmy/community/world@lemmy.world": cached([]),
		"HNewhere:frontpage_feed:world/lemmy/community/europe@feddit.org": cached([]),
	} });
	try {
		const { page } = app;
		page.setDefaultTimeout(6000);
		const list = page.locator("#app-list-body");
		const generalLink = list.getByRole("link", { name: general.title, exact: true });
		const reportLink = list.getByRole("link", { name: report.title, exact: true });
		const unread = rail(page, "unread");
		const all = rail(page, "all");
		const top = rail(page, "top-stories");
		const technology = rail(page, "topic:technology");
		const settings = page.getByRole("dialog", { name: "Settings" });
		const openSources = async () => {
			await page.locator("#settings-toggle").click();
			await page.getByRole("button", { name: "Sources", exact: true }).click();
		};
		await page.goto("https://backchnnl.app/");
		await reportLink.waitFor();
		assert.equal(await generalLink.count(), 0);
		await openSources();
		const chooser = settings.getByRole("radiogroup", { name: "Front Pages" });
		assert.deepEqual(await chooser.getByRole("radio").evaluateAll((radios) => radios.map((radio) => radio.labels[0].textContent)),
			["Top links from your sources", "Interests"]);
		assert(await chooser.getByRole("radio", { name: "Interests" }).isChecked());
		const interests = chooser.getByRole("group", { name: "Followed interests" });
		const headlines = interests.getByRole("button", { name: "Headlines", exact: true });
		await headlines.waitFor();
		assert.equal(await headlines.getAttribute("aria-pressed"), "false");
		assert.equal(await interests.getByRole("button").first().textContent(), "Headlines");
		assert.equal(await top.count(), 0);
		await headlines.press("Space");
		assert.equal(await headlines.getAttribute("aria-pressed"), "true");
		assert(await waitFor(() => app.store.get("HNewhere:settings").frontPageIncludeTopLinks === true));
		await settings.getByRole("button", { name: "Close settings" }).click();
		await generalLink.waitFor();
		await reportLink.waitFor();

		await page.reload();
		await generalLink.waitFor();
		await reportLink.waitFor();
		await top.waitFor();
		assert.equal(await top.getAttribute("aria-label"), "Headlines");
		assert((await top.boundingBox()).y < (await technology.boundingBox()).y);
		await top.click();
		await generalLink.waitFor();
		assert.equal(await reportLink.count(), 0);
		assert.equal(await top.getAttribute("aria-pressed"), "true");
		assert.equal(await all.locator(".rail-badge").textContent(), "4");
		assert.equal(await page.getByRole("tab", { name: "Topics", exact: true }).count(), 0);
		await technology.click();
		await page.getByRole("tab", { name: "Topics", exact: true }).click();
		await topic(list, "Extension permissions").getByText(/in 2 links$/).waitFor();
		assert.equal(await generalLink.count(), 0);
		await page.getByRole("tab", { name: "All links", exact: true }).click();
		await top.click();
		await generalLink.waitFor();
		await page.locator("#app-mark-read").click();
		assert(await waitFor(() => app.store.get("HNewhere:seen_comments")?.["lemmy:9362"]));
		assert.equal(app.store.get("HNewhere:seen_comments")?.["lemmy:9361"], undefined);
		await openSources();
		assert.equal(await headlines.getAttribute("aria-pressed"), "true");
		await headlines.click();
		assert(await waitFor(() => app.store.get("HNewhere:settings").frontPageIncludeTopLinks === false));
		await settings.getByRole("button", { name: "Close settings" }).click();
		await top.waitFor({ state: "detached" });
		await reportLink.waitFor();
		assert.equal(await unread.getAttribute("aria-pressed"), "true");
		assert.equal(await unread.locator(".rail-badge").textContent(), "1");
		await all.click();
		await list.getByRole("link", { name: guide.title }).waitFor();
		assert.equal(await generalLink.count(), 0);

		await openSources();
		const world = chooser.getByRole("button", { name: "World", exact: true });
		await world.click();
		assert(await waitFor(() => app.store.get("HNewhere:settings").frontPageTopics.includes("world")));
		const lemmy = settings.locator("#setting-source-lemmy");
		await lemmy.uncheck();
		assert(await waitFor(() => app.store.get("HNewhere:settings").sources.lemmy === false));
		assert(await waitFor(() => world.evaluate((chip) => chip.classList.contains("is-uncovered"))));
		assert.equal(await world.getAttribute("aria-pressed"), "true");
		assert.deepEqual(app.store.get("HNewhere:settings").frontPageTopics, ["technology", "world"]);
		await lemmy.check();
		assert(await waitFor(() => world.evaluate((chip) => !chip.classList.contains("is-uncovered"))));
		assert.equal(await world.getAttribute("aria-pressed"), "true");
		assert.deepEqual(app.errors, []);
	} finally {
		await app.browser.close();
	}
});

for (const surface of ["phone", "Sidebar"]) {
	test(`${surface} Front Pages puts Headlines first when selected in Interests`, async () => {
		const general = { ...unrelated, source: "lemmy" };
		const app = await launchTopics({
			...(surface === "phone" ? { viewport: { width: 390, height: 844 }, hasTouch: true } : { appHost: new URL(guide.url).hostname }),
			stored: {
				"HNewhere:settings": {
					updateCheck: false, autoOpenSidebar: true, sourceRefreshMinutes: 0, sources: { hn: true, lemmy: true },
					frontPageMode: "topics", frontPageTopics: ["technology"], frontPageIncludeTopLinks: true,
				},
				"HNewhere:frontpage_feed:/lemmy/front/": { timestamp: now * 1000, stories: [general] },
			},
		});
		try {
			const { page } = app;
			page.setDefaultTimeout(6000);
			const phone = surface === "phone";
			await page.goto(phone ? "https://backchnnl.app/" : guide.url);
			if (!phone) {
				await page.locator("#comments-content .comment[data-comment-id]").first().waitFor();
				await page.locator("#browse-toggle .wordmark-root").click();
			}
			const list = page.locator(phone ? "#app-list-body" : "#browse-list");
			const generalLink = list.getByRole("link", { name: general.title, exact: true });
			const interestLink = list.getByRole("link", { name: report.title, exact: true });
			const filters = page.locator(phone ? "#app-list-tags" : "#browse-home-filters");
			const attr = phone ? "data-app-view" : "data-browse-view";
			await generalLink.waitFor();
			await interestLink.waitFor();
			const top = filters.getByRole("button", { name: "Headlines", exact: true });
			await top.waitFor();
			assert.equal(await filters.locator(`[${attr}]`).first().getAttribute(attr), "top-stories");
			if (phone) assert.equal(await rail(page, "top-stories").isVisible(), false);
			await filters.locator(`[${attr}="topic:technology"]`).click();
			await generalLink.waitFor({ state: "hidden" });
			await interestLink.waitFor();
			await top.click();
			await generalLink.waitFor();
			assert.equal(await interestLink.count(), 0);
			assert.equal(await top.getAttribute("aria-pressed"), "true");
			assert.equal(app.store.get("HNewhere:settings").frontPageMode, "topics");
			assert.equal(app.store.get("HNewhere:settings").frontPageIncludeTopLinks, true);
			assert.deepEqual(app.errors, []);
		} finally {
			await app.browser.close();
		}
	});
}

test("Front Page Topics gives recent stories with more publishers a higher position", async () => {
	const groups = [
		{ id: "story:lakes", label: "Lakes reopen after the flood", time: now - 5 * 86400, publishers: ["oak.example.org", "maple.example.com", "beech.example.net"] },
		{ id: "story:repairs", label: "Bridge repairs close the avenue", time: now - 3600, publishers: ["one.example.org", "m.one.example.org", "amp.one.example.org"] },
		{ id: "story:weather", label: "New weather satellite reaches orbit", time: now - 3600, publishers: ["journal.example.org", "agency.example.net"] },
	];
	const articles = groups.flatMap(({ id, label, time, publishers }) => publishers.map((publisher, index) => ({
		id: id + index, source: "hn", time, title: label + ` (${index + 1})`, descendants: 12,
		url: `https://${publisher}/${id.slice(6)}-${index}`, topicIds: [id],
	})));
	const index = { version: 1, generatedAt: catalog.generatedAt,
		topics: groups.map(({ id, label }) => ({ id, label, kind: "story" })),
		pages: articles.map(({ url, topicIds }) => ({ key: url.slice("https://".length), topicIds })),
	};
	const app = await launchTopics({
		settings: { updateCheck: false, sourceRefreshMinutes: 0, frontPageMode: "sources", sources: { hn: true } },
		stored: { "HNewhere:frontpage_feed:/hn/front/": { timestamp: now * 1000, stories: articles } },
		responses: [{ match: (url) => url === catalogURL, json: index }],
	});
	try {
		const { page } = app;
		page.setDefaultTimeout(5000);
		await page.goto("https://backchnnl.app/");
		const list = page.locator("#app-list-body");
		await list.getByRole("link", { name: articles.at(-1).title, exact: true }).waitFor();
		const allLinks = await list.locator(".browse-title-link").allTextContents();
		await page.getByRole("tab", { name: "Topics", exact: true }).click();
		await topic(list, groups[0].label).waitFor();
		assert.deepEqual(await list.locator(".app-topic-name").allTextContents(), [groups[2], groups[1], groups[0]].map(({ label }) => `#${label}`));
		await page.getByRole("tab", { name: "All links", exact: true }).click();
		await list.getByRole("link", { name: articles.at(-1).title, exact: true }).waitFor();
		assert.deepEqual(await list.locator(".browse-title-link").allTextContents(), allLinks);
		assert.deepEqual(app.errors, []);
	} finally {
		await app.browser.close();
	}
});

test("switching Front Pages modes can reuse the other mode's existing front feed cache", async () => {
	const general = "HNewhere:frontpage_feed:/hn/front/";
	const technology = "HNewhere:frontpage_feed:technology/hn/front/";
	const cached = { timestamp: now * 1000, stories: [guide] };
	const app = await launchTopics({
		settings: { updateCheck: false, sourceRefreshMinutes: 0, frontPageMode: "sources", frontPageTopics: ["technology"], sources: { hn: true } },
		stored: { [general]: cached, [technology]: null },
	});
	try {
		const { page } = app;
		page.setDefaultTimeout(5000);
		await page.goto("https://backchnnl.app/");
		const link = page.locator("#app-list-body").getByRole("link", { name: guide.title, exact: true });
		await link.waitFor();
		await page.locator("#settings-toggle").click();
		await page.getByRole("button", { name: "Sources", exact: true }).click();
		const settings = page.getByRole("dialog", { name: "Settings" });
		await settings.getByRole("radio", { name: "Interests" }).check();
		assert(await waitFor(() => app.store.get("HNewhere:settings").frontPageMode === "topics"));
		await settings.getByRole("button", { name: "Close settings" }).click();
		await rail(page, "topic:technology").click();
		await link.waitFor();

		app.store.delete(general);
		app.store.set(technology, { ...cached, stories: [{ ...guide, topic: "technology" }] });
		await page.locator("#settings-toggle").click();
		await page.getByRole("button", { name: "Sources", exact: true }).click();
		await settings.getByRole("radio", { name: "Top links from your sources" }).check();
		assert(await waitFor(() => app.store.get("HNewhere:settings").frontPageMode === "sources"));
		await settings.getByRole("button", { name: "Close settings" }).click();
		await rail(page, "topic:technology").waitFor();
		await rail(page, "all").click();
		await link.waitFor();
		assert.deepEqual(app.errors, []);
	} finally {
		await app.browser.close();
	}
});

test("a pending source change preserves a later followed-interest edit", async () => {
	const slowSets = { prefix: "HNewhere:settings", ms: 900, armed: false };
	const app = await launchTopics({ slowSets });
	try {
		const { page } = app;
		page.setDefaultTimeout(5000);
		await page.goto("https://backchnnl.app/");
		await page.locator("#settings-toggle").click();
		await page.getByRole("button", { name: "Sources", exact: true }).click();
		const settings = page.getByRole("dialog", { name: "Settings" });
		const technology = settings.getByRole("button", { name: "Technology", exact: true });
		await technology.waitFor();
		slowSets.armed = true;
		await settings.locator("#setting-source-lemmy").uncheck();
		assert(await waitFor(() => !slowSets.armed));
		await technology.click();
		assert(await waitFor(() => slowSets.completed && !app.store.get("HNewhere:settings").frontPageTopics.includes("technology")));
		assert.equal(app.store.get("HNewhere:settings").sources.lemmy, false);
		assert.equal(await technology.getAttribute("aria-pressed"), "false");
		assert.deepEqual(app.errors, []);
	} finally {
		await app.browser.close();
	}
});

test("indexed Bluesky discussion counts do not double-count cached interest-feed totals", async () => {
	const firstPost = "at://did:plc:first/app.bsky.feed.post/a";
	const secondPost = "at://did:plc:second/app.bsky.feed.post/b";
	const feedName = "at://did:plc:cndfx4udwgvpjaakvxvh7wm5/app.bsky.feed.generator/flipboard-tech";
	const index = { ...catalog, pages: [
		{ ...catalog.pages[0], posts: [["bsky:" + firstPost, 7], ["bsky:" + secondPost, 6]] },
		catalog.pages[1],
	] };
	const app = await launchTopics({
		settings: { updateCheck: false, sourceRefreshMinutes: 0, frontPageMode: "topics", frontPageTopics: ["technology"], sources: { bsky: true, lemmy: true } },
		stored: { ["HNewhere:frontpage_feed:technology/bsky/feed/" + feedName]: { timestamp: now * 1000, stories: [
			{ ...guide, source: "bsky", id: firstPost, topic: "technology", descendants: 13 },
		] } },
		responses: [{ match: (url) => url === catalogURL, json: index }],
	});
	try {
		const { page } = app;
		page.setDefaultTimeout(5000);
		await page.goto("https://backchnnl.app/");
		await page.getByRole("tab", { name: "Topics", exact: true }).click();
		const group = topic(page.locator("#app-list-body"), "Extension permissions");
		await group.waitFor();
		assert.equal(await group.locator(".app-topic-meta").textContent(), "15 comments across 3 discussions in 2 links");
		assert.deepEqual(app.errors, []);
	} finally {
		await app.browser.close();
	}
});

test("right-clicking a topic row opens its menu and can select its links", async () => {
	const app = await launchTopics({ stored: frontPageWithUnrelated });
	try {
		const { page } = app;
		page.setDefaultTimeout(5000);
		await page.goto("https://backchnnl.app/");
		await page.getByRole("tab", { name: "Topics", exact: true }).click();
		const list = page.locator("#app-list-body");
		const group = topic(list, "Extension permissions");
		const guideLink = list.getByRole("link", { name: guide.title, exact: true });
		const reportLink = list.getByRole("link", { name: report.title, exact: true });
		const otherLink = list.getByRole("link", { name: unrelated.title, exact: true });
		const menu = page.locator("#app-row-menu");
		await otherLink.waitFor();
		await list.evaluate((body) => {
			body.addEventListener("contextmenu", (event) => {
				body.dataset.contextMenuHandled = String(event.defaultPrevented);
			}, { once: true });
		});
		await group.locator(".app-topic-media").click({ button: "right" });
		await menu.waitFor();
		assert.equal(await list.getAttribute("data-context-menu-handled"), "true");
		assert.equal(await menu.getAttribute("aria-label"), "This topic");
		assert.equal(await guideLink.count(), 0);
		await page.keyboard.press("Escape");
		await menu.waitFor({ state: "hidden" });
		assert(await group.evaluate((row) => row.getRootNode().activeElement === row));

		await group.press("Shift+F10");
		await menu.getByRole("menuitem", { name: "Open", exact: true }).click();
		await guideLink.waitFor();
		await reportLink.waitFor();
		await page.getByRole("button", { name: "Back to topics" }).click();
		assert(await waitFor(() => group.evaluate((row) => row.getRootNode().activeElement === row)));
		await group.locator(".app-topic-meta").click({ button: "right" });
		await menu.getByRole("menuitem", { name: "Select links" }).click();
		await page.locator("#app-selection-bar").waitFor();
		assert.equal(await page.locator("#app-selection-count").textContent(), "2 selected");
		assert(await list.getByRole("checkbox", { name: `Select ${guide.title}`, exact: true }).isChecked());
		assert(await list.getByRole("checkbox", { name: `Select ${report.title}`, exact: true }).isChecked());
		assert.equal(await otherLink.count(), 0);
		assert.deepEqual(app.errors, []);
	} finally {
		await app.browser.close();
	}
});

const coverageURL = catalogURL + "/coverage";
const coverageTopic = { id: "story:extension-permissions", label: "Extension permissions", kind: "story" };
const furtherLink = {
	url: "https://another.example.com/extension-permissions", title: "Changes to extension prompts",
	domain: "another.example.com", postedAt: new Date(now * 1000).toISOString(),
	posts: [{ id: "lobsters:prompts", source: "lobsters", community: "", title: "Extension prompts on Lobsters",
		url: "https://lobste.rs/s/prompts/extension_prompts", postedAt: null, comments: 7 }],
};
const coverageFixture = {
	version: 1, topic: coverageTopic, links: [
		{ url: guide.url, title: guide.title, domain: "framed.example.com", postedAt: new Date(guide.time * 1000).toISOString(),
			posts: [{ id: "hn:9360", source: "hn", community: "", title: "Extension permissions on HN",
				url: "https://news.ycombinator.com/item?id=9360", postedAt: null, comments: 3 },
			{ id: "hn:9359", source: "hn", community: "", title: "Earlier extension permissions discussion",
				url: "https://news.ycombinator.com/item?id=9359", postedAt: null, comments: 13 }] },
		{ url: report.url, title: report.title, domain: "plain.example.org", postedAt: new Date(report.time * 1000).toISOString(),
			posts: [{ id: "lemmy:9361", source: "lemmy", community: "!technology@lemmy.world", title: "Extension access on Lemmy",
				url: "https://lemmy.world/post/9361", postedAt: null, comments: 40 }] },
		furtherLink,
	],
};
const coverageIndex = {
	...catalog, topics: [coverageTopic], pages: [...catalog.pages, { key: "another.example.com/extension-permissions" }]
		.map(({ key }) => ({ key, topicIds: [coverageTopic.id] })),
};
const coverageWithImage = {
	...coverageFixture,
	topic: { ...coverageTopic, image: {
		url: topicPhoto, source: imageCredit, credit: "Example author · CC BY 4.0", subject: "Browser extension",
	} },
};
const coverageIndexWithImage = { ...coverageIndex, topics: [coverageWithImage.topic] };

function coverageResponse(id, options = { json: coverageFixture }, offset = null) {
	return {
		match: (url) => {
			if (!url.startsWith(coverageURL + "?")) return false;
			const params = new URL(url).searchParams;
			return params.get("id") === id && params.get("offset") === (offset === null ? null : String(offset));
		},
		...options,
	};
}

const loadHiddenLinks = (page) => page.getByRole("button", { name: "Load hidden links about this topic", exact: true });

async function openPermissionsTopic(page) {
	await page.goto("https://backchnnl.app/");
	await page.getByRole("tab", { name: "Topics", exact: true }).click();
	const list = page.locator("#app-list-body");
	await topic(list, coverageTopic.label).click();
	await list.getByRole("link", { name: report.title, exact: true }).waitFor();
	return list;
}

test("Reader loads additional topic links after the current rows without navigating", async () => {
	const preview = "https://another.example.com/preview.png";
	const app = await launchTopics({ stored: { "HNewhere:looks": {
		"another.example.com/extension-permissions": { image: preview, at: now * 1000 },
	} }, responses: [
		{ match: (url) => url === catalogURL, json: coverageIndexWithImage },
		coverageResponse(coverageTopic.id, { json: coverageWithImage }),
	] });
	try {
		const { page, context } = app;
		page.setDefaultTimeout(5000);
		await context.route(preview, (route) => route.fulfill({ contentType: "image/png", body: previewPNG }));
		await context.route(topicPhoto, (route) => route.fulfill({ contentType: "image/png", body: previewPNG }));
		const list = await openPermissionsTopic(page);
		const titles = list.locator(".browse-title-link");
		const visible = await titles.allTextContents();
		const load = loadHiddenLinks(page);
		await load.waitFor();
		assert(await list.locator(":scope > :last-child").getByRole("button", { name: "Load hidden links about this topic" }).isVisible());
		assert.deepEqual(new Set(visible), new Set([guide.title, report.title]));
		assert.equal(await page.locator("#app-list-topic").getByRole("link", { name: /image credit/i }).count(), 0);
		assert.equal(app.requests.some(({ url }) => url.startsWith(coverageURL)), false);

		await load.press("Enter");
		const additional = list.getByRole("link", { name: furtherLink.title, exact: true });
		await additional.waitFor();
		assert.deepEqual(await titles.allTextContents(), [...visible, furtherLink.title]);
		assert.equal(await load.count(), 0);
		assert.equal(new URL(page.url()).searchParams.has("topic"), false);
		assert.equal(await page.getByRole("button", { name: "Back to links", exact: true }).count(), 0);
		await page.locator("#app-list-topic").getByText(/in 3 links$/).waitFor();
		assert(await additional.locator("xpath=ancestor::*[@data-topic-extra]").isVisible());
		const picture = list.locator("[data-topic-extra] .browse-thumb");
		await picture.waitFor();
		assert(await waitFor(() => picture.evaluate((node) => node.naturalWidth === 1)));
		assert.deepEqual(await picture.evaluate((node) => [node.offsetWidth, node.offsetHeight]), [30, 30]);
		assert(await waitFor(() => additional.evaluate((link) => link.getRootNode().activeElement === link)));
		await page.getByRole("button", { name: "Back to topics", exact: true }).click();
		await topic(list, coverageTopic.label).waitFor();
		assert.equal(await additional.count(), 0);
		const requests = app.requests.filter(({ url }) => url.startsWith(coverageURL));
		assert.equal(requests.length, 1);
		assert(requests.every(({ method, anonymous, hasBody }) => method === "GET" && anonymous && !hasBody));
		assert.deepEqual(app.errors, []);
	} finally {
		await app.browser.close();
	}
});

test("an unread topic can reveal its read links without asking for public coverage", async () => {
	const earlier = { ...guide, id: 9359, url: furtherLink.url, title: furtherLink.title };
	const app = await launchTopics({
		stored: {
			"HNewhere:seen_comments": { "hn:9359": now - 60 },
			"HNewhere:frontpage_feed:technology/hn/front/": {
				timestamp: now * 1000,
				stories: [guide, earlier].map((story) => ({ ...story, topic: "technology" })),
			},
		},
		responses: [{ match: (url) => url === catalogURL, json: coverageIndex }],
	});
	try {
		const { page } = app;
		page.setDefaultTimeout(5000);
		const list = await openPermissionsTopic(page);
		const earlierLink = list.getByRole("link", { name: earlier.title, exact: true });
		assert.equal(await earlierLink.count(), 0);
		await loadHiddenLinks(page).click();
		await earlierLink.waitFor();
		assert.equal(await list.locator(".browse-title-link").last().textContent(), earlier.title);
		assert.equal(app.requests.filter(({ url }) => url.startsWith(coverageURL)).length, 0);
		assert.equal(await rail(page, "unread").locator(".rail-badge").textContent(), "2");
		assert.deepEqual(app.errors, []);
	} finally {
		await app.browser.close();
	}
});

test("a merged topic loads additional links from each equivalent topic", async () => {
	const older = { ...coverageTopic, id: "story:extension-access" };
	const another = { ...furtherLink, url: "https://archive.example.com/permissions", title: "An archive of extension changes", posts: [] };
	const index = { ...coverageIndex, topics: [coverageTopic, older], pages: [
		...coverageIndex.pages.slice(0, 2).map(({ key }) => ({ key, topicIds: [coverageTopic.id, older.id] })),
		coverageIndex.pages[2],
		{ key: "archive.example.com/permissions", topicIds: [older.id] },
	] };
	const app = await launchTopics({ responses: [
		{ match: (url) => url === catalogURL, json: index },
		coverageResponse(coverageTopic.id),
		coverageResponse(older.id, { json: { ...coverageFixture, topic: older, links: [...coverageFixture.links.slice(0, 2), another] } }),
	] });
	try {
		const { page } = app;
		page.setDefaultTimeout(5000);
		const list = await openPermissionsTopic(page);
		await loadHiddenLinks(page).click();
		await list.getByRole("link", { name: another.title, exact: true }).waitFor();
		assert.deepEqual(new Set(await list.locator("[data-topic-extra] .browse-title-link").allTextContents()), new Set([furtherLink.title, another.title]));
		assert.equal(await list.locator(".browse-title-link").count(), 4);
		assert.deepEqual(app.errors, []);
	} finally {
		await app.browser.close();
	}
});

test("a topic keeps an explicitly hidden link out of the additional rows", async () => {
	const app = await launchTopics({
		stored: { "HNewhere:hidden_stories": [{ ...furtherLink, key: "another.example.com/extension-permissions" }] },
		responses: [
			{ match: (url) => url === catalogURL, json: coverageIndex }, coverageResponse(coverageTopic.id),
		],
	});
	try {
		const { page } = app;
		page.setDefaultTimeout(5000);
		const list = await openPermissionsTopic(page);
		const back = page.getByRole("button", { name: "Back to topics", exact: true });
		assert(await waitFor(() => back.evaluate((button) => button.getRootNode().activeElement === button)));
		assert.deepEqual(new Set(await list.locator(".browse-title-link").allTextContents()), new Set([guide.title, report.title]));
		assert.equal(await loadHiddenLinks(page).count(), 0);
		assert.equal(app.requests.some(({ url }) => url.startsWith(coverageURL)), false);
		assert.deepEqual(app.errors, []);
	} finally {
		await app.browser.close();
	}
});

test("a narrow phone shows the additional links row without topic header actions", async () => {
	const app = await launchTopics({ viewport: { width: 320, height: 740 }, hasTouch: true, responses: [
		{ match: (url) => url === catalogURL, json: coverageIndexWithImage },
		coverageResponse(coverageTopic.id, { json: coverageWithImage }),
	] });
	try {
		const { page } = app;
		page.setDefaultTimeout(5000);
		const list = await openPermissionsTopic(page);
		assert.deepEqual(await page.locator("#app-list-topic").getByRole("button").allTextContents(), [""]);
		const load = loadHiddenLinks(page);
		await load.waitFor();
		const box = await load.boundingBox();
		assert(box.x >= 0 && box.x + box.width <= 320);
		await load.tap();
		await list.getByRole("link", { name: furtherLink.title, exact: true }).waitFor();
		assert.deepEqual(app.errors, []);
	} finally {
		await app.browser.close();
	}
});

test("a single visible story stays a link and hides the topic tabs", async () => {
	const app = await launchTopics({ responses: [
		{ match: (url) => url === catalogURL, json: coverageIndex }, coverageResponse(coverageTopic.id),
	] });
	try {
		const { page } = app;
		page.setDefaultTimeout(5000);
		const list = await openPermissionsTopic(page);
		await rail(page, "source:hn").click();
		const row = list.locator(".browse-row").filter({ hasText: guide.title });
		await row.getByRole("link", { name: guide.title, exact: true }).waitFor();
		assert.equal(await page.getByRole("tab", { name: "Topics", exact: true }).count(), 0);
		assert.equal(await list.getAttribute("role"), "region");
		await row.getByRole("button", { name: "More", exact: true }).click();
		assert.equal(await page.getByRole("menuitem", { name: "All coverage", exact: true }).count(), 0);
		assert.equal(await loadHiddenLinks(page).count(), 0);
		assert.deepEqual(app.errors, []);
	} finally {
		await app.browser.close();
	}
});

test("an unavailable additional link request keeps the topic readable while it is retried", async () => {
	const response = coverageResponse(coverageTopic.id, { status: 0, delay: 500 });
	const app = await launchTopics({ responses: [{ match: (url) => url === catalogURL, json: coverageIndex }, response] });
	try {
		const { page } = app;
		page.setDefaultTimeout(5000);
		const list = await openPermissionsTopic(page);
		await loadHiddenLinks(page).click();
		await list.getByRole("button", { name: /loading hidden links/i }).waitFor();
		await list.getByRole("link", { name: guide.title, exact: true }).waitFor();
		await list.getByRole("status").getByText(/couldn’t load hidden links/i).waitFor();
		assert.deepEqual(new Set(await list.locator(".browse-title-link").allTextContents()), new Set([guide.title, report.title]));
		Object.assign(response, { status: 200, json: coverageFixture, delay: 0 });
		await loadHiddenLinks(page).click();
		await list.getByRole("link", { name: furtherLink.title, exact: true }).waitFor();
		assert.deepEqual(app.errors, []);
	} finally {
		await app.browser.close();
	}
});

test("a direct topic link opens its group in the current view", async () => {
	const app = await launchTopics({ stored: { "HNewhere:app_panes": { list: false, discussion: true } }, responses: [
		{ match: (url) => url === catalogURL, json: coverageIndex },
		coverageResponse(coverageTopic.id),
	] });
	try {
		const { page } = app;
		page.setDefaultTimeout(5000);
		await page.goto("https://backchnnl.app/?topic=" + coverageTopic.id);
		await page.locator("#app-list-topic-title").getByText("#" + coverageTopic.label).waitFor();
		await loadHiddenLinks(page).waitFor();
		assert.equal(app.requests.some(({ url }) => url.startsWith(coverageURL)), false);
		assert.deepEqual(app.errors, []);
	} finally {
		await app.browser.close();
	}
});

test("Reader follows the canonical continuation when loading hidden topic links", async () => {
	const canonical = { ...coverageTopic, id: "story:extension-access" };
	const generatedAt = new Date(now * 1000).toISOString();
	const app = await launchTopics({ responses: [
		{ match: (url) => url === catalogURL, json: coverageIndex },
		coverageResponse(coverageTopic.id, { json: { ...coverageFixture, topic: canonical, generatedAt, links: coverageFixture.links.slice(0, 1), nextOffset: 1 } }),
		coverageResponse(canonical.id, { json: { ...coverageFixture, topic: canonical, generatedAt, links: coverageFixture.links.slice(1), nextOffset: null } }, 1),
	] });
	try {
		const { page } = app;
		page.setDefaultTimeout(5000);
		const list = await openPermissionsTopic(page);
		await loadHiddenLinks(page).click();
		await list.getByRole("link", { name: furtherLink.title, exact: true }).waitFor();
		const requests = app.requests.filter(({ url }) => url.startsWith(coverageURL + "?")).map(({ url }) => {
			const query = new URL(url).searchParams;
			return [query.get("id"), query.get("offset")];
		});
		assert.deepEqual(requests, [[coverageTopic.id, null], [canonical.id, "1"]]);
		assert.deepEqual(app.errors, []);
	} finally {
		await app.browser.close();
	}
});

test("Reader refuses to append a repeating or changed coverage continuation", async () => {
	const generatedAt = new Date(now * 1000).toISOString();
	const first = { ...coverageFixture, generatedAt, links: coverageFixture.links.slice(0, 1), nextOffset: 1 };
	const second = { ...coverageFixture, generatedAt, links: coverageFixture.links.slice(1), nextOffset: null };
	const invalid = coverageResponse(coverageTopic.id, { json: { ...second, nextOffset: 1 } }, 1);
	const app = await launchTopics({ responses: [
		{ match: (url) => url === catalogURL, json: coverageIndex },
		coverageResponse(coverageTopic.id, { json: first }),
		invalid,
	] });
	try {
		const { page } = app;
		page.setDefaultTimeout(5000);
		const list = await openPermissionsTopic(page);
		const status = list.getByRole("status").getByText(/couldn’t load hidden links/i);
		await loadHiddenLinks(page).click();
		await status.waitFor();
		assert.equal(await list.getByRole("link", { name: furtherLink.title, exact: true }).count(), 0);
		invalid.json = { ...second, generatedAt: new Date((now + 1) * 1000).toISOString() };
		await loadHiddenLinks(page).click();
		await status.waitFor();
		assert.equal(await list.getByRole("link", { name: furtherLink.title, exact: true }).count(), 0);
		assert.equal(app.requests.filter(({ url }) => url.startsWith(coverageURL + "?")).length, 4);
		assert.deepEqual(app.errors, []);
	} finally {
		await app.browser.close();
	}
});

test("Reader stops requesting hidden links after leaving the topic", async () => {
	const generatedAt = new Date(now * 1000).toISOString();
	const app = await launchTopics({ responses: [
		{ match: (url) => url === catalogURL, json: coverageIndex },
		coverageResponse(coverageTopic.id, { json: { ...coverageFixture, generatedAt, links: coverageFixture.links.slice(0, 1), nextOffset: 1 } }),
		coverageResponse(coverageTopic.id, { delay: 700, json: { ...coverageFixture, generatedAt, links: coverageFixture.links.slice(1, 2), nextOffset: 2 } }, 1),
		coverageResponse(coverageTopic.id, { json: { ...coverageFixture, generatedAt, links: coverageFixture.links.slice(2), nextOffset: null } }, 2),
	] });
	try {
		const { page } = app;
		page.setDefaultTimeout(5000);
		const requested = (offset) => app.requests.some(({ url }) => coverageResponse(coverageTopic.id, {}, offset).match(url));
		const list = await openPermissionsTopic(page);
		await loadHiddenLinks(page).click();
		assert(await waitFor(() => requested(1)));
		await page.getByRole("button", { name: "Back to topics", exact: true }).click();
		await topic(list, coverageTopic.label).waitFor();
		assert.equal(await waitFor(() => requested(2), 900), false);
		assert.equal(await list.getByRole("link", { name: furtherLink.title, exact: true }).count(), 0);
		assert.deepEqual(app.errors, []);
	} finally {
		await app.browser.close();
	}
});

test("reviewed standalone links and separately curated topics survive local regrouping", async () => {
	const label = "Lunar radio observatory extends its mission";
	const stories = Array.from({ length: 5 }, (_, i) => ({
		...guide, title: label + " — " + "ABCDE"[i], id: 9815 + i,
		url: "https://lunar" + i + ".example.org/mission", topic: "technology",
	}));
	const ids = ["story:lunar-mission", "story:lunar-mission-split"];
	const image = { url: topicPhoto, source: imageCredit, subject: "Radio telescope", credit: "Example author · CC BY 4.0" };
	const fixture = {
		...catalog, topics: ids.map((id, i) => ({ id, label, kind: "story", curated: true, image, ...(i ? { imageCurated: true } : {}) })),
		pages: stories.map(({ url }, i) => ({ key: new URL(url).host + "/mission", reviewed: true,
			topicIds: i ? [ids[i > 2 ? 1 : 0]] : [] })),
	};
	const app = await launchTopics({
		stored: {
			"HNewhere:app_browse_topics": true,
			"HNewhere:app_list_width": 220,
			"HNewhere:frontpage_feed:technology/hn/front/": { timestamp: now * 1000, stories },
			"HNewhere:frontpage_feed:technology/lemmy/community/technology@lemmy.world": { timestamp: now * 1000, stories: [] },
		}, responses: [{ match: (url) => url === catalogURL, json: fixture }],
	});
	try {
		const { page, context } = app;
		await context.route(topicPhoto, (route) => route.fulfill({ contentType: "image/png", body: previewPNG }));
		page.setDefaultTimeout(5000);
		await page.goto("https://backchnnl.app/");
		const list = page.locator("#app-list-body");
		const groups = topic(list, label);
		await groups.first().waitFor();
		assert.equal(await groups.count(), 2);
		const cover = list.locator(`[data-shared-topic="${ids[1]}"] img[src="${topicPhoto}"]`);
		await cover.waitFor();
		assert.equal(await groups.locator(`img[src="${topicPhoto}"]`).count(), 1);
		assert.deepEqual(await list.locator(".browse-title-link").allTextContents(), [stories[0].title]);
		for (const [i, id] of ids.entries()) {
			await list.locator(`[data-shared-topic="${id}"]`).click();
			await list.locator(".browse-title-link").getByText(stories[i * 2 + 1].title, { exact: true }).waitFor();
			assert.deepEqual(new Set(await list.locator(".browse-title-link").allTextContents()),
				new Set(stories.slice(i * 2 + 1, i * 2 + 3).map(({ title }) => title)));
			const header = await page.locator("#app-list-topic").evaluate((bar) => ({
				width: bar.clientWidth, scrollWidth: bar.scrollWidth, titleWidth: bar.querySelector("strong").getBoundingClientRect().width,
			}));
			assert(header.titleWidth >= 96 && header.scrollWidth === header.width);
			await page.getByRole("button", { name: "Back to topics", exact: true }).click();
		}
		assert.deepEqual(app.errors, []);
	} finally {
		await app.browser.close();
	}
});

test("right-clicking a link in a topic reports the link and the displayed assignment", async () => {
	const token = "r".repeat(43);
	const privateVariant = { ...unknown, url: "https://framed.example.com:9443/post/260?v=1" };
	const fixture = { ...catalog, topics: [catalog.topics[0], { ...catalog.topics[1], aliases: ["Site tracking"] }] };
	const app = await launchTopics({
		hasTouch: true, viewport: { width: 390, height: 844 },
		stored: {
			"HNewhere:account_sync": { token, expiresAt: Date.now() + 600_000 },
			"HNewhere:collected": [{ ...privateVariant, key: "framed.example.com/post/260?v=1", addedAt: now * 1000 }],
		},
		responses: [{ match: (url) => url === catalogURL, json: fixture }],
	});
	const submitted = [];
	try {
		const { page, context } = app;
		page.setDefaultTimeout(5000);
		await context.route(topicReportURL, async (route) => {
			const request = route.request();
			const headers = {
				"Access-Control-Allow-Origin": "https://backchnnl.app",
				"Access-Control-Allow-Methods": "POST",
				"Access-Control-Allow-Headers": "Authorization, Content-Type",
			};
			if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
			submitted.push({ authorization: request.headers().authorization, method: request.method(), body: request.postDataJSON() });
			await route.fulfill({ status: submitted.length === 1 ? 503 : 204, headers });
		});
		await page.goto("https://backchnnl.app/");
		const list = page.locator("#app-list-body");
		await page.getByRole("tab", { name: "Topics", exact: true }).click();
		await topic(list, "Extension permissions").click();
		const row = list.locator(".browse-row").filter({ hasText: guide.title });
		await row.click({ button: "right" });
		const menu = page.locator("#app-row-menu");
		await menu.getByRole("menuitem", { name: "Report incorrect topic…" }).click();
		const dialog = page.getByRole("dialog", { name: "Report incorrect topic" });
		await dialog.getByText(guide.title, { exact: true }).waitFor();
		await dialog.getByText(guide.url, { exact: true }).waitFor();
		await dialog.getByText("Extension permissions", { exact: true }).waitFor();
		assert.deepEqual(submitted, []);
		const suggestion = dialog.getByRole("combobox", { name: "Suggested topic (optional)" });
		assert.deepEqual(await suggestion.evaluate((field) => [getComputedStyle(field).fontSize, field.offsetHeight]), ["16px", 44]);
		await suggestion.fill("#site tracking");
		const option = dialog.getByRole("option", { name: "#Browser privacy", exact: true });
		await option.waitFor();
		await suggestion.press("Escape");
		await option.waitFor({ state: "hidden" });
		assert.equal(await suggestion.inputValue(), "#site tracking");
		await suggestion.press("ArrowDown");
		await suggestion.press("Enter");
		assert.equal(await suggestion.inputValue(), "Browser privacy");
		await suggestion.fill("#site tracking");
		await option.tap();
		assert.equal(await suggestion.inputValue(), "Browser privacy");
		assert.deepEqual(submitted, []);
		const send = dialog.getByRole("button", { name: "Send report" });
		await send.click();
		await dialog.getByRole("status").getByText("Couldn’t send the report. Try again.").waitFor();
		assert.equal(await suggestion.inputValue(), "Browser privacy");
		await suggestion.fill("Browser extension APIs");
		await dialog.getByRole("listbox", { name: "Matching topics" }).waitFor({ state: "hidden" });
		await send.click();
		await dialog.waitFor({ state: "hidden" });
		await page.getByText("Link reported for topic review.", { exact: true }).waitFor();
		assert.deepEqual(submitted, ["Browser privacy", "Browser extension APIs"].map((suggestedTopic) => ({
			authorization: "Bearer " + token, method: "POST",
			body: { url: guide.url, topic: "Extension permissions", suggestedTopic },
		})));
		await list.getByRole("link", { name: guide.title, exact: true }).waitFor();
		assert(await row.locator(".browse-more").evaluate((button) => button.getRootNode().activeElement === button));

		await rail(page, "collection").click();
		await list.locator(".browse-row").filter({ hasText: privateVariant.title }).click({ button: "right" });
		await menu.waitFor();
		assert.equal(await menu.getByRole("menuitem", { name: "Report incorrect topic…" }).count(), 0);
		assert.deepEqual(app.errors, []);
	} finally {
		await app.browser.close();
	}
});

test("the row menu offers topic reporting to signed-out readers and links to Account settings", async () => {
	const app = await launchTopics();
	try {
		const { page, context } = app;
		page.setDefaultTimeout(5000);
		const requests = [];
		await context.route(topicReportURL, async (route) => {
			requests.push(route.request().method());
			await route.abort();
		});
		await page.goto("https://backchnnl.app/");
		const row = page.locator("#app-list-body .browse-row").filter({ hasText: guide.title });
		await row.locator(".browse-more").click();
		await page.getByRole("menuitem", { name: "Report incorrect topic…" }).click();
		const dialog = page.getByRole("dialog", { name: "Report incorrect topic" });
		await dialog.getByRole("button", { name: "Sign in", exact: true }).click();
		await dialog.waitFor({ state: "hidden" });
		await page.getByRole("dialog", { name: "Settings" }).waitFor();
		assert.equal(await page.locator("#app-settings-modal").getAttribute("data-section"), "account");
		assert.deepEqual(requests, []);
		assert.deepEqual(app.errors, []);
	} finally {
		await app.browser.close();
	}
});

test("universal search opens multi-link topics and opens single links directly", async () => {
	const app = await launchTopics({
		stored: { "HNewhere:queue": [{ ...report, key: catalog.pages[1].key, addedAt: now * 1000 }] },
	});
	try {
		const { page } = app;
		page.setDefaultTimeout(5000);
		await page.goto("https://backchnnl.app/");
		const list = page.locator("#app-list-body");
		const reportLink = list.getByRole("link", { name: report.title, exact: true });
		await reportLink.waitFor();
		await page.getByRole("tab", { name: "All links", exact: true, selected: true }).waitFor();
		const destination = [
			["Front Pages", "2 links", "All articles"],
			["Collection", "1 link", "Collection"],
			["Queue", "1 link", "Queue"],
		];
		for (const [scope, count, title] of destination) {
			await page.locator("#app-rail-search").click();
			const search = page.locator("#app-search-input");
			await search.waitFor();
			await search.fill("extension perm");
			const result = page.getByRole("button", { name: "#Extension permissions " + scope + " · " + count, exact: true });
			await result.locator(".app-topic-icon svg").waitFor();
			await result.click();
			await page.locator("#app-list-title").getByText(title, { exact: true }).waitFor();
			const rowSelector = scope === "Collection" ? ".reader-collection-row" : ".browse-row:not(.reader-collection-row)";
			const article = scope === "Queue" ? report : guide;
			const link = list.locator(rowSelector).getByRole("link", { name: article.title, exact: true });
			await link.waitFor();
			if (scope === "Front Pages") {
				await page.locator("#app-list-topic-title").getByText("#Extension permissions", { exact: true }).waitFor();
			} else {
				await page.locator("#app-list-topic").waitFor({ state: "hidden" });
				const openedURL = await link.getAttribute("href");
				const original = page.locator("#app-article-open");
				assert(await waitFor(async () => await original.getAttribute("href") === openedURL),
					scope + " opened " + await original.getAttribute("href") + " instead of " + openedURL);
			}
			await reportLink.waitFor({ state: scope === "Collection" ? "detached" : "visible" });
			const topics = page.getByRole("tab", { name: "Topics", exact: true });
			if (scope === "Front Pages") assert.equal(await topics.getAttribute("aria-selected"), "true");
			else assert.equal(await topics.count(), 0);
			assert.equal(await page.locator("#app-search-page").isVisible(), false);
		}
		const requests = app.requests.filter(({ url }) => url === catalogURL);
		assert.equal(requests.length, 1);
		assert(requests.every(({ method, anonymous, hasBody }) => method === "GET" && anonymous && hasBody === undefined));
		assert.deepEqual(app.errors, []);
	} finally {
		await app.browser.close();
	}
});

test("universal search can find a local Collection topic with the public index unavailable", async () => {
	const bookmarks = [
		{ title: "Ceramic glazes for beginners", url: "https://pottery.example/clay/a", key: "pottery.example/clay/a", addedAt: now * 1000 },
		{ title: "Firing ceramic glazes without defects", url: "https://studio.example/firing/b", key: "studio.example/firing/b", addedAt: now * 1000 },
	];
	const app = await launchTopics({ status: 503, stored: { "HNewhere:collected": bookmarks } });
	try {
		const { page } = app;
		page.setDefaultTimeout(5000);
		await page.goto("https://backchnnl.app/");
		await page.locator("#app-rail-search").click();
		await page.locator("#app-search-input").fill("ceramic glazes");
		const result = page.getByRole("button", { name: "#Ceramic Glazes Collection · 2 links", exact: true });
		await result.waitFor();
		assert.deepEqual(app.requests.filter(({ url }) => url.includes("pottery.example") || url.includes("studio.example")), []);
		const calls = app.requests.filter(({ url }) => url.startsWith("https://topics.backchnnl.app"));
		assert.deepEqual(calls.map(({ url, method, anonymous, hasBody }) => ({ url, method, anonymous, hasBody })), [
			{ url: catalogURL, method: "GET", anonymous: true, hasBody: undefined },
		]);
		await result.click();
		await page.locator("#app-list-topic-title").getByText("#Ceramic Glazes", { exact: true }).waitFor();
		for (const { title } of bookmarks) {
			await page.locator("#app-list-body").getByRole("link", { name: title, exact: true }).waitFor();
		}
		assert.deepEqual(app.errors, []);
	} finally {
		await app.browser.close();
	}
});

test("the upgraded index refreshes an older cache and keeps its groups when offline", async () => {
	const app = await launchTopics({ status: 503, stored: { [catalogKey]: { fetchedAt: Date.now(), data: catalog } } });
	try {
		const { page } = app;
		page.setDefaultTimeout(5000);
		await page.goto("https://backchnnl.app/");
		const list = page.locator("#app-list-body");
		await list.getByRole("link", { name: guide.title, exact: true }).waitFor();
		await page.getByRole("tab", { name: "Topics", exact: true }).click();
		assert(await waitFor(() => app.requests.some(({ url }) => url === catalogURL)));
		await topic(list, "Extension permissions").waitFor();
		await page.getByRole("tab", { name: "All links", exact: true }).click();
		await list.getByRole("link", { name: guide.title, exact: true }).waitFor();
		assert.deepEqual(app.errors, []);
	} finally {
		await app.browser.close();
	}
});

test("offline Collection regroups stale automatic assignments while preserving reviewed links and discussion counts", async () => {
	const links = [
		["Selene reaches Ceres orbit", "https://orbit.example/31"],
		["Selene enters orbit around Ceres", "https://space.example/32"],
		["Selene enters Ceres orbit for its science survey", "https://mission.example/33"],
		["Oral histories from the library", "https://shelves.example/34"],
		["An interview with the archivist", "https://library.example/35"],
	];
	const story = { id: "story:stale-access", kind: "story", label: "Access to this page has been denied" };
	const coverage = { id: "coverage:stale-host", kind: "coverage", label: "reuters.com" };
	const curated = { id: "story:editorial", kind: "story", label: "Access Denied", curated: true };
	const pages = links.map(([, url], i) => ({
		key: new URL(url).host + new URL(url).pathname, topicIds: i < 3 ? [story.id, coverage.id] : [curated.id],
		reviewed: i >= 2, posts: i === 0 ? [["hn:9840", 12]] : i === 1 ? [["lemmy:9841", 31]] : [],
	}));
	await withBookmarkTopics(links, async (list, app) => {
		const group = list.locator('.app-topic-row[data-shared-topic^="reader-story:"]');
		assert.equal(await group.count(), 1, (await list.locator(".app-topic-name").allTextContents()).join(", "));
		await group.getByText("43 comments across 2 discussions in 2 links", { exact: true }).waitFor();
		await list.locator('[data-shared-topic="story:editorial"]').getByText("#Access Denied", { exact: true }).waitFor();
		await list.getByRole("link", { name: links[2][0], exact: true }).waitFor();
		assert.equal(await list.locator(".app-topic-row").count(), 2);
		assert(app.requests.some(({ url }) => url === catalogURL), "The old cache revision prompts an index refresh");
	}, { stored: {
		[catalogKey]: { revision: 9, fetchedAt: Date.now(), data: { ...catalog, topics: [story, coverage, curated], pages } },
	} });
});

test("recovering the shared index keeps the current topic open and restores focus to its new row", async () => {
	const article = { ...guide, title: "Browser adds hardware passkeys for account sign-in", points: 30, by: "fixture" };
	const other = { ...unrelated, title: "Browser adds hardware passkeys for account sign-in this week", points: 30, by: "fixture" };
	const published = { id: "story:browser-passkeys", label: article.title, kind: "story" };
	const fixture = { ...catalog, topics: [published], pages: [
		{ ...catalog.pages[0], topicIds: [published.id] },
		{ key: "plain.example.org/post/262", topicIds: [published.id] },
	] };
	let catalogCalls = 0;
	const app = await launchApp({
		settings: { sources: { hn: true }, frontPageMode: "sources", sourceRefreshMinutes: 0, updateCheck: false },
		values: { "HNewhere:frontpage_feed:/hn/front/": { timestamp: now * 1000, stories: [article, other] } },
		responses: [
			{ match: (url) => url === catalogURL && ++catalogCalls === 1, status: 503 },
			{ match: (url) => url === catalogURL, json: fixture },
			{ match: (url) => url === "https://news.ycombinator.com/news",
				headers: "content-type: text/html", text: frontPageHTML([article, other]) },
		],
	});
	try {
		const { page } = app;
		page.setDefaultTimeout(5000);
		await page.goto("https://backchnnl.app/");
		await page.getByRole("tab", { name: "Topics", exact: true }).click();
		const list = page.locator("#app-list-body");
		const group = topic(list, published.label);
		assert.match(await group.getAttribute("data-shared-topic"), /^reader-story:/);
		await group.click();
		await list.getByRole("link", { name: article.title, exact: true }).waitFor();
		await page.evaluate(() => {
			const now = Date.now;
			Date.now = () => now() + 61_000;
		});
		await page.locator("#app-list-sync").evaluate((button) => button.onclick());
		await list.getByRole("link", { name: article.title, exact: true }).waitFor();
		await page.getByRole("button", { name: "Back to topics" }).click();
		assert.equal(await group.getAttribute("data-shared-topic"), published.id);
		assert(await waitFor(() => group.evaluate((node) => node.getRootNode().activeElement === node)));
		assert.deepEqual(app.errors, []);
	} finally {
		await app.browser.close();
	}
});

test("mark all as read in a topic marks the current group", async () => {
	const app = await launchTopics({ stored: frontPageWithUnrelated });
	try {
		const { page } = app;
		page.setDefaultTimeout(5000);
		await page.goto("https://backchnnl.app/");
		const list = page.locator("#app-list-body");
		await list.getByRole("link", { name: guide.title }).waitFor();
		await page.getByRole("tab", { name: "Topics", exact: true }).click();
		const group = topic(list, "Extension permissions");
		await group.waitFor();
		await list.getByRole("link", { name: unrelated.title, exact: true }).waitFor();
		assert.equal(await list.getByRole("link", { name: guide.title, exact: true }).count(), 0);
		await group.click();
		await list.getByRole("link", { name: guide.title }).waitFor();
		await page.getByRole("button", { name: "Mark all as read" }).click();
		assert(await waitFor(() => ["hn:9360", "lemmy:9361"].every((id) => Number(app.store.get("HNewhere:seen_comments")?.[id]) > 0)));
		assert.equal(app.store.get("HNewhere:seen_comments")?.["hn:9362"], undefined);
		await loadHiddenLinks(page).waitFor();
		await page.getByRole("button", { name: "Back to topics" }).click();
		await list.getByRole("link", { name: unrelated.title, exact: true }).waitFor();
		assert.deepEqual(app.errors, []);
	} finally {
		await app.browser.close();
	}
});

test("clearing read Queue entries in a topic keeps the other queued links", async () => {
	const queue = [guide, report, unrelated].map((entry) => ({
		...entry, addedAt: now * 1000, readAt: now * 1000,
		key: new URL(entry.url).hostname + new URL(entry.url).pathname + new URL(entry.url).search,
	}));
	const app = await launchTopics({ stored: { "HNewhere:queue": queue } });
	try {
		const { page } = app;
		page.setDefaultTimeout(5000);
		await page.goto("https://backchnnl.app/");
		await rail(page, "queue").click();
		const list = page.locator("#app-list-body");
		await list.getByRole("link", { name: guide.title }).waitFor();
		await page.getByRole("tab", { name: "Topics", exact: true }).click();
		await topic(list, "Extension permissions").click();
		await list.getByRole("link", { name: guide.title, exact: true }).waitFor();
		await list.getByRole("button", { name: "clear read" }).click();
		assert(await waitFor(() => app.store.get("HNewhere:queue")?.length === 1));
		assert.deepEqual(app.store.get("HNewhere:queue").map(({ url }) => url), [unrelated.url]);
		await list.getByRole("link", { name: unrelated.title, exact: true }).waitFor();
	} finally {
		await app.browser.close();
	}
});

test("mark-read stays scoped while a topic list is still visible during navigation", async () => {
	const app = await launchTopics({ stored: frontPageWithUnrelated });
	try {
		const { page } = app;
		page.setDefaultTimeout(5000);
		await page.goto("https://backchnnl.app/");
		const list = page.locator("#app-list-body");
		const link = list.getByRole("link", { name: guide.title });
		await link.waitFor();
		await page.getByRole("tab", { name: "Topics", exact: true }).click();
		await topic(list, "Extension permissions").click();
		await link.waitFor();
		const stillShowingTopic = await page.getByRole("button", { name: "Back to topics" }).evaluate((button) => {
			const shadow = button.getRootNode();
			button.click();
			const stillShowingTopic = shadow.getElementById("app-list-body").hasAttribute("data-topic-rows");
			shadow.getElementById("app-mark-read").click();
			return stillShowingTopic;
		});
		assert.equal(stillShowingTopic, true);
		assert(await waitFor(() => ["hn:9360", "lemmy:9361"].every((id) => Number(app.store.get("HNewhere:seen_comments")?.[id]) > 0)));
		assert.equal(app.store.get("HNewhere:seen_comments")?.["hn:9362"], undefined);
	} finally {
		await app.browser.close();
	}
});

test("an empty source on a phone leaves the other filter chips tappable", async () => {
	const app = await launchTopics({
		viewport: { width: 390, height: 844 },
		hasTouch: true,
		stored: {
			"HNewhere:frontpage_feed:technology/lemmy/community/technology@lemmy.world": {
				timestamp: now * 1000, stories: [],
			},
		},
	});
	try {
		const { page } = app;
		page.setDefaultTimeout(5000);
		await page.goto("https://backchnnl.app/");
		await rail(page, "all").click();
		const filters = page.locator("#app-list-tags");
		await filters.locator('[data-app-view="source:lemmy"]').tap();
		const list = page.locator("#app-list-body");
		await list.locator(".browse-empty").waitFor();
		await filters.locator('[data-app-view="source:hn"]').tap();
		await list.getByRole("link", { name: guide.title }).waitFor();
		assert.equal(await page.getByRole("tab", { name: "Topics", exact: true }).count(), 0);
		await list.getByRole("link", { name: guide.title, exact: true }).tap();
		await page.locator('#app[data-stage="article"]').waitFor();
	} finally {
		await app.browser.close();
	}
});

test("Topics can use the same public index when the custom domain is unreachable", async () => {
	const fallbackURL = "https://backchannel-topics.triglavis-llc.workers.dev/api/topics";
	const app = await launchTopics({
		responses: [
			{ match: (url) => url === catalogURL, status: 0 },
			{ match: (url) => url === fallbackURL, json: catalog },
		],
	});
	try {
		const { page } = app;
		page.setDefaultTimeout(5000);
		await page.goto("https://backchnnl.app/");
		await page.getByRole("tab", { name: "Topics", exact: true }).click();
		await topic(page.locator("#app-list-body"), "Extension permissions").waitFor();
		const requests = app.requests.filter(({ url }) => [catalogURL, fallbackURL].includes(url));
		assert.deepEqual(requests.map(({ url }) => url), [catalogURL, fallbackURL]);
		assert(requests.every(({ method, anonymous, hasBody }) => method === "GET" && anonymous === true && hasBody === undefined));
	} finally {
		await app.browser.close();
	}
});

test("Collection finds subjects in unindexed bookmark titles and URL paths without sending the bookmarks", async () => {
	const bookmarks = [
		{ url: "https://guides.example/saving-pages", title: "Preserving Offline Web Archives" },
		{ url: "https://tools.example/offline-web-archives.html", title: "Saved page" },
		{ url: "https://news.example/study", title: "Clinical trials for a new treatment" },
		{ url: "https://bookmarks.example/719", title: "Lucky find" },
	];
	const app = await launchTopics({
		status: 503,
		stored: {
			"HNewhere:collected": bookmarks.map(({ url, title }) => ({
				key: new URL(url).host + new URL(url).pathname, url, title, addedAt: now * 1000,
			})),
		},
	});
	try {
		const { page } = app;
		page.setDefaultTimeout(5000);
		await page.goto("https://backchnnl.app/");
		await rail(page, "collection").click();
		const list = page.locator("#app-list-body");
		await list.getByRole("link", { name: bookmarks[0].title }).waitFor();
		await page.getByRole("tab", { name: "Topics", exact: true }).click();
		const archives = topic(list, "Offline Web Archives");
		await archives.getByText(/in 2 links$/).waitFor();
		await expectTopicPhoto(archives, /library shelves/i);
		for (const { title } of bookmarks.slice(2)) {
			await list.getByRole("link", { name: title, exact: true }).waitFor();
		}
		await archives.click();
		await list.getByRole("link", { name: bookmarks[0].title }).waitFor();
		assert.deepEqual(new Set(await list.locator(".reader-collection-row .browse-title-link").allTextContents()), new Set([
			bookmarks[0].title, bookmarks[1].title,
		]));
		const calls = app.requests.filter(({ url }) => url.startsWith("https://topics.backchnnl.app"));
		assert.deepEqual(calls.map(({ url, method, anonymous, hasBody }) => ({ url, method, anonymous, hasBody })), [
			{ url: catalogURL, method: "GET", anonymous: true, hasBody: undefined },
		]);
		assert.deepEqual(app.errors, []);
	} finally {
		await app.browser.close();
	}
});

test("Collection matches a saved headline to the exact public topic before aliases", async () => {
	const additional = { url: "https://library.example/browser-privacy-guide", title: "A practical Browser Privacy guide" };
	const alias = { id: "topic:archive", label: "Archive management", kind: "topic", aliases: ["Browser privacy"] };
	const fixture = { ...catalog, topics: [...catalog.topics, alias], pages: [
		catalog.pages[0], { ...catalog.pages[1], topicIds: [...catalog.pages[1].topicIds, alias.id] },
	] };
	const app = await launchTopics({
		stored: {
			"HNewhere:collected": [imported, additional].map(({ url, title }) => ({
				key: new URL(url).host + new URL(url).pathname + new URL(url).search, url, title, addedAt: now * 1000,
			})),
		},
		responses: [{ match: (url) => url === catalogURL, json: fixture }],
	});
	try {
		const { page } = app;
		page.setDefaultTimeout(5000);
		await page.goto("https://backchnnl.app/");
		await rail(page, "collection").click();
		const list = page.locator("#app-list-body");
		await list.getByRole("link", { name: additional.title }).waitFor();
		await page.getByRole("tab", { name: "Topics", exact: true }).click();
		const privacy = topic(list, "Browser privacy");
		await privacy.getByText(/in 2 links$/).waitFor();
		assert.equal(await privacy.count(), 1);
		await privacy.click();
		await list.getByRole("link", { name: additional.title }).waitFor();
		assert.deepEqual(new Set(await list.locator(".reader-collection-row .browse-title-link").allTextContents()), new Set([imported.title, additional.title]));
		assert.deepEqual(app.errors, []);
	} finally {
		await app.browser.close();
	}
});

test("Collection groups different wording with cached page metadata and specific subject cues", async () => {
	const bookmarks = [
		{ url: "https://guides.example/posts/762", title: "The easiest way to sign in" },
		{ url: "https://identity.example/articles/891", title: "Passwordless login from a hardware key" },
		{ url: "https://cities.example/articles/829", title: "Reconnecting neighborhoods" },
		{ url: "https://civic.example/category/urban-planning/404", title: "A closer look at this proposal" },
		{ url: "https://bookmarks.example/719", title: "Lucky find" },
	].map((entry) => ({ ...entry, key: new URL(entry.url).host + new URL(entry.url).pathname, addedAt: now * 1000 }));
	const app = await launchTopics({
		status: 503,
		stored: {
			"HNewhere:collected": bookmarks,
			"HNewhere:looks": {
				[bookmarks[0].key]: { description: "Configure passkeys for a safer account login.", at: now * 1000 },
				[bookmarks[2].key]: { section: "Urban planning", at: now * 1000 },
			},
		},
	});
	try {
		const { page } = app;
		await page.goto("https://backchnnl.app/");
		await rail(page, "collection").click();
		const list = page.locator("#app-list-body");
		await list.getByRole("link", { name: bookmarks[0].title }).waitFor();
		await page.getByRole("tab", { name: "Topics", exact: true }).click();
		const authentication = topic(list, "Authentication");
		await authentication.getByText(/in 2 links$/).waitFor({ timeout: 5000 });
		await topic(list, /Urban planning/i).getByText(/in 2 links$/).waitFor();
		await list.getByRole("link", { name: bookmarks.at(-1).title, exact: true }).waitFor();
		await authentication.click();
		await list.getByRole("link", { name: bookmarks[1].title }).waitFor();
		assert.deepEqual(new Set(await list.locator(".reader-collection-row .browse-title-link").allTextContents()), new Set(bookmarks.slice(0, 2).map(({ title }) => title)));
		const requests = app.requests.filter(({ url }) => url === catalogURL);
		assert(requests.every(({ anonymous, method, hasBody }) => anonymous && method === "GET" && hasBody === undefined));
		assert.deepEqual(app.errors, []);
	} finally {
		await app.browser.close();
	}
});

test("unrelated links outside the public index retain specific titles across views", async () => {
	const app = await launchTopics({ status: 503, stored: { "HNewhere:app_browse_topics": true } });
	try {
		const { page } = app;
		await page.goto("https://backchnnl.app/");
		await rail(page, "all").click();
		const list = page.locator("#app-list-body");
		const guideLink = list.getByRole("link", { name: guide.title, exact: true });
		const reportLink = list.getByRole("link", { name: report.title, exact: true });
		await guideLink.waitFor();
		await reportLink.waitFor();
		assert.equal(await list.locator(".app-topic-row").count(), 0);
		await rail(page, "source:hn").click();
		await reportLink.waitFor({ state: "hidden" });
		await guideLink.waitFor();
		await rail(page, "queue").click();
		await guideLink.waitFor();
		assert.equal(await list.locator(".app-topic-row").count(), 0);
		assert.deepEqual(app.errors, []);
	} finally {
		await app.browser.close();
	}
});

test("Unread groups closely matching headlines from different publishers without the shared index", async () => {
	const first = { ...guide, title: "Northern observatory captures first images of distant ringed planet" };
	const second = { ...report, title: first.title + " tonight" };
	const other = { ...guide, id: 9380, url: "https://other.example/76", title: "Northern observatory closes to visitors for winter repairs" };
	const feed = (stories) => ({ timestamp: now * 1000, stories: stories.map((story) => ({ ...story, topic: "technology" })) });
	const app = await launchTopics({
		status: 503,
		stored: {
			"HNewhere:frontpage_feed:technology/hn/front/": feed([first, other]),
			"HNewhere:frontpage_feed:technology/lemmy/community/technology@lemmy.world": feed([second]),
		},
	});
	try {
		const { page } = app;
		await page.goto("https://backchnnl.app/");
		await page.getByRole("tab", { name: "Topics", exact: true }).click();
		const list = page.locator("#app-list-body");
		const coverage = topic(list, first.title);
		await coverage.getByText(/in 2 links$/).waitFor({ timeout: 5000 });
		await coverage.click();
		await list.getByRole("link", { name: second.title, exact: true }).waitFor();
		assert.deepEqual(new Set(await list.locator(".browse-title-link").allTextContents()), new Set([first.title, second.title]));
		await page.getByRole("button", { name: "Back to topics" }).click();
		await list.getByRole("link", { name: other.title, exact: true }).waitFor();
		assert.deepEqual(app.errors, []);
	} finally {
		await app.browser.close();
	}
});

test("Topics put separate developments under specific headlines with or without a legacy subject bucket", async () => {
	const rows = [
		["Iran war escalates after renewed air strikes", 50],
		["Airstrikes intensify as Iran war enters a new phase", 26],
		["Iran blocks the Strait of Hormuz to commercial shipping", 20],
		["Strait of Hormuz blockade halts commercial shipping", 17],
		["Iran posts national football fixtures for spring", 2],
		["Reports: Hackers breach FBI National Crime Information Center database", 67],
		["FBI National Crime Information Center database compromised in reported breach", 48],
	].map(([title, descendants], index) => ({
		...guide, title, descendants, id: 9800 + index, url: "https://publisher" + index + ".example.org/coverage", topic: "technology",
	}));
	const subject = { id: "topic:iran", kind: "topic", label: "Iran" };
	const seeded = {
		"HNewhere:app_browse_topics": true,
		"HNewhere:frontpage_feed:technology/hn/front/": { timestamp: now * 1000, stories: rows },
		"HNewhere:frontpage_feed:technology/lemmy/community/technology@lemmy.world": { timestamp: now * 1000, stories: [] },
	};
	for (const published of [false, true]) {
		const fixture = { ...catalog, topics: published ? [subject] : [], pages: published ? rows.slice(0, 5)
			.map(({ url }) => ({ key: new URL(url).host + new URL(url).pathname, topicIds: [subject.id] })) : [] };
		const app = await launchTopics({ stored: seeded, responses: [{ match: (url) => url === catalogURL, json: fixture }] });
		try {
			const { page } = app;
			await page.goto("https://backchnnl.app/");
			const list = page.locator("#app-list-body");
			const expected = [[0, 1, 76], [3, 2, 37], [5, 6, 115]];
			for (const [lead, other, count] of expected) {
				const card = topic(list, "#" + rows[lead].title);
				await card.getByText(count + " comments across 2 discussions in 2 links", { exact: true }).waitFor({ timeout: 5000 });
				assert.equal(await list.locator(".app-topic-row").count(), 3);
				await card.click();
				await page.locator("#app-list-topic-title").getByText("#" + rows[lead].title, { exact: true }).waitFor();
				assert.deepEqual(new Set(await list.locator(".browse-title-link").allTextContents()), new Set([rows[lead].title, rows[other].title]));
				await page.getByRole("button", { name: "Back to topics" }).click();
			}
			await list.getByRole("link", { name: rows[4].title, exact: true }).waitFor();
			assert.equal(await list.getByText("#Iran", { exact: true }).count(), 0);
			assert.deepEqual(app.errors, []);
		} finally {
			await app.browser.close();
		}
	}
});

test("a local story headline retains reported uncertainty when another member states the event as fact", async () => {
	const certain = { ...guide, title: "Northbridge national crime database hacked", topic: "technology" };
	const qualified = { ...report, title: "Northbridge national crime database reportedly hacked", topic: "technology" };
	const app = await launchTopics({ status: 503, stored: {
		"HNewhere:app_browse_topics": true,
		"HNewhere:frontpage_feed:technology/hn/front/": { timestamp: now * 1000, stories: [certain] },
		"HNewhere:frontpage_feed:technology/lemmy/community/technology@lemmy.world": { timestamp: now * 1000, stories: [qualified] },
	} });
	try {
		await app.page.goto("https://backchnnl.app/");
		const list = app.page.locator("#app-list-body");
		await list.locator(".app-topic-name").first().waitFor({ timeout: 5000 });
		assert.deepEqual(await list.locator(".app-topic-name").allTextContents(), ["#" + qualified.title]);
		assert.deepEqual(app.errors, []);
	} finally {
		await app.browser.close();
	}
});

test("Topics gives a shared change of status one headline across differently worded reports", async () => {
	const titles = [
		"The U.S. has officially lost its measles elimination status",
		"US loses measles elimination status: what it means for the world",
		"The United States lost its measles elimination status",
		"Measles is no longer considered eliminated in the US and Mexico",
		"Canada has lost its measles elimination status",
		"The US could lose its measles elimination status",
		"The US regains its measles elimination status",
		"The US loses its rubella elimination status",
		"The U.S. hasn't lost its measles elimination status",
		"Has the U.S. lost its measles elimination status?",
	];
	const rows = titles.map((title, i) => ({
		...guide, title, id: 9950 + i, url: "https://publisher" + i + ".example/story", topic: "technology", descendants: i + 1,
	}));
	const app = await launchTopics({ status: 503, stored: {
		"HNewhere:app_browse_topics": true,
		"HNewhere:frontpage_feed:technology/hn/front/": { timestamp: now * 1000, stories: rows },
		"HNewhere:frontpage_feed:technology/lemmy/community/technology@lemmy.world": { timestamp: now * 1000, stories: [] },
	} });
	try {
		await app.page.goto("https://backchnnl.app/");
		const list = app.page.locator("#app-list-body");
		await list.locator(".app-topic-row, .browse-title-link").first().waitFor();
		const headings = await list.locator(".app-topic-name").allTextContents();
		assert.equal(headings.length, 1, headings.join(", "));
		assert(titles.slice(0, 3).some((title) => "#" + title === headings[0]), headings[0]);
		await list.getByText("10 comments across 4 discussions in 4 links", { exact: true }).waitFor();
		assert.deepEqual(new Set(await list.locator(".browse-title-link").allTextContents()), new Set(titles.slice(4)));
		await list.locator(".app-topic-row").click();
		await list.getByRole("link", { name: titles[3], exact: true }).waitFor();
		assert.deepEqual(new Set(await list.locator(".browse-title-link").allTextContents()), new Set(titles.slice(0, 4)));
		assert.deepEqual(app.errors, []);
	} finally {
		await app.browser.close();
	}
});

test("Unread keeps standalone links in their original rows with an empty shared index", async () => {
	const stories = [
		{ ...guide, title: "Language models can revise their own weights" },
		{ ...guide, id: 9370, url: "https://example.com/p/12", title: "The generational garbage collector" },
		{ ...guide, id: 9371, url: "https://example.org/p/59", title: "Has anyone seen this?" },
		{ ...guide, id: 9374, url: "https://example.net/p/86", title: "Show HN: A faster way to turn audio into MIDI" },
		{ ...guide, id: 9375, url: "https://example.net/p/92", title: "Show HN: Deterministic search for OpenStreetMap data" },
	];
	const football = { ...report, source: "reddit", id: "topic931", title: "Starter released after roster change", site: "r/fantasyfootball" };
	const app = await launchApp({
		sharedStore: true,
		settings: { sources: { hn: true, reddit: true }, frontPageMode: "sources", sourceRefreshMinutes: 0, updateCheck: false },
		values: {
			"HNewhere:app_browse_topics": true,
			"HNewhere:frontpage_feed:/hn/front/": { timestamp: now * 1000, stories },
			"HNewhere:frontpage_feed:/reddit/front/": { timestamp: now * 1000, stories: [football] },
		},
		responses: [{ match: (url) => url === catalogURL, status: 503 }],
	});
	try {
		const { page } = app;
		page.setDefaultTimeout(5000);
		await page.goto("https://backchnnl.app/");
		const list = page.locator("#app-list-body");
		await list.getByRole("link", { name: football.title }).waitFor();
		assert(await waitFor(async () => {
			const linkThumb = await list.locator(".browse-thumb-wrap").first().boundingBox();
			return linkThumb?.width === 30 && linkThumb.height === 30;
		}));
		for (const { title } of stories) {
			await list.locator(".browse-row").getByRole("link", { name: title, exact: true }).waitFor();
		}
		assert.equal(await list.locator(".app-topic-row").count(), 0);
		assert.deepEqual(app.errors, []);
	} finally {
		await app.browser.close();
	}
});

test("feed tags, communities, and preview descriptions reach the topic classifier", async () => {
	const releases = [{ short_id: "fg931", url: "https://example.com/p/23", title: "Version 0.6.0", tags: ["compilers"], created_at: new Date().toISOString(), score: 10 }];
	const posts = [{ post: { id: 9373, url: "https://example.org/p/34", name: "A visitor this morning", published: new Date().toISOString() }, community: { name: "birding" }, counts: { score: 15 } }];
	const links = [{ url: "https://example.net/p/46", title: "A glimpse of the future", description: "Marine researchers studied reef bleaching near the coast.", history: [{ accounts: "5", day: String(now), uses: "12" }] }];
	const app = await launchApp({
		sharedStore: true,
		settings: { sources: { hn: false, lobsters: true, lemmy: true, mastodon: true }, frontPageMode: "sources", updateCheck: false },
		values: { "HNewhere:app_browse_topics": true },
		responses: [
			{ match: (url) => url === catalogURL, status: 503 },
			{ match: (url) => url === "https://lobste.rs/hottest.json", json: releases },
			{ match: (url) => url.startsWith("https://lemmy.world/api/v3/post/list"), json: { posts } },
			{ match: (url) => url.startsWith("https://mastodon.social/api/v1/trends/links"), json: links },
		],
	});
	try {
		const { page } = app;
		page.setDefaultTimeout(5000);
		await page.goto("https://backchnnl.app/");
		const list = page.locator("#app-list-body");
		for (const title of [releases[0].title, posts[0].post.name, links[0].title]) {
			await list.getByRole("link", { name: title, exact: true }).waitFor();
		}
		const mastodonLink = list.locator(".browse-row").filter({ hasText: links[0].title });
		assert.equal(await mastodonLink.getByText(/12\+? comments/).count(), 0);
		assert.equal(await list.locator(".app-topic-row").count(), 0);
		const settings = await openTopicFilters(page);
		const search = settings.getByRole("searchbox", { name: "Search topics" });
		for (const label of ["Programming", "Animals", "Environment"]) {
			await search.fill(label);
			await settings.getByRole("button", { name: "Hide " + label, exact: true }).waitFor();
		}
		assert.deepEqual(app.errors, []);
	} finally {
		await app.browser.close();
	}
});

test("Collection groups corroborated subjects and keeps unrelated repeated words as separate links", async () => {
	const bookmarks = [
		{ title: "Repairing magnetic latches after a humid summer", url: "https://home.example/entry/271" },
		{ title: "The latch inside my cabinet stopped holding the magnetic plate", url: "https://repairs.example/entry/328" },
		{ title: "The magnetic personality effect", url: "https://thoughts.example/entry/371" },
		{ title: "Project README", url: "https://github.com/acme/magpie" },
		{ title: "Tracking issue", url: "https://github.com/acme/magpie/issues/27" },
		{ title: "Auditors ask suppliers to disclose costs from government travel", url: "https://audit.example/audits/401" },
		{ title: "Hospitals must disclose infection numbers in government filings", url: "https://health.example/filings/423" },
	].map((entry) => ({ ...entry, key: new URL(entry.url).host + new URL(entry.url).pathname, addedAt: now * 1000 }));
	const app = await launchTopics({ status: 503, stored: {
		"HNewhere:collected": bookmarks,
		"HNewhere:looks": { [bookmarks[1].key]: { description: "Reattaching magnetic latches to cabinet doors.", at: now * 1000 } },
	} });
	try {
		const { page } = app;
		await page.goto("https://backchnnl.app/");
		await rail(page, "collection").click();
		const list = page.locator("#app-list-body");
		await list.getByRole("link", { name: bookmarks[0].title }).waitFor();
		await page.getByRole("tab", { name: "Topics", exact: true }).click();
		const latches = topic(list, /Latch/);
		await latches.getByText(/in 2 links$/).waitFor({ timeout: 5000 });
		await topic(list, "acme/magpie").getByText(/in 2 links$/).waitFor();
		await list.getByRole("link", { name: bookmarks[2].title, exact: true }).waitFor();
		assert.equal(await topic(list, "Disclose · Government").count(), 0);
		for (const { title } of bookmarks.slice(5)) await list.getByRole("link", { name: title, exact: true }).waitFor();
		await latches.click();
		await list.getByRole("link", { name: bookmarks[1].title }).waitFor();
		assert.deepEqual(new Set(await list.locator(".reader-collection-row .browse-title-link").allTextContents()), new Set(bookmarks.slice(0, 2).map(({ title }) => title)));
		assert.deepEqual(app.errors, []);
	} finally {
		await app.browser.close();
	}
});

async function withBookmarkTopics(links, check, { responses = [], prepare, stored = {} } = {}) {
	const bookmarks = links.map(([title, url]) => ({
		title, url, key: new URL(url).host + new URL(url).pathname, addedAt: now * 1000, previewOnOpen: true,
	}));
	const app = await launchTopics({ responses: [{ match: (url) => url === catalogURL, status: 503 }, ...responses], stored: {
		"HNewhere:collected": bookmarks, "HNewhere:app_browse_topics": true, ...stored,
	} });
	try {
		await prepare?.(app);
		const { page } = app;
		page.setDefaultTimeout(5000);
		await page.goto("https://backchnnl.app/");
		await rail(page, "collection").click();
		const list = page.locator("#app-list-body");
		await list.locator(".reader-collection-row, .app-topic-row").first().waitFor();
		await check(list, app);
		assert.deepEqual(app.errors, []);
	} finally {
		await app.browser.close();
	}
}

test("Collection names a shared development from the member headlines and excludes the earlier milestone", async () => {
	const links = [
		["Spacecraft reaches Mercury on second-ever mission to enter its orbit", "https://www.theguardian.com/science/2026/nov/20/spacecraft-mercury-second-ever-mission-orbit-bepicolombo"],
		["BepiColombo finally reaches Mercury after eight-year odyssey", "https://www.nature.com/articles/d41586-026-03803-8"],
		["BepiColombo entering orbit around Mercury", "https://www.esa.int/media/about-us/directorates/science/bepicolombo-entering-orbit-around-mercury"],
		["BepiColombo begins Mercury arrival with MTM separation success", "https://www.esa.int/ga/articles/about-us/directorates/operations/bepicolombo-begins-mercury-arrival-with-mtm-separation-success"],
	];
	await withBookmarkTopics(links, async (list, app) => {
		assert.deepEqual(await list.locator(".app-topic-name").allTextContents(), ["#BepiColombo entering orbit around Mercury"]);
		const photo = list.locator(".app-topic-row img[data-loaded]");
		await photo.waitFor();
		assert.equal(await photo.getAttribute("src"), topicPhoto);
		assert.match(await photo.getAttribute("title"), /BepiColombo.*Example author/);
		await list.getByRole("link", { name: links[3][0], exact: true }).waitFor();
		await list.locator(".app-topic-row").click();
		await list.getByRole("link", { name: links[0][0], exact: true }).waitFor();
		assert.deepEqual(new Set(await list.locator(".browse-title-link").allTextContents()), new Set(links.slice(0, 3).map(([title]) => title)));
		const queries = app.requests.filter(({ url }) => new URL(url).hostname === "en.wikipedia.org")
			.flatMap(({ url }) => (new URL(url).searchParams.get("titles") || new URL(url).searchParams.get("gsrsearch")).split("|"));
		assert(queries.includes("BepiColombo"));
		assert(queries.every((query) => /^(?:BepiColombo|Mercury)$/i.test(query)));
		assert.equal(app.requests.some(({ url }) => links.some(([, bookmark]) => decodeURIComponent(url).includes(bookmark))), false);
	}, {
		prepare: ({ context }) => context.route(topicPhoto, (route) => route.fulfill({ contentType: "image/png", body: previewPNG })),
		responses: [
			{ match: (url) => new URL(url).hostname === "en.wikipedia.org", json: { query: { pages: [
				{ ns: 0, title: "BepiColombo", pageimage: "Subject.jpg" },
			] } } },
			{ match: (url) => new URL(url).hostname === "commons.wikimedia.org", json: { query: { pages: [
				{ ns: 6, title: "File:Subject.jpg", imagerepository: "local", imageinfo: [{
					thumburl: topicPhoto, descriptionurl: imageCredit, thumbwidth: 240, thumbheight: 180,
					extmetadata: { Artist: { value: "Example author" }, LicenseShortName: { value: "Public domain" } },
				}] },
			] } } },
		],
	});
});

test("Collection keeps different actors, milestones and placeholder titles individual alongside a shared technique", async () => {
	const links = [
		["Vesta reaches Mars after the long voyage", "https://vesta.example/1"],
		["Psyche reaches Mars to study the canyons", "https://psyche.example/2"],
		["Hesper Systems opens its initial public offering", "https://markets.example/3"],
		["Hesper Systems closes its initial public offering", "https://finance.example/4"],
		["Access Denied", "https://denied.example/5"],
		["Access Denied", "https://gated.example/6"],
		["reuters.com", "https://reuters.com/7"],
		["reuters.com", "https://reuters.com/8"],
		["Save What Matters", "https://reader.example/9"],
		["Save What Matters", "https://reader.example/10"],
		["Access to this page has been denied", "https://denied.example/13"],
		["Access to this page has been denied", "https://denied.example/14"],
		["Ananke launches Vela from Florida", "https://launch.example/15"],
		["Ananke launches Corvus from Florida", "https://space.example/16"],
		["Yarrow announces opening of its Toronto exchange", "https://market.example/17"],
		["Yarrow announces closing of its Toronto exchange", "https://ledger.example/18"],
		["Vireo enters Jupiter orbit", "https://archive.example/2014/11/20/vireo-jupiter"],
		["Vireo enters orbit around Jupiter", "https://science.example/2026/nov/20/vireo-enters-orbit"],
		["Firing ceramic glazes without defects", "https://studio.example/11"],
		["Ceramic glazes for beginners", "https://pottery.example/12"],
	];
	await withBookmarkTopics(links, async (list) => {
		assert.deepEqual(await list.locator(".app-topic-name").allTextContents(), ["#Ceramic Glazes"]);
		assert.deepEqual((await list.locator(".browse-title-link").evaluateAll((items) => items.map((item) => item.href))).sort(),
			links.slice(0, -2).map(([, url]) => url).sort());
	});
});

test("Collection preserves a descriptive title that begins with an access error phrase", async () => {
	const links = [
		["Access Denied: An oral history of censorship", "https://books.example/19"],
		["Writing an oral history of censorship", "https://essays.example/20"],
	];
	await withBookmarkTopics(links, async (list) => {
		assert.deepEqual(await list.locator(".app-topic-name").allTextContents(), ["#Oral History of Censorship"]);
	});
});

test("Collection can group a shared technique that contains an ordinary action word", async () => {
	const links = [
		["Adapting open source licenses for teaching", "https://lessons.example/21"],
		["Comparing open source licenses across libraries", "https://legal.example/22"],
	];
	await withBookmarkTopics(links, async (list) => {
		assert.deepEqual(await list.locator(".app-topic-name").allTextContents(), ["#Open Source Licenses"]);
	});
});

test("attribution and auxiliary phrases do not make Topics from unrelated saved links", async () => {
	const links = [
		["Wildflowers flourish on fallow farmland, study finds", "https://botany.example/81"],
		["Short naps boost recall, study finds", "https://sleep.example/82"],
		["The turbine has been rebuilt after flooding", "https://engineering.example/83"],
		["An heirloom has been returned to its owner", "https://museum.example/84"],
		["Coastal wetlands are shrinking, according to researchers", "https://coast.example/85"],
		["Heat pumps outlast oil boilers, according to researchers", "https://energy.example/86"],
		["A painter lost her favorite brush at a fair", "https://studio.example/87"],
		["A dog lost her favorite ball on the beach", "https://pets.example/88"],
	];
	await withBookmarkTopics(links, async (list, app) => {
		assert.deepEqual(await list.locator(".app-topic-name").allTextContents(), []);
		assert.deepEqual(new Set(await list.locator(".browse-title-link").allTextContents()), new Set(links.map(([title]) => title)));
		assert.equal(await app.page.getByRole("tab", { name: "Topics", exact: true }).isVisible(), false);
	}, { stored: { [catalogKey]: { fetchedAt: Date.now(), data: {
		...catalog, topics: [{ id: "topic:boilerplate", kind: "topic", label: "Study Finds" }],
		pages: links.slice(0, 2).map(([, url]) => ({ key: new URL(url).host + new URL(url).pathname, topicIds: ["topic:boilerplate"] })),
	} } } });
});

test("private bookmarks group the same accreditation change and keep other decisions separate", async () => {
	const links = [
		["Northbridge Academy has lost its engineering accreditation", "https://college.example/31"],
		["Northbridge Academy loses engineering accreditation", "https://education.example/32"],
		["Westhaven Academy loses engineering accreditation", "https://press.example/33"],
		["Northbridge Academy retains engineering accreditation", "https://archive.example/34"],
	];
	await withBookmarkTopics(links, async (list) => {
		const headings = await list.locator(".app-topic-name").allTextContents();
		assert.equal(headings.length, 1, headings.join(", "));
		assert(links.slice(0, 2).some(([title]) => "#" + title === headings[0]), headings[0]);
		assert.deepEqual(new Set(await list.locator(".browse-title-link").allTextContents()), new Set(links.slice(2).map(([title]) => title)));
		await list.locator(".app-topic-row").click();
		await list.getByRole("link", { name: links[0][0], exact: true }).waitFor();
		assert.deepEqual(new Set(await list.locator(".browse-title-link").allTextContents()), new Set(links.slice(0, 2).map(([title]) => title)));
	});
});

test("a published status change and newly imported coverage open as one topic with its existing ID", async () => {
	const links = [
		["US loses its measles elimination status", "https://science.example/41"],
		["The United States lost measles elimination status", "https://medicine.example/42"],
		["The U.S. has officially lost control of measles", "https://press.example/43"],
		["Measles is no longer considered eliminated in the US and Mexico", "https://news.example/44"],
		["The US has lost its measles-free status", "https://reviewed.example/45"],
	];
	const story = { id: "story:public-announcement", kind: "story", label: links[0][0] };
	const pages = links.map(([, url], i) => ({ key: new URL(url).host + new URL(url).pathname,
		topicIds: i < 2 ? [story.id] : [], reviewed: i === 4 }));
	await withBookmarkTopics(links, async (list) => {
		assert.deepEqual(await list.locator(".app-topic-name").allTextContents(), ["#" + story.label]);
		const card = list.locator('[data-shared-topic="story:public-announcement"]');
		await card.getByText(/in 4 links$/).waitFor();
		await list.getByRole("link", { name: links[4][0], exact: true }).waitFor();
		await card.click();
		await list.getByRole("link", { name: links[3][0], exact: true }).waitFor();
		assert.deepEqual(new Set(await list.locator(".browse-title-link").allTextContents()), new Set(links.slice(0, 4).map(([title]) => title)));
	}, { stored: { [catalogKey]: { fetchedAt: Date.now(), data: { ...catalog, topics: [story], pages } } } });
});

test("a status headline covers early reporting and keeps its explanatory follow-up on the original link", async () => {
	const links = [
		["US loses measles elimination status: what it means for the world", "https://science.example/2026/11/17/report"],
		["The U.S. has lost measles elimination status. Here's what that means and who is most at risk.", "https://news.example/2026/11/17/bulletin"],
		["The U.S. just lost its measles elimination status. What now?", "https://health.example/2026/11/17/coverage"],
		["US has lost measles elimination status, global health authorities say", "https://radio.example/2026/11/14/report"],
		["The U.S. lost its measles elimination status in 1991", "https://archive.example/2026/11/15/retrospective"],
	];
	await withBookmarkTopics(links, async (list) => {
		const headings = await list.locator(".app-topic-name").allTextContents();
		assert.equal(headings.length, 1, headings.join(", "));
		assert.match(headings[0], /^#(?:The U\.S\. (?:has |just )?lost|US loses) (?:its )?measles elimination status$/);
		await list.getByText(/in 4 links$/).waitFor();
		await list.getByRole("link", { name: links[4][0], exact: true }).waitFor();
		await list.locator(".app-topic-row").click();
		await list.getByRole("link", { name: links[3][0], exact: true }).waitFor();
		assert.deepEqual(new Set(await list.locator(".browse-title-link").allTextContents()), new Set(links.slice(0, 4).map(([title]) => title)));
	});
});

test("Collection uses meaningful saved discussions and disregards access-page descriptions", async () => {
	const links = [
		["Access Denied", "https://bulletin.example/23"], ["Access Denied", "https://chronicle.example/24"],
		["Access Denied", "https://journal.example/25"], ["Access Denied", "https://weekly.example/26"],
	];
	const discussions = ["Selene reaches Ceres orbit", "Selene enters orbit around Ceres"].map((title, i) => ({
		...guide, key: "hn:" + (9900 + i), id: 9900 + i, title, url: links[i][1], addedAt: now * 1000,
	}));
	await withBookmarkTopics(links, async (list) => {
		const headings = await list.locator(".app-topic-name").allTextContents();
		assert.equal(headings.length, 1, headings.join(", "));
		assert.match(headings[0], /^#Selene.*Ceres/);
		const rows = list.locator(".browse-title-link");
		assert.deepEqual((await rows.evaluateAll((nodes) => nodes.map((node) => node.href))).sort(), links.slice(2).map(([, url]) => url).sort());
		await list.locator(".app-topic-row").click();
		await list.getByRole("link", { name: discussions[0].title, exact: true }).waitFor();
		assert.deepEqual(new Set(await rows.allTextContents()), new Set(discussions.map(({ title }) => title)));
	}, { stored: {
		"HNewhere:favorites": [...discussions, { ...discussions[0], key: "hn:9902", id: 9902, title: "An apparent coincidence" }],
		"HNewhere:looks": Object.fromEntries(links.slice(2).map(([, url]) => [
			new URL(url).host + new URL(url).pathname, { description: "Save What Matters", at: now * 1000 },
		])),
	} });
});
