import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { launchApp, waitFor } from "./harness.mjs";

const catalogURL = "https://topics.backchnnl.app/api/topics";
const testPhoto = fileURLToPath(new URL("../../site/src/shot-reader.webp", import.meta.url));
const topic = { id: "topic:railway-signals", label: "Railway signal upgrades", kind: "topic" };
const articleURL = catalogURL + "/article?id=topic%3Arailway-signals";
const issue = {
	version: 1, topic: { id: topic.id, label: topic.label },
	generatedAt: "2026-11-20T12:00:00Z", method: "synthesis",
	sources: [
		{
			id: "s1", publisher: "Signal Journal", title: 'An upgrade for the "blue line"',
			url: "https://framed.example.com/post/260", excerpt: "Crews tested the interlocking at both ends of the line.",
			publishedAt: "2026-11-18T12:00:00Z", sharedAt: "2026-11-19T12:00:00Z",
			discussions: [{ url: "https://news.ycombinator.com/item?id=9410", title: "What changes for operators?", source: "hn", comments: 3 }],
		},
		{
			id: "s2", publisher: "Transit Desk", title: "The <signal> moved", url: "https://plain.example.org/post",
			excerpt: "The advisory keeps the old timetable until the new signals enter service.",
			publishedAt: null, sharedAt: "2026-11-20T07:00:00Z", discussions: [],
		},
	],
	sections: [{ heading: "Commissioning the line", paragraphs: [
		{ text: "The operators tested the interlocking before changing the schedule.", sourceIds: ["s1", "s2"] },
		{ text: "One of the source headlines contains a literal <signal> tag.", sourceIds: ["s2"] },
	] }],
	timeline: [
		{ date: "2026-11-20T07:00:00Z", kind: "shared", text: "The timetable advisory was shared.", sourceIds: ["s2"] },
		{ date: "2026-11-18T12:00:00Z", kind: "published", text: "Signal Journal published its test report.", sourceIds: ["s1"] },
		{ date: "2026-11-17", kind: "event", text: "Crews completed the evening tests.", sourceIds: ["s2"] },
		{ date: "2026-11-16", kind: "event", text: "Crews began testing the control room.", sourceIds: ["s1"] },
	],
};

function openReader({ catalogPages = [], catalogTopics = [], artwork, theme = "auto", responses = [{ match: (url) => url === articleURL, json: issue }], ...options } = {}) {
	const now = Date.now();
	const index = {
		version: 1, generatedAt: new Date(now).toISOString(), topics: [{ ...topic, image: artwork }, ...catalogTopics],
		pages: [{ key: "framed.example.com/post/260", topicIds: [topic.id] }, { key: "plain.example.org/post", topicIds: [topic.id] }, ...catalogPages],
	};
	const stories = issue.sources.map((source, i) => ({
		url: source.url, title: source.title, id: 9410 + i, source: "hn", time: Math.floor(now / 1000) - 60 * (i + 1),
		descendants: 3, topic: "technology",
	}));
	return launchApp({
		sharedStore: true,
		settings: { theme, updateCheck: false, sourceRefreshMinutes: 0, sources: { hn: true }, frontPageMode: "topics", frontPageTopics: ["technology"] },
		values: { "HNewhere:app_panes": { list: true, discussion: true }, "HNewhere:frontpage_feed:technology/hn/front/": { timestamp: now, stories } },
		responses: [{ match: (url) => url === catalogURL, json: index }, ...responses],
		...options,
	});
}

