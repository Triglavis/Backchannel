import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { launchApp, STORIES, waitFor } from "./harness.mjs";

const readerURL = "https://backchnnl.app/";
const now = 1795104000000;
const collectedKey = "HNewhere:collected";
const migratedKey = "HNewhere:collected_migrated";
const bookmarkHTML = (entries) => `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE><H1>Bookmarks</H1><DL><p>${entries}</DL><p>`;
const bookmark = (url, title, attributes = "") => `<DT><A HREF="${url}" ${attributes}>${title}</A>`;

async function importApp(options = {}) {
	const source = await readFile(process.env.BC_SCRIPT || new URL("../../HNewhere.user.js", import.meta.url), "utf8");
	const end = source.lastIndexOf("\n})();");
	assert(end >= 0);
	const hook = `window.__collectionImportTest = {
		parse: typeof parseBookmarkHTML === "function" && parseBookmarkHTML,
		preview: typeof previewBookmarkImport === "function" && previewBookmarkImport,
		identity: typeof bookmarkImportIdentity === "function" && bookmarkImportIdentity,
		apply: typeof applyBookmarkImport === "function" && applyBookmarkImport,
		accountLock: accountSyncLock,
	};`;
	return launchApp({ sharedStore: true, settings: { updateCheck: false }, ...options,
		source: source.slice(0, end) + "\n\t" + hook + source.slice(end),
	});
}

test("bookmark preview reads title and date, ignores active content, and detects aliases", async () => {
	const app = await importApp();
	try {
		const requests = [];
		app.context.on("request", (request) => requests.push(request.url()));
		await app.page.goto(readerURL);
		const file = bookmarkHTML([
			'<DT><H3>Articles</H3><DL><p>',
			bookmark("https://imported.example.com/page?utm_source=feed", "Caf&eacute; &amp; reading", 'ADD_DATE="1700000000" TAGS="reading"'),
			'<DD>Description with <a href="https://imported.example.com/description">another link</a>',
			bookmark("https://imported.example.com/page#other", "Duplicate"),
			bookmark("https://mirror.example.com/known", "An existing alias"),
			bookmark("https://imported.example.com/undated", "", 'ADD_DATE="invalid"'),
			"</DL><p>",
			bookmark("javascript:void(0)", "Bookmarklet"),
			bookmark("https://user:password@www.example.com/secret", "Credentials"),
			bookmark("https://www.example.com/login", "Excluded path"),
			bookmark("http://localhost:4444/private", "Local host"),
			'<img src="https://imported.example.com/image.png" onerror="window.bookmarkRan=true">',
			'<script>window.bookmarkRan = true;</script>',
		].join("\n"));
		const result = await app.page.evaluate(({ file, now }) => {
			const { parse, preview } = window.__collectionImportTest;
			if (!parse || !preview) return null;
			const parsed = parse(file, now);
			return {
				...preview(parsed, [{
					key: "original.example.com/known",
					url: "https://original.example.com/known",
					collected: { key: "original.example.com/known", addresses: ["mirror.example.com/known"] },
				}]),
				ran: Boolean(window.bookmarkRan),
			};
		}, { file, now });
		assert.ok(result, "the Reader exposes a bookmark preview");
		assert.equal(result.skipped, 4);
		assert.equal(result.duplicates, 2);
		assert.deepEqual(result.additions.map(({ key, title, addedAt, previewOnOpen }) => ({ key, title, addedAt, previewOnOpen })), [
			{ key: "imported.example.com/page", title: "Café & reading", addedAt: 1700000000000, previewOnOpen: true },
			{ key: "imported.example.com/undated", title: "imported.example.com", addedAt: now, previewOnOpen: true },
		]);
		assert(result.additions.every((entry) => !Object.hasOwn(entry, "unwatched")));
		assert.equal(result.ran, false);
		assert.equal(requests.some((url) => url.includes("imported.example.com")), false);
		assert.equal(app.requests.some(({ url }) => url.includes("imported.example.com")), false);
		await assert.rejects(app.page.evaluate((now) => window.__collectionImportTest.parse('<a href="https://www.example.com">Page</a>', now), now), /invalid-bookmark-file/);
	} finally {
		await app.browser.close();
	}
});

