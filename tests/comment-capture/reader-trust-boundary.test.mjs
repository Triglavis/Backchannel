import assert from "node:assert/strict";
import test from "node:test";
import { launchApp, STORIES, waitFor } from "./harness.mjs";

const article = STORIES[0];
const privateNote = "Private fixture note for the Reader";
const privateTopic = "Private fixture topic";
const articleKey = new URL(article.url).host + new URL(article.url).pathname;

test("Reader keeps its notes and private settings on the Reader origin", async () => {
	const app = await launchApp({ sharedStore: true, settings: { annotations: true, hiddenTopics: [privateTopic], updateCheck: false } });
	try {
		await app.context.addInitScript(() => {
			if (window.top === window) return;
			window.annotationMessages = [];
			window.addEventListener("message", ({ data }) => {
				if (data?.type === "annotate") window.annotationMessages.push(data);
			});
		});
		await app.page.goto("https://backchnnl.app/");
		await app.page.locator(`#app-list-body .browse-title-link[href="${article.url}"]`).first().click();
		await app.page.locator('#app-article-body[data-mode="frame-agent"]').waitFor();
		const composer = app.page.locator("#app-discussion-compose");
		await composer.locator(".composer-text").fill(privateNote);
		await composer.getByRole("button", { name: "Keep a note" }).click();
		await app.page.locator("[data-notes-section]").getByText(privateNote).waitFor();
		const frame = app.page.frames().find((entry) => entry.url() === article.url);
		assert(await waitFor(() => frame.evaluate(() => window.annotationMessages.some(({ comments }) => comments.length))));
		const delivered = await frame.evaluate(() => JSON.stringify(window.annotationMessages));
		assert.equal(delivered.includes(privateNote), false, "the Note's text stays in Reader");
		assert.equal(delivered.includes(privateTopic), false, "topic filters stay in Reader");
	} finally {
		await app.browser.close();
	}
});

test("The Sidebar leaves private drafts and exports in Reader", async () => {
	const app = await launchApp({
		appHost: new URL(article.url).hostname, sharedStore: true,
		settings: { autoOpenSidebar: true, updateCheck: false },
		values: {
			[`HNewhere:comment_draft:${article.id}`]: "Private fixture draft for the Reader",
			[`HNewhere:notes:url:${articleKey}`]: { notes: [{ id: "fixture", text: privateNote, created: 1 }] },
		},
	});
	try {
		await app.page.goto(article.url);
		await app.page.locator(".comment[data-comment-id]").first().waitFor();
		assert.equal(await app.page.locator(".composer-text").count(), 0);
		assert.equal(await app.page.getByText(privateNote).count(), 0);
		await app.page.getByRole("button", { name: "Open Backchannel settings" }).click();
		await app.page.getByRole("button", { name: "Collection", exact: true }).click();
		assert.equal(await app.page.getByRole("button", { name: "Download JSON" }).count(), 0);
		assert.equal(await app.page.getByRole("link", { name: "Open Collection settings in Reader" }).getAttribute("href"), "https://backchnnl.app/#collection-settings");
	} finally {
		await app.browser.close();
	}
});

test("Sidebar saves keep the identity of the rendered discussion", async () => {
	const app = await launchApp({
		appHost: new URL(article.url).hostname, sharedStore: true,
		settings: { autoOpenSidebar: true, updateCheck: false, sources: { hn: true } },
	});
	try {
		await app.page.goto(article.url);
		const save = app.page.locator(".story-meta [data-item-action='save']").first();
		await save.waitFor();
		const key = await save.getAttribute("data-save-key");
		assert(key);
		await save.evaluate((button) => {
			button.dataset.saveKey = "fixture:other";
			button.dataset.saveKind = "comment";
		});
		await save.click();
		assert(await waitFor(() => app.store.get("HNewhere:favorites")?.some((entry) => entry.key === key)));
		assert.equal(app.store.get("HNewhere:favorites").some((entry) => entry.key === "fixture:other"), false);
		await save.click();
		assert(await waitFor(() => app.store.get("HNewhere:favorites")?.length === 0));
	} finally {
		await app.browser.close();
	}
});

test("Reader shortcuts require keyboard focus outside the publisher frame", async () => {
	const app = await launchApp({ sharedStore: true, settings: { updateCheck: false } });
	try {
		await app.page.goto("https://backchnnl.app/");
		await app.page.locator(`#app-list-body .browse-title-link[href="${article.url}"]`).first().click();
		await app.page.locator('#app-article-body[data-mode="frame-agent"]').waitFor();
		const save = app.page.locator('#app-article-actions [data-item-action="save"]');
		await app.page.frameLocator(".app-article-frame").locator("body").press("s");
		await save.click();
		assert(await waitFor(() => app.store.get("HNewhere:favorites")?.length === 1));
	} finally {
		await app.browser.close();
	}
});

test("Selecting text on a publisher opens the note composer in Reader for that article", async () => {
	const app = await launchApp({ topHosts: [new URL(article.url).hostname], sharedStore: true, settings: { autoOpenSidebar: true, updateCheck: false } });
	try {
		await app.page.goto(article.url);
		await app.page.locator(".comment[data-comment-id]").first().waitFor();
		await app.page.locator("article p").first().evaluate((paragraph) => {
			const range = document.createRange();
			range.selectNodeContents(paragraph);
			window.getSelection().removeAllRanges();
			window.getSelection().addRange(range);
		});
		await app.page.keyboard.press("Shift");
		const [reader] = await Promise.all([
			app.context.waitForEvent("page"),
			app.page.getByRole("button", { name: "Add note in Reader" }).click(),
		]);
		const composer = reader.locator("[data-hnewhere-note-composer]");
		await composer.getByRole("textbox", { name: "Your note" }).fill(privateNote);
		await composer.getByRole("button", { name: "Save note" }).click();
		assert(await waitFor(() => app.store.get(`HNewhere:notes:url:${articleKey}`)?.notes[0]?.text === privateNote));
		assert.equal(await app.page.getByText(privateNote).count(), 0);
		assert.equal(new URL(reader.url()).origin, "https://backchnnl.app");
	} finally {
		await app.browser.close();
	}
});

