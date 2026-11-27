import test from "node:test";
import assert from "node:assert/strict";
import { frontPageHTML, launchApp, STORIES, waitFor } from "./harness.mjs";

const url = "https://backchnnl.app/";
const settings = { sources: { hn: true }, frontPageMode: "sources", updateCheck: false, sourceRefreshMinutes: 0 };
const collectedKey = "HNewhere:collected";

async function beginSelection(page, row) {
	await row.locator(".browse-more").click();
	await page.getByRole("menuitem", { name: "Select link", exact: true }).click();
}

function selectionBar(page) {
	return page.getByRole("group", { name: "Selected links", exact: true });
}

async function selectedAction(page, label) {
	await selectionBar(page).getByRole("button", { name: "Actions" }).click();
	await page.getByRole("menuitem", { name: label, exact: true }).click();
}

test("Shift-click on row padding enters selection and extends it across the visible list", async () => {
	const app = await launchApp({ sharedStore: true, settings });
	try {
		const { page } = app;
		page.setDefaultTimeout(3000);
		await page.goto(url);
		await page.locator("#app-list-sync").click();
		const rows = page.locator("#app-list-body .browse-row");
		await rows.nth(3).waitFor();
		const padding = { x: 4, y: 8 };
		await rows.nth(0).click({ position: padding, modifiers: ["Shift"] });
		const bar = selectionBar(page);
		await bar.getByText("1 selected", { exact: true }).waitFor();
		assert.deepEqual(await bar.getByRole("button").evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label") || button.textContent.trim())), [
			"Close selection", "Share reading list", "Actions",
		]);
		const close = bar.getByRole("button", { name: "Close selection" });
		assert(await close.evaluate((button) => button.parentElement.firstElementChild === button && Boolean(button.querySelector("svg")) && !button.textContent.trim()));
		await close.click();
		await bar.waitFor({ state: "hidden" });
		await rows.nth(0).click({ position: padding, modifiers: ["Shift"] });
		await rows.nth(2).click({ position: padding, modifiers: ["Shift"] });
		await bar.getByText("3 selected", { exact: true }).waitFor();
		await rows.nth(1).click({ button: "right", position: padding });
		await page.getByRole("menu", { name: "Selected link actions" }).waitFor();
		await page.keyboard.press("Escape");
		await bar.getByText("3 selected", { exact: true }).waitFor();
		assert(await waitFor(() => bar.evaluate((node) => {
			const root = node.getRootNode();
			const bottom = root.getElementById("app-chin").getBoundingClientRect().top;
			const bounds = node.getBoundingClientRect();
			return node.parentElement.id === "app" && bounds.bottom <= bottom && bottom - bounds.bottom <= 20;
		}), 1500), "the shared selection bar sits just above the desktop footer");
		assert.notEqual(await bar.evaluate((node) => getComputedStyle(node).animationName), "none");
		await page.emulateMedia({ reducedMotion: "reduce" });
		assert.equal(await bar.evaluate((node) => getComputedStyle(node).animationName), "none");
		for (const index of [0, 1, 2]) assert(await rows.nth(index).getByRole("checkbox").isChecked());
		assert.equal(await rows.nth(3).getByRole("checkbox").isChecked(), false);
		await rows.nth(1).click({ position: padding });
		await bar.getByText("2 selected", { exact: true }).waitFor();
		await rows.nth(1).locator(".browse-title-link").click();
		await bar.getByText("3 selected", { exact: true }).waitFor();
		assert.equal(await page.locator("#app-article-body iframe").count(), 0);
		assert.equal(app.context.pages().length, 1);
		for (const index of [0, 1, 2]) await rows.nth(index).getByRole("checkbox").click();
		await bar.waitFor({ state: "hidden" });
		assert.equal(await rows.getByRole("checkbox").count(), 0);
	} finally {
		await app.browser.close();
	}
});

