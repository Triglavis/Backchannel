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

async function openReader({ phone, phoneWidth = 320, hidden, more = [], responses = [], local = reports, catalogTopics = topics, byTopic = true,
	redirects, sourceEnabled = true, seen = {} } = {}) {
	const pages = reports.map(({ url, topic }) => ({ key: url.slice(8), topicIds: [topics[topic].id] }));
	for (const story of local.filter(({ topic }) => topic >= topics.length)) {
		pages.push({ key: story.url.slice(8), topicIds: [catalogTopics[story.topic].id] });
	}
	for (const { url } of more) pages.push({ key: url.slice(8), topicIds: [topics[0].id] });
	const fixture = { version: 1, generatedAt: new Date().toISOString(), topics: catalogTopics, pages, redirects };
	const app = await launchApp({
		...(phone && { viewport: { width: phoneWidth, height: 720 }, hasTouch: true }),
		settings: {
			sources: { hn: sourceEnabled }, updateCheck: false, sourceRefreshMinutes: 0,
			frontPageMode: "topics", frontPageTopics: ["technology"],
		},
		values: {
			"HNewhere:app_browse_topics": byTopic,
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

async function screenshotPixels(locator) {
	const screenshot = await locator.screenshot({ animations: "disabled", scale: "css" });
	return locator.page().evaluate(async (png) => {
		const image = new Image();
		image.src = "data:image/png;base64," + png;
		await image.decode();
		const canvas = document.createElement("canvas");
		canvas.width = image.naturalWidth;
		canvas.height = image.naturalHeight;
		const context = canvas.getContext("2d");
		context.drawImage(image, 0, 0);
		const { width, height } = canvas;
		return { width, height, pixels: Array.from(context.getImageData(0, 0, width, height).data) };
	}, screenshot.toString("base64"));
}

async function assertPaintedMenuDots(trigger) {
	const { width, height, pixels } = await screenshotPixels(trigger.locator("svg"));
	const columns = Array.from({ length: width }, (_, column) => {
		for (let row = 0; row < height; row++) {
			const offset = (row * width + column) * 4;
			if (Math.abs(pixels[offset] - pixels[0]) >= 24) return true;
		}
		return false;
	});
	assert.equal(columns.filter((ink, column) => ink && !columns[column - 1]).length, 3, "the ellipsis paints three distinct dots");
}

async function assertPaintedDivider(header, viewportWidth, color) {
	const { width, height, pixels } = await screenshotPixels(header);
	assert.equal(width, viewportWidth);
	const rule = pixels.slice((height - 1) * width * 4);
	assert(rule.every((channel, index) => channel === color[index % 4]), "the theme's divider is painted across the full header");
}

for (const width of [320, 390]) test(`a ${width}px phone topic card exposes its own menu and matches the article discussion header`, async (t) => {
	const app = await openReader({ phone: true, phoneWidth: width });
	t.after(() => app.browser.close());
	const { page } = app;
	const verifyPaint = width === 320 && process.env.ENGINE === "webkit";
	await page.emulateMedia({ reducedMotion: "reduce" });
	await page.goto(base);
	const topic = card(page, 0);
	await topic.waitFor();
	const more = topic.locator("..").getByRole("button", { name: "More", exact: true });
	const sizeAndInset = (button) => button.evaluate((element) => {
		const { width, height, right } = element.getBoundingClientRect();
		return [width, height, element.parentElement.getBoundingClientRect().right - right];
	});
	await more.waitFor();
	assert.deepEqual(await sizeAndInset(more), [24, 24, 16]);
	assert.equal(await more.getAttribute("aria-controls"), "app-row-menu");
	if (verifyPaint) await assertPaintedMenuDots(more);
	await more.tap({ timeout: 3000 });
	const menu = page.getByRole("menu", { name: "This topic" });
	await menu.waitFor();
	assert.deepEqual(await menu.getByRole("menuitem").allTextContents(), ["Open", "Open in new tab", "View links", "Select links", "Copy link"]);
	await menu.getByRole("menuitem", { name: "Open", exact: true }).tap();
	await articlePane(page).waitFor();
	await page.locator("#app-bar-discussion").tap();
	const measure = (header) => header.evaluate((element) => {
		const { width, height, x } = element.getBoundingClientRect();
		const { borderBottomWidth } = getComputedStyle(element);
		const title = element.querySelector("h2");
		return { width, height, x, borderBottomWidth,
			titleX: title.getBoundingClientRect().x, fontSize: getComputedStyle(title).fontSize };
	});
	const topicHeader = page.locator(".app-topic-discussion-head");
	await topicHeader.waitFor();
	const sources = topicHeader.getByRole("button", { name: "Discussion sources" });
	const compose = topicHeader.getByRole("button", { name: "Comment and note composer" });
	await compose.waitFor({ timeout: 3000 });
	assert((await compose.boundingBox()).x > (await sources.boundingBox()).x);
	const iconStyle = (button) => button.evaluate((element) => {
		const { backgroundColor, boxShadow, color } = getComputedStyle(element);
		return { backgroundColor, boxShadow, color };
	});
	const topicMetrics = await measure(topicHeader);
	assert.deepEqual([topicMetrics.width, topicMetrics.height, topicMetrics.titleX, topicMetrics.fontSize], [width, 36, 20, "13px"]);
	if (verifyPaint) await assertPaintedDivider(topicHeader, width, [220, 220, 210, 255]);
	const idle = await iconStyle(compose);
	await sources.tap();
	assert.equal(await sources.getAttribute("aria-expanded"), "true");
	const pressed = await iconStyle(sources);
	await sources.tap();
	await compose.tap();
	const composer = page.locator(".app-topic-discussions .composer-text");
	await composer.waitFor();
	assert.equal(await compose.getAttribute("aria-expanded"), "true");
	assert.notDeepEqual(pressed, idle);
	assert.deepEqual(await iconStyle(compose), pressed);
	await compose.tap();
	await composer.waitFor({ state: "hidden" });
	assert.equal(await compose.getAttribute("aria-expanded"), "false");
	await topicHeader.getByRole("heading", { name: "Discussion", exact: true }).tap();
	assert.deepEqual(await iconStyle(compose), idle);
	await page.locator("#app-bar-discussion").tap();
	await page.locator("#app-bar-back").tap();
	await page.getByRole("tab", { name: "By link", exact: true }).tap();
	const link = page.locator("#app-list-body .browse-title-link").first();
	const linkMore = page.locator("#app-list-body .browse-row").first().getByRole("button", { name: "More", exact: true });
	await linkMore.waitFor();
	assert.deepEqual(await sizeAndInset(linkMore), [24, 24, 16]);
	if (verifyPaint) await assertPaintedMenuDots(linkMore);
	await link.tap();
	await page.locator("#app-bar-discussion").tap();
	const articleHeader = page.locator("#panel > header");
	await articleHeader.getByRole("heading", { name: "Discussion", exact: true }).waitFor();
	assert.deepEqual(topicMetrics, await measure(articleHeader));
	if (verifyPaint) await assertPaintedDivider(articleHeader, width, [221, 221, 221, 255]);
	assert.deepEqual(app.errors, []);
});

test("the phone Topic Article Discussion divider follows the selected Style theme", async (t) => {
	const width = 390;
	const app = await openReader({ phone: true, phoneWidth: width });
	t.after(() => app.browser.close());
	const { page } = app;
	await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
	await page.goto(base);
	await card(page, 0).tap();
	await articlePane(page).waitFor();
	await page.locator("#app-bar-discussion").tap();
	const header = page.locator(".app-topic-discussion-head");
	const style = page.locator("#app-bar-view");
	for (const [theme, channels] of [
		["Gray", [97, 97, 100]], ["Night", [44, 44, 44]], ["Sepia", [224, 211, 180]],
		["White", [228, 228, 228]], ["Paper", [220, 220, 210]], ["Auto", [44, 44, 44]],
	]) {
		await style.tap();
		await page.locator("#app-view-menu").getByRole("button", { name: theme, exact: true }).tap();
		await style.tap();
		const color = await header.evaluate((node) => getComputedStyle(node).borderBottomColor);
		assert.equal(color, "rgb(" + channels.join(", ") + ")", theme + " colors the Discussion divider");
		if (theme === "Gray" && process.env.ENGINE === "webkit") {
			await assertPaintedDivider(header, width, [...channels, 255]);
		}
	}
	assert.deepEqual(app.errors, []);
});

test("opening a topic keeps the Reader list in place and only marks that topic read", async (t) => {
	const app = await openReader();
	t.after(() => app.browser.close());
	const { page } = app;
	await page.goto(base);
	await card(page, 0).waitFor();
	const sibling = await card(page, 1).elementHandle();
	assert.equal(traffic(app).length, 0);
	await card(page, 0).click();
	const article = articlePane(page);
	await article.getByText(summaries[0], { exact: false }).first().waitFor();
	await article.getByRole("heading", { name: topics[0].label, exact: true }).waitFor();
	assert.equal(new URL(page.url()).searchParams.get("topic"), topics[0].id);
	assert(await sibling.evaluate((node) => node.isConnected));
	assert.equal(await card(page, 0).getAttribute("aria-current"), "true");
	assert.equal(await card(page, 0).getAttribute("aria-description"), "Read");
	assert.equal(await card(page, 1).getAttribute("aria-description"), "Unread");
	assert.equal(await member(page, 0).count(), 0);
	assert.deepEqual(app.store.get("HNewhere:seen_comments"), {});
	assert.equal(await article.getByRole("link", { name: reports[0].title, exact: true }).getAttribute("href"), reports[0].url);
	assert.deepEqual(traffic(app).map(({ url, method, anonymous, data }) => [url, method, anonymous, data]),
		[[articleURL(topics[0]), "GET", true, undefined]]);
	assert.equal(await page.locator("#app-article-actions").isVisible(), false);
	assert.equal(await page.locator("#next-up").isVisible(), false);
	assert(await page.locator("#app-view-toggle").isVisible());
	await page.keyboard.press("Escape");
	await article.waitFor({ state: "detached" });
	assert.equal(new URL(page.url()).searchParams.has("topic"), false);
	assert(await card(page, 0).evaluate((node) => node.getRootNode().activeElement === node));
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
	await card(page, 1).click();
	await articlePane(page).getByText(summaries[1], { exact: false }).first().waitFor();
	assert.equal(await card(page, 0).count(), 0, "the previously opened topic leaves Unread");
	assert.equal(await card(page, 1).getAttribute("aria-current"), "true");
	await page.getByRole("tab", { name: "By link" }).click();
	await member(page, 2).click();
	await completed;
	assert(await waitFor(async () => (await page.locator("#app-article-open").getAttribute("href")) === reports[2].url));
	assert.equal(await articlePane(page).count(), 0);
	assert.deepEqual(app.errors, []);
});

test("a direct topic link opens the phone reading stage and returns to the focused topic card", async (t) => {
	const app = await openReader({ phone: true });
	t.after(() => app.browser.close());
	const { page } = app;
	await page.goto(base + "?topic=story:harbor-bridge");
	await articlePane(page).getByText(summaries[0], { exact: false }).first().waitFor();
	await page.locator('#app[data-stage="article"]').waitFor();
	assert(await page.locator("#app-bar-view").isVisible());
	assert.equal(await page.locator("#app-bar-open").isVisible(), false);
	await page.locator("#app-bar-back").tap();
	await page.locator('#app[data-stage="list"]:not([data-moving])').waitFor();
	assert.equal(await member(page, 0).count(), 0);
	assert.equal(new URL(page.url()).searchParams.has("topic"), false);
	assert(await waitFor(() => card(page, 0).evaluate((node) => node.getRootNode().activeElement === node)));
	await card(page, 1).tap();
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

test("a shared topic keeps By link selected and returns desktop keyboard focus to that list", async (t) => {
	const app = await openReader({ byTopic: false });
	t.after(() => app.browser.close());
	const { page } = app;
	await page.goto(base + "?topic=" + encodeURIComponent(topics[0].id));
	await articlePane(page).getByRole("heading", { name: topics[0].label, exact: true }).waitFor();
	const tab = page.getByRole("tab", { name: "By link", selected: true });
	await tab.waitFor();
	await member(page, 2).waitFor();
	await page.keyboard.press("Escape");
	await articlePane(page).waitFor({ state: "detached" });
	assert(await tab.evaluate((node) => node.getRootNode().activeElement === node));
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

test("a direct link can reveal previously read local sources while its public brief is unavailable", async (t) => {
	const seen = Object.fromEntries(reports.slice(0, 2).map((member) => ["hn:" + member.id, now]));
	const app = await openReader({ seen, responses: [{ match: (url) => url === articleURL(topics[0]), status: 503 }] });
	t.after(() => app.browser.close());
	await app.page.goto(base + "?topic=" + encodeURIComponent(topics[0].id));
	const sources = articlePane(app.page).locator(".app-topic-sources");
	await sources.getByRole("button", { name: "Load hidden links about this topic" }).click();
	await sources.getByRole("link", { name: reports[0].title, exact: true }).waitFor();
	assert.equal(app.requests.some(({ url }) => url.startsWith(api + "/coverage")), false);
	assert.deepEqual(app.store.get("HNewhere:seen_comments"), seen);
	assert.deepEqual(app.errors, []);
});

for (const phone of [false, true]) {
	test(`a topic preserves its filtered ${phone ? "phone" : "desktop"} list and scroll position`, async (t) => {
		const moreTopics = Array.from({ length: 18 }, (_, i) => ({
			id: "story:project-" + i, label: "Project " + i + " wins a local grant", curated: true, kind: "story",
		}));
		const moreStories = moreTopics.flatMap((topic, i) => [0, 1].map((j) => ({
			...reports[j], topic: i + topics.length, id: 93000 + i * 2 + j, time: now - 10 - i * 2 - j,
			url: "https://publisher" + j + ".example/project-" + i, title: topic.label + " in district " + j,
		})));
		const app = await openReader({ phone, local: [...reports, ...moreStories], catalogTopics: [...topics, ...moreTopics] });
		t.after(() => app.browser.close());
		const { page } = app;
		await page.goto(base);
		const filter = page.locator((phone ? "#app-list-tags" : "#app-rail") + ' [data-app-view="topic:technology"]');
		await filter.click();
		const target = page.locator('[data-shared-topic="' + moreTopics[12].id + '"]');
		await target.scrollIntoViewIfNeeded();
		const offset = () => target.evaluate((node, phone) => phone ? window.scrollY : node.closest("#app-list-body").scrollTop, phone);
		const before = await offset();
		assert(before > 0);
		await target.press("Enter");
		await articlePane(page).getByRole("heading", { name: moreTopics[12].label, exact: true }).waitFor();
		if (phone) {
			await page.locator('#app[data-stage="article"]:not([data-moving])').waitFor();
			await page.locator("#app-bar-back").tap();
			await page.locator('#app[data-stage="list"]:not([data-moving])').waitFor();
		} else {
			assert.equal(await offset(), before);
			await page.keyboard.press("Escape");
		}
		assert.equal(await filter.getAttribute("aria-pressed"), "true");
		assert.equal(await offset(), before);
		assert(await target.evaluate((node) => node.getRootNode().activeElement === node));
		assert.deepEqual(app.errors, []);
	});
}

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
