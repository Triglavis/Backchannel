import assert from "node:assert/strict";
import test from "node:test";
import { launchApp, waitFor } from "./harness.mjs";

const now = Math.floor(Date.now() / 1000);
const original = {
	source: "hn", id: 9260, time: now - 3600, descendants: 1,
	url: "https://framed.example.com/post/260",
	title: "Orbital telescope discovers methane clouds above Europa",
};
const related = {
	source: "lemmy", id: 761, time: now - 7200, descendants: 1,
	url: "https://plain.example.org/post/261",
	title: "Orbital telescope discovers thick methane clouds above Europa",
};
const older = {
	...related, id: 762, time: now - 7 * 86400,
	url: "https://science.example.org/previous-discovery",
};
const unrelated = {
	...related, id: 763,
	url: "https://observatory.example.org/titan",
	title: "Orbital telescope discovers ammonia clouds above Titan",
};
const sports = {
	url: "https://framed.example.com/olympics",
	title: "Cycling team wins Olympic gold after dramatic sprint",
};
const metadataOnly = {
	source: "hn", id: 9261, time: now - 3600, descendants: 1,
	url: "https://framed.example.com/post/262",
	title: "Engineers unveil compact glass bridge after years of tests",
};

async function coverageApp({ lemmy = true, ...options } = {}) {
	const postView = {
		post: { id: related.id, url: related.url, name: related.title, published: new Date(related.time * 1000).toISOString(), creator_id: 1 },
		creator: { id: 1, name: "reader" },
		community: { name: "technology", actor_id: "https://lemmy.world/c/technology" },
		counts: { comments: 1, score: 1 },
	};
	const comment = {
		comment: { id: 271, post_id: related.id, content: "A discussion of the second article", path: "0.271", published: new Date().toISOString() },
		creator: { id: 2, name: "reader" },
		counts: { score: 1 },
	};
	const key = (url) => new URL(url).hostname + new URL(url).pathname;
	const feed = (stories) => ({ timestamp: now * 1000, stories: stories.map((story) => ({ topic: "technology", ...story })) });
	const app = await launchApp({
		sharedStore: true,
		...options,
		settings: { updateCheck: false, sourceRefreshMinutes: 0, sources: { hn: true, lemmy }, frontPageMode: "topics", frontPageTopics: ["technology"] },
		values: {
			"HNewhere:collection_filed": true,
			"HNewhere:collected_migrated": true,
			"HNewhere:collected": [original, sports, metadataOnly].map(({ url, title }) => ({ key: key(url), url, title, addedAt: now * 1000, unwatched: true })),
			"HNewhere:queue": [{ ...original, key: key(original.url), addedAt: now * 1000 }],
			"HNewhere:app_panes": { list: true, discussion: true },
			"HNewhere:frontpage_feed:technology/hn/front/": feed([original, metadataOnly]),
			"HNewhere:frontpage_feed:technology/lemmy/community/technology@lemmy.world": feed([related, older, unrelated]),
		},
		extraStories: [{ ...original, comments: 1 }],
		responses: [
			{ match: (url) => url.includes("lemmy.world/api/v3/search"), json: { posts: [] } },
			{ match: (url) => url.includes("lemmy.world/api/v3/post?id=761"), json: { post_view: postView } },
			{ match: (url) => url.includes("lemmy.world/api/v3/comment/list?post_id=761"), json: { comments: [comment] } },
		],
	});
	app.page.setDefaultTimeout(5000);
	return app;
}

function rowFor(page, title) {
	return page.locator("#app-list-body .browse-title-link").and(page.getByRole("link", { name: title, exact: true })).locator("xpath=ancestor::*[contains(@class,'browse-row')][1]");
}

async function clickView(page, view) {
	await page.locator(`#app-rail [data-app-view="${view}"]`).click();
}

test("Collection labels saved articles using cached feed topics and headline terms and filters by either", async () => {
	const app = await coverageApp();
	try {
		const { page } = app;
		await page.goto("https://backchnnl.app/");
		await clickView(page, "collection");
		const body = page.locator("#app-list-body");
		const metadataRow = rowFor(page, metadataOnly.title);
		await metadataRow.getByText("Technology", { exact: true }).waitFor();
		await rowFor(page, sports.title).getByText("Sports", { exact: true }).waitFor();

		const filter = page.getByRole("button", { name: "Filter and sort Collection" });
		await filter.click();
		const menu = page.getByRole("menu", { name: "Filter and sort Collection" });
		assert(await menu.evaluate((node) => {
			const style = getComputedStyle(node);
			const readerStyle = getComputedStyle(node.getRootNode().getElementById("app-view-menu"));
			return ["borderRadius", "backgroundColor", "border", "padding", "boxShadow"].every((key) => style[key] === readerStyle[key]);
		}), "the filter has the same frame as the Reader Style popover");
		const selected = menu.getByRole("menuitemradio", { name: "All saved", exact: true });
		assert.equal(await selected.getAttribute("aria-checked"), "true");
		assert.equal(await selected.evaluate((node) => getComputedStyle(node, "::before").content), '"✓"');
		await page.getByRole("menuitemradio", { name: "Sports", exact: true }).click();
		assert(await waitFor(() => body.locator(".reader-collection-row").count().then((count) => count === 1)));
		assert.equal(await body.locator(".browse-title-link").textContent(), sports.title);

		await filter.click();
		await page.getByRole("menuitemradio", { name: "Technology", exact: true }).click();
		await metadataRow.waitFor();
		assert.equal(await body.getByRole("link", { name: sports.title }).count(), 0);

		assert.equal(await body.getByText("Related coverage", { exact: true }).count(), 0);
		const requests = app.requests.map(({ url }) => url);
		assert(!requests.some((url) => url.startsWith(original.url) || url.startsWith(related.url)), "tags use local metadata");
		assert.deepEqual(app.errors, []);
	} finally {
		await app.browser.close();
	}
});