for (const [theme, system, paper, scheme, background, buttonBackground] of [
	["auto", "light", "night", "dark", "rgb(18, 18, 18)", "rgb(30, 30, 30)"],
	["dark", "light", "sepia", "light", "rgb(244, 236, 216)", "rgb(235, 224, 198)"],
	["light", "dark", "gray", "dark", "rgb(74, 74, 76)", "rgb(60, 60, 62)"],
]) test(`topic Sort and Sources keep app typography with Aa ${paper} and ${theme} app appearance`, async (t) => {
	const { browser, page, errors } = await openReader({ theme, colorScheme: system });
	t.after(() => browser.close());
	const address = "https://backchnnl.app/?topic=" + encodeURIComponent(topic.id);
	await page.goto(address);
	const article = page.locator(".app-topic-article");
	await article.getByRole("heading", { name: issue.sections[0].heading }).waitFor();
	const sort = article.locator(".settings-select-toggle");
	const sources = article.getByRole("button", { name: "Discussion sources" });
	const menu = article.getByRole("group", { name: "Filter discussions by source" });
	const style = (locator, property, pseudo) => locator.evaluate((node, [key, part]) => getComputedStyle(node, part)[key], [property, pseudo]);
	const list = page.locator("#app-list");
	const appColor = await style(list, "backgroundColor");
	const originalSize = parseFloat(await style(sort, "fontSize"));
	const uiFace = await style(page.locator("#app"), "fontFamily");
	await sources.click();
	if (theme === "auto") {
		await page.emulateMedia({ colorScheme: "dark" });
		assert(await waitFor(async () => await style(menu, "backgroundColor") === "rgb(18, 18, 18)"));
		await page.emulateMedia({ colorScheme: "light" });
		assert(await waitFor(async () => await style(menu, "backgroundColor") === "rgb(246, 246, 239)"));
	}
	await page.keyboard.press("Escape");
	assert.equal(page.url(), address, "Escape dismisses the pointer-opened Sources menu");
	assert(await sources.evaluate((node) => node.getRootNode().activeElement === node));
	const appearance = page.getByRole("button", { name: "Style settings", exact: true }).filter({ visible: true });
	await appearance.click();
	await page.locator(`[data-reader-page="${paper}"]`).click();
	await page.locator('[data-reader-font="system"]').click();
	await page.locator("#app-zoom-in").click();
	await page.keyboard.press("Escape");
	assert.equal(page.url(), address, "closing Aa keeps the topic open");
	assert(await appearance.evaluate((node) => node.getRootNode().activeElement === node));
	const ink = await style(article, "color");
	const face = await style(article, "fontFamily");
	const accent = await style(article.locator(".app-topic-cite").first(), "color");
	const secondary = await style(article.locator(".bc-reader-byline"), "color");
	const rule = await style(article.locator(".bc-reader-head"), "borderBottomColor");
	assert.equal(await style(page.locator(".app-topic-article-scroll"), "backgroundColor"), background);
	assert.equal(await style(list, "backgroundColor"), appColor);
	assert.equal(await style(sort, "backgroundColor"), buttonBackground);
	assert.equal(await style(sort, "borderTopColor"), rule);
	assert.equal(await style(sort.locator("[aria-hidden]"), "color"), ink);
	assert.equal(await style(article.locator(".page-sort-label"), "color"), secondary);
	assert.notEqual(face, uiFace);
	assert.equal(await style(sort, "fontFamily"), uiFace);
	assert.equal(parseFloat(await style(sort, "fontSize")), originalSize);
	assert.equal(await style(sources, "color"), secondary);

	await sort.press("ArrowDown");
	const options = article.getByRole("menu", { name: "Sort" });
	const selected = options.getByRole("menuitemradio", { checked: true });
	assert.equal(await style(options, "backgroundColor"), background);
	assert.equal(await style(options, "borderTopColor"), rule);
	assert.equal(await style(options.getByRole("separator"), "borderTopColor"), rule);
	assert.equal(await style(selected, "color", "::before"), ink);
	assert.notEqual(await style(selected, "fontFamily"), face);
	assert.equal(await style(selected, "fontSize"), "12px");
	assert.equal(await style(selected, "outlineColor"), accent);
	assert.notEqual(await style(selected, "backgroundColor"), await style(options.getByRole("menuitemradio", { checked: false }).first(), "backgroundColor"));
	await selected.press("Escape");
	assert.equal(page.url(), address);
	assert(await sort.evaluate((node) => node.getRootNode().activeElement === node));
	await sources.press("Enter");
	const all = menu.getByRole("checkbox", { name: "All sources" });
	assert.equal(await style(menu, "backgroundColor"), background);
	assert.equal(await style(menu, "borderTopColor"), rule);
	assert.equal(await style(menu, "colorScheme"), scheme);
	assert.equal(await style(article.locator(".app-drop-arrow"), "backgroundColor"), background);
	assert.equal(await style(article.locator(".app-drop-arrow"), "borderLeftColor"), rule);
	assert.equal(await style(sources, "color"), accent);
	assert.equal(await style(menu.locator(".choice-label").first(), "color"), ink);
	assert.equal(await style(menu.locator(".choice-label").first(), "fontFamily"), uiFace);
	assert.equal(await style(menu.locator(".app-discussion-summary"), "color"), secondary);
	assert.equal(await style(menu.locator(".discussion-thread-link").first(), "color"), accent);
	const group = menu.getByRole("button", { name: /Hacker News discussions/ });
	assert.equal(await style(group, "fontFamily"), uiFace);
	assert.equal(await style(group, "borderRightColor", "::after"), secondary);
	assert.equal(await style(all, "backgroundColor"), accent);
	assert.equal(await style(all, "borderLeftColor", "::after"), background);
	assert.equal(await style(all, "outlineColor"), accent);
	const thread = menu.getByRole("checkbox", { name: issue.sources[0].discussions[0].title, exact: true });
	await thread.press("Space");
	assert(await all.evaluate((node) => node.indeterminate));
	assert.equal(await style(all, "backgroundColor"), accent);
	assert.equal(await style(all, "backgroundColor", "::after"), background);
	await thread.press("Space");
	await all.press("Space");
	const sync = menu.getByRole("button", { name: "Sync" });
	assert(await sync.isDisabled());
	assert.equal(await style(sync, "color"), secondary);
	assert(await waitFor(async () => await style(all, "borderTopColor") === rule));
	await all.press("Escape");
	assert.equal(page.url(), address);
	assert(await sources.evaluate((node) => node.getRootNode().activeElement === node));
	assert.deepEqual(errors, []);
});

