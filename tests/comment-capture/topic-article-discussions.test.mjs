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

async function openTopic(t, { phone, responses = [], signedIn = false, local = stories, threads = [], values = {}, enabled = {}, holdURL } = {}) {
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
		const items = requests.filter(({ url }) => new URL(url).hostname === "hacker-news.firebaseio.com");
		assert(items.length > 2 && items.length <= 14);
		assert(items.every(({ method, anonymous, hasBody }) => method === "GET" && anonymous && hasBody === undefined));
		const firstPage = await list.getByRole("listitem").count();
		assert(firstPage >= 4 && firstPage <= 8);
		await aside.getByRole("button", { name: "Show more comments" }).click();
		assert(await waitFor(async () => (await list.getByRole("listitem").count()) > firstPage));
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


test("a sparse topic checks a bounded group of public posts before the reader asks for more", async (t) => {
	const did = "did:plc:abcdefghijklmnopqrstuvwx";
	const threads = Array.from({ length: 10 }, (_, i) => ({ source: "bsky", url: "https://bsky.app/profile/" + did + "/post/root" + i,
		title: "Shared harbor report " + i, comments: 0 }));
	const asPost = (uri, text) => ({ uri, author: { did, handle: "port.example" }, record: { text } });
	const responses = threads.map((thread, i) => {
		const uri = "at://" + did + "/app.bsky.feed.post/root" + i;
		return { match: (url) => new URL(url).searchParams.get("uri") === uri,
			json: { thread: { post: asPost(uri, thread.title), replies: i === 8 ? [{ post: asPost(uri + "reply", "A reply to the ninth known thread.") }] : [] } } };
	});
	const { aside, requests } = await openTopic(t, { threads, enabled: { hn: false }, responses });
	const sent = () => requests.filter(({ url }) => url.includes("app.bsky.feed.getPostThread"));
	await aside.getByText("No replies found in the discussions checked.", { exact: true }).waitFor();
	assert.equal(sent().length, 8);
	assert.equal(await aside.locator(".app-topic-comment-body").count(), 0);
	await aside.getByRole("button", { name: "Show more comments" }).click();
	await feedList(aside).getByText("A reply to the ninth known thread.", { exact: true }).waitFor();
	assert(sent().length > 8 && sent().length <= 10);
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
	const { aside, store, page, errors } = await openTopic(t);
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
	await detail.getByRole("textbox", { name: /Add a comment/ }).fill("Local note on the harbor findings");
	await detail.getByRole("button", { name: "Keep a note" }).click();
	assert(await waitFor(() => store.get("HNewhere:notes:url:journal.example/findings")?.notes?.some((note) => note.text === "Local note on the harbor findings")));
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

test("the topic composer can start a comment in a chosen empty discussion", async (t) => {
	const { aside, context, store } = await openTopic(t, { responses: [
		{ match: (url) => url === hnItem(stories[0].id), json: { id: stories[0].id, kids: [] } },
	] });
	await feedList(aside).getByText(/Comment 1 on Operators/).waitFor();
	const start = aside.getByRole("button", { name: "Add a comment", exact: true });
	assert(await start.count(), "the mixed feed exposes the discussion composer");
	await start.press("Enter");
	const chooser = aside.getByRole("group", { name: "Choose a discussion" });
	await chooser.getByRole("button", { name: new RegExp(stories[0].title) }).click();
	const detail = threadDetail(aside);
	await detail.getByText("No comments yet.", { exact: true }).waitFor();
	const draft = detail.getByRole("textbox", { name: /Add a comment/ });
	assert(await draft.evaluate((field) => field.matches(":focus")));
	await draft.fill("Question for the original inspection report");
	await context.route("https://news.ycombinator.com/**", (route) => route.fulfill({ contentType: "text/html", body: "<p>Fixture discussion</p>" }));
	const waiting = context.waitForEvent("page");
	await detail.getByRole("button", { name: "Add a comment", exact: true }).click();
	const helper = await waiting;
	await helper.waitForURL((url) => url.origin === "https://news.ycombinator.com" && url.pathname === "/item" && url.searchParams.get("id") === "9741");
	assert([...store.values()].some((value) => value?.storyID === "9741" && value.parentId === null && value.text === "Question for the original inspection report"));
	await helper.close();
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