test("confirming previews in two tabs keeps both imports and skips a repeated link", async () => {
	const app = await importApp({ values: { [collectedKey]: [], [migratedKey]: true } });
	try {
		const other = await app.context.newPage();
		await Promise.all([app.page.goto(readerURL), other.goto(readerURL)]);
		assert(await app.page.evaluate(() => Boolean(window.__collectionImportTest.apply)), "the Reader can confirm an import");
		const alpha = bookmark("https://imported.example.com/alpha", "Alpha");
		const beta = bookmark("https://imported.example.com/beta", "Beta");
		const confirm = (page, html) => page.evaluate(async (html) => {
			const { identity, parse, apply } = window.__collectionImportTest;
			return apply(parse(html), await identity());
		}, html);
		const result = await Promise.all([
			confirm(app.page, bookmarkHTML(alpha + beta)),
			confirm(other, bookmarkHTML(beta)),
		]);
		assert.equal(result.reduce((sum, each) => sum + each.added, 0), 2);
		assert.equal(result.reduce((sum, each) => sum + each.duplicates, 0), 1);
		assert.deepEqual(app.store.get(collectedKey).map(({ title, previewOnOpen }) => [title, previewOnOpen]).sort(), [["Alpha", true], ["Beta", true]]);
		assert.equal((await confirm(other, bookmarkHTML(alpha))).added, 0);
	} finally {
		await app.browser.close();
	}
});

test("an oversized import and a changed library owner leave saved pages intact", async () => {
	const existing = { key: "imported.example.com/existing", url: "https://imported.example.com/existing", title: "Existing", addedAt: now };
	const app = await importApp({ values: { [collectedKey]: [existing], [migratedKey]: true, "HNewhere:collection_filed": true } });
	try {
		await app.page.goto(readerURL);
		assert(await app.page.evaluate(() => Boolean(window.__collectionImportTest.apply)), "the Reader can confirm an import");
		await assert.rejects(app.page.evaluate(async (html) => {
			const { identity, parse, apply } = window.__collectionImportTest;
			const parsed = parse(html);
			parsed.bookmarks[0].title = "a".repeat(32 * 1024 * 1024);
			return apply(parsed, await identity());
		}, bookmarkHTML(bookmark("https://imported.example.com/new", "New"))), /snapshot-too-large/);
		const before = await app.page.evaluate(() => window.__collectionImportTest.identity());
		app.store.set("HNewhere:account_data_owner", "another-account");
		await assert.rejects(app.page.evaluate(({ html, before }) => {
			const { parse, apply } = window.__collectionImportTest;
			return apply(parse(html), before);
		}, { html: bookmarkHTML(bookmark("https://imported.example.com/new", "New")), before }), /bookmark-import-owner-changed/);
		assert.deepEqual(app.store.get(collectedKey), [existing]);
	} finally {
		await app.browser.close();
	}
});

test("an import leaves the library untouched if shared storage coordination fails", async () => {
	const app = await importApp({ values: { [collectedKey]: [], [migratedKey]: true, "HNewhere:collection_filed": true } });
	try {
		await app.page.goto(readerURL);
		await assert.rejects(app.page.evaluate(async (html) => {
			const { identity, parse, apply } = window.__collectionImportTest;
			const list = GM.listValues;
			GM.listValues = async () => { throw new Error("manager unavailable"); };
			try {
				return await apply(parse(html), await identity());
			} finally {
				GM.listValues = list;
			}
		}, bookmarkHTML(bookmark("https://imported.example.com/new", "New"))), /Shared storage coordination is unavailable/);
		assert.deepEqual(app.store.get(collectedKey), []);
	} finally {
		await app.browser.close();
	}
});

test("a pending account change finishes before the import can commit", async () => {
	const app = await importApp({ values: { [collectedKey]: [], [migratedKey]: true, "HNewhere:collection_filed": true } });
	try {
		await app.page.goto(readerURL);
		await app.page.evaluate(async () => {
			const { identity, accountLock } = window.__collectionImportTest;
			window.previewOwner = await identity();
			window.accountTransition = accountLock(() => new Promise((release) => { window.finishAccountTransition = release; }));
		});
		assert(await waitFor(() => app.page.evaluate(() => Boolean(window.finishAccountTransition))));
		let outcome;
		const confirm = app.page.evaluate((html) => {
			const { parse, apply } = window.__collectionImportTest;
			return apply(parse(html), window.previewOwner);
		}, bookmarkHTML(bookmark("https://imported.example.com/new", "New"))).then(
			() => { outcome = "saved"; },
			(error) => { outcome = error.message; },
		);
		assert(await waitFor(() => outcome || [...app.store.keys()].filter((key) => key.startsWith("HNewhere:storage_lock:account-sync:")).length > 1));
		app.store.set("HNewhere:account_data_owner", "new-owner");
		await app.page.evaluate(() => { window.finishAccountTransition(); return window.accountTransition; });
		await confirm;
		assert.match(outcome, /bookmark-import-owner-changed/);
		assert.deepEqual(app.store.get(collectedKey), []);
	} finally {
		await app.browser.close();
	}
});

