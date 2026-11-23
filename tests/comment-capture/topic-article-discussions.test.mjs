import assert from "node:assert/strict";
import test from "node:test";
import { launchApp, waitFor } from "./harness.mjs";

const api = "https://topics.backchnnl.app/api/topics";
const now = Math.floor(Date.now() / 1000);
const topic = { id: "story:harbor-inspection", label: "Harbor inspection findings", kind: "story", curated: true };
const stories = [
	{ id: 9741, title: "Inspectors publish the harbor report", url: "https://maritime.example/inspection", comments: 35 },
	{ id: 9742, title: "Operators discuss the harbor findings", url: "https://journal.example/findings", comments: 8 },
].map((story) => ({ ...story, source: "hn", time: now - 60, descendants: story.comments, topic: "technology" }));
const threadURL = (id) => "https://news.ycombinator.com/item?id=" + id;
const hnItem = (id) => "https://hacker-news.firebaseio.com/v0/item/" + id + ".json";
const address = "https://backchnnl.app/?topic=" + encodeURIComponent(topic.id);

async function openTopic(t, { phone, responses = [], signedIn = false, local = stories, threads = [] } = {}) {
	const sources = stories.map((story, i) => ({ id: "s" + i, title: story.title, url: story.url,
		publisher: new URL(story.url).hostname, excerpt: story.title + ".", publishedAt: null, sharedAt: null,
		discussions: [{ source: "hn", url: threadURL(story.id), title: story.title, comments: story.comments }] }));
	sources[0].discussions.push({ source: "reddit", title: "Reddit discussion", url: "https://www.reddit.com/r/ports/comments/abcde/harbor/", comments: 9000 });
	sources[0].discussions.push({ source: "x", title: "Harbor update on X", url: "https://x.com/ports/status/123456", comments: 8000 });
	for (const { sourceIndex = 0, ...thread } of threads) sources[sourceIndex].discussions.push(thread);
	const article = { version: 1, topic, generatedAt: new Date().toISOString(), method: "synthesis", sources,
		sections: [{ heading: "What happened", paragraphs: [{ text: "Inspectors published the harbor report.", sourceIds: ["s0","s1"] }] }], timeline: [] };
	const app = await launchApp({
		...(phone && { viewport: { width: 360, height: 740 }, hasTouch: true }),
		sharedStore: true,
		settings: { sources: { hn: true, reddit: signedIn, x: signedIn, ...Object.fromEntries(threads.map(({ source }) => [source, true])) },
			updateCheck: false, sourceRefreshMinutes: 0,
			frontPageMode: "topics", frontPageTopics: ["technology"] },
		values: { "HNewhere:app_browse_topics": true,
			"HNewhere:frontpage_feed:technology/hn/front/": { timestamp: now * 1000, stories: local } },
		extraStories: stories,
		responses: [
			{ match: (url) => url === api, json: { version: 1, generatedAt: article.generatedAt, topics: [topic],
				pages: stories.map(({ url }) => ({ key: url.slice(8), topicIds: [topic.id] })) } },
			{ match: (url) => url === api + "/article?id=" + encodeURIComponent(topic.id), json: article }, ...responses,
		],
	});
	t.after(() => app.browser.close());
	app.page.setDefaultTimeout(5000);
	await app.page.goto(address);
	const aside = app.page.locator(".app-topic-discussions");
	return { ...app, aside };
}