for (const [width, scheme] of [[1280, "light"], [320, "dark"]]) {
	test(`a topic shows its brief, milestones, comments and original sources together at ${width}px in ${scheme}`, async () => {
		let requests = 0;
		const additionalThreads = [null, 0, 3, 3, 1].map((comments, index) => ({
			url: "https://news.ycombinator.com/item?id=" + (9450 + index),
			title: "Operator report " + (index + 1), source: "hn", comments,
		}));
		const busiest = { url: "https://news.ycombinator.com/item?id=9460", title: "Control room handover", source: "hn", comments: 11 };
		const edition = { ...issue, sources: [
			{ ...issue.sources[0], discussions: [...issue.sources[0].discussions, ...additionalThreads] },
			{ ...issue.sources[1], discussions: [busiest] },
		], sections: [{ ...issue.sections[0], heading: "agreement terms for the EU and NASA" }] };
		const app = await openReader({ viewport: { width, height: 740 }, colorScheme: scheme,
			extraStories: [{ id: 9460, url: issue.sources[1].url, title: busiest.title, comments: 11 },
				{ id: 9410, url: issue.sources[0].url, title: issue.sources[0].discussions[0].title, comments: 3 }],
			responses: [
			{ match: (url) => url === articleURL && requests++ === 0, status: 202, headers: "Retry-After: 1" },
			{ match: (url) => url === articleURL, json: edition },
		] });
		try {
			const { page, context } = app;
			page.setDefaultTimeout(7000);
			await page.goto("https://backchnnl.app/?topic=" + encodeURIComponent(topic.id));
			const article = page.locator("#app-article-body article");
			await article.getByRole("heading", { name: "Agreement terms for the EU and NASA", exact: true }).waitFor();
			await article.getByRole("heading", { name: topic.label, level: 1 }).waitFor();
			assert.match(await article.locator(".bc-reader-byline").innerText(), /^AI-generated brief · 2 sources · Updated Nov 20, 2026$/);
			assert.equal(await article.getByRole("button", { name: /^(Brief|Timeline|Sources)$/ }).count(), 0);
			const paragraph = article.getByText(issue.sections[0].paragraphs[0].text, { exact: false }).and(article.locator("p"));
			assert.deepEqual(await paragraph.getByRole("button").allTextContents(), ["1", "2"]);
			const citation = paragraph.getByRole("button", { name: "Source 2, Transit Desk" });
			await citation.click();
			const dialog = page.getByRole("dialog", { name: issue.sources[1].title });
			await dialog.getByText(issue.sources[1].excerpt).waitFor();
			assert.match(await dialog.innerText(), /Shared.*Nov 20, 2026/);
			assert.equal(await article.locator("signal").count(), 0);
			const original = dialog.getByRole("link", { name: /Open original/ });
			assert.equal(await original.getAttribute("href"), issue.sources[1].url);
			const [tab] = await Promise.all([context.waitForEvent("page"), original.click()]);
			await tab.waitForURL(issue.sources[1].url);
			assert.equal(await tab.evaluate(() => window.opener === null), true);
			await tab.close();
			await page.bringToFront();
			await page.keyboard.press("Escape");
			await dialog.waitFor({ state: "hidden" });
			assert.equal(await citation.evaluate((el) => el === el.getRootNode().activeElement), true);

			const events = article.getByRole("list", { name: "Timeline" }).getByRole("listitem");
			assert.deepEqual(await events.locator("time").evaluateAll((nodes) => nodes.map((el) => el.dateTime.slice(0, 10))), ["2026-11-16", "2026-11-17"]);
			const originals = article.getByRole("list", { name: "Sources" });
			assert.equal(await originals.getByRole("link", { name: issue.sources[0].title }).getAttribute("href"), issue.sources[0].url);
			assert.match(await originals.innerText(), /Published Nov 18, 2026.*Shared Nov 19, 2026/);
			assert.match(await originals.innerText(), /Shared Nov 20, 2026/);
			const discussion = article.getByRole("complementary", { name: "Discussions", exact: true });
			if (width <= 700) await page.locator("#app-bar-discussion").click();
			await discussion.getByRole("list", { name: "Comments across discussions" }).getByText(/Comment 1 on Control room handover/).waitFor();
			assert.equal(await discussion.getByRole("link", { name: busiest.title, exact: true }).count(), 0);
			assert.equal(await discussion.getByRole("link", { name: /What changes for operators/ }).count(), 0);
			if (width <= 700) {
				await page.locator("#app-bar-discussion").click();
				await discussion.waitFor({state: "hidden"});
			}
			const source = originals.locator(":scope > li").first();
			const sourceThreads = source.locator("details");
			assert.equal(await sourceThreads.getAttribute("open"), null);
			await sourceThreads.locator("summary").click();
			const thread = sourceThreads.getByRole("link", { name: "What changes for operators?", exact: true });
			assert.equal(await thread.getAttribute("href"), issue.sources[0].discussions[0].url);
			const external = thread.locator("xpath=..").getByRole("link", { name: /Open original discussion/ });
			assert.equal(await external.getAttribute("href"), issue.sources[0].discussions[0].url);
			assert.equal(await external.getAttribute("target"), "_blank");
			assert.equal(await sourceThreads.locator("[data-topic-thread]").count(), 6);
			await sourceThreads.locator("summary").click();
			assert(await article.evaluate((el, wide) => {
				const narrative = el.querySelector(".app-topic-narrative").getBoundingClientRect();
				const discussion = el.querySelector(".app-topic-discussions").getBoundingClientRect();
				const sources = el.querySelector(".app-topic-sources").getBoundingClientRect();
				return wide ? discussion.left >= narrative.right && discussion.top < narrative.bottom && sources.top >= narrative.bottom :
					discussion.height === 0 && sources.top >= narrative.bottom;
			}, width > 700), "the wide layout has a right column and the phone brief flows directly to its sources");
			assert.deepEqual(await article.evaluate((el) => {
				const host = el.getRootNode().host;
				const before = getComputedStyle(el).fontSize;
				host.style.setProperty("--app-text-zoom", "1.4");
				return [parseFloat(getComputedStyle(el).fontSize) > parseFloat(before), el.scrollWidth <= el.clientWidth + 1, getComputedStyle(el).color];
			}), [true, true, scheme === "dark" ? "rgb(216, 216, 216)" : "rgb(31, 31, 28)"]);
			assert.equal(app.requests.filter((r) => r.url === articleURL).every((r) => r.anonymous && r.method === "GET" && !r.hasBody), true);
			assert.deepEqual(app.errors, []);
		} finally {
			await app.browser.close();
		}
	});
}

test("the topic discussion divider widens the feed and remembers pointer and keyboard adjustments", async (t) => {
	const second = { ...topic, id: "topic:platform-signals", label: "Platform signals" };
	const app = await openReader({ catalogTopics: [second], responses: [
		{ match: (url) => url === articleURL, json: issue },
		{ match: (url) => url === catalogURL + "/article?id=" + encodeURIComponent(second.id), json: { ...issue, topic: second } },
	] });
	t.after(() => app.browser.close());
	const { page } = app;
	const article = page.locator("#app-article-body article");
	const feed = article.locator(".app-topic-feed");
	const divider = article.getByRole("separator", { name: /discussions/i });
	const width = async () => Math.round((await feed.boundingBox()).width);
	const open = async (id) => {
		await page.goto("https://backchnnl.app/?topic=" + encodeURIComponent(id));
		await article.getByRole("heading", { name: issue.sections[0].heading }).waitFor();
	};
	const drag = async (delta) => {
		const box = await divider.boundingBox();
		const x = box.x + box.width / 2, y = Math.max(0, box.y) + 24;
		await page.mouse.move(x, y);
		await page.mouse.down();
		await page.mouse.move(x + delta, y);
		await page.mouse.up();
	};

	await open(topic.id);
	const initial = await width();
	assert(initial >= 400, "a 1440px desktop gives discussion text at least 400px, measured " + initial);
	assert.equal(await divider.getAttribute("aria-orientation"), "vertical");
	await drag(-80);
	const dragged = await width();
	assert(Math.abs(dragged - initial - 80) <= 2, "the divider follows the pointer outside its grab area");
	await open(second.id);
	assert.equal(await width(), dragged, "another topic uses the saved column width");
	await divider.press("ArrowLeft");
	assert(await width() > dragged);
	await divider.press("ArrowRight");
	assert(Math.abs(await width() - dragged) <= 1);
	await divider.press("End");
	const widest = await width();
	assert(widest > dragged && (await article.locator(".app-topic-narrative").boundingBox()).width >= 310);
	await drag(-440);
	assert.equal(await width(), widest, "the pointer respects the readable brief width");
	await divider.press("Home");
	const narrowest = await width();
	assert(narrowest >= 240 && narrowest < initial);
	await drag(440);
	assert.equal(await width(), narrowest, "the pointer respects the minimum discussion width");
	await divider.press("ArrowLeft");
	const keyed = await width();
	assert(keyed > narrowest && keyed < initial, "the next key moves one step after a drag ends outside the window");
	await page.reload();
	await article.getByRole("heading", { name: issue.sections[0].heading }).waitFor();
	assert.equal(await width(), keyed, "the keyboard adjustment survives a reload");
	assert.deepEqual(app.errors, []);
});