test("Reader shows related links above the article and opens their own discussion", async () => {
	const app = await coverageApp();
	try {
		const { page } = app;
		await page.goto("https://backchnnl.app/");
		const story = rowFor(page, original.title);
		await story.locator(".browse-title-link").waitFor();

		for (const view of ["unread", "all", "source:hn", "topic:technology", "queue"]) {
			await clickView(page, view);
			await story.locator(".browse-title-link").waitFor();
			assert.equal(await story.getByText("Related coverage", { exact: true }).count(), 0, view);
		}
		await story.locator(".browse-title-link").click();
		const coverage = page.locator("#app-article").getByRole("navigation", { name: "Related coverage" });
		const article = coverage.getByRole("link", { name: related.title, exact: true });
		await article.waitFor();
		assert.equal(await article.getAttribute("href"), related.url);
		assert.deepEqual(await coverage.locator("li").count(), 1, "older and unrelated links are omitted");
		const header = await coverage.boundingBox();
		const content = await page.locator("#app-article-body").boundingBox();
		assert(header.y + header.height <= content.y + 1, "coverage sits above the article frame");
		await article.focus();
		await page.keyboard.press("Enter");
		assert.equal(await page.locator("#app-article-open").getAttribute("href"), related.url);
		const discussion = page.locator("#comments-content");
		await discussion.getByText("A discussion of the second article", { exact: true }).waitFor();
		assert.equal(await discussion.locator('[data-story-id="9260"]').count(), 0);
		assert.equal(await coverage.getByRole("link", { name: related.title, exact: true }).count(), 0, "the old coverage clears when switching articles");

		await clickView(page, "all");
		await story.locator(".browse-title-link").waitFor();
		await story.locator(".browse-comments-total").click();
		await discussion.locator('.comment[data-comment-id="hn:926000"]').getByText("Comment 1 on " + original.title).waitFor();
		assert.equal(await discussion.getByText("A discussion of the second article", { exact: true }).count(), 0);
		assert.deepEqual(app.errors, []);
	} finally {
		await app.browser.close();
	}
});

test("Reader omits related coverage from a disabled topic source when opening a Collection link", async () => {
	const app = await coverageApp({ lemmy: false });
	try {
		const { page } = app;
		await page.goto("https://backchnnl.app/");
		await clickView(page, "collection");
		const story = rowFor(page, original.title);
		await story.getByText("Technology", { exact: true }).waitFor();
		await story.locator(".browse-title-link").click();
		await page.locator('#app-article-body[data-mode^="frame"]').waitFor();
		assert.equal(await page.locator("#app-article").getByRole("navigation", { name: "Related coverage" }).count(), 0);
		assert.deepEqual(app.errors, []);
	} finally {
		await app.browser.close();
	}
});

test("Collection tag choices stay within a short phone viewport", async () => {
	const app = await coverageApp({ viewport: { width: 390, height: 250 }, hasTouch: true });
	try {
		const { page } = app;
		await page.goto("https://backchnnl.app/");
		await clickView(page, "collection");
		await rowFor(page, sports.title).getByText("Sports", { exact: true }).waitFor();
		const filter = page.getByRole("button", { name: "Filter and sort Collection" });
		await filter.click();
		const menu = page.getByRole("menu", { name: "Filter and sort Collection" });
		await menu.waitFor();
		const bounds = await menu.boundingBox();
		assert(bounds.y >= 0 && bounds.y + bounds.height <= 250, "the tag menu fits inside the viewport");
		const arrow = page.locator("#app-collection-filter-arrow");
		const anchor = await filter.boundingBox();
		assert(bounds.y >= anchor.y + anchor.height, "the scrollable menu opens below the filter on a short screen");
		const pointer = await arrow.boundingBox();
		assert(pointer && Math.abs(pointer.x + pointer.width / 2 - (anchor.x + anchor.width / 2)) <= 1);
		await page.keyboard.press("End");
		await page.keyboard.press("ArrowUp");
		assert.equal(await menu.evaluate((node) => node.getRootNode().activeElement.textContent), "Sports");
		await page.keyboard.press("Enter");
		await arrow.waitFor({ state: "hidden" });
		const title = page.locator("#app-list-body .browse-title-link");
		assert(await waitFor(async () => (await title.count()) === 1 && await title.textContent() === sports.title));
		assert.deepEqual(app.errors, []);
	} finally {
		await app.browser.close();
	}
});