test("Right-click opens the same article menu as More, without view names", async () => {
	const story = STORIES[7];
	const key = "framed.example.com/post/8";
	const app = await launchApp({
		sharedStore: true, settings,
		values: {
			[collectedKey]: [{ key, url: story.url, title: story.title, addedAt: 1700000000000, unwatched: true }],
			"HNewhere:collected_migrated": true, "HNewhere:collection_filed": true,
			"HNewhere:queue": [{ ...story, key, source: "hn", addedAt: 1700000000000 }],
		},
	});
	try {
		const { page } = app;
		page.setDefaultTimeout(3000);
		await page.emulateMedia({ reducedMotion: "reduce" });
		await page.goto(url);
		await page.locator("#app-list-sync").click();
		for (const [view, section, action] of [["all", "All Front Pages", "Hide"], ["queue", "Queue", "Unqueue"], ["collection", "Collection", "Remove"]]) {
			await page.locator(`#app-rail [data-app-view="${view}"]`).click();
			const row = page.locator("#app-list-body .browse-row").filter({ has: page.getByRole("link", { name: story.title, exact: true }) });
			const more = row.locator(".browse-more");
			await more.waitFor();
			assert.equal(await more.getAttribute("aria-controls"), "app-row-menu", view);
			assert.equal(await more.getAttribute("aria-expanded"), "false", view);
			await more.click();
			const menu = page.locator("#app-row-menu");
			await menu.waitFor();
			assert.equal(await more.getAttribute("aria-expanded"), "true", view);
			const items = await menu.getByRole("menuitem").allTextContents();
			assert.deepEqual(items.slice(0, 3), ["Open", "Open in new tab", action], view);
			assert.deepEqual(items.slice(-2), ["Copy link", "Select link"], view);
			assert.equal(await menu.getByRole("separator").count(), 2);
			await menu.getByRole("menuitem", { name: action, exact: true }).waitFor();
			assert.equal(await menu.getByRole("menuitem", { name: /^(un)?watch$/i }).count(), 0);
			await page.keyboard.press("Escape");
			assert.equal(await more.getAttribute("aria-expanded"), "false", view);
			assert(await more.evaluate((button) => button.matches(":focus")), view);
			const target = view === "collection" ? row.locator(".browse-title-link") : row;
			await row.evaluate((node) => node.addEventListener("contextmenu", (event) => {
				const { clientX, clientY, defaultPrevented } = event;
				node.dataset.contextClick = JSON.stringify({ clientX, clientY, defaultPrevented });
			}, { once: true }));
			await target.click({ button: "right", position: { x: 4, y: 8 } });
			await menu.waitFor();
			assert.deepEqual(await menu.getByRole("menuitem").allTextContents(), items, view);
			assert.equal(await menu.getByText(section, { exact: true }).count(), 0, view);
			const point = JSON.parse(await row.getAttribute("data-context-click"));
			assert(point.defaultPrevented, `the browser menu is suppressed in ${view}`);
			const bounds = await menu.boundingBox();
			const viewport = page.viewportSize();
			assert(Math.abs(bounds.x - Math.min(point.clientX, viewport.width - bounds.width - 8)) <= 1);
			assert(Math.abs(bounds.y - Math.min(point.clientY, viewport.height - bounds.height - 8)) <= 1);
			await page.keyboard.press("Escape");
		}
	} finally {
		await app.browser.close();
	}
});

test("The toolbar selection button starts empty, reuses row selection, and exits when cleared", async () => {
	const app = await launchApp({ sharedStore: true, settings });
	try {
		const { page } = app;
		page.setDefaultTimeout(3000);
		await page.goto(url);
		await page.locator("#app-list-sync").click();
		const toggle = page.getByRole("button", { name: "Select links", exact: true });
		const rows = page.locator("#app-list-body .browse-row");
		await rows.nth(1).waitFor();
		assert(await toggle.evaluate((node) => Boolean(node.closest("#app-list .app-pane-actions") && node.querySelector("svg"))));
		assert.equal(await toggle.getAttribute("aria-pressed"), "false");
		await toggle.click();
		const first = rows.first().getByRole("checkbox");
		await first.waitFor();
		assert.equal(await toggle.getAttribute("aria-pressed"), "true");
		assert.equal(await rows.locator("input:checked").count(), 0);
		assert.equal(await selectionBar(page).count(), 0);
		await first.press("Escape");
		assert.equal(await toggle.getAttribute("aria-pressed"), "false");
		assert(await toggle.evaluate((node) => node.getRootNode().activeElement === node));
		await toggle.click();
		await first.check();
		await selectionBar(page).getByText("1 selected", { exact: true }).waitFor();
		await first.click();
		await selectionBar(page).waitFor({ state: "hidden" });
		assert.equal(await rows.getByRole("checkbox").count(), 0);
		assert.equal(await toggle.getAttribute("aria-pressed"), "false");
		await toggle.click();
		await rows.nth(1).click({ button: "right", position: { x: 4, y: 8 } });
		await page.getByRole("menu", { name: "Selected link actions" }).waitFor();
		assert(await rows.nth(1).getByRole("checkbox").isChecked());
		await page.keyboard.press("Escape");
		await toggle.click();
		await selectionBar(page).waitFor({ state: "hidden" });
		await page.locator('#app-rail [data-app-view="collection"]').click();
		await page.getByText("No saved pages yet.", { exact: true }).waitFor();
		assert(await toggle.isDisabled());
	} finally {
		await app.browser.close();
	}
});

