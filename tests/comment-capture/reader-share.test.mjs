import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { launchApp, STORIES, waitFor } from "./harness.mjs";

const readerURL = "https://backchnnl.app/";
const now = 1795104000000;
const story = STORIES[0];
const url = "https://imported.example.com/reading_(list)?mode=plain&text=%3C";
const key = "framed.example.com/gc";
const noteKey = "HNewhere:notes:url:" + key;
const selected = [
	{ key, url: story.url, title: story.title },
	{ key: "imported.example.com/reading_(list)?mode=plain&text=%3C", url, title: "Saved [draft] <script>" },
	{ key: "unsafe", url: "javascript:alert(1)", title: "Unsafe link" },
	{ key: "credentials", url: "https://user:password@www.example.com/", title: "Credentials" },
];

async function shareApp(options = {}) {
	const source = await readFile(process.env.BC_SCRIPT || new URL("../../HNewhere.user.js", import.meta.url), "utf8");
	const end = source.lastIndexOf("\n})();");
	assert(end >= 0);
	const hook = '\n\twindow.__openReadingListShare = typeof openReadingListShare === "function" && openReadingListShare;';
	return launchApp({
		sharedStore: true,
		settings: { updateCheck: false },
		values: {
			"HNewhere:collected_migrated": true,
			"HNewhere:collection_filed": true,
			"HNewhere:collected": [{ key, url: story.url, title: story.title, addedAt: now, unwatched: true }],
			"HNewhere:favorites": [
				{ key: "lobsters:reading", kind: "discussion", url: story.url, page: key, source: "lobsters", id: "reading", title: story.title, addedAt: now },
				{ key: "hn:900101", kind: "comment", url: story.url, page: key, source: "hn", id: "900101", text: "Saved quotation\n> A second line", addedAt: now },
			],
			"HNewhere:notes_index": [{ key: noteKey, kind: "url", id: key, url: story.url, title: story.title, count: 1 }],
			[noteKey]: { version: 1, notes: [{ id: "share-test", text: "My private note\n[another line](javascript:no)", created: now / 1000 }] },
		},
		...options,
		source: source.slice(0, end) + hook + source.slice(end),
	});
}

async function openShare(page) {
	const opened = await page.evaluate(async (entries) => {
		if (!window.__openReadingListShare) return false;
		const openerID = matchMedia("(max-width:700px)").matches ? "app-search" : "app-rail-search";
		const opener = document.querySelector("[data-hnewhere-app]").shadowRoot.getElementById(openerID);
		opener.focus();
		await window.__openReadingListShare(entries, opener);
		return true;
	}, selected);
	assert.ok(opened, "the Reader can open a reading list preview");
	const dialog = page.getByRole("dialog", { name: "Share reading list" });
	await dialog.waitFor();
	return dialog;
}

test("sharing copies selected links with known discussions and requires an opt-in for saved text", async () => {
	const app = await shareApp();
	try {
		const { page } = app;
		page.setDefaultTimeout(5000);
		await page.addInitScript(() => {
			Object.defineProperty(navigator, "clipboard", {
				value: { writeText: async (text) => { window.copiedReadingList = text; } },
			});
		});
		await page.goto(readerURL);
		await page.locator("#app-list-body").getByRole("link", { name: story.title, exact: true }).waitFor();
		const dialog = await openShare(page);
		await dialog.getByText("2 links", { exact: true }).waitFor();
		const copy = dialog.getByRole("button", { name: "Copy Markdown" });
		const title = dialog.getByRole("textbox", { name: "List title" });
		const notes = dialog.getByRole("checkbox", { name: "My notes" });
		const quotes = dialog.getByRole("checkbox", { name: "Saved quotes" });
		assert.equal(await notes.isChecked(), false);
		assert.equal(await quotes.isChecked(), false);
		assert.equal(await dialog.getByText("My private note", { exact: false }).count(), 0);
		await title.fill("Weekend [reading] #");
		await copy.click();
		const defaultText = await page.evaluate(() => window.copiedReadingList);
		assert.ok(defaultText.startsWith("# Weekend \\[reading\\] \\#\n"));
		assert.ok(defaultText.includes(story.url));
		assert.ok(defaultText.includes("[Saved \\[draft\\] \\<script\\>](<https://imported.example.com/reading_(list)?mode=plain&text=%3C>)"));
		assert.ok(defaultText.includes("https://news.ycombinator.com/item?id=9001"));
		assert.ok(defaultText.includes("[Lobsters discussion](https://lobste.rs/s/reading)"));
		assert.doesNotMatch(defaultText, /Unsafe link|Credentials|Fixture story 2|My private note|Saved quotation/);
		await notes.check();
		assert.equal(await dialog.getByText("My private note", { exact: false }).count(), 1);
		assert.equal(await dialog.getByText("Saved quotation", { exact: false }).count(), 0);
		await quotes.check();
		await dialog.getByRole("checkbox", { name: "Discussion links" }).uncheck();
		await copy.click();
		const optedIn = await page.evaluate(() => window.copiedReadingList);
		assert.match(optedIn, /My private note/);
		assert.match(optedIn, /Saved quotation/);
		assert.match(optedIn, /\\\[another line\\\]\(javascript:no\)/);
		assert.doesNotMatch(optedIn, /news\.ycombinator\.com|lobste\.rs/);
		await dialog.getByRole("button", { name: "Cancel" }).click();
		const reopened = await openShare(page);
		assert.equal(await reopened.getByRole("checkbox", { name: "My notes" }).isChecked(), false);
		assert.equal(await reopened.getByRole("checkbox", { name: "Saved quotes" }).isChecked(), false);
		assert.equal(app.requests.some((request) => request.url.includes("imported.example.com/reading_")), false);
	} finally {
		await app.browser.close();
	}
});

test("the phone preview blocks Reader shortcuts and exposes the Markdown when clipboard access fails", async () => {
	const app = await shareApp({ viewport: { width: 390, height: 740 }, hasTouch: true });
	try {
		const { page } = app;
		page.setDefaultTimeout(5000);
		await page.addInitScript(() => {
			Object.defineProperty(navigator, "clipboard", {
				value: { writeText: async () => { throw new Error("clipboard denied"); } },
			});
		});
		await page.goto(readerURL);
		await page.locator("#app").waitFor();
		const dialog = await openShare(page);
		const copy = dialog.getByRole("button", { name: "Copy Markdown" });
		const bounds = await copy.boundingBox();
		assert.ok(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 390 && bounds.y + bounds.height <= 740);
		await copy.click();
		const markdown = dialog.getByRole("textbox", { name: "Generated Markdown" });
		await markdown.waitFor();
		assert.match(await markdown.inputValue(), /Reading list/);
		const select = await markdown.evaluate((field) => ({
			start: field.selectionStart, end: field.selectionEnd, length: field.value.length,
		}));
		assert.equal(select.start, 0);
		assert.equal(select.end, select.length);
		await dialog.getByRole("checkbox", { name: "Discussion links" }).focus();
		const modifier = await page.evaluate(() => /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent));
		await page.keyboard.press(modifier ? "Meta+k" : "Control+k");
		assert.equal(await page.locator("#app-search-page").evaluate((node) => node.hidden), true);
		await page.keyboard.press("Escape");
		await dialog.waitFor({ state: "hidden" });
		assert(await waitFor(() => page.evaluate(() => document.querySelector("[data-hnewhere-app]").shadowRoot.activeElement?.id === "app-search")));
		assert.equal(await page.locator("#app").getAttribute("data-stage"), "list");
	} finally {
		await app.browser.close();
	}
});