test("the topic discussion divider fits the reading pane across resizing, text zoom and phone layout", async (t) => {
	const app = await openReader({ viewport: { width: 1280, height: 800 } });
	t.after(() => app.browser.close());
	const { page } = app;
	const article = page.locator("#app-article-body article");
	const aside = article.getByRole("complementary", { name: "Discussions", exact: true });
	const divider = article.getByRole("separator", { name: /discussions/i });
	const fits = () => article.evaluate((el) => el.scrollWidth <= el.clientWidth + 1 &&
		el.parentElement.scrollWidth <= el.parentElement.clientWidth + 1);
	const open = async () => {
		await page.goto("https://backchnnl.app/?topic=" + encodeURIComponent(topic.id));
		await article.getByRole("heading", { name: issue.sections[0].heading }).waitFor();
	};
	const zoom = async (percent) => {
		await page.getByRole("button", { name: "Style settings", exact: true }).click();
		const field = page.getByRole("textbox", { name: "Font size in percent" });
		await field.fill(String(percent));
		await field.press("Enter");
	};
	await open();
	const width = (await aside.locator(".app-topic-feed").boundingBox()).width;
	assert(width >= 330, "the 1280px layout gives discussions room, measured " + width);
	await divider.press("End");
	const widest = (await aside.boundingBox()).width;
	await page.setViewportSize({ width: 1080, height: 800 });
	assert(await divider.isVisible());
	assert((await article.locator(".app-topic-narrative").boundingBox()).width >= 310);
	assert((await aside.boundingBox()).width < widest && await fits());
	await page.setViewportSize({ width: 1280, height: 800 });
	assert.equal((await aside.boundingBox()).width, widest, "the wider window restores the chosen split");

	await zoom(150);
	assert(await waitFor(() => divider.isHidden()), "larger type stacks the two columns in the same window");
	assert(await fits());
	await page.setViewportSize({ width: 320, height: 740 });
	await open();
	assert.equal(await divider.count(), 0, "the stacked phone layout has no focusable divider");
	await page.setViewportSize({ width: 700, height: 740 });
	await zoom(80);
	assert.equal(await divider.count(), 0, "smaller text keeps the full-width phone feed stacked");
	assert(await fits());
	assert.deepEqual(app.errors, []);
});

test("a topic illustrates its reporting with attributed publisher photos and quiet source references", async (t) => {
	const images = [
		{ url: "https://pictures.example.org/platform.jpg", alt: "Signal crews at the station", sourceId: "s2" },
		{ url: "https://pictures.example.org/interlock.jpg", alt: "The replacement interlocking", sourceId: "s1" },
	];
	const published = { ...issue, images, sections: [...issue.sections, {
		heading: "Testing the interlocking", paragraphs: [{ text: "The interlocking passed its tests.", sourceIds: ["s1"] }],
	}] };
	const app = await openReader({ responses: [{ match: (url) => url === articleURL, json: published }] });
	t.after(() => app.browser.close());
	const photos = [];
	await app.context.route("https://pictures.example.org/**", async (route) => {
		photos.push([route.request().url(), route.request().headers().referer]);
		await route.fulfill({ contentType: "image/webp", path: testPhoto });
	});
	await app.page.goto("https://backchnnl.app/?topic=" + encodeURIComponent(topic.id));
	const article = app.page.locator("#app-article-body article");
	await article.getByRole("heading", { name: "Testing the interlocking" }).waitFor();
	const figures = article.locator(".app-topic-narrative figure");
	assert.equal(await figures.count(), 2);
	for (const [i, image] of images.entries()) {
		const figure = figures.nth(i);
		const pic = figure.getByRole("img", { name: image.alt });
		await pic.scrollIntoViewIfNeeded();
		assert(await waitFor(() => pic.evaluate((el) => el.complete && el.naturalWidth > 0)));
		assert.equal(await figure.locator("figcaption a").getAttribute("href"), issue.sources.find((s) => s.id === image.sourceId).url);
	}
	assert(photos.every(([, referer]) => !referer));
	const first = article.getByRole("list", { name: "Sources" }).locator(":scope > li").first();
	const reference = first.getByRole("button", { name: "Source 1, Signal Journal" });
	assert(await reference.evaluate((el) => el.closest(".app-topic-credit") && getComputedStyle(el).backgroundColor === "rgba(0, 0, 0, 0)" &&
		parseFloat(getComputedStyle(el).fontSize) <= 0.87 * parseFloat(getComputedStyle(el.closest(".app-topic-credit")).fontSize)));
	await reference.click();
	await app.page.getByRole("dialog", { name: issue.sources[0].title }).waitFor();
});

test("a missing publisher photo falls back to attributed topic artwork without loading a hidden source photo", async (t) => {
	const broken = "https://pictures.example.org/broken.jpg", hiddenImage = "https://pictures.example.org/hidden.jpg";
	const artwork = { url: "https://upload.wikimedia.org/wikipedia/commons/1/11/Station.jpg",
		source: "https://commons.wikimedia.org/wiki/File:Station.jpg", credit: "Chris Track · CC BY 4.0", subject: "Station signals" };
	const seen = [];
	const hidden = issue.sources[1];
	const app = await openReader({ artwork, values: { "HNewhere:hidden_stories": [{ key: hidden.url.slice(8), url: hidden.url, title: hidden.title }] },
		responses: [{ match: (url) => url === articleURL, json: { ...issue, images: [
			{ url: broken, alt: "Unavailable photo", sourceId: "s1" }, { url: hiddenImage, alt: "Hidden photo", sourceId: "s2" },
		] } }] });
	t.after(() => app.browser.close());
	await app.context.route("https://pictures.example.org/**", async (route) => { seen.push(route.request().url()); await route.fulfill({ status: 404 }); });
	await app.context.route(artwork.url, (route) => route.fulfill({ contentType: "image/webp", path: testPhoto }));
	await app.page.goto("https://backchnnl.app/?topic=" + encodeURIComponent(topic.id));
	const figure = app.page.locator("#app-article-body article .app-topic-narrative figure");
	await app.page.locator(".app-topic-source-title").first().waitFor();
	assert(await waitFor(() => seen.includes(broken)), "the public publisher photo is tried");
	const image = figure.getByRole("img", { name: artwork.subject });
	await image.waitFor();
	assert(await waitFor(() => image.evaluate((el) => el.complete && el.naturalWidth > 0)));
	assert.equal(await figure.locator("figcaption a").getAttribute("href"), artwork.source);
	assert.match(await figure.locator("figcaption").innerText(), /Chris Track · CC BY 4\.0/);
	assert(!seen.includes(hiddenImage));
});