test("Unqueue immediately removes each row and updates the Queue badge and empty state", async () => {
	const stories = [STORIES[0], STORIES[7]];
	const app = await launchApp({
		sharedStore: true,
		settings,
		values: {
			"HNewhere:queue": stories.map((story) => ({
				...story, key: new URL(story.url).hostname + new URL(story.url).pathname,
				source: "hn", addedAt: 1700000000000, readAt: null,
			})),
		},
	});
	try {
		const { page } = app;
		page.setDefaultTimeout(4000);
		await page.goto(url);
		const queue = page.locator('#app-rail [data-app-view="queue"]');
		const badge = queue.locator(".rail-badge");
		await queue.click();
		assert(await waitFor(async () => await badge.textContent() === "2", 2000));
		const body = page.locator("#app-list-body");
		for (const [index, story] of stories.entries()) {
			const row = body.locator(".browse-row.app-row").filter({ has: page.getByRole("link", { name: story.title, exact: true }) });
			await row.locator(".browse-more").click();
			await page.getByRole("menuitem", { name: "Unqueue", exact: true }).click();
			const remaining = stories.length - index - 1;
			assert(await waitFor(() => app.store.get("HNewhere:queue").length === remaining, 2000));
			assert(await waitFor(async () => await badge.textContent() === (remaining ? String(remaining) : ""), 2000));
			await row.waitFor({ state: "detached", timeout: 2000 });
		}
		await body.getByText(/Nothing queued yet/).waitFor();
		await queue.waitFor({ state: "hidden", timeout: 2000 });
		assert.deepEqual(app.errors, []);
	} finally {
		await app.browser.close();
	}
});

test("returning to Unread on a phone removes the link just read", async () => {
	const [first, second] = STORIES;
	const app = await launchApp({
		sharedStore: true, settings, hasTouch: true, viewport: { width: 390, height: 844 },
		values: { "HNewhere:frontpage_feed:/hn/front/": {
			timestamp: Date.now(), stories: [first, second].map((story) => ({ ...story, source: "hn", descendants: story.comments })),
		} },
	});
	try {
		const { page } = app;
		page.setDefaultTimeout(5000);
		const list = page.locator("#app-list-body");
		const article = list.getByRole("link", { name: first.title, exact: true });
		const next = list.getByRole("link", { name: second.title, exact: true });
		const unread = page.getByRole("button", { name: "Unread only", exact: true });
		await page.goto(url);
		await next.waitFor();
		assert.equal(await unread.getAttribute("aria-pressed"), "true");
		await article.tap();
		await page.locator('#app[data-stage="article"]:not([data-moving])').waitFor();
		assert(await waitFor(() => app.store.get("HNewhere:seen_comments")?.[`hn:${first.id}`] > 0));
		assert.equal(await page.locator("#app-next .app-next-title").textContent(), second.title);
		await page.locator("#app-bar-back").tap();
		await page.locator('#app[data-stage="list"]:not([data-moving])').waitFor();
		await article.waitFor({ state: "detached", timeout: 2000 });
		assert(await next.isVisible());

		await page.emulateMedia({ reducedMotion: "reduce" });
		await next.tap();
		await page.locator('#app[data-stage="article"]').waitFor();
		await page.locator("#app-bar-back").tap();
		await list.getByText("All caught up.", { exact: true }).waitFor();
		assert.deepEqual(app.errors, []);
	} finally {
		await app.browser.close();
	}
});

