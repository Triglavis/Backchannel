import assert from "node:assert/strict";
import test from "node:test";
import { launchApp, waitFor } from "./harness.mjs";

const base = "https://backchnnl.app/";
const api = "https://topics.backchnnl.app/api/topics";
const now = Math.floor(Date.now() / 1000);
const topics = [
	{ id: "story:harbor-bridge", kind: "story", label: "Harbor bridge reopens after overnight inspections", curated: true },
	{ id: "story:observatory", kind: "story", label: "Observatory opens a new telescope dome", curated: true },
];
const reports = [
	["Inspectors clear the harbor bridge for traffic", "harbor.example/bridge", 0],
	["City lifts the bridge closure on Monday", "metro.example/traffic", 0],
	["The new telescope dome opens at Hill Observatory", "space.example/telescope", 1],
	["Astronomers open a telescope dome to students", "campus.example/dome", 1],
].map(([title, path, topic], i) => ({
	source: "hn", id: 89101 + i, title, url: "https://" + path, topic, time: now - i - 1, descendants: i + 3,
}));
const extra = {
	id: "p3", title: "Shipping resumes past the bridge", url: "https://port.example/shipping",
	publisher: "port.example", excerpt: "The port reopened the shipping lane on Monday.",
	publishedAt: null, sharedAt: null, discussions: [],
};
const summaries = ["Traffic resumed after the engineers inspected the bridge.", "Students observed the first light from the new dome."];
const articleURL = (topic) => api + "/article?id=" + encodeURIComponent(topic.id);
const card = (page, index) => page.locator('[data-shared-topic="' + topics[index].id + '"]');
const articlePane = (page) => page.locator("#app-article-body .app-topic-article");
const traffic = (app) => app.requests.filter(({ url }) => url.startsWith(api + "/article"));
const button = (page, name) => page.getByRole("button", { name, exact: true });
const member = (page, i) => page.locator("#app-list-body").getByRole("link", { name: reports[i].title, exact: true });

function responseFor(i, more = []) {
	const sources = reports.filter((story) => story.topic === i).map((story, j) => ({
		id: "s" + (j + 1), title: story.title, url: story.url, publisher: new URL(story.url).hostname,
		excerpt: story.title + ".", publishedAt: null, sharedAt: new Date(story.time * 1000).toISOString(), discussions: [],
	}));
	return {
		version: 1, topic: topics[i], generatedAt: new Date().toISOString(), method: "synthesis",
		sources: [...sources, ...more],
		sections: [{ heading: "What happened", paragraphs: [{ text: summaries[i], sourceIds: sources.map(({ id }) => id) }] }],
		timeline: [{ date: sources[0].sharedAt, kind: "shared", text: sources[0].title, sourceIds: [sources[0].id] }],
	};
}

async function openReader({ phone, hidden, more = [], responses = [], local = reports, redirects, sourceEnabled = true, seen = {} } = {}) {
	const pages = reports.map(({ url, topic }) => ({ key: url.slice(8), topicIds: [topics[topic].id] }));
	for (const { url } of more) pages.push({ key: url.slice(8), topicIds: [topics[0].id] });
	const fixture = { version: 1, generatedAt: new Date().toISOString(), topics, pages, redirects };
	const app = await launchApp({
		...(phone && { viewport: { width: 320, height: 720 }, hasTouch: true }),
		settings: {
			sources: { hn: sourceEnabled }, updateCheck: false, sourceRefreshMinutes: 0,
			frontPageMode: "topics", frontPageTopics: ["technology"],
		},
		values: {
			"HNewhere:app_browse_topics": true,
			"HNewhere:seen_comments": seen,
			"HNewhere:app_panes": { list: true, discussion: true },
			"HNewhere:frontpage_feed:technology/hn/front/": {
				timestamp: now * 1000, stories: local.map((story) => ({ ...story, topic: "technology" })),
			},
			...(hidden && { "HNewhere:hidden_stories": [{ key: hidden.url.slice(8), url: hidden.url, title: hidden.title }] }),
		},
		responses: [
			{ match: (url) => url === api, json: fixture }, ...responses,
			...topics.map((topic, i) => ({ match: (url) => url === articleURL(topic), json: responseFor(i, i === 0 ? more : []) })),
		],
	});
	app.page.setDefaultTimeout(8000);
	return app;
}

test("opening a topic shows its cited brief and leaves the source links unread", async (t) => {
	const app = await openReader();
	t.after(() => app.browser.close());
	const { page } = app;
	await page.goto(base);
	await card(page, 0).waitFor();
	assert.equal(traffic(app).length, 0);
	await card(page, 0).click();
	const article = articlePane(page);
	await article.getByText(summaries[0], { exact: false }).first().waitFor();
	await article.getByRole("heading", { name: topics[0].label, exact: true }).waitFor();
	assert.equal(new URL(page.url()).searchParams.get("topic"), topics[0].id);
	assert.equal(await page.locator("#app-list-body .app-row.is-unread").count(), 2);
	assert.deepEqual(traffic(app).map(({ url, method, anonymous, data }) => [url, method, anonymous, data]),
		[[articleURL(topics[0]), "GET", true, undefined]]);
	assert.equal(await page.locator("#app-article-actions").isVisible(), false);
	assert.equal(await page.locator("#next-up").isVisible(), false);
	assert(await page.locator("#app-view-toggle").isVisible());
	await member(page, 0).click();
	await article.waitFor({ state: "detached" });
	assert.equal(await page.locator("#app-article-open").getAttribute("href"), reports[0].url);
	assert.equal(new URL(page.url()).searchParams.has("topic"), false);
	await button(page, "Read topic article").click();
	await article.getByText(summaries[0], { exact: false }).first().waitFor();
	await button(page, "Back to topics").click();
	await card(page, 1).waitFor();
	assert.equal(await article.count(), 0);
	assert.deepEqual(app.errors, []);
});