test("uncaptioned alternatives replace a failed lead without repeating it in the brief", async (t) => {
	const images = ["s1", "s2"].map((sourceId) => ({ sourceId, alt: "", url: "https://pictures.example.org/" + sourceId + ".jpg" }));
	const app = await openReader({ responses: [{ match: (url) => url === articleURL, json: { ...issue, images, sections: [
		issue.sections[0], { heading: "Schedule changes", paragraphs: [{ text: "Operators revised the schedule.", sourceIds: ["s2"] }] },
	] } }] });
	t.after(() => app.browser.close());
	await app.context.route(images[0].url, (route) => route.fulfill({ status: 404 }));
	await app.context.route(images[1].url, (route) => route.fulfill({ contentType: "image/webp", path: testPhoto }));
	await app.page.goto("https://backchnnl.app/?topic=" + encodeURIComponent(topic.id));
	const narrative = app.page.locator("#app-article-body .app-topic-narrative");
	await narrative.getByRole("heading", { name: "Schedule changes" }).waitFor();
	assert(await waitFor(() => narrative.evaluate((el) => {
		const photo = el.querySelector(":scope > figure img");
		return photo?.complete && photo.naturalWidth > 0 && photo.src.endsWith("/s2.jpg");
	}), 2500));
	assert.equal(await narrative.locator("figure").count(), 1);
});

test("thin coverage keeps titles in Sources and quotes only complete publisher descriptions", async () => {
	const listed = "The public listing describes this link as “Subscribe to continue reading all our coverage.”";
	const byline = issue.sources[1].title + " Sam Tracks, Transit DeskSun, November 22, 2026 at 3:33 PM UTC Rail...";
	const full = "A U.S. operator and Rep. Jo Fox reviewed the signal tests with the station manager.";
	const thin = { ...issue, method: "coverage", sections: [], timeline: issue.timeline.slice(0, 2),
		sources: [{ ...issue.sources[0], excerpt: listed }, { ...issue.sources[1], excerpt: byline }] };
	const earlier = { ...thin, sections: [{ heading: "Coverage", paragraphs: [{ text: "A public listing shared a timetable.", sourceIds: ["s1"] }] }],
		sources: [thin.sources[0], { ...issue.sources[1], excerpt: full }] };
	let limited = true;
	const app = await openReader({ responses: [
		{ match: (url) => url === articleURL && limited, json: thin },
		{ match: (url) => url === articleURL, json: earlier },
	], pages: Object.fromEntries(thin.sources.map(({ url }) => [url, { status: 403, html: "<title>Access denied</title>" }])) });
	try {
		const { page } = app;
		page.setDefaultTimeout(7000);
		await page.goto("https://backchnnl.app/?topic=" + encodeURIComponent(topic.id));
		const article = page.locator("#app-article-body article");
		const narrative = article.locator(".app-topic-narrative");
		await article.getByRole("list", { name: "Sources" }).getByText(/^Signal Journal/).waitFor();
		await narrative.getByRole("status").filter({ hasText: /original sources/i }).waitFor();
		assert.equal(await narrative.locator("p").count(), 1);
		assert.equal(await narrative.locator(".bc-reader-byline, .app-topic-timeline").count(), 0);
		assert.equal(await article.getByRole("list", { name: "Sources" }).getByRole("link").count(), 2);
		await article.getByRole("complementary", { name: "Discussions" }).waitFor();
		assert.equal(await article.getByRole("complementary", { name: "Discussions" }).getByRole("link", { name: "What changes for operators?" }).count(), 0);
		for (const publisher of issue.sources.map((s) => s.publisher)) {
			await article.getByRole("list", { name: "Sources" }).getByRole("button", { name: new RegExp(publisher) }).click();
			assert.equal(await page.getByRole("dialog").locator(".app-topic-source-excerpt").count(), 0);
			await page.keyboard.press("Escape");
		}
		limited = false;
		await page.reload();
		const paragraph = narrative.locator(".app-topic-brief-section p");
		await paragraph.waitFor();
		assert((await paragraph.innerText()).includes(full));
		assert.doesNotMatch(await narrative.innerText(), /public listing|AI-generated brief/);
		await paragraph.getByRole("button", { name: "Source 2, Transit Desk" }).click();
		await page.getByRole("dialog").getByText(full, { exact: true }).waitFor();
		assert.deepEqual(app.errors, []);
	} finally {
		await app.browser.close();
	}
});

test("an empty shared brief reads the available originals and cites what they report", async (t) => {
	const reports = [
		"The westbound signal tests detected a wiring fault that delayed the railway upgrade.",
		"Transit engineers traced the faulty relay to the switching cabinet at Willow Station.",
	];
	const restricted = "The internal signal audit names three inspectors and describes their disciplinary hearings.";
	const sources = [...issue.sources.map((source) => ({ ...source, excerpt: "" })),
		{ ...issue.sources[0], id: "s3", url: "https://restricted.example.org/railway", excerpt: "" },
		{ ...issue.sources[0], id: "s4", url: "https://hidden.example.org/railway", excerpt: "" },
	];
	const thin = { ...issue, sources, method: "coverage", sections: [], timeline: [] };
	const { browser, page, requests, errors } = await openReader({
		values: { "HNewhere:hidden_stories": [{ key: "hidden.example.org/railway", url: sources[3].url, title: sources[3].title }] },
		responses: [{ match: (url) => url === articleURL, json: thin }],
		pages: {
			[sources[0].url]: { html: '<meta name="description" content="' + reports[0] + '">' },
			[sources[1].url]: { html: '<article><p data-nosnippet>' + restricted + '</p><p>' + reports[1] +
				' <span data-nosnippet>' + restricted + '</span></p></article>' },
			[sources[2].url]: { html: '<meta name="robots" content="nosnippet"><article><p>' + restricted + '</p></article>' },
			[sources[3].url]: { html: '<article><p>' + restricted + '</p></article>' },
		},
	});
	t.after(() => browser.close());
	await page.goto("https://backchnnl.app/?topic=" + encodeURIComponent(topic.id));
	const narrative = page.locator(".app-topic-narrative");
	for (const [i, text] of reports.entries()) {
		const paragraph = narrative.locator(".app-topic-brief-section p").filter({ hasText: text });
		await paragraph.waitFor({ timeout: 6500 });
		await paragraph.getByRole("button", { name: new RegExp(sources[i].publisher) }).click();
		await page.getByRole("dialog").getByText(text, { exact: true }).waitFor();
		await page.keyboard.press("Escape");
	}
	assert.doesNotMatch(await narrative.innerText(), /internal signal audit|No readable summary|AI-generated/);
	assert(!requests.some(({ url }) => url === sources[3].url));
	assert.deepEqual(errors, []);
});