test("an article read in Reader stays out of Unread when the same link is reposted", async () => {
	const feedKey = "HNewhere:frontpage_feed:/hn/front/";
	const [first, second] = STORIES.slice(7, 9).map((story) => ({ ...story, source: "hn", descendants: story.comments }));
	const feed = (story) => ({ timestamp: Date.now(), stories: [story, second] });
	const app = await launchApp({ sharedStore: true, settings, values: { [feedKey]: feed(first) } });
	try {
		const { page } = app;
		page.setDefaultTimeout(5000);
		const list = page.locator("#app-list-body");
		const link = (story) => list.getByRole("link", { name: story.title, exact: true });
		const unread = page.getByRole("button", { name: "Unread only", exact: true });
		await page.goto(url);
		await link(first).click();
		assert(await waitFor(() => app.store.get("HNewhere:seen_comments")?.[`hn:${first.id}`] > 0));
		const repost = { ...first, id: 9999, url: first.url + "?utm_source=feed", title: "A new discussion of the same article" };
		app.store.set(feedKey, feed(repost));
		await page.reload();
		await link(second).waitFor();
		assert.equal(await unread.getAttribute("aria-pressed"), "true");
		assert.equal(await link(repost).count(), 0);
		await unread.click();
		await link(repost).waitFor();
		assert.equal(app.store.get("HNewhere:seen_comments")[`hn:${repost.id}`], undefined, "the new discussion has its own comment history");
		assert.deepEqual(app.errors, []);
	} finally {
		await app.browser.close();
	}
});

test("marking selected Unread articles read leaves another article unread", async () => {
	const app = await launchApp({ sharedStore: true, settings });
	try {
		const { page } = app;
		page.setDefaultTimeout(5000);
		await page.goto(url);
		await page.locator("#app-list-sync").click();
		const rows = page.locator("#app-list-body .browse-row");
		const row = (story) => rows.filter({ has: page.getByRole("link", { name: story.title, exact: true }) });
		const [first, second, other] = STORIES.slice(7, 10);
		await row(other).waitFor();
		await beginSelection(page, row(first));
		await row(second).getByRole("checkbox", { name: `Select ${second.title}` }).check();
		await selectionBar(page).getByText("2 selected", { exact: true }).waitFor();
		await selectedAction(page, "Mark selected as read");
		await row(first).waitFor({ state: "hidden" });
		await row(second).waitFor({ state: "hidden" });
		assert(await row(other).isVisible());
		const seen = app.store.get("HNewhere:seen_comments");
		assert(seen[`hn:${first.id}`] > 0);
		assert(seen[`hn:${second.id}`] > 0);
		assert.equal(seen[`hn:${other.id}`], undefined);
		await page.locator("#toast").getByRole("button", { name: "undo" }).click();
		await row(first).waitFor();
		await row(second).waitFor();
	} finally {
		await app.browser.close();
	}
});

