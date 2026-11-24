import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

async function openTopic(t, { phone, viewport, brief = ["Inspectors published the harbor report."], extraSources = [], responses = [], signedIn = false, local = stories, threads = [], values = {}, enabled = {}, holdURL, topHosts } = {}) {
	const sources = stories.map((story, i) => ({ id: "s" + i, title: story.title, url: story.url,
		publisher: new URL(story.url).hostname, excerpt: story.title + ".", publishedAt: null, sharedAt: null,
		discussions: [{ source: "hn", url: threadURL(story.id), title: story.title, comments: story.comments }] }));
	sources[0].discussions.push({ source: "reddit", title: "Reddit discussion", url: "https://www.reddit.com/r/ports/comments/abcde/harbor/", comments: 9000 });
	sources[0].discussions.push({ source: "x", title: "Harbor update on X", url: "https://x.com/ports/status/123456", comments: 8000 });
	for (const { sourceIndex = 0, ...thread } of threads) sources[sourceIndex].discussions.push(thread);
	sources.push(...extraSources);
	const article = { version: 1, topic, generatedAt: new Date().toISOString(), method: "synthesis", sources,
		sections: [{ heading: "What happened", paragraphs: brief.map((text) => ({ text, sourceIds: ["s0","s1"] })) }], timeline: [] };
	const app = await launchApp({
		...(phone && { viewport: viewport || { width: 360, height: 740 }, hasTouch: true }),
		topHosts,
		sharedStore: true,
		settings: { sources: { hn: true, reddit: signedIn, x: signedIn, ...Object.fromEntries(threads.map(({ source }) => [source, true])), ...enabled },
			updateCheck: false, sourceRefreshMinutes: 0,
			frontPageMode: "topics", frontPageTopics: ["technology"] },
		values: { ...values, "HNewhere:app_browse_topics": true,
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
	if (holdURL) await app.page.addInitScript((url) => {
		const get = window.__gmXHR;
		window.__gmXHR = async (request) => {
			const result = await get(request);
			if (request.url === url && !window.__topicResponseReleased) await new Promise((resolve) => {
				window.__releaseTopicResponse = () => { window.__topicResponseReleased = true; resolve(); };
			});
			return result;
		};
	}, holdURL);
	await app.page.goto(address);
	const aside = app.page.locator(".app-topic-discussions");
	if (phone) await app.page.locator('#app[data-stage="article"]:not([data-moving]) .app-topic-article').waitFor();
	return { ...app, aside };
}

const feedList = (aside) => aside.getByRole("list", { name: "Comments across discussions" });
const threadDetail = (aside) => aside.getByRole("region", { name: "Thread comments" });

async function sourceThread(page, url) {
	const action = page.locator('.app-topic-sources [data-topic-thread="' + url + '"]').first();
	const group = action.locator("xpath=ancestor::details");
	if (!(await group.evaluate((node) => node.open))) await group.locator("summary").click();
	return action;
}

for (const phone of [false, true]) {
	test(`the ${phone ? "phone" : "desktop"} topic opens straight to real replies across discussions`, async (t) => {
		const { page, context, requests, store, errors, aside } = await openTopic(t, { phone });
		const list = feedList(aside);
		await list.getByText(/Comment 1 on Inspectors/).waitFor();
		await list.getByText(/Comment 1 on Operators/).waitFor();
		assert.equal(await aside.locator("[data-topic-thread], h3").count(), 0);
		const locator = list.getByRole("listitem").filter({ hasText: /Comment 1 on Operators/ });
		await locator.getByText("commenter1", { exact: true }).waitFor();
		assert(await locator.locator("time[datetime]").count());
		const native = locator.locator(".app-topic-comment-meta").getByRole("link", { name: "Open comment on Hacker News in a new tab" });
		assert.equal(await native.getAttribute("href"), threadURL(stories[1].id * 100));
		assert.equal(await native.getAttribute("target"), "_blank");
		const replies = list.getByRole("listitem");
		assert(await waitFor(async () => await replies.count() >= 20), "a busy topic opens with enough comments to read");
		const items = requests.filter(({ url }) => new URL(url).hostname === "hacker-news.firebaseio.com");
		assert(items.length > 2 && items.every(({ method, anonymous, hasBody }) => method === "GET" && anonymous && hasBody === undefined));
		assert.equal(await aside.getByRole("button", { name: "Show more comments" }).count(), 0);
		const firstPage = await replies.count();
		assert(firstPage < stories.reduce((sum, story) => sum + story.comments, 0));
		await replies.last().evaluate((item) => item.scrollIntoView({ block: "start" }));
		assert(await waitFor(async () => (await replies.count()) > firstPage), "scrolling the discussion loads the next comments");
		const keys = await list.locator(".app-topic-comment-source").evaluateAll((nodes) => nodes.map((node) => node.href));
		assert.equal(new Set(keys).size, keys.length);
		const anchor = locator.getByRole("button", { name: "Read thread on Hacker News" });
		await anchor.focus();
		const scroller = page.locator(".app-topic-article-scroll");
		const position = await scroller.evaluate((node) => node.scrollTop);
		await anchor.press("Enter");
		const detail = threadDetail(aside);
		await detail.getByText(/Comment 1 on Operators/).waitFor();
		assert.equal(await detail.getByRole("link", { name: "Open original discussion" }).getAttribute("href"), threadURL(stories[1].id));
		assert.equal(page.url(), address);
		assert.equal(context.pages().length, 1);
		assert.deepEqual(store.get("HNewhere:seen_comments") || {}, {});
		assert.equal(requests.some(({ url }) => new URL(url).hostname === "hn.algolia.com"), false);
		if (phone) await page.locator("#app-bar-back").tap();
		else await detail.getByRole("button", { name: "Back to discussions" }).click();
		await detail.waitFor({ state: "hidden" });
		assert(await waitFor(() => anchor.evaluate((node) => node.getRootNode().activeElement === node)));
		assert.equal(await scroller.evaluate((node) => node.scrollTop), position);
		await anchor.press("Enter");
		await detail.getByText(/Comment 1 on Operators/).waitFor();
		await page.keyboard.press("Escape");
		await detail.waitFor({ state: "hidden" });
		assert(await anchor.evaluate((node) => node.getRootNode().activeElement === node));
		if (phone) {
			await page.locator("#app-bar-back").tap();
			await page.locator('#app[data-stage="list"] [data-shared-topic="' + topic.id + '"]').waitFor();
		}
		assert.deepEqual(errors, []);
	});
}

test("scrolling one busy topic thread reaches its final comment without duplicates or eager requests for the whole thread", async (t) => {
	const comments = Array.from({ length: 131 }, (_, i) => ({ id: 8800000 + i, by: "pilot", type: "comment",
		parent: stories[0].id, time: now - i, text: "Harbor log entry " + (i + 1) }));
	const { aside, requests, errors } = await openTopic(t, { responses: [
		{ match: (url) => url === hnItem(stories[0].id), json: { id: stories[0].id, kids: comments.map(({ id }) => id) } },
		{ match: (url) => url === hnItem(stories[1].id), json: { id: stories[1].id, kids: [] } },
		...comments.map((comment) => ({ match: (url) => url === hnItem(comment.id), json: comment })),
	] });
	const list = feedList(aside);
	const items = list.getByRole("listitem");
	const reads = () => requests.filter(({ url }) => /\/item\/8800\d+\.json$/.test(url));
	assert(await waitFor(async () => await items.count() >= 20));
	assert(reads().length < comments.length / 2, "opening the topic requests only its first batch");
	while (await items.count() < comments.length) {
		const previous = await items.count();
		await items.last().evaluate((node) => node.scrollIntoView({ block: "start" }));
		assert(await waitFor(async () => await items.count() > previous), "scrolling past " + previous + " comments uncovers more");
	}
	const links = await list.getByRole("link").evaluateAll((nodes) => nodes.map((node) => node.href));
	assert.deepEqual(new Set(links), new Set(comments.map(({ id }) => threadURL(id))));
	assert.equal(links.length, comments.length);
	assert.equal(reads().length, comments.length, "a comment is fetched once across scrolls");
	assert.deepEqual(errors, []);
});

test("the same conversation reported by two outlets supplies each reply once", async (t) => {
	const { aside, requests } = await openTopic(t, { threads: [
		{ sourceIndex: 1, source: "hn", url: threadURL(stories[0].id), title: "Updated harbor report discussion", comments: 900 },
		{ source: "hn", url: threadURL(stories[1].id), title: stories[1].title, comments: 500 },
	] });
	const list = feedList(aside);
	await list.getByText(/Comment 1 on Operators/).waitFor();
	await list.getByText(/Comment 1 on Inspectors/).waitFor();
	assert.equal(await list.getByText(/Comment 1 on Inspectors/).count(), 1);
	assert.equal(requests.filter(({ url }) => url === hnItem(stories[0].id)).length, 1);
	assert.equal(await aside.getByText("Updated harbor report discussion", { exact: true }).count(), 0);
});

test("a delayed comment page stays in view when phone scrolling has just crossed into the article sources", async (t) => {
	const ids = Array.from({ length: 60 }, (_, i) => 8600100 + i);
	const extraSources = Array.from({ length: 16 }, (_, i) => ({ id: "ref" + i, publisher: "Survey station " + i,
		title: "Measurements from station " + i, url: "https://station" + i + ".example/harbor", discussions: [] }));
	const { page, aside } = await openTopic(t, { phone: true, viewport: { width: 390, height: 640 }, extraSources, holdURL: hnItem(ids[24]), responses: [
		{ match: (url) => url === hnItem(stories[0].id), json: { id: stories[0].id, kids: ids } },
		{ match: (url) => url === hnItem(stories[1].id), json: { id: stories[1].id, kids: [] } },
		...ids.map((id) => ({ match: (url) => url === hnItem(id), json: { id, type: "comment", by: "pilot", time: now,
			text: "The water level at survey marker " + id + " was checked against the reading taken on the previous tide." } })),
	] });
	const items = feedList(aside).getByRole("listitem");
	assert(await waitFor(async () => await items.count() === 24));
	await items.last().evaluate((node) => node.scrollIntoView({ block: "end" }));
	await page.waitForFunction(() => typeof window.__releaseTopicResponse === "function");
	await items.last().evaluate((node) => window.scrollBy(0, node.getBoundingClientRect().bottom + 60));
	assert((await items.last().boundingBox()).y < 0);
	await page.evaluate(() => window.__releaseTopicResponse());
	assert(await waitFor(async () => await items.count() >= 48));
	const firstNew = await items.nth(24).boundingBox();
	assert(firstNew.y < 640 && firstNew.y + firstNew.height > 0, "the next reply is visible at the old end of the feed: " + firstNew.y);
});

test("scrolling continues through available replies while another discussion is still loading", async (t) => {
	const { page, aside } = await openTopic(t, { holdURL: hnItem(stories[1].id) });
	const items = feedList(aside).getByRole("listitem");
	await page.waitForFunction(() => typeof window.__releaseTopicResponse === "function");
	assert(await waitFor(async () => await items.count() >= 24));
	await items.last().evaluate((node) => node.scrollIntoView({ block: "start" }));
	assert(await waitFor(async () => await items.count() > 24), "a pending source does not stall reading another");
	await page.evaluate(() => window.__releaseTopicResponse());
	await feedList(aside).getByText(/Comment 1 on Operators/).waitFor();
});

test("a slow conversation lets earlier comments appear and cannot overwrite an open thread", async (t) => {
	const { page, aside } = await openTopic(t, { holdURL: hnItem(stories[1].id) });
	const list = feedList(aside);
	await list.getByText(/Comment 1 on Inspectors/).waitFor();
	await page.waitForFunction(() => typeof window.__releaseTopicResponse === "function");
	assert.equal(await list.getByText(/Comment 1 on Operators/).count(), 0);
	const trigger = list.getByRole("button", { name: "Read thread on Hacker News" }).first();
	await trigger.click();
	const detail = threadDetail(aside);
	await detail.getByText(/Comment 1 on Inspectors/).waitFor();
	await page.evaluate(() => window.__releaseTopicResponse());
	await aside.locator(".app-topic-feed .app-topic-comment-body").filter({ hasText: /Comment 1 on Operators/ }).waitFor({ state: "attached" });
	assert(await detail.getByText(/Comment 1 on Inspectors/).isVisible());
	await detail.getByRole("button", { name: "Back to discussions" }).click();
	await list.getByText(/Comment 1 on Operators/).waitFor();
	assert.equal(page.url(), address);
});

test("phone Back closes a discussion before leaving a public topic with no local members", async (t) => {
	const local = [{ ...stories[0], id: 9750, title: "Autumn harvest sets a new record", url: "https://orchard.example/harvest" }];
	const { page, aside } = await openTopic(t, { phone: true, local });
	const entry = feedList(aside).getByRole("listitem").filter({ hasText: /Comment 1 on Operators/ });
	await entry.getByRole("button", { name: "Read thread on Hacker News" }).tap();
	assert.equal(await page.locator("#app-list-topic").isVisible(), false);
	const detail = threadDetail(aside);
	await detail.getByText(/Comment 1 on Operators/).waitFor();
	await page.locator("#app-bar-back").tap();
	await detail.waitFor({ state: "hidden" });
	await page.locator('#app[data-stage="article"] .app-topic-article').waitFor();
	assert.equal(page.url(), address);
	await page.locator("#app-bar-back").tap();
	await page.locator('#app[data-stage="list"]').waitFor();
	assert.equal(new URL(page.url()).searchParams.has("topic"), false);
});

test("an unavailable and an empty conversation give way to replies from another known thread listed with zero", async (t) => {
	let available = false;
	const thread = { source: "lemmy", url: "https://lemmy.world/post/112233", title: "Harbor thread", comments: 0 };
	const reply = "The pilot boat followed the narrower channel.";
	const { page, context, aside, requests } = await openTopic(t, { threads: [thread], responses: [
		{ match: (url) => !available && url === hnItem(stories[0].id), status: 503 },
		{ match: (url) => url === hnItem(stories[1].id), json: { id: stories[1].id, kids: [] } },
		{ match: (url) => url.includes("/api/v3/comment/list?post_id=112233"), json: { comments: [
			{ comment: { id: 2, path: "0.2", content: reply }, creator: { name: "pilot" } }] } },
	] });
	await feedList(aside).getByText(reply, { exact: true }).waitFor();
	await aside.getByRole("button", { name: "Discussion sources" }).click();
	const sourceChoice = aside.getByRole("checkbox", { name: thread.title, exact: true }).locator("xpath=ancestor::div[contains(@class, 'source-menu-entry')][1]");
	assert.equal(await sourceChoice.getByRole("link").textContent(), "1 comment");
	await sourceChoice.getByRole("checkbox").press("Escape");
	assert.equal(await aside.getByText("Comments couldn’t be loaded.", { exact: true }).count(), 0);
	assert(requests.filter(({ url }) => url.includes("/api/v3/comment/list?post_id=112233")).every(({ anonymous }) => anonymous));
	const first = await sourceThread(page, threadURL(stories[0].id));
	await first.click();
	const detail = threadDetail(aside);
	await detail.getByRole("button", { name: "Retry comments" }).waitFor();
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
	await detail.getByRole("button", { name: "Back to discussions" }).click();
	assert(await first.evaluate((node) => node.getRootNode().activeElement === node));
	await feedList(aside).getByText(/Comment 1 on Inspectors/).waitFor();
	const second = await sourceThread(page, threadURL(stories[1].id));
	await second.click();
	await detail.getByText("No comments yet.", { exact: true }).waitFor();
});

test("a feed with only failed reads can retry and distinguishes an empty thread", async (t) => {
	let fail = true;
	const { aside } = await openTopic(t, { responses: [
		{ match: (url) => fail && url === hnItem(stories[0].id), status: 503 },
		{ match: (url) => stories.some((story) => url === hnItem(story.id)), json: { kids: [] } },
	] });
	await aside.getByText("Comments couldn’t be loaded.", { exact: true }).waitFor();
	fail = false;
	await aside.getByRole("button", { name: "Retry comments" }).click();
	await aside.getByText("No comments yet.", { exact: true }).waitFor();
	assert.equal(await aside.locator(".app-topic-comment-body").count(), 0);
});

test("automatic comments avoid social sessions even when those sources are enabled", async (t) => {
	const { page, context, aside, requests } = await openTopic(t, { signedIn: true });
	await feedList(aside).getByText(/Comment 1 on Inspectors/).waitFor();
	assert.equal(context.pages().length, 1);
	assert.deepEqual(requests.filter(({ url }) => /(^|\.)reddit\.com$|^x\.com$/.test(new URL(url).hostname) || decodeURIComponent(url).includes(stories[0].url)), []);
	const x = await sourceThread(page, "https://x.com/ports/status/123456");
	await context.route("https://x.com/ports/status/123456", (route) => route.fulfill({ contentType: "text/html", body: "<p>Original post</p>" }));
	const opened = context.waitForEvent("page");
	await x.click();
	const original = await opened;
	await original.waitForURL("https://x.com/ports/status/123456");
	assert.equal(page.url(), address);
	await original.close();
});

test("a private Collection topic loads its known saved discussion IDs without sending bookmark URLs", async (t) => {
	const bookmarks = stories.map((story, i) => ({ ...story, url: "https://private" + i + ".example/notes?draft=" + i,
		title: ["Ceramic glazes for beginners", "Firing ceramic glazes without defects"][i] }));
	const app = await launchApp({ sharedStore: true, extraStories: bookmarks,
		settings: { sources: { hn: true, reddit: true }, updateCheck: false, sourceRefreshMinutes: 0 },
		values: {
			"HNewhere:collection_filed": true, "HNewhere:collected_migrated": true,
			"HNewhere:collected": bookmarks.map(({ url, title }) => ({ key: url.slice(8), url, title, addedAt: now * 1000, previewOnOpen: true })),
			"HNewhere:favorites": [...bookmarks.map((story) => ({ ...story, key: "hn:" + story.id, kind: "discussion",
				page: story.url.slice(8), permalink: threadURL(story.id), addedAt: now * 1000 })),
				{ ...bookmarks[0], source: "reddit", id: "priv007", key: "reddit:priv007", kind: "discussion",
					page: bookmarks[0].url.slice(8), permalink: "https://www.reddit.com/r/clay/comments/priv007/glazes/", addedAt: now * 1000 }],
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
	const list = feedList(aside);
	await list.getByText(/Comment 1 on Ceramic glazes/i).waitFor();
	await list.getByText(/Comment 1 on Firing ceramic glazes/i).waitFor();
	assert(requests.filter(({ url }) => url.startsWith("https://hacker-news.firebaseio.com/")).every(({ anonymous }) => anonymous));
	assert.equal(page.url(), "https://backchnnl.app/");
	assert.deepEqual(requests.filter(({ url }) => url.startsWith(api)).map(({ url, method, anonymous, hasBody }) =>
		[url, method, anonymous, hasBody]), [[api, "GET", true, undefined]]);
	assert.equal(await page.locator('.app-topic-sources [data-topic-thread*="priv007"]').count(), 1);
	assert.equal(requests.some(({ url }) => [id, "priv007", ...bookmarks.map((story) => new URL(story.url).hostname)]
		.some((value) => decodeURIComponent(url).includes(value))), false);
});

test("the feed includes public Lobsters, Lemmy and Bluesky replies from their known permalinks", async (t) => {
	const threads = [
		{ source: "lobsters", url: "https://lobste.rs/s/h8r12/inspection", title: "Lobsters harbor thread", comments: 3 },
		{ source: "lemmy", url: "https://lemmy.world/post/112233", title: "Lemmy harbor thread", comments: 4 },
		{ source: "bsky", url: "https://bsky.app/profile/port.example/post/3lbview", title: "Port observer's thread", comments: 5 },
	];
	const did = "did:plc:abcdefghijklmnopqrstuvwx";
	const uri = "at://" + did + "/app.bsky.feed.post/3lbview";
	const post = (uri, text) => ({ uri, author: { did, handle: "port.example" }, record: { text } });
	const expected = ["Lobsters inspection reply", "Lemmy inspection reply", "Bluesky inspection reply"];
	const { aside, requests } = await openTopic(t, { threads, enabled: { hn: false }, responses: [
		{ match: (url) => url === "https://lobste.rs/s/h8r12.json", json: { comments: [
			{ short_id: "entry", commenting_user: "shipwright", comment: "<p>" + expected[0] + "</p>" }] } },
		{ match: (url) => url.includes("/api/v3/comment/list?post_id=112233"), json: { comments: [
			{ comment: { id: 2, path: "0.2", content: expected[1] }, creator: { name: "captain" } }] } },
		{ match: (url) => url === "https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=port.example", json: { did } },
		{ match: (url) => url.includes("/app.bsky.feed.getPostThread?") && new URL(url).searchParams.get("uri") === uri,
			json: { thread: { post: post(uri, "An observer explains the inspection."), replies: [{post: post(uri + "r", expected[2])}] } } },
	] });
	const list = feedList(aside);
	for (const [index, thread] of threads.entries()) {
		const row = list.getByRole("listitem").filter({ hasText: expected[index] });
		await row.getByText(expected[index], { exact: true }).waitFor();
		await row.getByRole("button").click();
		const detail = threadDetail(aside);
		await detail.getByText(expected[index], { exact: true }).waitFor();
		assert.equal(await detail.getByRole("link", { name: "Open original discussion" }).getAttribute("href"), thread.url);
		await detail.getByRole("button", { name: "Back to discussions" }).click();
	}
	assert.equal(await aside.getByText("An observer explains the inspection.", { exact: true }).count(), 0);
	assert(requests.filter(({ url }) => /public\.api\.bsky\.app|lobste\.rs|lemmy\.world/.test(url)).every(({ method, anonymous, hasBody }) => method === "GET" && anonymous && hasBody === undefined));

	assert.equal(requests.some(({ url }) => decodeURIComponent(url).includes(stories[0].url)), false);
});
async function readTopicThread(t, discussion, responses, values = {}) {
	const script = await readFile(process.env.BC_SCRIPT || new URL("../../HNewhere.user.js", import.meta.url), "utf8");
	const app = await launchApp({ sharedStore: true, values, responses,
		source: script.replace("init().catch(console.error);", "Object.assign(globalThis, { __readTopicThread: readAppTopicComments, __forgetTopicItems: forgetSyncedItems });") });
	t.after(() => app.browser.close());
	await app.page.goto("https://backchnnl.app/");
	await app.page.evaluate((discussion) => {
		window.__topicDiscussion = discussion;
		window.__topicPanel = { controller: new AbortController(), published: new Set([discussion.key]), actors: new Map(), revisions: new Map(), hnItems: new Map() };
	}, discussion);
	const read = (limit, automatic = true) => app.page.evaluate(async ([limit, automatic]) => {
		const data = await window.__readTopicThread(window.__topicPanel, window.__topicDiscussion, limit, automatic, () => true);
		return data && { more: data.more, failed: data.failed, deferred: data.deferred, rows: data.comments.map(({ comment, parent, depth }) => [comment.key, parent, depth]) };
	}, [limit, automatic]);
	return { ...app, read };
}

test("successive Hacker News reads retain the frontier through missing, deleted and deeply nested replies", async (t) => {
	const id = 9790, first = 979000, absent = 978900;
	const discussion = { source: "hn", key: "hn:" + id, id, rootKeys: [], commentCount: 81 };
	const responses = [
		{ match: (url) => url === hnItem(id), json: { id, type: "story", kids: [absent, first, first] } },
		{ match: (url) => url === hnItem(absent), text: "null" },
		...Array.from({ length: 81 }, (_, i) => ({
			match: (url) => url === hnItem(first + i),
			json: { id: first + i, type: "comment", by: "harborpilot", text: "Pier sounding " + i, time: now + i,
				parent: i ? first + i - 1 : id, kids: i === 80 ? [] : [first + i + 1], deleted: i === 0 },
		})),
	];
	const { read, requests } = await readTopicThread(t, discussion, responses);
	let previous = [];
	for (const limit of [8, 24, 48, 72, 100]) {
		const data = await read(limit);
		assert.equal(data.rows.length, Math.min(limit, 80));
		assert.deepEqual(data.rows.slice(0, previous.length), previous);
		assert.equal(data.more, limit < 80);
		previous = data.rows;
	}
	assert.deepEqual(previous.at(-1), ["hn:979080", "hn:979079", 80]);
	assert.equal(requests.filter(({ url }) => url.startsWith("https://hacker-news.firebaseio.com/")).length, 83);
});

test("sync forgets a Hacker News item being fetched before its old revision can refill the new reader", async (t) => {
	const discussion = { source: "hn", key: "hn:9700", id: 9700, rootKeys: [], commentCount: 1 };
	const id = 970000;
	let changed = false;
	const { read, page, requests } = await readTopicThread(t, discussion, [
		{ match: (url) => url === hnItem(9700), json: { id: 9700, type: "story", kids: [id] } },
		{ match: (url) => url === hnItem(id) && !changed, delay: 250, json: { id, type: "comment", parent: 9700, text: "Before sync" } },
		{ match: (url) => url === hnItem(id), json: { id, type: "comment", parent: 9700, text: "After sync" } },
	]);
	const previous = read(8);
	assert(await waitFor(() => requests.some(({ url }) => url === hnItem(id))));
	changed = true;
	const latest = await page.evaluate(async () => {
		const p = window.__topicPanel, d = window.__topicDiscussion;
		window.__forgetTopicItems([d], Array.from(p.hnItems.get(d.key) || []));
		p.revisions.set(d.key, 1);
		return (await window.__readTopicThread(p, d, 8, true, () => true, true)).comments[0].comment.bodyHTML;
	});
	assert.equal(latest, "After sync");
	assert.equal(await previous, null);
});

test("a partly failed Hacker News batch keeps successful siblings and retries only its failed child", async (t) => {
	const discussion = { source: "hn", key: "hn:9800", id: 9800, rootKeys: [], commentCount: 9 };
	const keys = [980010, 980011, 980012, 980013, 980014, 980015, 980016, 980017, 980018];
	let failed = false;
	const { read, requests } = await readTopicThread(t, discussion, [
		{ match: (url) => url === hnItem(9800), json: { id: 9800, type: "story", kids: keys } },
		{ match: (url) => url === hnItem(keys[1]) && !failed, get status() { failed = true; return 503; } },
		...keys.map((id) => ({ match: (url) => url === hnItem(id), json: { id, type: "comment", parent: 9800, text: "Dock comment " + id } })),
	]);
	const preview = await read(8);
	assert.equal(preview.rows.length, 8);
	const full = await read(18);
	assert.deepEqual(new Set(full.rows.map(([key]) => key)), new Set(keys.map((id) => "hn:" + id)));
	assert.equal(full.more, false);
	for (const id of keys) assert.equal(requests.filter(({ url }) => url === hnItem(id)).length, id === keys[1] ? 2 : 1);
});

test("a mostly deleted Hacker News thread bounds a single read and resumes after the inspected replies", async (t) => {
	const discussion = { source: "hn", key: "hn:9810", id: 9810, rootKeys: [], commentCount: 100 };
	const keys = Array.from({ length: 100 }, (_, i) => 981000 + i);
	const { read, requests } = await readTopicThread(t, discussion, [
		{ match: (url) => url === hnItem(9810), json: { id: 9810, type: "story", kids: keys } },
		...keys.map((id, i) => ({ match: (url) => url === hnItem(id), json: { id, type: "comment", parent: 9810, deleted: i < 95, text: "Dock comment " + id } })),
	]);
	const preview = await read(8);
	assert.equal(preview.rows.length, 0);
	assert(preview.more);
	assert(preview.deferred);
	assert(requests.length < 40, "a short preview inspects a bounded set of deleted comments");
	const full = await read(48);
	assert.equal(full.rows.length, 5);
	assert.equal(full.more, false);
	assert.equal(new Set(requests.map(({ url }) => url)).size, requests.length);
});

test("the inline thread keeps its continuation when an entire portion was removed", async (t) => {
	const keys = Array.from({ length: 191 }, (_, i) => 982000 + i);
	const { page, aside } = await openTopic(t, { responses: [
		{ match: (url) => url === hnItem(stories[0].id), json: { id: stories[0].id, type: "story", kids: keys } },
		...keys.map((id, i) => ({ match: (url) => url === hnItem(id), json: { id, type: "comment", deleted: i < 190, text: "The final harbor report." } })),
	] });
	await (await sourceThread(page, threadURL(stories[0].id))).click();
	const detail = threadDetail(aside), more = detail.getByRole("button", { name: "Show more replies" });
	await detail.locator(".app-topic-thread-content:not([aria-busy])").waitFor();
	assert(await more.isVisible(), "the reader can pass an initial block of removed comments");
	for (let i = 0; i < 5 && await more.isVisible(); i++) {
		await more.click();
		await detail.locator(".app-topic-feed-more:not([aria-busy])").waitFor({ state: "attached" });
	}
	await detail.getByText("The final harbor report.", { exact: true }).waitFor();
	assert.equal(await more.isVisible(), false);
});

test("published archive pages reach hundreds of replies once across overlapping timestamp boundaries and a retry", async (t) => {
	const discussion = { source: "reddit", id: "dock01", key: "reddit:dock01", commentCount: 1200 };
	const rows = Array.from({ length: 221 }, (_, i) => ({
		id: "port" + i, parent_id: i && i % 3 ? "t1_port" + (i - i % 3) : "t3_dock01", link_id: "t3_dock01",
		created_utc: now + Math.floor(i / 3), author: "mariner", score: i % 9, body: "Tide gauge " + i,
	}));
	let args, fail = false;
	const archive = {
		match(url) { const parsed = new URL(url); args = parsed.searchParams; return parsed.pathname === "/api/comments/search"; },
		get status() { return fail && args.has("after") ? 503 : 200; },
		get json() {
			const limit = Number(args.get("limit"));
			if (limit > 100) return { error: "limit must be <=100" };
			const items = rows.filter((row) => !args.has("after") || row.created_utc > Number(args.get("after")));
			if (args.get("sort") !== "asc") items.reverse();
			return { data: items.slice(0, limit) };
		},
	};
	const { read, requests } = await readTopicThread(t, discussion, [archive]);
	const early = await read(8);
	assert.equal(early.rows.length, 8);
	fail = true;
	const partial = await read(120);
	assert(partial?.failed && partial.more, "the failed continuation can be retried");
	assert(partial.rows.length > early.rows.length, "all available replies survive a failed next page");
	fail = false;
	for (const limit of [120, 180, 240]) {
		const data = await read(limit);
		assert(data, "the archive continuation succeeds within the provider's page limit");
		assert.equal(data.rows.length, Math.min(limit, 221));
		assert.deepEqual(data.rows.slice(0, early.rows.length), early.rows);
		assert.equal(data.more, limit < 221);
		assert.equal(new Set(data.rows.map(([key]) => key)).size, data.rows.length);
		if (!data.more) assert.deepEqual(data.rows.find(([key]) => key === "reddit:port220"), ["reddit:port220", "reddit:port219", 1]);
	}
	const hits = requests.filter(({ url }) => new URL(url).hostname === "arctic-shift.photon-reddit.com");
	assert.equal(new Set(hits.map(({ url }) => url)).size, hits.length - 1, "only the failed archive page repeats");
	assert(hits.length <= 14 && hits.every(({ url, anonymous }) => anonymous && Number(new URL(url).searchParams.get("limit")) <= 100));
	assert.equal(requests.some(({ url }) => /^(?:www\.)?reddit\.com$/.test(new URL(url).hostname)), false);
});

test("a full second of archived Reddit comments switches to bounded branches without skipping timestamp ties", async (t) => {
	const discussion = { source: "reddit", id: "dock22", key: "reddit:dock22", commentCount: 500 };
	const rows = Array.from({ length: 121 }, (_, i) => ({ id: "tie" + i, link_id: "t3_dock22", body: "Report " + i, author: "pilot",
		parent_id: i === 118 ? "t1_tie0" : i === 119 ? "t1_tie118" : "t3_dock22", created_utc: now + (i === 120 ? 1 : 0) }));
	const node = (i, replies = "") => ({ kind: "t1", data: { ...rows[i], replies } });
	const more = (ids, count) => ({ kind: "more", data: { children: ids, count } });
	let args;
	const arc = {
		match(url) { const parsed = new URL(url); args = parsed; return parsed.hostname === "arctic-shift.photon-reddit.com"; },
		get json() {
			const query = args.searchParams;
			if (args.pathname.endsWith("/search")) {
				return { data: rows.filter((row) => !query.has("after") || row.created_utc > Number(query.get("after"))).slice(0, Number(query.get("limit"))) };
			}
			if (args.pathname.endsWith("/ids")) return { data: query.get("ids").split(",").map((id) => rows.find((row) => row.id === id)) };
			if (query.has("parent_id")) return { data: [node(118, { data: { children: [node(119)] } })] };
			return { data: [node(0, { data: { children: [more(["tie118"], 2)] } }), more(rows.slice(1, 118).concat(rows[120]).map(({ id }) => id), 118)] };
		},
	};
	const { read, requests } = await readTopicThread(t, discussion, [arc]);
	await read(8);
	await read(90);
	const full = await read(160);
	assert.equal(full.rows.length, 121);
	assert.deepEqual(full.rows.find(([key]) => key === "reddit:tie119"), ["reddit:tie119", "reddit:tie118", 2]);
	assert.equal(full.more, false);
	assert.equal(new Set(requests.map(({ url }) => url)).size, requests.length);
	assert(requests.length <= 8 && requests.every(({ anonymous }) => anonymous));
});

test("Lemmy page limits use the paged listing and preserve parents across pages", async (t) => {
	const discussion = { source: "lemmy", id: 77885, key: "lemmy:77885", commentCount: 400 };
	const rows = Array.from({ length: 325 }, (_, i) => ({ comment: { id: i + 1, post_id: discussion.id,
		path: i === 324 ? "0.1.325" : "0." + (i + 1), content: "Quay depth " + i }, creator: { name: "pilot" } }));
	let args;
	const listing = {
		match(url) { const parsed = new URL(url); args = parsed.searchParams; return parsed.pathname === "/api/v3/comment/list"; },
		get json() {
			const size = Number(args.get("limit")), page = Number(args.get("page") || 1);
			return { comments: args.has("max_depth") ? rows.slice(0, 300) : rows.slice((page - 1) * size, page * size) };
		},
	};
	const { read, requests } = await readTopicThread(t, discussion, [listing]);
	for (const limit of [8, 48, 128, 256, 400]) {
		const data = await read(limit);
		assert.equal(data.rows.length, Math.min(limit, 325));
		assert.equal(data.more, limit < 325);
		if (!data.more) assert.deepEqual(data.rows.at(-1), ["lemmy:325", "lemmy:1", 1]);
	}
	const pages = requests.filter(({ url }) => new URL(url).pathname === "/api/v3/comment/list");
	assert.equal(new Set(pages.map(({ url }) => url)).size, pages.length);
	assert(pages.every(({ url, anonymous }) => anonymous && Number(new URL(url).searchParams.get("limit")) <= 50));
});

test("Lemmy exhausts the last supported listing page without offering a failing continuation", async (t) => {
	const discussion = { source: "lemmy", id: 1199, key: "lemmy:1199", commentCount: 12000 };
	let args;
	const { read, requests } = await readTopicThread(t, discussion, [{
		match(url) { const parsed = new URL(url); args = parsed.searchParams; return parsed.pathname === "/api/v3/comment/list"; },
		get status() { return Number(args.get("page")) > 100 ? 400 : 200; },
		get json() {
			const limit = Number(args.get("limit")), page = Number(args.get("page"));
			return { comments: Array.from({ length: limit }, (_, i) => {
				const id = (page - 1) * limit + i + 1;
				return { comment: { id, post_id: 1199, path: "0." + id, content: "Port " + id }, creator: { name: "pilot" } };
			}) };
		},
	}]);
	let data;
	for (let i = 0; i < 40; i++) {
		data = await read(5500);
		if (!data?.deferred) break;
	}
	assert.equal(data?.rows.length, 5000);
	assert.equal(data.more, false);
	assert.equal(requests.length, 100);
});

test("overlapping feed and detail reads share a busy Lobsters story payload", async (t) => {
	const discussion = { source: "lobsters", key: "lobsters:dock55", id: "dock55", commentCount: 125 };
	const comments = Array.from({ length: 125 }, (_, i) => ({ short_id: "c" + i, commenting_user: "pilot", comment: "<p>Port " + i + "</p>",
		parent_comment: i === 124 ? "c0" : null }));
	const { read, requests } = await readTopicThread(t, discussion, [
		{ match: (url) => url === "https://lobste.rs/s/dock55.json", delay: 80, json: { short_id: discussion.id, comments } },
	]);
	const [preview, detail, next] = await Promise.all([read(8), read(48, false), read(24)]);
	assert.equal(preview.rows.length, 8);
	assert.deepEqual(detail.rows.slice(0, 24), next.rows);
	const full = await read(160);
	assert.equal(full.rows.length, 125);
	assert.deepEqual(full.rows.at(-1), ["lobsters:c124", "lobsters:c0", 1]);
	assert.equal(full.more, false);
	assert.equal(requests.filter(({ url }) => url === "https://lobste.rs/s/dock55.json").length, 1);
});

test("Bluesky continues a deep reply branch at the last returned post and stops at a blocked branch", async (t) => {
	const actor = "did:plc:abcdefghijklmnopqrstuvwx";
	const uri = "at://" + actor + "/app.bsky.feed.post/port";
	const discussion = { source: "bsky", id: uri + 0, key: "bsky:" + uri + 0, actor, rkey: "port0", articleURL: stories[0].url };
	let args;
	const provider = {
		match(url) { const parsed = new URL(url); args = parsed.searchParams; return parsed.pathname.endsWith("app.bsky.feed.getPostThread"); },
		get json() {
			const start = Number(args.get("uri").slice(uri.length)), depth = Number(args.get("depth"));
			if (start === 27) return { thread: { $type: "app.bsky.feed.defs#blockedPost", uri: uri + start, blocked: true } };
			let node;
			for (let i = Math.min(27, start + depth); i >= start; i--) {
				node = { post: { uri: uri + i, replyCount: 1, author: { did: actor, handle: "port.example" }, record: { text: "Reading " + i } },
					...(node ? { replies: [node] } : {}) };
			}
			return { thread: node };
		},
	};
	const { read, requests } = await readTopicThread(t, discussion, [provider]);
	for (const limit of [4, 12, 24, 30]) {
		const data = await read(limit);
		assert.equal(data.rows.length, Math.min(27, limit));
		assert.equal(data.more, limit < 27);
	}
	const hits = requests.filter(({ url }) => new URL(url).pathname.endsWith("app.bsky.feed.getPostThread"));
	assert.equal(new Set(hits.map(({ url }) => new URL(url).searchParams.get("uri"))).size, hits.length);
	assert(hits.every(({ anonymous }) => anonymous));
});

test("Bluesky opens a partly returned branch once to collect its omitted siblings", async (t) => {
	const actor = "did:plc:abcdefghijklmnopqrstuvwx";
	const base = "at://" + actor + "/app.bsky.feed.post/";
	const make = (id, count, replies = []) => ({ post: { uri: base + id, replyCount: count, author: { did: actor, handle: "port.example" },
		record: { text: "Harbor " + id } }, replies });
	const discussion = { source: "bsky", key: "bsky:" + base + "rdf", id: base + "rdf", articleURL: stories[0].url, actor, rkey: "rdf" };
	const { read, requests } = await readTopicThread(t, discussion, [
		{ match: (url) => new URL(url).searchParams.get("uri") === base + "rdf", json: { thread: make("rdf", 1, [make("a", 2, [make("b", 0)])]) } },
		{ match: (url) => new URL(url).searchParams.get("uri") === base + "a", json: { thread: make("a", 2, [make("b", 0), make("c", 0)]) } },
	]);
	const full = await read(8);
	assert.equal(full.rows.length, 3);
	assert.deepEqual(full.rows.at(-1), ["bsky:" + actor + "/c", "bsky:" + actor + "/a", 1]);
	assert.equal(full.more, false);
	assert.equal(requests.length, 2);
});

test("an incomplete local X snapshot traverses all saved replies and exhausts its inaccessible continuation", async (t) => {
	const discussion = { source: "x", key: "x:12", id: "12", articleURL: stories[0].url };
	const records = Array.from({ length: 63 }, (_, i) => ({
		source: "x", id: String(12 + i), key: "x:" + (12 + i), author: "port", bodyHTML: "Tide report " + i,
		replyKeys: i === 62 ? ["x:999"] : ["x:" + (13 + i)],
	}));
	const values = { "HNewhere:thread_cache:x:maritime.example/inspection": { version: 1, at: Date.now(),
		rootKeys: ["x:12"], rootTimes: [], incomplete: true, rootMore: { ids: ["unknown"], count: 77 },
		comments: Object.fromEntries(records.map((comment) => [comment.key, comment])) } };
	const { read, requests } = await readTopicThread(t, discussion, [], values);
	assert.equal((await read(8)).rows.length, 8);
	const full = await read(100);
	assert.equal(full.rows.length, 62);
	assert.equal(full.more, false);
	assert.deepEqual(full.rows.at(-1), ["x:74", "x:73", 61]);
	assert.equal(requests.some(({ url }) => /(^|\.)x\.com$/.test(new URL(url).hostname)), false);
});

test("published Reddit replies load by post ID from the anonymous archive without a social session", async (t) => {
	const getArchive = (url) => new URL(url).hostname === "arctic-shift.photon-reddit.com";
	const supplied = "The archive lists the change in tidal height.";
	const { aside, requests, context } = await openTopic(t, { signedIn: true, enabled: { hn: false, x: false },
		responses: [{ match: getArchive, json: { data: [
			{ id: "tide1", link_id: "t3_abcde", author: "surveyor", created_utc: now, body: supplied },
			{ id: "outside", link_id: "t3_other", author: "wrong-thread", body: "From an unrelated submission." },
		] } }] });
	await feedList(aside).getByText(supplied, { exact: true }).waitFor();
	assert.equal(await aside.getByText("From an unrelated submission.").count(), 0);
	const arctic = requests.filter(({ url }) => getArchive(url));
	assert.equal(arctic.length, 1);
	const endpoint = new URL(arctic[0].url);
	assert.equal(endpoint.pathname, "/api/comments/search");
	assert.equal(endpoint.searchParams.get("link_id"), "abcde");
	assert(Number(endpoint.searchParams.get("limit")) > 0 && Number(endpoint.searchParams.get("limit")) <= 50);
	assert.equal(arctic[0].anonymous, true);
	assert.equal(arctic[0].method, "GET");
	assert.equal(arctic[0].hasBody, undefined);
	assert.equal(requests.some(({ url }) => /(^|\.)reddit\.com$/.test(new URL(url).hostname) || decodeURIComponent(url).includes(stories[0].url)), false);
	assert.equal(context.pages().length, 1);
});

test("cached X replies remain available without accessing X or showing the original post", async (t) => {
	const root = { source: "x", key: "x:123456", id: "123456", author: "ports", bodyHTML: "Original X post", replyKeys: ["x:123459"] };
	const reply = { source: "x", key: "x:123459", id: "123459", author: "pilot", createdAt: now, bodyHTML: "An actual saved X reply", replyKeys: [] };
	const values = { "HNewhere:thread_cache:x:maritime.example/inspection": { version: 1, at: Date.now(),
		rootKeys: [root.key], rootTimes: [], comments: { [root.key]: root, [reply.key]: reply } } };
	const { aside, requests } = await openTopic(t, { signedIn: true, enabled: { hn: false, reddit: false }, values });
	const row = feedList(aside).getByRole("listitem").filter({ hasText: "An actual saved X reply" });
	await row.getByText("An actual saved X reply").waitFor();
	assert.equal(await aside.getByText("Original X post").count(), 0);
	assert.equal(await row.getByRole("link").getAttribute("href"), "https://x.com/pilot/status/123459");
	await row.getByRole("button", { name: "Read thread on X" }).click();
	await threadDetail(aside).getByText("An actual saved X reply").waitFor();
	assert.equal(requests.some(({ url }) => /(^|\.)x\.com$/.test(new URL(url).hostname)), false);
});

test("a Bluesky post with zero replies never appears as a comment", async (t) => {
	const did = "did:plc:abcdefghijklmnopqrstuvwx";
	const thread = { source: "bsky", url: "https://bsky.app/profile/" + did + "/post/rootonly", title: "Shared harbor report", comments: 1 };
	const uri = "at://" + did + "/app.bsky.feed.post/rootonly";
	const { aside, requests } = await openTopic(t, { threads: [thread], enabled: { hn: false }, responses: [
		{ match: (url) => url.includes("app.bsky.feed.getPostThread") && new URL(url).searchParams.get("uri") === uri,
			json: { thread: { post: { uri, author: { did, handle: "port.example" }, record: { text: "Here is the original article." }, replyCount: 0 }, replies: [] } } },
	] });
	await aside.getByText("No comments yet.", { exact: true }).waitFor();
	assert.equal(await aside.locator(".app-topic-comment-body").count(), 0);
	assert.equal(await aside.getByText("Here is the original article.").count(), 0);
	assert.equal(requests.filter(({ url }) => url.startsWith("https://public.api.bsky.app/")).length, 1);
});


test("the first page samples every enabled discussion source even when a provider reported zero replies", async (t) => {
	const additional = Array.from({ length: 8 }, (_, i) => ({ source: "hn", url: threadURL(71000 + i),
		title: "Harbor survey from station " + i, comments: 120 - i }));
	const responses = additional.flatMap((_, i) => {
		const id = 71000 + i;
		const kids = Array.from({ length: 9 }, (_, j) => id * 100 + j);
		return [{ match: (url) => url === hnItem(id), json: { id, kids } },
			...kids.map((kid) => ({ match: (url) => url === hnItem(kid), json: { id: kid, by: "observer", time: now, text: "Reading " + kid } }))];
	});
	const text = "The harbor launch found the missing measurement.";
	const { aside, requests } = await openTopic(t, { phone: true, threads: [...additional,
		{ source: "lemmy", url: "https://lemmy.world/post/112233", title: "Independent checks", comments: 0 }], responses: [...responses,
		{ match: (url) => url.includes("/api/v3/comment/list?post_id=112233"), json: { comments: [
			{ comment: { id: 74, path: "0.74", content: text }, creator: { name: "pilot" }, counts: { score: 33 } }] } },
	] });
	await feedList(aside).getByText(text, { exact: true }).waitFor();
	assert(requests.some(({ url }) => url.includes("/api/v3/comment/list?post_id=112233")));
});

const harborBrief = [
	"Inspectors surveyed each entrance to the harbor at low tide. They used soundings from the pilot boat to check the measurements recorded by the shore stations.",
	"The first report covers the north entrance. The current there moves sand across the navigation channel between surveys, so the published depth can change throughout the season.",
	"The second report compares the observations made across the channel. The pilots will make another pass at high tide before the harbor authority revises its charts.",
];

test("a sparse topic checks a bounded group of public posts and continues when the reader reaches the discussion", async (t) => {
	const did = "did:plc:abcdefghijklmnopqrstuvwx";
	const threads = Array.from({ length: 10 }, (_, i) => ({ source: "bsky", url: "https://bsky.app/profile/" + did + "/post/root" + i,
		title: "Shared harbor report " + i, comments: 0 }));
	const asPost = (uri, text) => ({ uri, author: { did, handle: "port.example" }, record: { text } });
	const responses = threads.map((thread, i) => {
		const uri = "at://" + did + "/app.bsky.feed.post/root" + i;
		return { match: (url) => new URL(url).searchParams.get("uri") === uri,
			json: { thread: { post: asPost(uri, thread.title), replies: i === 8 ? [{ post: asPost(uri + "reply", "A reply to the ninth known thread.") }] : [] } } };
	});
	const { aside, requests } = await openTopic(t, { phone: true, viewport: { width: 320, height: 320 }, brief: harborBrief, threads, enabled: { hn: false }, responses });
	const sent = () => requests.filter(({ url }) => url.includes("app.bsky.feed.getPostThread"));
	await aside.getByText("No replies found in the discussions checked.", { exact: true }).waitFor();
	assert.equal(sent().length, 8);
	assert.equal(await aside.locator(".app-topic-comment-body").count(), 0);
	await aside.getByText("No replies found in the discussions checked.", { exact: true }).evaluate((el) => el.scrollIntoView({ block: "center" }));
	await feedList(aside).getByText("A reply to the ninth known thread.", { exact: true }).waitFor();
	assert(sent().length > 8 && sent().length <= 10);
});

test("a visible empty feed waits for another scroll before checking more sparse discussions", async (t) => {
	const did = "did:plc:abcdefghijklmnopqrstuvwx";
	const threads = Array.from({ length: 27 }, (_, i) => ({ source: "bsky", comments: 0, title: "Survey " + i,
		url: "https://bsky.app/profile/" + did + "/post/check" + String(i).padStart(2, "0") }));
	const responses = threads.map((thread, i) => {
		const uri = "at://" + did + "/app.bsky.feed.post/" + thread.url.split("/").pop();
		const post = (uri, text) => ({ uri, author: { did, handle: "port.example" }, record: { text } });
		return { match: (url) => new URL(url).searchParams.get("uri") === uri, json: { thread: { post: post(uri, thread.title),
			replies: i === 25 ? [{ post: post(uri + "r", "A surveyor replied to the later report.") }] : [] } } };
	});
	const { page, aside, requests } = await openTopic(t, { phone: true, viewport: { width: 320, height: 320 }, brief: harborBrief, threads, enabled: { hn: false }, responses });
	const checked = () => requests.filter(({ url }) => url.includes("app.bsky.feed.getPostThread")).length;
	const status = aside.getByText("No replies found in the discussions checked.", { exact: true });
	await status.evaluate((node) => node.scrollIntoView({ block: "center" }));
	assert(await waitFor(() => checked() >= 16));
	assert.equal(await waitFor(() => checked() > 16, 600), false, "an unmoving page does not scan every empty discussion");
	for (const expected of [24, 27]) {
		if (checked() >= expected) continue;
		await status.scrollIntoViewIfNeeded();
		const rect = await status.boundingBox();
		await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
		await page.mouse.wheel(0, 250);
		assert(await waitFor(() => checked() >= expected));
	}
	await feedList(aside).getByText("A surveyor replied to the later report.", { exact: true }).waitFor();
});

test("a hidden member and deleted comments do not appear in the feed or its source requests", async (t) => {
	const removed = 976001, placeholder = 976002, useful = 976003;
	const hidden = stories[1];
	const { aside, requests } = await openTopic(t, { values: { "HNewhere:hidden_stories": [{ key: hidden.url.slice(8), url: hidden.url, title: hidden.title }] },
		responses: [
			{ match: (url) => url === hnItem(stories[0].id), json: { id: stories[0].id, kids: [removed, placeholder, useful] } },
			{ match: (url) => url === hnItem(removed), json: { id: removed, deleted: true, by: "gone", text: "Deleted for privacy." } },
			{ match: (url) => url === hnItem(placeholder), json: { id: placeholder, by: "gone", text: "<p>[removed]</p>" } },
			{ match: (url) => url === hnItem(useful), json: { id: useful, by: "salvor", text: "<p>The channel was marked at high tide.</p>" } },
		] });
	const list = feedList(aside);
	await list.getByText("The channel was marked at high tide.").waitFor();
	assert.equal(await list.getByRole("listitem").count(), 1);
	assert.equal(requests.some(({ url }) => url === hnItem(hidden.id)), false);
	assert.doesNotMatch(await list.textContent(), /Deleted for privacy|\[removed\]|gone/);
});

for (const [name, values] of [
	["off tier", { "HNewhere:reddit_tier": { tier: "off", timestamp: Date.now() } }],
	["cooldown", { "HNewhere:reddit_poll": { until: Date.now() + 600000, status: "limited" } }],
]) {
	test("Reddit's " + name + " suppresses archive traffic while another source still supplies replies", async (t) => {
		const { aside, requests } = await openTopic(t, { signedIn: true, values });
		await feedList(aside).getByText(/Comment 1 on Operators/).waitFor();
		assert.equal(requests.some(({ url }) => /reddit\.com$/.test(new URL(url).hostname)), false);
	});
}

test("a comment request finishing after opening a source article leaves that article in place", async (t) => {
	const { page, aside } = await openTopic(t, { holdURL: hnItem(stories[1].id) });
	await feedList(aside).getByText(/Comment 1 on Inspectors/).waitFor();
	await page.waitForFunction(() => typeof window.__releaseTopicResponse === "function");
	await page.getByRole("tab", { name: "By link", exact: true }).click();
	await page.locator("#app-list-body").getByRole("link", { name: stories[0].title, exact: true }).click();
	assert(await waitFor(async () => (await page.locator("#app-article-open").getAttribute("href")) === stories[0].url));
	await page.evaluate(() => window.__releaseTopicResponse());
	await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
	assert.equal(await page.locator(".app-topic-discussions").count(), 0);
	assert.equal(await page.locator("#app-article-open").getAttribute("href"), stories[0].url);
});

test("a public front-page Reddit post opens its archive when the Worker lists only its article", async (t) => {
	const posted = { ...stories[1], source: "reddit", id: "port002", key: stories[1].url.slice(8), site: "r/technology",
		permalink: "https://www.reddit.com/r/technology/comments/port002/harbor/", descendants: 100, kind: "discussion" };
	const values = { "HNewhere:frontpage_feed:technology/reddit/subreddits/technology+Futurology": { timestamp: Date.now(), stories: [posted] } };
	const { page, aside, requests } = await openTopic(t, { signedIn: true, values, responses: [
		{ match: (url) => new URL(url).hostname === "arctic-shift.photon-reddit.com" && new URL(url).searchParams.get("link_id") === "port002",
			json: { data: [{ id: "berth", link_id: "t3_port002", author: "pilot", body: "The berth was open during inspection." }] } },
	] });
	await (await sourceThread(page, posted.permalink)).waitFor();
	await feedList(aside).getByText("The berth was open during inspection.", { exact: true }).waitFor();
	const reads = requests.filter(({ url }) => new URL(url).searchParams.get("link_id") === "port002");
	assert.equal(reads.length, 1);
	assert(reads[0].anonymous && reads[0].method === "GET" && reads[0].hasBody === undefined);
	assert.equal(requests.some(({ url }) => decodeURIComponent(url).includes(stories[1].url)), false);
});

test("a missing comment response is reported as unavailable", async (t) => {
	const { aside } = await openTopic(t, { responses: [
		{ match: (url) => url === hnItem(stories[0].id), json: { id: stories[0].id, kids: [978012] } },
		{ match: (url) => url === hnItem(978012), status: 503 },
		{ match: (url) => url === hnItem(stories[1].id), json: { id: stories[1].id, kids: [] } },
	] });
	await aside.getByText("Comments couldn’t be loaded.", { exact: true }).waitFor();
	assert.equal(await aside.locator(".app-topic-comment-body").count(), 0);
});

test("Back from a differently ordered full Reddit thread restores the original archived reply and focus", async (t) => {
	const raw = (id, body) => ({ id, body, link_id: "t3_abcde", parent_id: "t3_abcde", author: "bridgepilot", created_utc: now });
	const archived = Array.from({ length: 12 }, (_, i) => raw("saved" + i, "Archived observation " + i));
	const children = Array.from({ length: 10 }, (_, i) => ({ kind: "t1", data: raw("full" + i, "Full conversation reply " + i) }));
	const { aside, page } = await openTopic(t, { signedIn: true, enabled: { hn: false, x: false }, responses: [
		{ match: (url) => url.includes("/api/comments/search?"), json: { data: archived } },
		{ match: (url) => url.includes("/api/comments/tree?"), json: { data: children } },
		{ match: (url) => new URL(url).hostname === "www.reddit.com" && url.includes("/comments/abcde/") && url.includes(".json"), json: [null, { data: { children } }] },
	] });
	const list = feedList(aside);
	const original = list.getByRole("listitem").filter({ hasText: "Archived observation 0" }).getByRole("button");
	await original.focus();
	const keys = await list.getByRole("link").evaluateAll((links) => links.map((link) => link.href));
	await original.press("Enter");
	await threadDetail(aside).getByText("Full conversation reply 0", { exact: true }).waitFor();
	await page.keyboard.press("Escape");
	await list.waitFor();
	assert.deepEqual(await list.getByRole("link").evaluateAll((links) => links.map((link) => link.href)), keys);
	assert(await original.evaluate((node) => node.getRootNode().activeElement === node));
});

const asideSort = (aside) => aside.getByRole("button", { name: /^Sort (Best|Oldest|Newest)$/ });
const asideSources = (aside) => aside.getByRole("button", { name: /discussion sources/i });

test("the topic header matches the regular discussion header's controls and alignment", async (t) => {
	const { aside } = await openTopic(t);
	const measure = (button) => {
		const bar = button.closest("aside, header");
		const sort = bar.querySelector(".settings-select-toggle");
		const left = sort.getBoundingClientRect(), right = button.getBoundingClientRect();
		const heading = bar.querySelector("h2")?.getBoundingClientRect();
		const size = (node, box) => [box.width, box.height, getComputedStyle(node).borderTopLeftRadius, getComputedStyle(node).borderTopWidth];
		return { buttons: [size(sort, left), size(button, right)], gap: right.left - left.right,
			titleAligned: heading && heading.right <= left.left && Math.abs((heading.top + heading.bottom - right.top - right.bottom) / 2) <= 2 };
	};
	const sources = asideSources(aside);
	const topic = await sources.evaluate(measure);
	const regular = await launchApp({ sharedStore: true, settings: { sources: { hn: true }, frontPageMode: "sources", updateCheck: false } });
	t.after(() => regular.browser.close());
	await regular.page.goto("https://backchnnl.app/");
	await regular.page.locator("#app-list-body .browse-title-link").first().click();
	await regular.page.locator("#comments-content .comment[data-comment-id]").first().waitFor();
	await regular.page.locator(".discussion-progress-strip:not([aria-hidden=true])").waitFor({ state: "hidden" });
	const sidebar = await regular.page.locator("#app-discussion-meta .page-header-disclosure:visible").evaluate(measure);
	assert.deepEqual(topic.buttons, sidebar.buttons);
	assert(Math.abs(topic.gap - sidebar.gap) <= 1, `topic gap ${topic.gap}, sidebar gap ${sidebar.gap}`);
	assert(topic.titleAligned);
	assert(await sources.evaluate((button) => button.textContent.trim() === "" && Boolean(button.title)));
});

for (const [width, withoutPopover, paper] of [[1280, false, "paper"], [320, false, "night"], [320, true, "sepia"]]) {
	test(`the topic Sources menu fits at ${width}px in ${paper}${withoutPopover ? " without native popovers" : ""} and its last discussion is reachable`, async (t) => {
		const threads = Array.from({ length: 16 }, (_, i) => ({ source: "hn", url: threadURL(92000 + i),
			title: "Harbor inspection report from the coast guard, field office " + (i + 1), comments: 1 }));
		const { page, aside } = await openTopic(t, { phone: width === 320, threads, values: { "HNewhere:reader_page": paper } });
		if (withoutPopover) {
			await page.addInitScript(() => { delete HTMLElement.prototype.showPopover; });
			await page.reload();
		}
		await page.setViewportSize({ width, height: width === 320 ? 450 : 600 });
		await feedList(aside).getByText(/Comment 1 on Inspectors/).waitFor();
		const sources = asideSources(aside);
		if (width === 320) await sources.evaluate((el) => window.scrollBy(0, el.getBoundingClientRect().top - 48));
		await sources.click();
		const menu = aside.getByRole("group", { name: "Filter discussions by source" });
		if (withoutPopover) assert(await page.locator("#app-bar-back").isHidden(), "the floating Back button yields to the open menu");
		const disclosure = menu.getByRole("button", { name: /Hacker News discussions/i });
		const arrow = () => disclosure.evaluate((button) => getComputedStyle(button, "::after").transform);
		const foldedArrow = await arrow();
		assert.equal(await disclosure.getAttribute("aria-expanded"), "false");
		if (width === 320) {
			const folded = await disclosure.evaluate((button) => {
				const menu = button.closest(".source-menu");
				const rect = button.getBoundingClientRect();
				const hit = button.getRootNode().elementFromPoint(rect.right - 8, rect.top + rect.height / 2);
				const chevron = getComputedStyle(button, "::after");
				return { reachable: button.contains(hit) && rect.width >= 44 && rect.height >= 40,
					visible: parseFloat(chevron.borderRightWidth) > 0 && chevron.borderRightColor === getComputedStyle(button).color &&
						chevron.borderRightColor !== getComputedStyle(menu).backgroundColor, paper: getComputedStyle(menu).backgroundColor };
			});
			assert.deepEqual(folded, { reachable: true, visible: true, paper: paper === "night" ? "rgb(18, 18, 18)" : "rgb(244, 236, 216)" });
		}
		await disclosure.press("Enter");
		assert.notEqual(await arrow(), foldedArrow);
		const last = menu.getByRole("checkbox").last();
		await menu.evaluate((el) => { el.scrollTop = el.scrollHeight; });
		const geometry = await menu.evaluate((el) => {
			const pane = el.closest(".app-reader-scroll").getBoundingClientRect();
			const box = el.getBoundingClientRect(), last = [...el.querySelectorAll("input")].at(-1).getBoundingClientRect();
			const hit = el.getRootNode().elementFromPoint(last.x + last.width / 2, last.y + last.height / 2);
			let edgesReachable = true;
			for (let y = box.top + 14; y < box.bottom - 6; y += 12) {
				for (const x of [box.left + 16, box.right - 16]) edgesReachable &&= el.contains(el.getRootNode().elementFromPoint(x, y));
			}
			return { width: Math.round(box.width), within: box.left >= Math.max(0, pane.left) && box.right <= Math.min(innerWidth, pane.right) + 1 &&
				box.top >= Math.max(0, pane.top) && box.bottom <= Math.min(innerHeight, pane.bottom) + 1,
				usable: edgesReachable && el.contains(hit) && el.scrollWidth <= el.clientWidth + 1 };
		});
		assert.deepEqual(geometry, { width: 300, within: true, usable: true });
		await last.uncheck();
		assert.equal(await last.isChecked(), false);
		await last.press("Escape");
		assert(await menu.isHidden());
		if (withoutPopover) assert(await page.locator("#app-bar-back").isVisible());
		assert(await sources.evaluate((el) => el.matches(":focus")));
		await sources.press("Enter");
		assert.equal(await disclosure.getAttribute("aria-expanded"), "true");
		assert(!(await last.isChecked()));
		assert(await last.evaluate((input) => input.matches(":focus")));
		assert(await waitFor(() => last.evaluate((input) => {
			const row = input.getBoundingClientRect();
			return input.getRootNode().elementFromPoint(row.x + row.width / 2, row.y + row.height / 2) === input;
		})), "the focused discussion is still reachable after reopening the menu");
	});
}

test("scrolling a phone topic toolbar out of view dismisses its Sources menu", async (t) => {
	const { page, aside } = await openTopic(t, { phone: true });
	const toggle = asideSources(aside);
	await feedList(aside).getByText(/Comment 1 on Inspectors/).waitFor();
	await toggle.click();
	const menu = aside.getByRole("group", { name: "Filter discussions by source" });
	await menu.waitFor();
	await toggle.evaluate((el) => window.scrollBy(0, el.getBoundingClientRect().bottom + 100));
	assert(await waitFor(() => toggle.evaluate((el) => el.getBoundingClientRect().bottom <= 0)));
	await menu.waitFor({ state: "hidden" });
	assert.equal(await toggle.getAttribute("aria-expanded"), "false");
});

test("Best places the leading HN, Reddit and Lemmy replies together across article links", async (t) => {
	const lemmy = { sourceIndex: 1, source: "lemmy", url: "https://lemmy.world/post/112233", title: "Pilot reports", comments: 2 };
	const { aside } = await openTopic(t, { signedIn: true, enabled: { x: false }, threads: [lemmy],
		values: { "HNewhere:seen_comments": { "hn:9741": now - 300 } }, responses: [
			{ match: (url) => url === hnItem(9741), json: { id: 9741, kids: [982101, 982102] } },
			{ match: (url) => url === hnItem(9742), json: { id: 9742, kids: [] } },
			{ match: (url) => url === hnItem(982101), json: { id: 982101, type: "comment", by: "pilot", time: now - 600, text: "First HN sounding" } },
			{ match: (url) => url === hnItem(982102), json: { id: 982102, type: "comment", by: "pilot", time: now - 120, text: "Second HN sounding" } },
			{ match: (url) => new URL(url).searchParams.get("link_id") === "abcde", json: { data: [
				{ id: "bridge", link_id: "t3_abcde", parent_id: "t3_abcde", author: "surveyor", body: "Reddit bridge survey", score: 9000, created_utc: now - 700 },
				{ id: "wharf", link_id: "t3_abcde", parent_id: "t1_bridge", author: "sailor", body: "Reddit wharf correction", score: 19000, created_utc: now - 500 },
			] } },
			{ match: (url) => new URL(url).searchParams.get("post_id") === "112233", json: { comments: [
				{ comment: { id: 81, path: "0.81", content: "Lemmy berth question" }, creator: { name: "captain" }, counts: { score: 0 } },
				{ comment: { id: 82, path: "0.81.82", content: "Lemmy berth measurements" }, creator: { name: "pilot" }, counts: { score: 2 } },
			] } },
		] });
	const list = feedList(aside);
	const bodies = () => list.locator(".app-topic-comment-body").allTextContents();
	assert(await waitFor(async () => (await bodies()).length === 6));
	const best = await bodies();
	assert.deepEqual(new Set(best.slice(0, 3)), new Set(["First HN sounding", "Reddit wharf correction", "Lemmy berth measurements"]));
	await asideSort(aside).click();
	await aside.getByRole("menuitemcheckbox", { name: "Prioritize unread comments" }).click();
	assert(await waitFor(async () => (await bodies())[0] === "Second HN sounding"));
	await asideSort(aside).click();
	await aside.getByRole("menuitemcheckbox", { name: "Prioritize unread comments" }).click();
	assert(await waitFor(async () => (await bodies()).join() === best.join()));
});

test("Best uses Lobsters votes, Bluesky likes and replies, and replies observed in an X snapshot", async (t) => {
	const did = "did:plc:abcdefghijklmnopqrstuvwx";
	const uri = "at://" + did + "/app.bsky.feed.post/";
	const sky = (id, text, likes, replies) => ({ post: { uri: uri + id, author: { did, handle: "port.example" },
		record: { text, createdAt: new Date((now - 600) * 1000).toISOString() }, likeCount: likes, replyCount: replies } });
	const x = (id, bodyHTML, replyKeys) => ({ source: "x", id, key: "x:" + id, bodyHTML, author: "pilot", score: null, createdAt: now - 500, replyKeys });
	const saved = [x("123456", "Original harbor post", ["x:123457", "x:123458"]), x("123457", "X harbor notice", []),
		x("123458", "X harbor answer", ["x:123459"]), x("123459", "X follow-up", [])];
	const { aside } = await openTopic(t, { signedIn: true, enabled: { hn: false, reddit: false }, threads: [
		{ source: "lobsters", url: "https://lobste.rs/s/h8r12/inspection", title: "Harbor surveying tools", comments: 2 },
		{ sourceIndex: 1, source: "bsky", url: "https://bsky.app/profile/" + did + "/post/report", title: "Sailors report", comments: 3 },
	], values: { "HNewhere:thread_cache:x:maritime.example/inspection": { version: 1, at: Date.now(), rootKeys: [saved[0].key], rootTimes: [],
		comments: Object.fromEntries(saved.map((row) => [row.key, row])) } }, responses: [
		{ match: (url) => url === "https://lobste.rs/s/h8r12.json", json: { comments: [
			{ short_id: "question", commenting_user: "pilot", comment: "<p>Lobsters survey question</p>", score: 1 },
			{ short_id: "answer", parent_comment: "question", commenting_user: "engineer", comment: "<p>Lobsters corrected calculation</p>", score: 4 },
		] } },
		{ match: (url) => new URL(url).searchParams.get("uri") === uri + "report", json: { thread: { ...sky("report", "Harbor report", 40, 3), replies: [
			sky("sky1", "Bluesky passing mention", 0, 0), sky("sky2", "Bluesky chart", 7, 0),
			{ ...sky("sky3", "Bluesky chart discussion", 7, 4), replies: [
				{ $type: "app.bsky.feed.defs#blockedPost", uri: uri + "hidden", blocked: true, author: { did } },
			] },
		] } } },
	] });
	const list = feedList(aside);
	assert(await waitFor(async () => (await list.locator(".app-topic-comment-source").evaluateAll((nodes) =>
		new Set(nodes.map((link) => new URL(link.href).hostname)).size)) === 3));
	const bodies = await list.locator(".app-topic-comment-body").allTextContents();
	assert.deepEqual(new Set(bodies.slice(0, 3)), new Set(["Lobsters corrected calculation", "Bluesky chart discussion", "X harbor answer"]));
});

test("several discussions on one platform leave room for a smaller source's second reply in Best", async (t) => {
	const did = "did:plc:abcdefghijklmnopqrstuvwx";
	const uri = "at://" + did + "/app.bsky.feed.post/";
	const sky = (id, text, likes) => ({ post: { uri: uri + id, author: { did, handle: "port.example" }, record: { text }, likeCount: likes } });
	const threads = ["port1", "port2", "port3", "port4"].map((id, i) => ({ sourceIndex: i % 2, source: "lobsters",
		url: "https://lobste.rs/s/" + id + "/harbor", title: "Survey " + id, comments: 1 }));
	threads.push({ sourceIndex: 1, source: "bsky", url: "https://bsky.app/profile/" + did + "/post/inlet", title: "Inlet observer", comments: 2 });
	const results = [];
	for (const reverse of [false, true]) {
		const { aside } = await openTopic(t, { threads: reverse ? [...threads].reverse() : threads, enabled: { hn: false },
			responses: [
				{ match: (url) => new URL(url).searchParams.get("uri") === uri + "inlet", delay: reverse ? 0 : 100,
					json: { thread: { ...sky("inlet", "Inlet report", 0), replies: [
						sky("upper", "Upper inlet soundings", 7), sky("lower", "Lower inlet soundings", 6),
					] } } },
				...["port1", "port2", "port3", "port4"].map((id) => ({ match: (url) => url === "https://lobste.rs/s/" + id + ".json",
					delay: reverse && id === "port1" ? 100 : 0, json: { comments: [
						{ short_id: id + "c", commenting_user: "pilot", comment: "<p>Survey reply on " + id + "</p>", score: 40 },
					] } })),
			] });
		const bodies = feedList(aside).locator(".app-topic-comment-body");
		assert(await waitFor(async () => (await bodies.count()) === 6));
		results.push(await bodies.allTextContents());
	}
	assert.deepEqual(results[0], results[1], "changing source and response order keeps the same settled ranking");
	assert(results[0].indexOf("Lower inlet soundings") < results[0].findLastIndex((body) => body.includes("Survey reply")),
		"the second Bluesky reply competes with leaders from four separate Lobsters conversations");
});

test("Best compares engagement across discussions on the same site and preserves HN's native order", async (t) => {
	const did = "did:plc:abcdefghijklmnopqrstuvwx";
	const uri = "at://" + did + "/app.bsky.feed.post/";
	const sky = (id, likes, age) => ({ post: { uri: uri + id, author: { did, handle: "port.example" },
		record: { text: id, createdAt: new Date((now - age) * 1000).toISOString() }, likeCount: likes } });
	const lemmy = (id, score, replies, content, age) => ({ comment: { id, path: "0." + id, content,
		published: new Date((now - age) * 1000).toISOString() }, creator: { name: "pilot" }, counts: { score, child_count: replies } });
	const hn = (id, text, age, kids = []) => ({ match: (url) => url === hnItem(id), json: { id, type: "comment", by: "pilot", time: now - age, text, kids } });
	const { aside } = await openTopic(t, { threads: [
		...["small", "large"].map((id, sourceIndex) => ({ sourceIndex, source: "bsky", url: "https://bsky.app/profile/" + did + "/post/" + id,
			title: "Observer " + id, comments: sourceIndex + 1 })),
		...[112231, 112232, 112233].map((id, i) => ({ sourceIndex: i % 2, source: "lemmy", url: "https://lemmy.world/post/" + id,
			title: "Survey " + id, comments: 1 })),
	], responses: [
		{ match: (url) => url === hnItem(9741), json: { id: 9741, kids: [982201] } },
		{ match: (url) => url === hnItem(9742), json: { id: 9742, kids: [982202, 982203] } },
		hn(982201, "Quiet HN leader", 10), hn(982202, "Active HN leader", 1000, [982204]), hn(982203, "Active HN runner-up", 100, [982205, 982206]),
		hn(982204, "Recorded fathoms", 50), hn(982205, "First follow-up", 50), hn(982206, "Second follow-up", 50),
		{ match: (url) => new URL(url).searchParams.get("uri") === uri + "small", json: { thread: { ...sky("small", 0, 10), replies: [sky("Unliked", 0, 10)] } } },
		{ match: (url) => new URL(url).searchParams.get("uri") === uri + "large", json: { thread: { ...sky("large", 50, 1500),
			replies: [sky("Acclaimed", 23, 1500), sky("Liked", 16, 1000)] } } },
		{ match: (url) => new URL(url).searchParams.get("post_id") === "112231", json: { comments: [lemmy(301, 3, 0, "Unremarkable survey", 10)] } },
		{ match: (url) => new URL(url).searchParams.get("post_id") === "112232", json: { comments: [lemmy(302, 524, 0, "Endorsed survey", 300)] } },
		{ match: (url) => new URL(url).searchParams.get("post_id") === "112233", json: { comments: [lemmy(303, 524, 77, "Discussed survey", 500)] } },
	] });
	const bodies = feedList(aside).locator(".app-topic-comment-body");
	assert(await waitFor(async () => (await bodies.count()) === 12));
	const sorted = await bodies.allTextContents();
	for (const [higher, lower] of [["Active HN leader", "Quiet HN leader"], ["Active HN leader", "Active HN runner-up"],
		["Acclaimed", "Liked"], ["Liked", "Unliked"], ["Discussed survey", "Endorsed survey"], ["Endorsed survey", "Unremarkable survey"]]) {
		assert(sorted.indexOf(higher) < sorted.indexOf(lower), higher + " should precede " + lower + " in " + sorted.join(", "));
	}
});

test("topic sorting uses comment dates and the saved per-discussion unread timestamps", async (t) => {
	const ids = [981011, 981012, 981021, 981022];
	const dates = [now - 100, now - 500, now - 300, now - 200];
	const names = ["Bridge survey", "Earlier inspection", "Port reopening", "Updated clearance"];
	const { aside, page, store } = await openTopic(t, { phone: true, values: {
		"HNewhere:seen_comments": { "hn:9741": now - 350, "hn:9742": now - 250 },
	}, responses: [
		...stories.map((story, i) => ({ match: (url) => url === hnItem(story.id), json: { id: story.id, kids: ids.slice(i * 2, i * 2 + 2) } })),
		...ids.map((id, i) => ({ match: (url) => url === hnItem(id), json: { id, type: "comment", by: "surveyor", time: dates[i], text: names[i] } })),
	] });
	const list = feedList(aside);
	const bodies = () => list.locator(".app-topic-comment-body").allTextContents();
	await list.getByText("Updated clearance").waitFor();
	const sort = asideSort(aside);
	assert(await sort.count(), "the Topic Article exposes its own Discussion sort");
	await sort.press("ArrowDown");
	await aside.getByRole("menuitemradio", { name: "Oldest" }).click();
	assert(await waitFor(async () => (await bodies()).join() === ["Earlier inspection", "Port reopening", "Updated clearance", "Bridge survey"].join()));
	await sort.press("Enter");
	await page.keyboard.press("End");
	const unread = aside.getByRole("menuitemcheckbox", { name: "Prioritize unread comments" });
	assert(await unread.evaluate((button) => button.matches(":focus")));
	await unread.press("Space");
	assert(await waitFor(async () => (await bodies()).join() === ["Updated clearance", "Bridge survey", "Earlier inspection", "Port reopening"].join()));
	await sort.click();
	await aside.getByRole("menuitemradio", { name: "Newest" }).click();
	assert(await waitFor(async () => (await bodies()).join() === ["Bridge survey", "Updated clearance", "Port reopening", "Earlier inspection"].join()));
	assert.equal(store.get("HNewhere:settings").commentSort, "newest");
	assert.equal(store.get("HNewhere:settings").newCommentsFirst, true);
	await page.reload();
	await feedList(aside).getByText("Updated clearance").waitFor();
	await sort.click();
	assert.equal(await unread.getAttribute("aria-checked"), "true");
	assert.equal(await aside.getByRole("menuitemradio", { name: "Newest" }).getAttribute("aria-checked"), "true");
	await page.keyboard.press("Escape");
	assert(await sort.evaluate((button) => button.matches(":focus")));
	assert.deepEqual(store.get("HNewhere:seen_comments"), { "hn:9741": now - 350, "hn:9742": now - 250 });
});

test("topic Sources retains an expanded platform and its focused disclosure when comment counts arrive", async (t) => {
	const id = 98150;
	const threads = Array.from({ length: 5 }, (_, i) => ({ source: "hn", url: threadURL(id + i),
		title: "Harbor field notes " + (i + 1), comments: i === 0 ? 3 : 1 }));
	const kids = [981501, 981502, 981503, 981504];
	const { aside, page, errors } = await openTopic(t, { phone: true, threads, holdURL: hnItem(id), responses: [
		{ match: (url) => url === hnItem(id), json: { id, kids } },
		...kids.map((key) => ({ match: (url) => url === hnItem(key), json: { id: key, type: "comment", by: "pilot", time: now, text: "Field observation " + key } })),
	] });
	await feedList(aside).getByText(/Comment 1 on Inspectors/).waitFor();
	await page.waitForFunction(() => typeof window.__releaseTopicResponse === "function");
	const trigger = asideSources(aside);
	await trigger.press("Enter");
	const menu = aside.getByRole("group", { name: "Filter discussions by source" });
	const leaf = menu.getByRole("checkbox", { name: threads[0].title, exact: true });
	assert(await leaf.isHidden(), "long topic source lists start folded");
	const toggle = menu.getByRole("button", { name: /Hacker News discussions/i });
	await toggle.press("Space");
	const entry = leaf.locator("xpath=ancestor::div[contains(@class, 'source-menu-entry')][1]");
	assert(await entry.getByRole("link", { name: "3 comments" }).isVisible());
	await page.evaluate(() => window.__releaseTopicResponse());
	await entry.getByRole("link", { name: "4 comments" }).waitFor();
	assert(await toggle.evaluate((button) => button.matches(":focus")));
	assert.equal(await toggle.getAttribute("aria-expanded"), "true");
	await toggle.press("Escape");
	assert(await trigger.evaluate((button) => button.matches(":focus")));
	await trigger.press("Enter");
	assert(await leaf.isVisible(), "reopening the topic menu retains the disclosure choice");
	assert(await toggle.evaluate((button) => button.matches(":focus")));
	assert.equal(await menu.getByRole("checkbox", { name: "All sources", exact: true }).isChecked(), true);
	assert.deepEqual(errors, []);
});

test("topic Sources filters all, platforms and individual threads and syncs the chosen discussions", async (t) => {
	let revised = false;
	const update = 981032;
	const published = "An updated sounding from the selected discussion.";
	const { aside, page, requests, errors } = await openTopic(t, { phone: true, responses: [
		{ match: (url) => revised && url === hnItem(stories[1].id), json: { id: stories[1].id, kids: [update] } },
		{ match: (url) => url === hnItem(update), json: { type: "comment", id: update, by: "pilot", time: now, text: published } },
	] });
	const list = feedList(aside);
	await list.getByText(/Comment 1 on Operators/).waitFor();
	const sources = asideSources(aside);
	assert(await sources.count(), "the Topic Article exposes its own discussion source picker");
	await sources.press("Enter");
	const group = aside.getByRole("group", { name: "Filter discussions by source" });
	const all = group.getByRole("checkbox", { name: "All sources", exact: true });
	const platform = group.getByRole("checkbox", { name: "Hacker News", exact: true });
	await platform.uncheck();
	await aside.getByText("No discussions selected.").waitFor();
	assert.equal(await all.isChecked(), false);
	await group.getByRole("checkbox", { name: stories[1].title, exact: true }).check();
	assert(await platform.evaluate((box) => box.indeterminate));
	assert(await all.evaluate((box) => box.indeterminate));
	await list.getByText(/Comment 1 on Operators/).waitFor();
	assert.equal(await list.getByText(/Comment 1 on Inspectors/).count(), 0);
	const before = requests.filter(({ url }) => url === hnItem(stories[0].id)).length;
	revised = true;
	await group.getByRole("button", { name: "Sync" }).click();
	await list.getByText(published).waitFor();
	assert.equal(requests.filter(({ url }) => url === hnItem(stories[0].id)).length, before);
	if (await group.isVisible()) await group.getByRole("checkbox", { name: "All sources" }).press("Escape");
	assert(await sources.evaluate((button) => button.matches(":focus")));
	await sources.click();
	await all.check();
	await group.getByRole("checkbox", { name: "All sources" }).press("Escape");
	await list.getByText(/Comment 1 on Inspectors/).waitFor();
	assert(await list.getByText(published).isVisible());
	assert.equal(await aside.evaluate((element) => element.scrollWidth > element.clientWidth + 1), false);
	assert.deepEqual(errors, []);
});

test("thread controls target the chosen comment, preserve drafts, and save under its source article", async (t) => {
	const { aside, store, page, errors } = await openTopic(t, { values: { "HNewhere:comment_draft:9742": "Draft from the Reader discussion" } });
	const root = feedList(aside).getByRole("listitem").filter({ hasText: /Comment 2 on Operators/ });
	await root.getByRole("button", { name: /Read thread/ }).click();
	const detail = threadDetail(aside);
	const row = detail.getByRole("listitem").filter({ hasText: /Comment 2 on Operators/ });
	await row.waitFor();
	const reply = row.getByRole("button", { name: "Reply", exact: true });
	assert(await reply.count(), "thread actions are available for the selected source comment");
	assert(await row.evaluate((li) => li.matches(":focus")));
	await reply.click();
	const field = row.getByRole("textbox");
	await field.fill("Comment draft for the second port report");
	await detail.getByRole("button", { name: "Back to discussions" }).click();
	assert(await root.getByRole("button", { name: /Read thread/ }).evaluate((button) => button.matches(":focus")));
	await root.getByRole("button", { name: /Read thread/ }).click();
	await reply.click();
	await field.waitFor();
	assert(await waitFor(async () => (await field.inputValue()) === "Comment draft for the second port report"));
	await reply.click();
	await row.getByRole("button", { name: /^save$/i }).click();
	assert(await waitFor(() => store.get("HNewhere:favorites")?.some((item) => item.focus === "hn:974201" && item.parent === "9742" && item.url === stories[1].url && item.page === "journal.example/findings")));
	await row.getByRole("button", { name: "Collapse comment" }).click();
	assert.equal(await row.locator(".app-topic-comment-body").isVisible(), false);
	assert(await waitFor(() => store.get("HNewhere:collapsed_comments")?.includes("hn:974201")));
	await row.getByRole("button", { name: "Expand comment" }).press("Enter");
	await row.getByRole("button", { name: "Focus", exact: true }).click();
	assert.equal(await detail.getByRole("listitem").count(), 1);
	await detail.getByRole("button", { name: "Show full thread" }).click();
	assert(await detail.getByRole("listitem").count() > 1);
	const topDraft = detail.getByRole("textbox", { name: /Add a comment/ });
	assert(await waitFor(async () => (await topDraft.inputValue()) === "Draft from the Reader discussion"));
	assert.equal(await topDraft.evaluate((node) => getComputedStyle(node.closest(".compose-field")).display), "grid");
	await topDraft.fill("Local note on the harbor findings");
	await detail.getByRole("button", { name: "Keep a note" }).click();
	assert(await waitFor(() => store.get("HNewhere:notes:url:journal.example/findings")?.notes?.some((note) => note.text === "Local note on the harbor findings")));
	assert(await waitFor(() => !store.get("HNewhere:comment_draft:9742")));
	assert.equal(page.url(), address);
	assert.deepEqual(errors, []);
});

test("the thread vote and reply controls address the selected Hacker News item", async (t) => {
	const comment = 974201;
	const { aside, page, context, store } = await openTopic(t, { responses: [{ match: (url) => url === threadURL(stories[1].id),
		text: '<a id="up_974201" href="vote?id=974201&amp;how=up">up</a>' }] });
	await context.route("https://news.ycombinator.com/**", (route) => route.fulfill({ contentType: "text/html", body: "<p>Fixture discussion</p>" }));
	const origin = feedList(aside).getByRole("listitem").filter({ hasText: /Comment 2 on Operators/ });
	await origin.getByRole("button", { name: /Read thread/ }).click();
	const row = threadDetail(aside).getByRole("listitem").filter({ hasText: /Comment 2 on Operators/ });
	await row.waitFor();
	const reply = row.getByRole("button", { name: "Reply", exact: true });
	assert(await reply.count(), "reply is available on this source");
	await reply.click();
	const composer = row.locator(".comment-composer");
	await composer.getByRole("textbox").fill("A reply for this harbor survey");
	const popup = context.waitForEvent("page");
	await composer.getByRole("button", { name: "Post reply", exact: true }).click();
	const helper = await popup;
	await helper.waitForURL((url) => url.hostname === "news.ycombinator.com" && url.pathname === "/reply" && url.searchParams.get("id") === String(comment));
	assert([...store.values()].some((value) => value?.storyID === "9742" && value.parentId === String(comment) && value.text === "A reply for this harbor survey"));
	await helper.close();
	await page.bringToFront();
	const votePopup = context.waitForEvent("page");
	await row.getByRole("button", { name: "Upvote on Hacker News" }).click();
	const voter = await votePopup;
	await voter.waitForURL((url) => url.hostname === "news.ycombinator.com" && url.searchParams.get("id") === String(comment));
	assert([...store.values()].some((value) => value?.kind === "vote" && value.storyID === "9742" && value.item === String(comment)));
	await voter.close();
});

test("the mixed topic message bar sends the written comment to the chosen empty discussion", async (t) => {
	let submitted;
	const message = "Question for the original inspection report";
	const { aside, context, store, errors } = await openTopic(t, { topHosts: ["news.ycombinator.com"], responses: [
		{ match: (url) => url === hnItem(stories[0].id), json: { id: stories[0].id, kids: [] } },
	] });
	await feedList(aside).getByText(/Comment 1 on Operators/).waitFor();
	const draft = aside.getByRole("textbox", { name: /Add a comment/ });
	assert(await draft.isVisible(), "the mixed feed exposes the message field immediately");
	const send = aside.getByRole("button", { name: "Add a comment", exact: true });
	assert.equal(await send.isVisible(), false);
	await draft.fill(message);
	assert(await send.locator("svg").isVisible(), "the compact send arrow appears beside the draft");
	await send.press("Enter");
	const chooser = aside.getByRole("group", { name: "Choose a discussion" });
	const choice = chooser.getByRole("button", { name: new RegExp(stories[0].title) });
	assert(await chooser.getByRole("button").first().evaluate((node) => node.matches(":focus")));
	await choice.press("Escape");
	assert(await send.evaluate((node) => node.matches(":focus")));
	assert.equal(await draft.inputValue(), message);
	await send.press("Enter");
	await context.route("https://news.ycombinator.com/**", (route) => {
		const request = route.request();
		if (request.method() === "POST") {
			submitted = Object.fromEntries(new URLSearchParams(request.postData()));
			return route.fulfill({ contentType: "text/html", body: '<div class="commtext">Question for the original inspection report</div>' });
		}
		const id = new URL(request.url()).searchParams.get("id");
		return route.fulfill({ contentType: "text/html", body: '<form action="/comment" method="post"><input name="parent" value="' + id + '"><textarea name="text"></textarea></form>' });
	});
	await choice.press("Enter");
	assert(await waitFor(() => submitted));
	assert.deepEqual(submitted, { parent: "9741", text: message });
	assert(await waitFor(async () => (await draft.inputValue()) === ""));
	assert(await waitFor(() => ![...store.values()].includes(message)));
	assert(await feedList(aside).isVisible());
	assert.deepEqual(errors, []);
});

test("a topic draft survives an immediate reload after opening and leaving a thread", async (t) => {
	const { aside, page, errors } = await openTopic(t, { phone: true, viewport: { width: 320, height: 480 } });
	await feedList(aside).getByText(/Comment 1 on Operators/).waitFor();
	const draft = aside.getByRole("textbox", { name: /Add a comment/ });
	const text = "Keep this before the next save timer";
	const entered = await draft.evaluate((field, message) => {
		const box = field.closest(".compose-box");
		const pane = field.closest("aside");
		field.focus();
		field.value = message;
		field.dispatchEvent(new Event("input", { bubbles: true }));
		const send = box.querySelector(".compose-send-comment");
		send.focus();
		send.click();
		const target = box.querySelector(".compose-target");
		target.focus();
		target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		pane.querySelector(".app-topic-comment-context").click();
		const back = pane.querySelector(".app-topic-thread-back");
		back.click();
		return !pane.querySelector(".app-topic-thread-detail") && field.value === message;
	}, text);
	assert(entered);
	await page.reload();
	await feedList(aside).getByText(/Comment 1 on Operators/).waitFor();
	assert(await waitFor(async () => (await draft.inputValue()) === text, 1500));
	const edit = "Keep the latest change while the field still has focus";
	await draft.fill(edit);
	await page.reload();
	await feedList(aside).getByText(/Comment 1 on Operators/).waitFor();
	assert(await waitFor(async () => (await draft.inputValue()) === edit, 1500));
	assert.deepEqual(errors, []);
});

test("the mixed topic message bar keeps its draft and saves a note to the selected article", async (t) => {
	const { aside, page, store, errors } = await openTopic(t, { phone: true });
	await feedList(aside).getByText(/Comment 1 on Operators/).waitFor();
	const field = aside.getByRole("textbox", { name: /Add a comment/ });
	assert(await field.isVisible(), "the phone feed offers the message bar");
	await field.fill("A local note about the operator interviews");
	await feedList(aside).getByRole("button", { name: /Read thread/ }).first().tap();
	assert.equal(await threadDetail(aside).getByRole("textbox", { name: /Add a comment/ }).inputValue(), "");
	await threadDetail(aside).getByRole("button", { name: "Back to discussions" }).tap();
	assert.equal(await field.inputValue(), "A local note about the operator interviews");
	assert(await waitFor(() => [...store.values()].includes("A local note about the operator interviews")));
	await page.reload();
	await feedList(aside).getByText(/Comment 1 on Operators/).waitFor();
	assert(await waitFor(async () => (await field.inputValue()) === "A local note about the operator interviews"));
	const save = aside.getByRole("button", { name: "Keep a note" });
	const choices = aside.getByRole("group", { name: "Choose a source article" });
	await save.tap();
	await choices.waitFor();
	await field.press("End");
	await field.press("!");
	assert(await choices.isHidden(), "editing a draft dismisses the pending note destination");
	await save.tap();
	await choices.getByRole("button", { name: new RegExp(stories[1].title) }).tap();
	assert(await waitFor(() => store.get("HNewhere:notes:url:journal.example/findings")?.notes?.some((note) => note.text === "A local note about the operator interviews!")));
	assert(await waitFor(async () => (await field.inputValue()) === ""));
	assert(!store.get("HNewhere:notes:url:maritime.example/inspection")?.notes?.length);
	assert.deepEqual(errors, []);
});

test("the phone message bar follows Aa and keeps its draft as the available destinations change", async (t) => {
	const { aside, page, store, errors } = await openTopic(t, { phone: true });
	await feedList(aside).getByText(/Comment 1 on Operators/).waitFor();
	const field = aside.getByRole("textbox", { name: /Add a comment/ });
	const send = aside.getByRole("button", { name: "Add a comment", exact: true });
	const destination = aside.getByRole("group", { name: "Choose a discussion" });
	const appearance = page.getByRole("button", { name: "Style settings", exact: true }).filter({ visible: true });
	assert(await aside.evaluate((node) => node.scrollWidth <= node.clientWidth + 1), "the blank field fits on a phone");
	await field.fill("Keep the harbor report draft while filtering");
	for (const [paper, background, ink, link] of [
		["night", "rgb(18, 18, 18)", "rgb(216, 216, 216)", "rgb(143, 201, 165)"],
		["sepia", "rgb(244, 236, 216)", "rgb(59, 46, 30)", "rgb(123, 74, 18)"],
	]) {
		await appearance.tap();
		await page.locator('[data-reader-page="' + paper + '"]').tap();
		await appearance.tap();
		const style = await field.evaluate((node) => {
			const box = node.closest(".compose-box");
			const arrow = box.querySelector(".compose-send-comment");
			const article = node.closest("article");
			return {
				paper: getComputedStyle(box.querySelector(".compose-field")).backgroundColor, ink: getComputedStyle(node).color,
				arrow: getComputedStyle(arrow).backgroundColor, glyph: getComputedStyle(arrow).color,
				face: getComputedStyle(node).fontFamily, articleFace: getComputedStyle(article).fontFamily,
				placeholder: getComputedStyle(node, "::placeholder").color, secondary: getComputedStyle(article.querySelector(".bc-reader-byline")).color,
				size: parseFloat(getComputedStyle(node).fontSize),
			};
		});
		assert.deepEqual([style.paper, style.ink, style.arrow, style.glyph], [background, ink, link, background]);
		assert.equal(style.face, style.articleFace);
		assert.equal(style.placeholder, style.secondary);
		assert(style.size >= 16);
		await send.tap();
		assert.equal(await destination.evaluate((node) => getComputedStyle(node).backgroundColor), background);
		assert.equal(await destination.getByRole("button").first().evaluate((node) => getComputedStyle(node).color), ink);
		assert(await aside.evaluate((node) => node.scrollWidth <= node.clientWidth + 1), "the destination list fits on a phone");
		await send.tap();
		assert(await destination.isHidden());
	}
	await send.press("Enter");
	assert(await destination.getByRole("button").first().evaluate((node) => node.matches(":focus")));
	const sources = asideSources(aside);
	await sources.press("Enter");
	assert(await destination.isHidden());
	const group = aside.getByRole("group", { name: "Filter discussions by source" });
	const excluded = group.getByRole("checkbox", { name: stories[0].title, exact: true });
	await excluded.uncheck();
	await excluded.press("Escape");
	assert(await sources.evaluate((node) => node.matches(":focus")));
	assert.equal(await field.inputValue(), "Keep the harbor report draft while filtering");
	await aside.getByRole("button", { name: "Keep a note" }).tap();
	assert(await waitFor(() => store.get("HNewhere:notes:url:journal.example/findings")?.notes?.some((note) => note.text === "Keep the harbor report draft while filtering")));
	assert.deepEqual(errors, []);
});

test("a read-only source offers a note-only message bar and saves directly to its article", async (t) => {
	const { aside, page, store, errors } = await openTopic(t, { enabled: { hn: false }, values: { "HNewhere:comment_draft:112233": "Separate Hacker News draft" }, threads: [{
		source: "lemmy", url: "https://lemmy.world/post/112233", title: "Port community findings", comments: 0,
	}], responses: [{ match: (url) => url.includes("/api/v3/comment/list?post_id=112233"), json: { comments: [] } }] });
	await aside.getByText("No comments yet.", { exact: true }).waitFor();
	const draft = aside.getByRole("textbox", { name: /Keep a note/ });
	assert(await draft.isVisible(), "a note can be written directly in the mixed feed");
	await draft.fill("An observation from the port community");
	assert.equal(await aside.getByRole("button", { name: "Add a comment", exact: true }).isVisible(), false);
	await aside.getByRole("button", { name: "Keep a note" }).click();
	assert(await waitFor(() => store.get("HNewhere:notes:url:maritime.example/inspection")?.notes?.some((note) => note.text === "An observation from the port community")));
	const thread = await sourceThread(page, "https://lemmy.world/post/112233");
	await thread.click();
	const detail = threadDetail(aside);
	await detail.getByText("No comments yet.", { exact: true }).waitFor();
	const noteDraft = detail.getByRole("textbox", { name: /Keep a note/ });
	assert.equal(await noteDraft.inputValue(), "", "a read-only thread has its own note draft");
	await noteDraft.fill("Continue this port note later");
	await detail.getByRole("button", { name: "Back to discussions" }).click();
	await thread.click();
	assert(await waitFor(async () => await noteDraft.inputValue() === "Continue this port note later"));
	assert.equal(store.get("HNewhere:comment_draft:112233"), "Separate Hacker News draft");
	assert.deepEqual(errors, []);
});

test("a long inline topic thread can load the next replies", async (t) => {
	const { aside } = await openTopic(t);
	await feedList(aside).getByRole("listitem").filter({ hasText: /Comment 1 on Inspectors/ }).getByRole("button", { name: /Read thread/ }).click();
	const detail = threadDetail(aside);
	await detail.getByText(/Comment 16 on Inspectors/).waitFor();
	const more = detail.getByRole("button", { name: "Show more replies", exact: true });
	assert(await more.count(), "the inline thread exposes unread portions of a long conversation");
	await more.click();
	await detail.getByText(/Comment 17 on Inspectors/).waitFor();
	await detail.getByText(/Comment 1 on Inspectors/).waitFor();
});

test("an inline topic thread offers the submission's own vote and Save controls and links its authors", async (t) => {
	const { aside, store } = await openTopic(t, { responses: [{ match: (url) => url === threadURL(9742),
		text: '<a id="up_9742" href="vote?id=9742&amp;how=up">up</a>' }] });
	await feedList(aside).getByRole("listitem").filter({ hasText: /Comment 1 on Operators/ }).getByRole("button", { name: /Read thread/ }).click();
	const detail = threadDetail(aside);
	await detail.getByText(/Comment 1 on Operators/).waitFor();
	const actions = detail.getByRole("group", { name: "Discussion actions" });
	assert(await actions.count(), "the discussion has its own source actions");
	await actions.getByRole("button", { name: "Upvote on Hacker News" }).waitFor();
	await actions.getByRole("button", { name: /^save$/i }).click();
	assert(await waitFor(() => store.get("HNewhere:favorites")?.some((item) => item.key === "hn:9742" && item.kind === "discussion" && item.url === stories[1].url)));
	assert.equal(await detail.getByRole("link", { name: "commenter1", exact: true }).getAttribute("href"), "https://news.ycombinator.com/user?id=commenter1");
});

test("sync in an open topic thread reloads comments beyond the mixed feed preview", async (t) => {
	let revised = false;
	const changed = 974111;
	const { aside } = await openTopic(t, { responses: [{ match: (url) => revised && url === hnItem(changed),
		json: { id: changed, type: "comment", by: "editor", text: "Revised after the hydrographic survey.", time: now } }] });
	await feedList(aside).getByRole("listitem").filter({ hasText: /Comment 1 on Inspectors/ }).getByRole("button", { name: /Read thread/ }).click();
	const detail = threadDetail(aside);
	await detail.getByText(/Comment 12 on Inspectors/).waitFor();
	revised = true;
	await asideSources(aside).click();
	await aside.getByRole("group", { name: "Filter discussions by source" }).getByRole("button", { name: "Sync" }).click();
	assert(await waitFor(async () => (await detail.getByText("Revised after the hydrographic survey.").count()) === 1), "sync retrieves fresh bodies throughout the inline discussion");
});