test("short public link descriptions survive an unavailable brief as labeled previews", async (t) => {
	const detail = "The system estimates the weight and balance of flights before departure from Atlanta.";
	const clipped = "The dispatch outage delayed aircraft waiting at gates and crews on the ground…";
	const suppressed = "The second public preview discusses the same incident with a different set of measurements.";
	const thin = { ...issue, method: "coverage", sections: [], timeline: [],
		sources: [{ ...issue.sources[0], excerpt: "The public listing describes this link as “" + detail + " The delays began shortly before…”" },
			{ ...issue.sources[1], excerpt: "The public listing describes this link as “" + clipped + "”" },
			{ ...issue.sources[1], id: "s3", url: "https://restricted.example.org/report",
				excerpt: "The public listing describes this link as “" + suppressed + "”" }],
	};
	const { browser, page } = await openReader({
		responses: [{ match: (url) => url === articleURL, json: thin }],
		pages: {
			[thin.sources[0].url]: { status: 403, html: "<title>Access denied</title>" },
			[thin.sources[1].url]: { status: 403, html: "<title>Access denied</title>" },
			[thin.sources[2].url]: { headers: { "x-robots-tag": "nosnippet" }, html: "<article><p>" + suppressed + "</p></article>" },
		},
	});
	t.after(() => browser.close());
	await page.goto("https://backchnnl.app/?topic=" + encodeURIComponent(topic.id));
	const narrative = page.locator(".app-topic-narrative");
	await narrative.getByRole("heading", { name: "Shared link previews" }).waitFor({ timeout: 6500 });
	const paragraph = narrative.locator(".app-topic-brief-section p").filter({ hasText: detail });
	await paragraph.waitFor();
	assert((await narrative.innerText()).includes(clipped));
	assert.doesNotMatch(await narrative.innerText(), /No readable summary|The delays began shortly|AI-generated/i);
	assert(!(await narrative.innerText()).includes(suppressed));
	await paragraph.getByRole("button", { name: /Signal Journal/ }).click();
	await page.getByRole("dialog").getByText(detail, { exact: true }).waitFor();
});

test("a Collection topic gets a cited excerpt directly from its bookmarks", async (t) => {
	const bookmarks = [
		{ url: "https://glaze.example.org/ceramics/glazes", title: "Ceramic glazes for beginners" },
		{ url: "https://pottery.example.net/ceramics/glazes", title: "Firing ceramic glazes without defects" },
		{ url: "https://studio.example.org/notes?draft=glaze", title: "Drying ceramic glazes in the studio", previewOnOpen: true },
	];
	const detail = "A thin glaze layer reduces the chance of pinholes during the first kiln firing.";
	const { browser, page, requests } = await launchApp({
		sharedStore: true,
		settings: { sources: { hn: true }, updateCheck: false, sourceRefreshMinutes: 0 },
		values: { "HNewhere:collection_filed": true, "HNewhere:collected_migrated": true,
			"HNewhere:collected": bookmarks.map((bookmark) => ({ ...bookmark, key: bookmark.url.slice(8), addedAt: Date.now() })) },
		responses: [{ match: (url) => url === catalogURL, status: 503 }],
		pages: {
			[bookmarks[0].url]: { html: "<article><h1>" + bookmarks[0].title + "</h1><p>" + detail + "</p></article>" },
			[bookmarks[1].url]: { html: "<article><h1>Account Login</h1><p>Please register for our site before continuing.</p></article>" },
		},
	});
	t.after(() => browser.close());
	await page.goto("https://backchnnl.app/");
	await page.locator('#app-rail [data-app-view="collection"]').click();
	await page.getByRole("tab", { name: "By topic", exact: true }).click();
	await page.locator(".app-topic-row").filter({ hasText: /ceramic glazes/i }).click();
	const brief = page.locator(".app-topic-brief-section");
	await brief.getByText(new RegExp(detail)).waitFor({ timeout: 6500 });
	assert.equal(await brief.getByText(/please register/).count(), 0);
	assert(requests.some(({ url, anonymous }) => url === bookmarks[0].url && anonymous));
	assert(!requests.some(({ url }) => url === bookmarks[2].url));
	assert(!requests.some(({ url }) => url.startsWith(catalogURL + "/article")));
});