for (const phone of [false, true]) {
	test(`the ${phone ? "phone" : "desktop"} topic shows real comments and opens another thread in place`, async (t) => {
		const { page, context, requests, store, errors, aside } = await openTopic(t, { phone });
		const link = (id) => aside.locator('[data-topic-thread="' + threadURL(id) + '"]');
		const preview = aside.getByRole("region", { name: "Discussion preview", exact: true });
		await preview.getByText(/Comment 1 on Inspectors/).waitFor();
		assert.equal(requests.filter(({ url }) => url === hnItem(stories[1].id)).length, 0);
		const items = requests.filter(({ url }) => new URL(url).hostname === "hacker-news.firebaseio.com");
		assert(items.length > 0 && items.length <= 4);
		assert(items.every(({ method, anonymous, hasBody }) => method === "GET" && anonymous && hasBody === undefined));
		const article = page.locator(".app-topic-article");
		const heading = article.getByRole("heading", { name: topic.label, exact: true });
		const second = link(stories[1].id);
		await second.focus();
		const scroller = page.locator(".app-topic-article-scroll");
		const position = await scroller.evaluate((node) => node.scrollTop);
		await second.press("Enter");
		const detail = aside.getByRole("region", { name: "Thread comments", exact: true });
		await detail.getByText(/Comment 1 on Operators/).waitFor();
		await heading.waitFor();
		assert.equal(page.url(), address);
		assert.equal(context.pages().length, 1);
		const native = detail.getByRole("link", { name: "Open original discussion", exact: true });
		assert.equal(await native.getAttribute("href"), threadURL(stories[1].id));
		assert.equal(await native.getAttribute("target"), "_blank");
		assert.deepEqual(store.get("HNewhere:seen_comments") || {}, {});
		assert.equal(requests.some(({ url }) => new URL(url).hostname === "hn.algolia.com"), false);
		if (phone) await page.locator("#app-bar-back").tap();
		else await detail.getByRole("button", { name: "Back to discussions", exact: true }).click();
		await detail.waitFor({ state: "hidden" });
		assert(await waitFor(() => second.evaluate((node) => node.getRootNode().activeElement === node)));
		assert.equal(await scroller.evaluate((node) => node.scrollTop), position);
		assert.equal(page.url(), address);
		await second.press("Enter");
		await detail.getByText(/Comment 1 on Operators/).waitFor();
		await page.keyboard.press("Escape");
		await detail.waitFor({ state: "hidden" });
		assert(await second.evaluate((node) => node.getRootNode().activeElement === node));
		if (phone) {
			await page.locator("#app-bar-back").tap();
			await page.locator('#app[data-stage="list"] #app-list-topic-title').waitFor();
		}
		assert.deepEqual(errors, []);
	});
}

test("a thread mentioned by two sources uses its highest published comment count for the preview", async (t) => {
	const { aside, requests } = await openTopic(t, { threads: [
		{ sourceIndex: 1, source: "hn", url: threadURL(stories[0].id), title: "Updated harbor report discussion", comments: 900 },
		{ source: "hn", url: threadURL(stories[1].id), title: stories[1].title, comments: 500 },
	] });
	const preview = aside.getByRole("region", { name: "Discussion preview" });
	await preview.getByText(/Comment 1 on/).waitFor();
	assert(await preview.getByRole("heading", { name: "Updated harbor report discussion" }).isVisible());
	assert.equal(requests.some(({ url }) => url === hnItem(stories[1].id)), false);
});

test("late comments cannot replace a different selected thread; empty threads keep their original link", async (t) => {
	let delivered;
	const late = new Promise((resolve) => { delivered = resolve; });
	const { page, aside, requests, errors } = await openTopic(t, { responses: [
		{ match: (url) => url === hnItem(stories[1].id), delay: 700,
			get json() { delivered(); return { id: stories[1].id, kids: [] }; } },
	] });
	const first = aside.locator('[data-topic-thread="' + threadURL(stories[0].id) + '"]');
	const second = aside.locator('[data-topic-thread="' + threadURL(stories[1].id) + '"]');
	await aside.getByRole("region", { name: "Discussion preview" }).getByText(/Comment 1 on Inspectors/).waitFor();
	await second.click();
	assert(await waitFor(() => requests.some(({ url }) => url === hnItem(stories[1].id))));
	await first.click();
	const detail = aside.getByRole("region", { name: "Thread comments", exact: true });
	await detail.getByText(/Comment 1 on Inspectors/).waitFor();
	await late;
	await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
	assert(await detail.getByText(/Comment 1 on Inspectors/).isVisible());
	await second.click();
	await detail.getByText("No comments yet.", { exact: true }).waitFor();
	assert.equal(await detail.getByRole("link", { name: "Open original discussion" }).getAttribute("href"), threadURL(stories[1].id));
	assert.equal(page.url(), address);
	assert.deepEqual(errors, []);
});

