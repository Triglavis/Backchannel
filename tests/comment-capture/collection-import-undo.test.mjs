import test from "node:test";
import assert from "node:assert/strict";
import { fillComposer, launchApp, STORIES, waitFor } from "./harness.mjs";

const reader = "https://backchnnl.app/";
const folders = "HNewhere:collected";
const noteIndex = "HNewhere:notes_index";
const libraryOwner = "HNewhere:account_data_owner";
const example = "https://books.example.com/";
const options = {
	sharedStore: true,
	settings: { updateCheck: false, sourceRefreshMinutes: 0 },
};

async function importBookmarks(page, entries, count = entries.length) {
	await page.getByRole("button", { name: "Open Backchannel settings" }).click();
	const settings = page.getByRole("dialog", { name: "Settings" });
	await settings.getByRole("button", { name: "Collection", exact: true }).click();
	const [picker] = await Promise.all([
		page.waitForEvent("filechooser"),
		settings.getByRole("button", { name: "Choose file…" }).click(),
	]);
	const links = entries.map(([url, title]) => `<DT><A HREF="${url}" ADD_DATE="1700000000">${title}</A>`).join("");
	await picker.setFiles({
		name: "bookmarks.html", mimeType: "text/html",
		buffer: Buffer.from(`<!DOCTYPE NETSCAPE-Bookmark-file-1><DL>${links}</DL>`),
	});
	await page.getByRole("button", { name: `Import ${count} ${count === 1 ? "link" : "links"}` }).click();
	const toast = page.locator("#toast.is-showing");
	await toast.getByText(/Saved on this device\. Sign in to sync across devices/).waitFor();
	return toast.getByRole("button", { name: "Undo", exact: true });
}

test("Undo removes newly imported links while keeping an existing link and a new Reader note", async () => {
	const existing = { key: "books.example.com/existing", url: example + "existing", title: "Existing link", addedAt: 1700000000000, unwatched: true };
	const story = STORIES[0];
	const app = await launchApp({
		...options,
		values: {
			[folders]: [existing],
			"HNewhere:collected_migrated": true,
			"HNewhere:collection_filed": true,
			"HNewhere:queue": [{
				id: story.id, key: "framed.example.com/gc", source: "hn", url: story.url,
				permalink: "https://news.ycombinator.com/item?id=" + story.id, title: story.title,
				addedAt: 1700000000000, readAt: null, descendants: story.comments,
			}],
		},
	});
	try {
		const { page } = app;
		const other = await app.context.newPage();
		page.setDefaultTimeout(5000);
		other.setDefaultTimeout(5000);
		await Promise.all([page.goto(reader), other.goto(reader)]);
		await other.locator('#app-rail [data-app-view="queue"]').click();
		await other.locator("#app-list-body .browse-title-link", { hasText: story.title }).first().click();
		await other.locator(`#app .comment[data-comment-id="hn:${story.id}01"]`).waitFor();
		const noteText = "A note made after importing";
		const composer = other.locator("#app-discussion-compose");
		await fillComposer(composer.locator(".composer-text"), noteText);

		const undo = await importBookmarks(page, [
			[existing.url, "Duplicate title"],
			[story.url, "My copy of the article"],
			[example + "untouched", "Untouched link"],
		], 2);
		const body = page.locator("#app-list-body");
		const untouched = body.getByRole("link", { name: "Untouched link", exact: true });
		await untouched.waitFor();
		await composer.locator(".compose-send-note").click();
		await other.locator("#app .notepad-section").getByText(noteText, { exact: true }).waitFor();
		await undo.click();
		await untouched.waitFor({ state: "detached" });
		await body.getByRole("link", { name: existing.title, exact: true }).waitFor();
		await body.getByRole("link", { name: story.title, exact: true }).waitFor();
		assert.deepEqual(app.store.get(folders).find((entry) => entry.key === existing.key), existing);
		assert(app.store.get(folders).some((entry) => entry.url === story.url));
		assert(app.store.get(noteIndex).some((entry) => entry.url === story.url));
		assert.deepEqual(app.errors, []);
	} finally {
		await app.browser.close();
	}
});