test("Only the exact HTTPS origin starts Reader", async () => {
	const app = await launchApp({ sharedStore: true, settings: { updateCheck: false } });
	try {
		await app.context.route(/^(?:http:\/\/backchnnl\.app|https:\/\/backchnnl\.app:8443)\//, (route) => route.fulfill({
			contentType: "text/html", body: "<!doctype html><title>Reader origin fixture</title><p>Page content</p>",
		}));
		for (const origin of ["http://backchnnl.app", "https://backchnnl.app:8443"]) {
			await app.page.goto(origin + "/");
			await app.page.locator('[data-backchannel-installed], [data-hnewhere-sidebar], #hn-restore-button, #hn-collapse-button, #hn-submit-button').first().waitFor({ state: "attached" });
			assert.equal(await app.page.locator("#app").count(), 0, origin);
		}
		await app.page.goto("https://backchnnl.app/");
		await app.page.locator("#app").waitFor();
	} finally {
		await app.browser.close();
	}
});

test("A Reader note stays with its original article when the selected row changes", async () => {
	const original = STORIES[1];
	const originalKey = new URL(original.url).host + new URL(original.url).pathname;
	const app = await launchApp({ sharedStore: true, settings: { updateCheck: false } });
	try {
		await app.page.goto("https://backchnnl.app/");
		await app.page.locator(`#app-list-body .browse-title-link[href="${original.url}"]`).first().click();
		await app.page.locator(".bc-reader p").first().evaluate((paragraph) => {
			const range = document.createRange();
			range.selectNodeContents(paragraph);
			window.getSelection().removeAllRanges();
			window.getSelection().addRange(range);
		});
		await app.page.keyboard.press("Shift");
		await app.page.getByRole("button", { name: "Add note", exact: true }).click();
		const composer = app.page.locator("[data-hnewhere-note-composer]");
		await composer.getByRole("textbox", { name: "Your note" }).fill(privateNote);
		await app.page.locator(`#app-list-body .browse-title-link[href="${article.url}"]`).first().click();
		await composer.getByRole("button", { name: "Save note" }).click();
		assert(await waitFor(() => app.store.get(`HNewhere:notes:url:${originalKey}`)?.notes[0]?.text === privateNote));
		assert.equal(app.store.has(`HNewhere:notes:url:${articleKey}`), false);
	} finally {
		await app.browser.close();
	}
});

test("A PDF note handed off to Reader keeps its page and joins existing notes for that document", async () => {
	const url = "https://edition.example.org/research.pdf";
	const title = "Fixture paper";
	const key = "HNewhere:notes:pdf:edition-archive-test";
	const other = "HNewhere:notes:pdf:edition-other-test";
	const previousNote = "Page six from an earlier reading";
	const app = await launchApp({
		topHosts: ["edition.example.org"], sharedStore: true, extraStories: [{ url, title }],
		settings: { autoOpenSidebar: true, updateCheck: false },
		pages: { [url]: { html: `<title>${title}</title><article><div class="pdfViewer"><div class="page" data-page-number="7"><div class="textLayer"><p>A long passage in the seventh page of the paper.</p></div></div></div></article>` } },
		values: {
			[key]: { version: 1, notes: [{ id: "old", text: previousNote, page: 6, created: 1 }] },
			[other]: { version: 1, notes: [{ id: "other", text: "Notes for a different edition", page: 2, created: 1 }] },
			"HNewhere:notes_index": [
				{ kind: "pdf", id: "edition-archive-test", key, url: `${url}#page=6`, title, count: 1, updated: 1 },
				{ kind: "pdf", id: "edition-other-test", key: other, url: `${url}?edition=other`, title, count: 1, updated: 1 },
			],
		},
	});
	try {
		await app.context.addInitScript((pdfURL) => {
			if (location.href !== pdfURL) return;
			window.PDFViewerApplication = { pdfDocument: {
				fingerprints: ["edition-viewer-test"], numPages: 7,
				getMetadata: async () => ({ info: { Title: "Fixture paper" } }),
			} };
		}, url);
		await app.page.goto(url);
		await app.page.locator(".comment[data-comment-id]").first().waitFor();
		await app.page.locator(".textLayer p").evaluate((paragraph) => {
			const range = document.createRange();
			range.selectNodeContents(paragraph);
			window.getSelection().removeAllRanges();
			window.getSelection().addRange(range);
		});
		await app.page.keyboard.press("Shift");
		const [reader] = await Promise.all([
			app.context.waitForEvent("page"),
			app.page.getByRole("button", { name: "Add note in Reader" }).click(),
		]);
		const composer = reader.locator("[data-hnewhere-note-composer]");
		await composer.getByRole("textbox", { name: "Your note" }).fill(privateNote);
		await composer.getByRole("button", { name: "Save note" }).click();
		await reader.locator("[data-notes-section]").getByText(privateNote).waitFor({ timeout: 6000 });
		const notes = app.store.get(key).notes;
		assert.deepEqual(notes.map(({ text, page }) => [text, page]), [[previousNote, 6], [privateNote, 7]]);
		assert.equal(app.store.get(other).notes.length, 1);
		assert.equal(app.store.has("HNewhere:notes:pdf:edition-viewer-test"), false);
		assert.equal(app.store.has("HNewhere:notes:url:edition.example.org/research.pdf"), false);
	} finally {
		await app.browser.close();
	}
});