test("the empty Collection opens a local import preview and includes confirmed links in search", async () => {
	const app = await launchApp({ sharedStore: true, settings: { updateCheck: false, sourceRefreshMinutes: 0 } });
	try {
		const { page } = app;
		const requested = [];
		app.context.on("request", (request) => requested.push(request.url()));
		page.setDefaultTimeout(5000);
		await page.goto(readerURL);
		await page.locator("#app").waitFor();
		const collection = page.locator('#app-rail [data-app-view="collection"]');
		assert(await collection.isVisible(), "an empty Collection can be opened from the rail");
		await collection.click();
		const open = page.locator("#app-list-body").getByRole("button", { name: "Import bookmarks" });
		const selectFile = async () => {
			const [picker] = await Promise.all([page.waitForEvent("filechooser"), open.click()]);
			await picker.setFiles({
				name: "bookmarks.html", mimeType: "text/html",
				buffer: Buffer.from(bookmarkHTML(bookmark("https://imported.example.com/quiet", "Quiet migration"))),
			});
			return page.getByRole("dialog", { name: "Import bookmarks" });
		};
		let dialog = await selectFile();
		await dialog.getByRole("button", { name: "Cancel" }).focus();
		const modifier = await page.evaluate(() => /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent));
		await page.keyboard.press(modifier ? "Meta+k" : "Control+k");
		assert.equal(await page.locator("#app-search-page").evaluate((node) => node.hidden), true);
		await page.keyboard.press("Escape");
		await dialog.waitFor({ state: "hidden" });
		assert.deepEqual(app.store.get(collectedKey), []);
		dialog = await selectFile();
		await dialog.getByText(/Backchannel checks saved links for new discussions/).waitFor();
		await dialog.getByRole("button", { name: "Import 1 link" }).click();
		assert(await waitFor(() => app.store.get(collectedKey)?.some((item) => item.title === "Quiet migration")));
		await page.locator("#toast").getByText(/Sign in to sync across devices/).waitFor();
		const placeholder = page.locator("#app-list-body .reader-collection-row .browse-thumb-wrap.is-generic");
		await placeholder.waitFor();
		assert.deepEqual(await placeholder.evaluate((node) => {
			const box = node.getBoundingClientRect();
			const glyph = getComputedStyle(node, "::before");
			return [box.width, box.height, glyph.top, glyph.right, glyph.bottom, glyph.left];
		}), [30, 30, "0px", "0px", "0px", "0px"]);
		assert.equal(app.requests.some(({ url }) => url.includes("imported.example.com")), false);
		assert.equal(requested.some((url) => url.includes("imported.example.com")), false);

		await page.locator("#app-rail-search").click();
		const search = page.getByRole("searchbox", { name: "Search Backchannel" });
		await search.fill("Quiet migration");
		await page.locator("#app-search-results").getByRole("button", { name: /Quiet migration/ }).waitFor();
		await search.fill("https://imported.example.com/quiet");
		assert(await waitFor(async () => (await page.locator("#app-search-results").getByRole("button", { name: /Quiet migration/ }).count()) === 1, 2000));
		await search.fill("Import bookmarks");
		await page.locator("#app-search-results").getByRole("button", { name: /Import bookmarks/ }).click();
		const settings = page.getByRole("dialog", { name: "Settings" });
		await settings.getByRole("button", { name: "Choose file…" }).waitFor();
		assert.equal(await settings.getByText("Sync across devices", { exact: true }).count(), 0);
		const collectionTab = settings.getByRole("button", { name: "Collection", exact: true });
		assert.equal(await collectionTab.getAttribute("aria-current"), "page");
		const { fill, stroke } = await collectionTab.locator("svg path").evaluate((path) => {
			const style = getComputedStyle(path);
			return { fill: style.fill, stroke: style.stroke };
		});
		assert.equal(fill, "none", "the Collection Settings icon is outlined");
		assert.notEqual(stroke, "none");
	} finally {
		await app.browser.close();
	}
});