test("a late topic brief cannot replace the next topic or a member article", async (t) => {
	let delivered;
	const completed = new Promise((resolve) => { delivered = resolve; });
	const app = await openReader({ responses: [{
		match: (url) => url === articleURL(topics[0]), delay: 1100,
		get json() { delivered(); return responseFor(0); },
	}] });
	t.after(() => app.browser.close());
	const { page } = app;
	await page.goto(base);
	await card(page, 0).click();
	assert(await waitFor(() => traffic(app).length === 1));
	await button(page, "Back to topics").click();
	await card(page, 1).click();
	await articlePane(page).getByText(summaries[1], { exact: false }).first().waitFor();
	await member(page, 2).click();
	await completed;
	assert(await waitFor(async () => (await page.locator("#app-article-open").getAttribute("href")) === reports[2].url));
	assert.equal(await articlePane(page).count(), 0);
	assert.deepEqual(app.errors, []);
});

test("a direct topic link opens the phone reading stage with a route back to member links", async (t) => {
	const app = await openReader({ phone: true });
	t.after(() => app.browser.close());
	const { page } = app;
	await page.goto(base + "?topic=story:harbor-bridge");
	await articlePane(page).getByText(summaries[0], { exact: false }).first().waitFor();
	await page.locator('#app[data-stage="article"]').waitFor();
	assert(await page.locator("#app-bar-view").isVisible());
	assert.equal(await page.locator("#app-bar-open").isVisible(), false);
	await page.locator("#app-bar-back").tap();
	await member(page, 0).waitFor();
	await button(page, "Read topic article").tap();
	await page.locator('#app[data-stage="article"]').waitFor();
	assert.deepEqual(app.errors, []);
});

test("a shared former topic address opens its current brief without any local membership", async (t) => {
	const old = "story:harbor-before-the-inspection";
	const app = await openReader({ phone: true, local: [], sourceEnabled: false, redirects: { [old]: topics[0].id } });
	t.after(() => app.browser.close());
	const { page } = app;
	await page.goto(base + "?topic=" + encodeURIComponent(old) + "&lang=en");
	const article = articlePane(page);
	await article.getByText(summaries[0], { exact: false }).first().waitFor();
	await page.locator('#app[data-stage="article"]').waitFor();
	await article.getByRole("heading", { name: "Sources", exact: true }).waitFor();
	assert.equal(await article.getByRole("link", { name: reports[0].title, exact: true }).getAttribute("href"), reports[0].url);
	const address = new URL(page.url());
	assert.equal(address.searchParams.get("topic"), topics[0].id);
	assert.equal(address.searchParams.get("lang"), "en");
	await page.locator("#app-bar-back").tap();
	await page.locator("#app-onboarding").waitFor();
	assert.equal(new URL(page.url()).searchParams.has("topic"), false);
	assert.deepEqual(app.errors, []);
});

test("a published article still opens from its URL when all of its local members have been read", async (t) => {
	const members = reports.filter(({ topic }) => topic === 0);
	const seen = Object.fromEntries(members.map((member) => ["hn:" + member.id, now]));
	const app = await openReader({ phone: true, seen });
	t.after(() => app.browser.close());
	const { page } = app;
	await page.goto(base + "?topic=" + encodeURIComponent(topics[0].id));
	await articlePane(page).getByText(summaries[0], { exact: false }).first().waitFor();
	assert.deepEqual(traffic(app).map(({ url }) => url), [articleURL(topics[0])]);
	assert.deepEqual(app.store.get("HNewhere:seen_comments"), seen);
	assert.deepEqual(app.errors, []);
});

test("hidden sources are excluded from the brief, timeline and list of sources", async (t) => {
	const dto = responseFor(0, [extra]);
	dto.sections[0].paragraphs.push({ text: "A previously hidden dispatch reports confidential cargo figures.", sourceIds: [extra.id] });
	dto.timeline.push({ date: new Date().toISOString(), kind: "shared", text: "Hidden shipping dispatch", sourceIds: [extra.id] });
	const app = await openReader({ hidden: extra, more: [extra], responses: [{ match: (url) => url === articleURL(topics[0]), json: dto }] });
	t.after(() => app.browser.close());
	const { page } = app;
	await page.goto(base);
	await card(page, 0).click();
	const article = articlePane(page);
	await article.getByText(summaries[0], { exact: false }).first().waitFor();
	await article.getByRole("heading", { name: "Sources", exact: true }).waitFor();
	assert.equal(await article.getByRole("group", { name: "Topic article views" }).count(), 0);
	assert.doesNotMatch(await article.textContent(), /confidential cargo|shipping dispatch|shipping lane|port\.example|Shipping resumes/i);
	assert.deepEqual(app.errors, []);
});
