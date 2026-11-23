import assert from "node:assert/strict";
import test from "node:test";
import { launchApp, STORIES, waitFor } from "./harness.mjs";

const looksKey = "HNewhere:looks";
const settings = { updateCheck: false, sourceRefreshMinutes: 0 };
const keyFor = (url) => new URL(url).hostname + new URL(url).pathname;
const queueEntry = (story) => ({ ...story, key: keyFor(story.url), source: "hn", addedAt: Date.now() });
const existingLook = {
	image: "https://framed.example.com/established-preview.png",
	icon: "https://framed.example.com/established-icon.png",
	site: "Original publication",
	bg: "#fee",
	text: "#120",
	font: "Georgia",
	weight: "700",
	color: "#123",
};

function article(head) {
	const paragraphs = "<p>The latest expedition measured changing conditions offshore and compared them with earlier observations. Local researchers tracked the long-term effects along several stretches of coast.</p>";
	return `<!doctype html><html><head><title>Field report</title>${head}</head><body><main><article><h1>Field report</h1>${paragraphs.repeat(12)}</article></main></body></html>`;
}

async function openStory(page, story) {
	await page.goto("https://backchnnl.app/");
	await page.locator('#app-rail [data-app-view="queue"]').click();
	await page.locator(`#app-list-body .browse-title-link[href="${story.url}"]`).first().click({ timeout: 10000 });
}

async function readLook(app, url, after = 0) {
	const key = keyFor(url);
	const current = () => app.store.get(looksKey)?.[key];
	assert(await waitFor(() => current()?.at > after, 5000), `a new look is stored for ${key}`);
	const { at, ...look } = current();
	return { at, look };
}

test("article frame captures bounded metadata and retains it on a sparse refresh", async () => {
	const story = STORIES[0];
	const longDescription = "  Reef restoration &amp;   weather. " + "Long report ".repeat(60);
	const html = article(`<meta name="description" content="A secondary description"><meta property="og:description" content="${longDescription}"><meta property="article:section" content=" Oceans ${"x".repeat(100)} ">`);
	const app = await launchApp({ sharedStore: true, settings, values: { "HNewhere:queue": [queueEntry(story)] }, pages: { [story.url]: { html } } });
	try {
		await openStory(app.page, story);
		const first = await readLook(app, story.url);
		assert.equal(first.look.description, "Reef restoration & weather. " + "Long report ".repeat(27) + "Long rep");
		assert.equal(first.look.section, "Oceans " + "x".repeat(73));

		await app.context.route(story.url, (route) => route.fulfill({
			contentType: "text/html",
			body: article('<meta property="article:section" content="Marine Science">'),
		}));
		await openStory(app.page, story);
		const later = await readLook(app, story.url, first.at);
		assert.equal(later.look.description, first.look.description);
		assert.equal(later.look.section, "Marine Science");
		assert.deepEqual(app.errors, []);
	} finally {
		await app.browser.close();
	}
});

test("an HTML Reader probe adds metadata to an established preview", async () => {
	const story = STORIES[1];
	const html = article('<meta property="og:description" content="  "><meta property="twitter:description" content=" Inside the peloton "><meta name="description" content="A secondary description"><meta name="article:section" content="Cycling"><meta property="og:image" content="/probe-preview.png">');
	const app = await launchApp({
		sharedStore: true, settings,
		values: { "HNewhere:queue": [queueEntry(story)], [looksKey]: { [keyFor(story.url)]: { ...existingLook, at: 1 } } },
		pages: { [story.url]: { html, headers: { "x-frame-options": "DENY" } } },
	});
	try {
		await openStory(app.page, story);
		assert(await waitFor(() => app.requests.some(({ url }) => url === story.url), 12_000), "the Reader probes the page after waiting for the frame");
		const { look } = await readLook(app, story.url, 1);
		assert.deepEqual(look, { ...existingLook, description: "Inside the peloton", section: "Cycling" });
		assert.equal(app.requests.filter(({ url }) => url === story.url).length, 1);
		assert.deepEqual(app.errors, []);
	} finally {
		await app.browser.close();
	}
});

test("revisiting a saved page fills only missing metadata in its established look", async () => {
	const url = "https://fieldnotes.example.net/reports/latest";
	const canonical = "https://fieldnotes.example.net/reports/204";
	const html = article('<meta name="description" content="Surveying the shoreline"><meta itemprop="articleSection" content="Coastal ecology">');
	const app = await launchApp({
		sharedStore: true, settings, topHosts: [new URL(url).hostname],
		values: {
			"HNewhere:collection_filed": true,
			"HNewhere:collected_migrated": true,
			"HNewhere:collected": [{ key: keyFor(canonical), url: canonical, title: "Field report", addresses: [keyFor(url)], addedAt: Date.now() }],
			[looksKey]: { [keyFor(canonical)]: { ...existingLook, description: " ", section: "Conservation", at: 1 } },
		},
		pages: { [url]: { html } },
	});
	try {
		await app.page.goto(url);
		const { look } = await readLook(app, canonical, 1);
		assert.deepEqual(look, { ...existingLook, section: "Conservation", description: "Surveying the shoreline" });
		assert.equal(app.store.get(looksKey)[keyFor(url)], undefined);
		assert.equal(app.requests.filter((request) => request.url === url).length, 0);
		assert.deepEqual(app.errors, []);
	} finally {
		await app.browser.close();
	}
});