test("opening an imported bookmark discovers its Hacker News discussion by URL", async () => {
	const url = "https://framed.example.com/post/99";
	const app = await launchApp({
		sharedStore: true,
		settings: { updateCheck: false, sourceRefreshMinutes: 0, sources: { hn: true } },
		values: { "HNewhere:app_panes": { list: true, discussion: true } },
		extraStories: [{ id: 9200, url, title: "Article with a discussion", comments: 1 }],
	});
	try {
		const { page } = app;
		page.setDefaultTimeout(6000);
		await page.goto(readerURL);
		await page.locator('#app-rail [data-app-view="collection"]').click();
		const body = page.locator("#app-list-body");
		const [picker] = await Promise.all([
			page.waitForEvent("filechooser"),
			body.getByRole("button", { name: "Import bookmarks" }).click(),
		]);
		await picker.setFiles({
			name: "bookmarks.html", mimeType: "text/html",
			buffer: Buffer.from(bookmarkHTML(bookmark(url, "My bookmark title"))),
		});
		await page.getByRole("button", { name: "Import 1 link" }).click();
		const row = body.getByRole("link", { name: "My bookmark title" });
		await row.waitFor();
		const lookedUp = () => app.requests.some(({ url: requestURL }) => {
			const request = new URL(requestURL);
			return request.hostname === "hn.algolia.com" && request.searchParams.get("query") === url;
		});
		assert.equal(lookedUp(), false, "importing does not look up discussions");
		await row.click();
		await page.locator('#comments-content .comment[data-comment-id="hn:920000"]')
			.getByText(/Comment 1 on Article with a discussion/).waitFor();
		assert.equal(lookedUp(), true, "opening the bookmark looks up its URL");
	} finally {
		await app.browser.close();
	}
});

test("Collection checks only eligible URLs and sends neither fragments nor saved dates", async () => {
	const legacy = { key: "framed.example.com/post/99", url: "https://framed.example.com/post/99", title: "Previously unwatched", unwatched: true };
	const imported = { key: "framed.example.com/post/100", url: "https://framed.example.com/post/100", title: "Imported link", previewOnOpen: true };
	const privateQuery = { key: "framed.example.com/post/101?invite=fixture", url: "https://framed.example.com/post/101?invite=fixture", title: "Private query" };
	const publicURL = "https://framed.example.com/post/102";
	const publicPage = { key: "framed.example.com/post/102", url: publicURL + "?utm_source=fixture#section", title: "Manually saved link" };
	const pages = [legacy, imported, privateQuery, publicPage];
	const app = await launchApp({
		sharedStore: true,
		settings: { updateCheck: false, sourceRefreshMinutes: 5, sources: { hn: true } },
		values: {
			[collectedKey]: pages.map((entry) => ({ ...entry, addedAt: 1700000000000, marks: { hn: "total:0" } })),
			[migratedKey]: true,
			"HNewhere:collection_filed": true,
		},
		extraStories: [{ url: publicURL, title: publicPage.title, comments: 1 }],
		responses: [{
			match: (url) => url.startsWith("https://hn.algolia.com/api/v1/search?") && new URL(url).searchParams.get("hitsPerPage") === "0",
			json: { nbHits: 1 },
		}],
	});
	try {
		const { page } = app;
		page.setDefaultTimeout(6000);
		await page.goto(readerURL);
		await page.locator('#app-rail [data-app-view="collection"]').click();
		const row = page.locator(".reader-collection-row").filter({ has: page.getByRole("link", { name: publicPage.title, exact: true }) });
		await row.getByText(/new comment|New discussion/).waitFor();
		const queries = app.requests.map(({ url }) => new URL(url)).filter((request) => request.hostname === "hn.algolia.com");
		assert(queries.some(({ searchParams }) => searchParams.get("query") === publicURL));
		assert(queries.every(({ searchParams }) => !searchParams.has("numericFilters")));
		assert(queries.every(({ searchParams }) => {
			const query = searchParams.get("query") || "";
			return !/post\/(?:99|100|101)|utm_source|#section/.test(query);
		}));
		assert.deepEqual(app.errors, []);
	} finally {
		await app.browser.close();
	}
});