test("phone Back closes a discussion before leaving a public topic with no local members", async (t) => {
	const local = [{ ...stories[0], id: 9750, title: "Autumn harvest sets a new record", url: "https://orchard.example/harvest" }];
	const { page, aside } = await openTopic(t, { phone: true, local });
	await aside.getByRole("region", { name: "Discussion preview" }).getByText(/Comment 1 on Inspectors/).waitFor();
	assert.equal(await page.locator("#app-list-topic").isVisible(), false);
	await aside.locator('[data-topic-thread="' + threadURL(stories[1].id) + '"]').tap();
	const detail = aside.getByRole("region", { name: "Thread comments" });
	await detail.getByText(/Comment 1 on Operators/).waitFor();
	await page.locator("#app-bar-back").tap();
	await detail.waitFor({ state: "hidden" });
	await page.locator('#app[data-stage="article"] .app-topic-article').waitFor();
	assert.equal(page.url(), address);
	await page.locator("#app-bar-back").tap();
	await page.locator('#app[data-stage="list"]').waitFor();
	assert.equal(new URL(page.url()).searchParams.has("topic"), false);
});

test("an unavailable preview leaves the list visible; an explicit thread offers its original and retry", async (t) => {
	let available = false;
	const { page, context, aside, requests } = await openTopic(t, { responses: [
		{ match: (url) => !available && url === hnItem(stories[0].id), status: 503 },
	] });
	const first = aside.locator('[data-topic-thread="' + threadURL(stories[0].id) + '"]');
	await first.waitFor();
	assert(await waitFor(() => requests.some(({ url }) => url === hnItem(stories[0].id))));
	await aside.getByRole("region", { name: "Discussion preview" }).waitFor({ state: "detached" });
	await first.click();
	const detail = aside.getByRole("region", { name: "Thread comments" });
	await detail.getByText("Comments couldn’t be loaded.", { exact: false }).first().waitFor();
	const opened = context.waitForEvent("page");
	await detail.getByRole("link", { name: "Open original discussion" }).click();
	const original = await opened;
	await original.waitForURL(threadURL(stories[0].id));
	assert.equal(await original.evaluate(() => window.opener), null);
	await original.close();
	await page.bringToFront();
	available = true;
	await detail.getByRole("button", { name: "Retry comments" }).click();
	await detail.getByText(/Comment 1 on Inspectors/).waitFor();
	assert.equal(page.url(), address);
});

test("automatic previews avoid social sessions even when those sources are enabled", async (t) => {
	const { page, context, aside, requests } = await openTopic(t, { signedIn: true });
	await aside.getByRole("region", { name: "Discussion preview" }).getByText(/Comment 1 on Inspectors/).waitFor();
	assert.equal(context.pages().length, 1);
	assert.deepEqual(requests.filter(({ url }) => /abcde|\/status\/123456|maritime\.example\/inspection/.test(decodeURIComponent(url))), []);
	const x = aside.getByRole("link", { name: "Harbor update on X", exact: true });
	await context.route("https://x.com/ports/status/123456", (route) => route.fulfill({ contentType: "text/html", body: "<p>Original post</p>" }));
	const opened = context.waitForEvent("page");
	await x.click();
	const original = await opened;
	await original.waitForURL("https://x.com/ports/status/123456");
	assert.equal(page.url(), address);
	await original.close();
});

test("a private Collection topic reads a saved conversation only when selected", async (t) => {
	const bookmarks = stories.map((story, i) => ({ ...story, url: "https://private" + i + ".example/notes?draft=" + i,
		title: ["Ceramic glazes for beginners", "Firing ceramic glazes without defects"][i] }));
	const app = await launchApp({ sharedStore: true, extraStories: bookmarks,
		settings: { sources: { hn: true }, updateCheck: false, sourceRefreshMinutes: 0 },
		values: {
			"HNewhere:collection_filed": true, "HNewhere:collected_migrated": true,
			"HNewhere:collected": bookmarks.map(({ url, title }) => ({ key: url.slice(8), url, title, addedAt: now * 1000, previewOnOpen: true })),
			"HNewhere:favorites": bookmarks.map((story) => ({ ...story, key: "hn:" + story.id, kind: "discussion",
				page: story.url.slice(8), permalink: threadURL(story.id), addedAt: now * 1000 })),
		},
		responses: [{ match: (url) => url === api, status: 503 }],
	});
	t.after(() => app.browser.close());
	const { page, requests } = app;
	page.setDefaultTimeout(5000);
	await page.goto("https://backchnnl.app/");
	await page.locator('#app-rail [data-app-view="collection"]').click();
	await page.getByRole("tab", { name: "By topic", exact: true }).click();
	const card = page.locator(".app-topic-row").filter({ hasText: /ceramic glazes/i });
	const id = await card.getAttribute("data-shared-topic");
	await card.click();
	const aside = page.locator(".app-topic-discussions");
	const source = aside.locator('[data-topic-thread="' + threadURL(bookmarks[0].id) + '"]');
	await source.waitFor();
	assert.equal(await aside.getByRole("region", { name: "Discussion preview" }).count(), 0);
	assert.equal(requests.some(({ url }) => bookmarks.some((story) => url === hnItem(story.id))), false);
	await source.click();
	await aside.getByText(/Comment 1 on Ceramic glazes/i).waitFor();
	assert.equal(page.url(), "https://backchnnl.app/");
	assert.deepEqual(requests.filter(({ url }) => url.startsWith(api)).map(({ url, method, anonymous, hasBody }) =>
		[url, method, anonymous, hasBody]), [[api, "GET", true, undefined]]);
	assert.equal(requests.some(({ url }) => [id, ...bookmarks.map((story) => new URL(story.url).hostname)]
		.some((value) => decodeURIComponent(url).includes(value))), false);
});