test("Mark all as read stays available during selection and includes unselected links", async () => {
	for (const phone of [false, true]) {
		const app = await launchApp({
			sharedStore: true, settings, hasTouch: phone,
			viewport: phone ? { width: 390, height: 844 } : undefined,
		});
		try {
			const { page } = app;
			page.setDefaultTimeout(4000);
			await page.goto(url);
			const heading = page.locator("#app-list-heading-button");
			if (phone) {
				await page.evaluate(() => {
					const request = window.__gmXHR;
					const ready = new Promise((resolve) => { window.finishFrontPage = resolve; });
					window.__gmXHR = (options) => options.url === "https://news.ycombinator.com/news"
						? ready.then(() => request(options)) : request(options);
				});
				await page.locator('#app-rail [data-app-view="all"]').click();
				await heading.click();
				await page.getByRole("menuitem", { name: "Sync", exact: true }).click();
			} else {
				await page.locator("#app-list-sync").click();
			}
			if (phone) {
				assert.equal(await page.getByRole("button", { name: "Select links", exact: true }).count(), 0);
				await heading.click();
			}
			const select = page.getByRole(phone ? "menuitem" : "button", { name: "Select links", exact: true });
			if (phone) {
				assert(await select.isDisabled());
				await page.evaluate(() => window.finishFrontPage());
			}
			await select.click();
			const checkbox = (story) => page.getByRole("checkbox", { name: `Select ${story.title}`, exact: true });
			const [selected, unselected] = STORIES.slice(7, 9);
			await checkbox(selected).check();
			assert.equal(await checkbox(unselected).isChecked(), false);
			await selectionBar(page).getByText("1 selected", { exact: true }).waitFor();
			if (phone) await heading.click();
			await page.getByRole(phone ? "menuitem" : "button", { name: "Mark all as read", exact: true }).click();
			assert(await waitFor(() => app.store.get("HNewhere:seen_comments")?.[`hn:${unselected.id}`] > 0));
			if (phone) {
				assert(await checkbox(selected).isChecked());
			} else {
				await page.getByText("All caught up.", { exact: true }).waitFor();
				await selectionBar(page).waitFor({ state: "hidden" });
				assert(await select.isDisabled());
			}
		} finally {
			await app.browser.close();
		}
	}
});

test("Collection selection works on a phone and applies actions only to selected pages", async () => {
	const when = Date.now() - 1000;
	const entries = [1, 2, 3].map((number) => ({
		key: `books.example.com/${number}`, url: `https://books.example.com/${number}`,
		title: `Saved link ${number}`, addedAt: when - number, foundAt: when, count: 2, unwatched: true,
	}));
	const app = await launchApp({
		sharedStore: true, viewport: { width: 390, height: 844 }, hasTouch: true, settings,
		values: { [collectedKey]: entries, "HNewhere:collected_migrated": true, "HNewhere:collection_filed": true },
	});
	try {
		const { page } = app;
		page.setDefaultTimeout(5000);
		await page.goto(url);
		await page.locator('#app-rail [data-app-view="collection"]').click();
		const rows = page.locator("#app-list-body .reader-collection-row");
		const row = (number) => rows.filter({ has: page.getByRole("link", { name: `Saved link ${number}`, exact: true }) });
		const filter = page.getByRole("button", { name: "Filter and sort Collection" });
		await filter.waitFor();
		assert.equal(await page.getByRole("button", { name: "Select links", exact: true }).count(), 0);
		await page.locator("#app-list-heading-button").tap();
		await page.getByRole("menuitem", { name: "Select links", exact: true }).tap();
		await row(1).getByRole("checkbox").check();
		await row(2).getByRole("checkbox").check();
		const bar = selectionBar(page);
		assert(await waitFor(() => bar.evaluate((node) => {
			const rail = node.getRootNode().getElementById("app-rail").getBoundingClientRect();
			const bounds = node.getBoundingClientRect();
			return bounds.bottom <= rail.top && rail.top - bounds.bottom <= 20 && bounds.x >= 0 && bounds.right <= innerWidth;
		}), 1500), "the phone bar fits just above the bottom navigation");
		await bar.getByRole("button", { name: "Actions" }).click();
		const menu = page.getByRole("menu", { name: "Selected link actions" });
		const barBounds = await bar.boundingBox();
		const menuBounds = await menu.boundingBox();
		assert(menuBounds.y + menuBounds.height <= barBounds.y, "bulk actions open above the dock");
		assert.deepEqual(await menu.getByRole("menuitem").allTextContents(), ["Mark selected as seen"]);
		await menu.getByRole("menuitem", { name: "Mark selected as seen", exact: true }).click();
		assert(await waitFor(() => app.store.get(collectedKey)?.[1].seenAt >= when));
		assert(app.store.get(collectedKey)[0].seenAt >= when);
		assert.equal(app.store.get(collectedKey)[2].seenAt, undefined);
		await beginSelection(page, row(1));
		await page.locator('#app-rail [data-app-view="all"]').click();
		await selectionBar(page).waitFor({ state: "hidden" });
		await page.locator('#app-rail [data-app-view="collection"]').click();
		assert.equal(await rows.getByRole("checkbox").count(), 0);
	} finally {
		await app.browser.close();
	}
});