test("Collection uses standard Reader row spacing and shows saved and retrieved previews", async () => {
	const story = STORIES[7];
	const key = "framed.example.com/post/8";
	const favicon = "https://books.example.com/site-icon.png";
	const iconKey = "books.example.com/icon-only";
	const cachedImage = "https://books.example.com/cached-cover.png";
	const watchedURL = "https://books.example.com/watched";
	const watchedImage = "https://books.example.com/watched-cover.png";
	const app = await launchApp({
		sharedStore: true,
		settings: { updateCheck: false, sourceRefreshMinutes: 0, frontPageMode: "sources", sources: { hn: true } },
		values: {
			[collectedKey]: [
				{ key, url: story.url, title: story.title, addedAt: now, unwatched: true },
				{ key: "books.example.com/watched", url: watchedURL, title: "Watched article", addedAt: now - 1000 },
				{ key: iconKey, url: `https://${iconKey}`, title: "Bookmark with a site icon", addedAt: now - 2000, previewOnOpen: true },
			],
			[migratedKey]: true,
			"HNewhere:collection_filed": true,
			"HNewhere:looks": { [key]: { image: cachedImage, at: now }, [iconKey]: { icon: favicon, at: now } },
		},
		responses: [{
			match: (url) => url === watchedURL,
			headers: "content-type: text/html",
			text: `<html><head><meta property="og:image" content="${watchedImage}"></head><body>Preview fixture</body></html>`,
		}],
	});
	try {
		const { page } = app;
		page.setDefaultTimeout(5000);
		for (const image of [favicon, cachedImage, watchedImage]) {
			await app.context.route(image, (route) => route.fulfill({
				contentType: "image/svg+xml",
				body: '<svg xmlns="http://www.w3.org/2000/svg" width="220" height="220"><rect width="220" height="220" fill="#237140"/></svg>',
			}));
		}
		const rowFor = (title) => page.locator("#app-list-body .browse-row").filter({ has: page.getByRole("link", { name: title, exact: true }) });
		const dimensions = async (row) => {
			let measurement;
			assert(await waitFor(async () => {
				measurement = await row.evaluate((node) => {
					const title = getComputedStyle(node.querySelector(".browse-title-link"));
					const thumb = node.querySelector(".browse-thumb-wrap")?.getBoundingClientRect();
					return {
						font: title.fontSize, lineHeight: title.lineHeight, padding: getComputedStyle(node).padding,
						thumb: thumb && [thumb.width, thumb.height], height: node.getBoundingClientRect().height,
					};
				});
				return measurement.height > 0;
			}, 2000));
			return measurement;
		};
		const checkThumbnail = async (thumbnail, source) => {
			assert(await waitFor(() => thumbnail.evaluate((node, url) => node.src === url && node.naturalWidth > 0, source), 2000), source);
			assert.deepEqual(await thumbnail.evaluate((node) => {
				const box = node.getBoundingClientRect();
				const style = getComputedStyle(node);
				return [box.width, box.height, style.margin, style.objectFit];
			}), [30, 30, "0px", "cover"]);
		};
		await page.goto(readerURL);
		await page.locator("#app-list-sync").click();
		const { height: standardHeight, ...standard } = await dimensions(rowFor(story.title));
		assert.deepEqual(standard.thumb, [30, 30]);
		await page.locator('#app-rail [data-app-view="collection"]').click();
		const collection = rowFor(story.title).and(page.locator(".reader-collection-row"));
		const { height, ...collectionStyle } = await dimensions(collection);
		assert.deepEqual(collectionStyle, standard);
		assert(height <= standardHeight);
		for (const [row, image] of [[collection, cachedImage], [rowFor("Watched article"), watchedImage]]) {
			await checkThumbnail(row.locator(".has-preview .browse-thumb"), image);
		}
		await checkThumbnail(rowFor("Bookmark with a site icon").locator(".browse-thumb"), favicon);
	} finally {
		await app.browser.close();
	}
});