test("two claims citing the same article open their respective supporting passages, including after a repaint", async () => {
	const first = { text: "Drivers checked the west signal first.", sourceIds: ["s1"],
		citations: [{ sourceId: "s1", excerpt: "Testing started at the west signal." }] };
	const second = { text: "The east signal passed its test later.", sourceIds: ["s1"],
		citations: [{ sourceId: "s1", excerpt: "Later that morning the east <signal> passed inspection." }] };
	const event = { ...issue.timeline[3], citations: [{ sourceId: "s1", excerpt: "The first shift entered the control room on November 16." }] };
	const extraURL = "https://plain.example.org/engineering-notes";
	const app = await openReader({
		catalogPages: [{ key: "plain.example.org/engineering-notes", topicIds: [topic.id] }],
		responses: [
			{ match: (url) => url === articleURL, json: { ...issue, sections: [{ heading: "Commissioning the line", paragraphs: [first, second] }], timeline: [event] } },
			{ match: (url) => url.startsWith(catalogURL + "/coverage?"), delay: 1200, json: {
				version: 1, generatedAt: issue.generatedAt, topic, links: [{ url: extraURL, title: "Maintenance log", posts: [] }],
			} },
		],
	});
	try {
		const { page } = app;
		page.setDefaultTimeout(7000);
		await page.goto("https://backchnnl.app/?topic=" + encodeURIComponent(topic.id));
		const article = page.locator("#app-article-body article");
		const dialog = page.getByRole("dialog", { name: issue.sources[0].title });
		const original = dialog.getByRole("link", { name: /Open original/ });
		const citation = (text) => article.locator("p").filter({ hasText: text }).getByRole("button", { name: "Source 1, Signal Journal" });
		const sourceThreads = article.getByRole("list", { name: "Sources" }).locator("details").first();
		await sourceThreads.locator("summary").click();
		await citation(first.text).click();
		await dialog.getByText(first.citations[0].excerpt, { exact: true }).waitFor();
		assert.equal(await original.getAttribute("href"), issue.sources[0].url);
		await page.keyboard.press("Escape");
		await page.getByRole("button", { name: "Load hidden links about this topic" }).click();
		const secondButton = citation(second.text);
		await secondButton.click();
		await dialog.getByText(second.citations[0].excerpt, { exact: true }).waitFor();
		await original.focus();
		await article.locator(".bc-reader-byline").filter({ hasText: "3 sources" }).waitFor({ state: "attached" });
		assert.equal(await sourceThreads.getAttribute("open"), "");
		await dialog.getByText(second.citations[0].excerpt, { exact: true }).waitFor();
		assert.equal(await dialog.locator("signal").count(), 0);
		assert(await original.evaluate((el) => el === el.getRootNode().activeElement));
		const dismissal = await dialog.evaluateHandle((node) => {
			const root = node.getRootNode();
			return { passage: new Promise((resolve) => node.addEventListener("close",
				() => resolve(root.activeElement?.dataset.topicPassage ?? null), { once: true, capture: true })) };
		});
		await original.press("Escape");
		await dialog.waitFor({ state: "hidden" });
		assert.equal(await dismissal.evaluate((result) => result.passage), second.citations[0].excerpt);
		assert(await secondButton.evaluate((el) => el === el.getRootNode().activeElement));
		await citation(event.text).click();
		await dialog.getByText(event.citations[0].excerpt, { exact: true }).waitFor();
		await page.keyboard.press("Escape");
		await article.getByRole("list", { name: "Sources" }).getByRole("button", { name: "Source 1, Signal Journal" }).click();
		await dialog.getByText(issue.sources[0].excerpt, { exact: true }).waitFor();
		assert.deepEqual(app.errors, []);
	} finally {
		await app.browser.close();
	}
});

test("background synthesis keeps keyboard focus on the same source and action", async () => {
	let ready = false;
	const longerBrief = { ...issue, sections: [
		{ heading: "During the signal tests", paragraphs: [{ text: "The advisory keeps the old timetable during testing. ".repeat(65), sourceIds: ["s2"] }] },
		...issue.sections,
	] };
	const app = await openReader({ responses: [
		{ match: (url) => url === articleURL && !ready, status: 202, headers: "Retry-After: 1" },
		{ match: (url) => url === articleURL, json: longerBrief },
	] });
	try {
		const { page } = app;
		page.setDefaultTimeout(7000);
		for (const inspecting of [false, true]) {
			ready = false;
			await page.goto("https://backchnnl.app/?topic=" + encodeURIComponent(topic.id));
			const article = page.locator("#app-article-body article");
			const source = article.locator(".app-topic-sources").getByTitle(issue.sources[0].title).first();
			await source.focus();
			assert.equal(await article.locator(".app-topic-brief-section").count(), 0, "pending headline-only coverage has no headline narration");
			assert.equal(await article.getByRole("list", { name: "Timeline" }).count(), 0);
			await article.locator(".app-topic-narrative").getByRole("status").filter({ hasText: "Loading the brief…" }).waitFor();
			const dialog = page.getByRole("dialog", { name: issue.sources[0].title });
			const original = dialog.getByRole("link", { name: /Open original/ });
			if (inspecting) {
				await source.press("Enter");
				await original.focus();
			}
			ready = true;
			await article.locator("h2").filter({ hasText: "Commissioning the line" }).waitFor({ state: "attached" });
			if (inspecting) {
				assert(await original.evaluate((el) => el === el.getRootNode().activeElement));
				assert(await dialog.evaluate((el) => {
					const { top, bottom } = el.getBoundingClientRect();
					return top >= 0 && bottom <= innerHeight;
				}), "the inspector remains visible when the shared brief moves its citation outside the viewport");
				await original.press("Escape");
				await dialog.waitFor({ state: "hidden" });
				assert(await source.evaluate((el) => {
					const { top, bottom } = el.getBoundingClientRect();
					return top >= 0 && bottom <= innerHeight;
				}), "closing a refreshed inspector returns the reader to the cited passage");
			}
			assert(await source.evaluate((el) => el === el.getRootNode().activeElement), "focus follows the cited source when its shared ID arrives");
		}
		assert.deepEqual(app.errors, []);
	} finally {
		await app.browser.close();
	}
});