test("Undo keeps an opened page, a saved discussion, and a pending note but ignores background checks", async () => {
	const app = await launchApp(options);
	try {
		const { page } = app;
		page.setDefaultTimeout(5000);
		await page.goto(reader);
		const undo = await importBookmarks(page, [
			[example + "opened", "An opened link"],
			[example + "saved", "A link with a saved discussion"],
			[example + "noted", "A link with a pending note"],
			[example + "untouched", "Untouched link"],
		]);
		const untouched = page.locator("#app-list-body").getByRole("link", { name: "Untouched link", exact: true });
		await untouched.waitFor();

		app.store.set(folders, app.store.get(folders).map((entry) => {
			if (entry.key === "books.example.com/opened") return { ...entry, lastViewedAt: Date.now() };
			if (entry.key === "books.example.com/untouched") return { ...entry, checkedAt: Date.now(), marks: { hn: 2 }, misses: 0, foundAt: Date.now(), count: 1 };
			return entry;
		}));
		app.store.set("HNewhere:favorites", [
			{ key: "hn:123", url: example + "saved", title: "Saved discussion", kind: "discussion", page: "books.example.com/saved", addedAt: Date.now() },
		]);
		const pendingKey = "HNewhere:notes:url:books.example.com/noted";
		const pending = { version: 1, notes: [{ id: "pending", text: "A note before its index write", created: 1700000000 }] };
		app.store.set(pendingKey, pending);

		await undo.click();
		await untouched.waitFor({ state: "detached" });
		assert.deepEqual(app.store.get(folders).map((entry) => entry.key).sort(), [
			"books.example.com/noted", "books.example.com/opened", "books.example.com/saved",
		]);
		assert.equal(app.store.get("HNewhere:favorites")[0].title, "Saved discussion");
		assert.deepEqual(app.store.get(pendingKey), pending);
	} finally {
		await app.browser.close();
	}
});

test("Undo checks the library owner after a pending account operation", async () => {
	const app = await launchApp(options);
	try {
		const { page } = app;
		page.setDefaultTimeout(5000);
		await page.goto(reader);
		const undo = await importBookmarks(page, [[example + "owned", "Imported before the owner changed"]]);
		const row = page.locator("#app-list-body").getByRole("link", { name: "Imported before the owner changed", exact: true });
		await row.waitFor();
		await undo.waitFor();
		const locks = "HNewhere:storage_lock:account-sync:";
		const transition = locks + "account-transition";
		app.store.set(transition, { choosing: false, ticket: 1, expires: Date.now() + 10000 });
		await undo.click();
		assert(await waitFor(() => [...app.store.keys()].some((key) => key.startsWith(locks) && key !== transition)));
		app.store.set(libraryOwner, "a-different-library-owner");
		app.store.delete(transition);
		await page.locator("#toast.is-showing").getByText(/library or account changed/i).waitFor();
		assert.equal(app.store.get(folders)[0].url, example + "owned");
		assert(await row.isVisible());
	} finally {
		await app.browser.close();
	}
});

test("Undo for an earlier batch keeps the same bookmark imported again in a second tab", async () => {
	const app = await launchApp(options);
	try {
		const { page } = app;
		const other = await app.context.newPage();
		page.setDefaultTimeout(5000);
		other.setDefaultTimeout(5000);
		await Promise.all([page.goto(reader), other.goto(reader)]);
		const repeated = [example + "repeated", "An exact copy"];
		const undo = await importBookmarks(page, [repeated, [example + "untouched", "Untouched link"]]);
		const untouched = page.locator("#app-list-body").getByRole("link", { name: "Untouched link", exact: true });
		await untouched.waitFor();
		await undo.waitFor();

		app.store.set(folders, app.store.get(folders).filter((entry) => entry.url !== repeated[0]));
		const laterUndo = await importBookmarks(other, [repeated]);
		await laterUndo.waitFor();
		await undo.click();
		await untouched.waitFor({ state: "detached" });
		assert.deepEqual(app.store.get(folders).map((entry) => entry.url), [repeated[0]]);
	} finally {
		await app.browser.close();
	}
});