test("Collection settings download portable bookmarks and the existing notes export", async () => {
	const url = "https://framed.example.com/post/99?q=one&mode=two";
	const noteKey = "HNewhere:notes:url:framed.example.com/post/99";
	const values = {
		[collectedKey]: [{ key: "framed.example.com/post/99", url, title: "Research", addedAt: 1700000000000 }],
		[migratedKey]: true,
		"HNewhere:collection_filed": true,
		"HNewhere:notes_index": [{ key: noteKey, kind: "url", id: "framed.example.com/post/99", url, title: "Café & reading", count: 1 }],
		[noteKey]: { version: 1, notes: [{ id: "export-test", text: "My private note", created: 1700000000 }] },
	};
	const app = await importApp({ values });
	try {
		const { page } = app;
		page.setDefaultTimeout(5000);
		await page.goto(readerURL);
		await page.getByRole("button", { name: "Open Backchannel settings" }).click();
		const settings = page.getByRole("dialog", { name: "Settings" });
		assert.equal(await settings.getByRole("button", { name: /export notes|download json|^export$/i }).count(), 0);
		await settings.getByRole("button", { name: "Collection", exact: true }).click();
		const imports = settings.getByRole("region", { name: "Import", exact: true });
		await imports.getByText("Import your bookmarks from other services", { exact: true }).waitFor();
		assert(await imports.getByRole("button", { name: "Choose file…" }).isVisible());
		const exports = settings.getByRole("region", { name: "Export", exact: true });
		const download = async (name) => {
			const [file] = await Promise.all([page.waitForEvent("download"), exports.getByRole("button", { name }).click()]);
			return readFile(await file.path(), "utf8");
		};
		const html = await download("Download HTML");
		assert(!html.includes("My private note"), "bookmark files contain no note text");
		const parsed = await page.evaluate((file) => window.__collectionImportTest.parse(file), html);
		assert.deepEqual(parsed.bookmarks.map(({ url, title, addedAt }) => ({ url, title, addedAt })), [
			{ url, title: "Café & reading", addedAt: 1700000000000 },
		]);
		const notes = JSON.parse(await download("Download JSON"));
		assert.equal(notes.application, "Backchannel");
		assert.equal(notes.noteCount, 1);
		assert.equal(notes.documents[0].notes[0].text, "My private note");
	} finally {
		await app.browser.close();
	}
});

test("Sidebar Collection imports and exports bookmarks and notes in place", async () => {
	const url = STORIES[0].url;
	const key = "framed.example.com/post/99";
	const noteKey = "HNewhere:notes:url:" + key;
	const app = await launchApp({
		topHosts: [new URL(url).hostname],
		sharedStore: true,
		settings: { autoOpenSidebar: true, updateCheck: false },
		values: {
			[migratedKey]: true,
			"HNewhere:notes_index": [{ key: noteKey, kind: "url", id: key, url, title: "Private export", count: 1 }],
			[noteKey]: { version: 1, notes: [{ id: "sidebar-export-test", text: "A private Sidebar note", created: 1700000000 }] },
		},
	});
	try {
		const { page } = app;
		page.setDefaultTimeout(5000);
		await page.goto(url);
		await page.getByRole("button", { name: "Open Backchannel settings" }).click();
		const settings = page.getByRole("dialog", { name: "Settings" });
		await settings.getByRole("button", { name: "Collection", exact: true }).click();
		assert(await waitFor(() => page.frame("backchannel-sidebar-settings"), 3500));
		const frame = page.frame("backchannel-sidebar-settings");
		const [chooser] = await Promise.all([
			page.waitForEvent("filechooser"),
			frame.getByRole("button", { name: "Choose file…" }).click(),
		]);
		await chooser.setFiles({ name: "bookmarks.html", mimeType: "text/html",
			buffer: Buffer.from(bookmarkHTML(bookmark("https://imported.example.com/sidebar", "Imported from the Sidebar"))) });
		await frame.getByRole("button", { name: "Import 1 link", exact: true }).click();
		assert(await waitFor(() => page.frame("backchannel-saved-list"), 3500));
		await page.frame("backchannel-saved-list").getByRole("link", { name: "Imported from the Sidebar", exact: true }).waitFor();
		await page.getByRole("button", { name: "Open Backchannel settings" }).click();
		await settings.getByRole("button", { name: "Collection", exact: true }).click();
		assert(await waitFor(() => page.frame("backchannel-sidebar-settings"), 3500));
		const exports = page.frame("backchannel-sidebar-settings").getByRole("region", { name: "Export", exact: true });
		const download = async (name) => {
			const [file] = await Promise.all([page.waitForEvent("download"), exports.getByRole("button", { name }).click()]);
			return readFile(await file.path(), "utf8");
		};
		assert.match(await download("Download HTML"), /Imported from the Sidebar/);
		assert.equal(JSON.parse(await download("Download JSON")).documents[0].notes[0].text, "A private Sidebar note");
		assert.equal(page.url(), url);
		assert.deepEqual(app.context.pages(), [page]);
	} finally {
		await app.browser.close();
	}
});