test("malformed citations and unsupported origins cannot replace local coverage or send private identifiers", async () => {
	const source = await readFile(new URL("../../HNewhere.user.js", import.meta.url), "utf8");
	const seam = "\tfunction appTopicVisitIds(";
	assert(source.includes(seam));
	const instrumented = source.replace(seam, `	window.__topicContent = () => ({
		parse: typeof parseAppTopicArticle === "function" && parseAppTopicArticle,
		request: typeof requestAppTopicArticle === "function" && requestAppTopicArticle,
		local: typeof appTopicSourceArticle === "function" && appTopicSourceArticle,
		fromRows: appTopicReadingSources,
	});
${seam}`);
	const coldId = "story:signal-commissioning";
	const coldURL = catalogURL + "/article?id=" + encodeURIComponent(coldId);
	const app = await openReader({ source: instrumented, responses: [
		{ match: (url) => url === articleURL, status: 202, headers: "Retry-After: 2" },
		{ match: (url) => url === coldURL, delay: 500, json: { ...issue, topic: { ...topic, id: coldId } } },
	] });
	try {
		const { page } = app;
		await page.goto("https://backchnnl.app/");
		await page.locator("#app-list-body").waitFor();
		assert(await page.evaluate(() => typeof window.__topicContent?.().parse === "function"), "the article parser is available");
		const results = await page.evaluate((fixture) => {
			const { parse, local, fromRows } = window.__topicContent();
			const altered = (edit) => {
				const copy = structuredClone(fixture);
				edit(copy);
				return parse(copy, [fixture.topic.id]);
			};
			const sourceOnly = local("Upgraded line", "reader-story:local", [
				{ ...fixture.sources[0], excerpt: "" }, { ...fixture.sources[1], sharedAt: null },
			]);
			const withUnsafeThread = altered((item) => item.sources[0].discussions[0].url = "javascript:noop()");
			const safeURL = "https://pictures.example.org/engineering/signals.jpg?width=700";
			const filteredImages = altered((item) => item.images = [
				{ url: "https://127.0.0.1/photo.jpg", alt: "Local network", sourceId: "s1" },
				{ url: safeURL, alt: "Unknown coverage", sourceId: "s999" },
				{ url: safeURL, alt: "Engineering works", sourceId: "s2" },
			]).images;
			const localSources = Array.from({ length: 170 }, (_, index) => ({
				...fixture.sources[0], id: "local" + index, url: "https://tracks.example.com/story/" + index,
			}));
			const detailed = local("Signal report", "local", [
				{ ...fixture.sources[0], preview: "https://pictures.example.org/west.jpg", discussions: [] },
				{ ...fixture.sources[1], preview: "https://pictures.example.org/east.jpg", discussions: [{ url: "https://news.ycombinator.com/item?id=205", source: "hn", comments: 50 }] },
				{ ...fixture.sources[0], id: "s3", url: "https://other.example.org/tests", excerpt: fixture.sources[1].excerpt },
			]);
			return {
				rejected: [
					parse(fixture, new Set(["story:unrelated"])),
					altered((item) => item.sections[0].paragraphs[1].sourceIds = ["missing"]),
					altered((item) => item.timeline[0].sourceIds = []),
					altered((item) => item.sources[0].url = "data:text/plain,invalid"),
					altered((item) => item.sources[0].url = "https://user:secret@public.example.org/"),
					altered((item) => item.sources[0].id = "s2"),
					altered((item) => item.sources[0].title = "x".repeat(300000)),
					altered((item) => item.sections[0].paragraphs[1].citations = [{ sourceId: "s1", excerpt: "An unrelated article." }]),
					altered((item) => item.timeline[0].citations = [{ sourceId: "s2", excerpt: "x".repeat(2500) }]),
					altered((item) => item.sections[0].paragraphs[0].citations = Array(2).fill({ sourceId: "s1", excerpt: "Duplicated." })),
				],
				discussions: withUnsafeThread.sources[0].discussions,
				images: filteredImages,
				savedThreads: fromRows([{ story: { title: "River report", url: "https://city.example/report" }, discussions: [
					{ source: "hn", id: 115 }, { source: "lemmy", id: 120 }, { source: "lobsters", id: "ow65gf" },
					{ source: "reddit", id: "r4567" }, { source: "bsky", id: "at://did:plc:abcd/app.bsky.feed.post/3a56" },
					{ source: "hn", id: "bad-id" }, { source: "bsky", id: "at://did:plc:abcd/app.bsky.feed.like/3a56" },
				] }], {})[0].discussions.map(({ url }) => url),
				fallback: sourceOnly, headlineOnly: local("Empty material", "local", fixture.sources.map((s) => ({ ...s, excerpt: "" }))),
				localCount: local("Railway history", "local", localSources).sources.length,
				detailSources: detailed.sections.flatMap((s) => s.paragraphs.map((p) => p.citations[0].sourceId)),
				previewSources: detailed.images.map((photo) => photo.sourceId),
			};
		}, issue);
		assert.deepEqual(results.rejected, Array(10).fill(null));
		assert.deepEqual(results.discussions, []);
		assert.deepEqual(results.images, [{ url: "https://pictures.example.org/engineering/signals.jpg?width=700", alt: "Engineering works", sourceId: "s2" }]);
		assert.deepEqual(results.savedThreads, ["https://news.ycombinator.com/item?id=115", "https://lemmy.world/post/120",
			"https://lobste.rs/s/ow65gf", "https://www.reddit.com/comments/r4567/", "https://bsky.app/profile/did:plc:abcd/post/3a56"]);
		assert.equal(results.fallback.method, "coverage");
		const paragraphs = results.fallback.sections.flatMap(({ paragraphs }) => paragraphs);
		assert(!paragraphs.some(({ text }) => text.includes(issue.sources[0].title)));
		assert(paragraphs.some(({ text, sourceIds }) => text.includes(issue.sources[1].excerpt) && sourceIds.includes("s2")));
		assert.deepEqual(results.fallback.timeline, []);
		assert.deepEqual(results.headlineOnly.sections, []);
		assert.equal(results.localCount, 170);
		assert.deepEqual(results.detailSources, ["s2", "s1"]);
		assert.deepEqual(results.previewSources, ["s2", "s1"]);
		const invalid = await page.evaluate(async () => {
			const { request } = window.__topicContent();
			return Promise.all(["reader-story:private/article", "https://private.example.org/article", "topic:https://private.example.org/article"].map((id) => request(id)));
		});
		assert.deepEqual(invalid, Array(3).fill({ status: "missing" }));
		await page.evaluate((id) => {
			window.__topicAbort = new AbortController();
			window.__topicPending = window.__topicContent().request(id, window.__topicAbort.signal);
		}, topic.id);
		assert(await waitFor(() => app.requests.some(({ url }) => url === articleURL)));
		assert.equal(await page.evaluate(async () => { window.__topicAbort.abort(); return await window.__topicPending; }), null);
		await page.waitForTimeout(2100);
		assert.deepEqual(app.requests.filter(({ url }) => url.startsWith(catalogURL + "/article")).map((r) => r.url), [articleURL]);
		await page.clock.install();
		await page.evaluate((id) => { window.__topicPending = window.__topicContent().request(id); }, coldId);
		assert(await waitFor(() => app.requests.some(({ url }) => url === coldURL)));
		await page.clock.fastForward(28_000);
		assert.equal(await page.evaluate(async () => (await window.__topicPending)?.article?.topic.id), coldId);
		assert.equal(app.requests.filter(({ url }) => url === coldURL).length, 1, "a cold generation can use its full response window");
	} finally {
		await app.browser.close();
	}
});