test("named Lobsters, Lemmy and Bluesky threads load replies from their own permalinks", async (t) => {
	const threads = [
		{ source: "lobsters", url: "https://lobste.rs/s/h8r12/inspection", title: "Lobsters harbor thread", comments: 3 },
		{ source: "lemmy", url: "https://lemmy.world/post/112233", title: "Lemmy harbor thread", comments: 4 },
		{ source: "bsky", url: "https://bsky.app/profile/port.example/post/3lbview", title: "Port observer's thread", comments: 5 },
	];
	const did = "did:plc:abcdefghijklmnopqrstuvwx";
	const uri = "at://" + did + "/app.bsky.feed.post/3lbview";
	const post = (uri, text) => ({ uri, author: { did, handle: "port.example" }, record: { text } });
	const expected = ["Lobsters inspection reply", "Lemmy inspection reply", "Bluesky inspection reply"];
	const { aside, requests } = await openTopic(t, { threads, responses: [
		{ match: (url) => url === "https://lobste.rs/s/h8r12.json", json: { comments: [
			{ short_id: "entry", commenting_user: "shipwright", comment: "<p>" + expected[0] + "</p>" }] } },
		{ match: (url) => url.includes("/api/v3/comment/list?post_id=112233"), json: { comments: [
			{ comment: { id: 2, path: "0.2", content: expected[1] }, creator: { name: "captain" } }] } },
		{ match: (url) => url === "https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=port.example", json: { did } },
		{ match: (url) => url.includes("/app.bsky.feed.getPostThread?") && new URL(url).searchParams.get("uri") === uri,
			json: { thread: { post: post(uri, "An observer explains the inspection."), replies: [{post: post(uri + "r", expected[2])}] } } },
	] });
	for (const [index, thread] of threads.entries()) {
		await aside.locator('[data-topic-thread="' + thread.url + '"]').click();
		const detail = aside.getByRole("region", { name: "Thread comments" });
		await detail.getByText(expected[index], { exact: true }).waitFor();
		assert.equal(await detail.getByRole("link", { name: "Open original discussion" }).getAttribute("href"), thread.url);
	}
	assert.equal(requests.some(({ url }) => decodeURIComponent(url).includes(stories[0].url)), false);
});

for (const [source, url, endpoint] of [
	["lobsters", "https://lobste.rs/s/h8r12", "https://lobste.rs/s/h8r12.json"],
	["lemmy", "https://lemmy.world/post/112233", "https://lemmy.world/api/v3/comment/list?post_id=112233"],
]) {
	test(`the automatic ${source} preview requests only its public thread and omits credentials`, async (t) => {
		const { requests } = await openTopic(t, { threads: [{ source, url, title: "Harbor thread", comments: 600 }],
			responses: [{ match: (address) => address.startsWith(endpoint), json: { comments: [] } }] });
		assert(await waitFor(() => requests.some((request) => request.url.startsWith(endpoint))));
		assert.deepEqual(requests.filter((request) => request.url.startsWith(endpoint)).map(({ method, anonymous, hasBody }) =>
			[method, anonymous, hasBody]), [["GET", true, undefined]]);
		assert.equal(requests.some((request) => request.url === hnItem(stories[0].id)), false);
	});
}