test("Reader Collection filters and pages its rows without changing the article layout", async () => {
	const story = STORIES[0];
	const key = new URL(story.url).hostname + new URL(story.url).pathname;
	const noteKey = "HNewhere:notes:url:" + key;
	const values = {
		"HNewhere:app_panes": { list: true, discussion: true },
		[collectedKey]: [
			{ key, url: story.url, title: story.title, addedAt: now, foundAt: now, count: 8 },
			...Array.from({ length: 31 }, (_, index) => ({
				key: "books.example.com/" + index, url: "https://books.example.com/" + index,
				title: "Saved link " + index, addedAt: now - index, unwatched: true,
			})),
		],
		[migratedKey]: true,
		"HNewhere:notes_index": [{ key: noteKey, kind: "url", id: key, url: story.url, title: story.title, count: 1 }],
		[noteKey]: { version: 1, notes: [{ id: "collection-test-note", created: now / 1000, text: "A saved note for this story" }] },
		"HNewhere:favorites": [{ key: "hn:900101", kind: "comment", url: story.url, title: "An earlier quote", text: "An earlier quote", page: key, focus: "hn:900101", addedAt: now }],
	};
	const app = await launchApp({ sharedStore: true, values, settings: { updateCheck: false, sourceRefreshMinutes: 0 } });
	try {
		const { page } = app;
		page.setDefaultTimeout(6000);
		await page.goto(readerURL);
		const collection = page.locator('#app-rail [data-app-view="collection"]');
		await collection.click();
		const body = page.locator("#app-list-body");
		const filter = page.getByRole("button", { name: "Filter and sort Collection" });
		assert.equal(await filter.count(), 1, "Collection has a dedicated filter and sort control");
		await body.getByRole("heading", { name: "New discussion activity" }).waitFor();
		assert.equal(Math.round((await page.locator("#app-list").boundingBox()).width), 300);
		assert.equal(await body.locator(".reader-collection-row").count(), 30);
		await body.getByRole("button", { name: "Show more" }).click();
		assert(await waitFor(async () => (await body.locator(".reader-collection-row").count()) === 32));
		await filter.click();
		await page.getByRole("menuitemradio", { name: "Notes & quotes" }).click();
		assert(await waitFor(async () => (await body.locator(".reader-collection-row").count()) === 1));
		const threadKey = `HNewhere:thread_cache:hn:${story.id}`;
		await page.evaluate((threadKey) => {
			const setValue = GM.setValue;
			const ready = new Promise((resolve) => { window.finishQuoteDiscussion = resolve; });
			GM.setValue = async (key, value) => {
				if (key === threadKey) await ready;
				return setValue(key, value);
			};
		}, threadKey);
		await body.getByRole("link", { name: story.title }).click();
		await page.locator("#app-article-body iframe").waitFor();
		const discussion = page.locator("#comments-content");
		const disclosure = discussion.getByText("Saved quotes", { exact: true });
		await disclosure.waitFor();
		await disclosure.click();
		const quote = discussion.getByRole("button", { name: /An earlier quote/ });
		await quote.waitFor();
		await page.evaluate(() => window.finishQuoteDiscussion());
		assert(await waitFor(() => app.store.has(threadKey)));
		await page.locator("#comment-sort:enabled").waitFor();
		assert(await quote.isVisible(), "Saved quotes stays open after the discussion finishes loading");
		await discussion.getByText("A saved note for this story", { exact: true }).waitFor();
		assert.equal(await discussion.getByText("In your Collection", { exact: true }).count(), 0);
		await page.locator('#app-rail [data-app-view="all"]').click();
		await discussion.getByText("In your Collection", { exact: true }).waitFor();
	} finally {
		await app.browser.close();
	}
});