test("All, source, and topic views offer the same selection mode and keyboard exit", async () => {
	const app = await launchApp({
		sharedStore: true,
		settings: { ...settings, frontPageMode: "topics", frontPageTopics: ["technology"] },
	});
	try {
		const { page } = app;
		page.setDefaultTimeout(5000);
		await page.goto(url);
		await page.locator("#app-list-sync").click();
		for (const view of ["all", "source:hn", "topic:technology"]) {
			await page.locator(`#app-rail [data-app-view="${view}"]`).click();
			const row = page.locator("#app-list-body .browse-row").filter({ has: page.getByRole("link", { name: STORIES[7].title, exact: true }) });
			await beginSelection(page, row);
			await selectionBar(page).getByText("1 selected", { exact: true }).waitFor();
			await row.getByRole("checkbox").press("Escape");
			await selectionBar(page).waitFor({ state: "hidden" });
			assert(await row.locator(".browse-more").evaluate((button) => button.getRootNode().activeElement === button));
		}
	} finally {
		await app.browser.close();
	}
});

test("a selected article can still be queued after it rolls off the refreshed feed", async () => {
	const [first, second] = STORIES.slice(7, 9);
	let refreshed = false;
	const app = await launchApp({
		sharedStore: true, settings,
		responses: [{
			match: (request) => refreshed && request === "https://news.ycombinator.com/news",
			headers: "content-type: text/html",
			text: frontPageHTML([second]),
		}],
	});
	try {
		const { page } = app;
		page.setDefaultTimeout(5000);
		await page.goto(url);
		const sync = page.locator("#app-list-sync");
		await sync.click();
		const rows = page.locator("#app-list-body .browse-row");
		const row = (story) => rows.filter({ has: page.getByRole("link", { name: story.title, exact: true }) });
		await beginSelection(page, row(first));
		await row(second).getByRole("checkbox").check();
		refreshed = true;
		await sync.click();
		await row(first).waitFor({ state: "detached" });
		await row(second).waitFor();
		await selectedAction(page, "Add selected to queue");
		assert(await waitFor(() => app.store.get("HNewhere:queue")?.length === 2));
		assert.deepEqual(app.store.get("HNewhere:queue").map((entry) => entry.url).sort(), [first.url, second.url].sort());
	} finally {
		await app.browser.close();
	}
});

test("sharing from Collection previews only the selected rows and preserves selection on close", async () => {
	const entries = [1, 2, 3].map((number) => ({
		key: `books.example.com/${number}`, url: `https://books.example.com/${number}`,
		title: `Saved link ${number}`, addedAt: 1700000000000 - number, unwatched: true,
	}));
	const app = await launchApp({
		sharedStore: true, settings,
		values: { [collectedKey]: entries, "HNewhere:collected_migrated": true, "HNewhere:collection_filed": true },
	});
	try {
		const { page } = app;
		page.setDefaultTimeout(5000);
		await page.goto(url);
		await page.locator('#app-rail [data-app-view="collection"]').click();
		const rows = page.locator("#app-list-body .reader-collection-row");
		const row = (number) => rows.filter({ has: page.getByRole("link", { name: `Saved link ${number}`, exact: true }) });
		await beginSelection(page, row(1));
		await row(3).getByRole("checkbox").check();
		const bar = selectionBar(page);
		const share = bar.getByRole("button", { name: "Share reading list" });
		await share.click();
		const dialog = page.getByRole("dialog", { name: "Share reading list" });
		await dialog.getByText("2 links", { exact: true }).waitFor();
		const preview = dialog.getByRole("region", { name: "Reading list preview" });
		await preview.getByText("Saved link 1", { exact: true }).waitFor();
		await preview.getByText("Saved link 3", { exact: true }).waitFor();
		assert.equal(await preview.getByText("Saved link 2", { exact: true }).count(), 0);
		await dialog.getByRole("button", { name: "Cancel" }).click();
		await bar.getByText("2 selected", { exact: true }).waitFor();
		assert(await share.evaluate((button) => button.getRootNode().activeElement === button));
	} finally {
		await app.browser.close();
	}
});
