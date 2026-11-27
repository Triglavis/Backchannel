import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { articleFor, fillComposer, launchApp, sidebarComposer, STORIES, waitFor } from "./harness.mjs";

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
		const editor = composer.getByRole("textbox");
		await fillComposer(editor, privateNote);
		await composer.getByRole("button", { name: "Formatting", exact: true }).click();
		for (const name of ["Underline", "Strikethrough"]) {
			await editor.press("ControlOrMeta+a");
			await composer.getByRole("button", { name, exact: true }).click();
		}
		await composer.getByRole("button", { name: "Keep a note" }).click();
		await app.page.locator("[data-notes-section]").getByText(privateNote).waitFor();
		for (const tag of ["u", "s"]) {
			assert.equal(await app.page.locator(`[data-notes-section] ${tag}`).innerText(), privateNote);
		}
		const frame = app.page.frames().find((entry) => entry.url() === article.url);
		assert(await waitFor(() => frame.evaluate(() => window.annotationMessages.some(({ comments }) => comments.length))));
		const delivered = await frame.evaluate(() => JSON.stringify(window.annotationMessages));
		assert.equal(delivered.includes(privateNote), false, "the Note's text stays in Reader");
		assert.equal(delivered.includes(privateTopic), false, "topic filters stay in Reader");
	} finally {
		await app.browser.close();
	}
});

test("The publisher cannot read private Sidebar settings, drafts or notes", async () => {
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
		assert(await waitFor(() => app.page.frame("backchannel-sidebar-settings")));
		await app.page.frame("backchannel-sidebar-settings").getByRole("button", { name: "Download JSON" }).waitFor();
		await app.page.getByRole("button", { name: "Sidebar", exact: true }).click();
		assert(await waitFor(() => app.page.frame("backchannel-sidebar-settings")));
		const sites = app.page.frame("backchannel-sidebar-settings");
		const close = app.page.getByRole("button", { name: "Close settings" });
		await sites.getByText("No sites disabled yet.").waitFor();
		await close.focus();
		await app.page.keyboard.press("Shift+Tab");
		assert(await waitFor(() => sites.evaluate(() => document.hasFocus())));
		const addFocused = () => sites.evaluate(() => document.activeElement.classList.contains("manage-table-add"));
		for (let tab = 0; tab < 2 && !await addFocused(); tab++) await app.page.keyboard.press("Tab");
		assert(await addFocused());
		await app.page.keyboard.press("Tab");
		assert(await waitFor(() => close.evaluate((button) => button.getRootNode().activeElement === button)));
		await app.page.evaluate(() => {
			window.settingsKeys = [];
			document.addEventListener("keydown", ({ key }) => window.settingsKeys.push(key), true);
		});
		await sites.getByRole("button", { name: "Disable Backchannel on a site or page" }).click();
		const address = sites.getByRole("textbox", { name: "A site, like example.com, or a page's address" });
		const site = "private.example.org";
		await address.pressSequentially(site);
		await address.press("Enter");
		const row = sites.getByRole("option").filter({ hasText: site });
		await row.click();
		assert.deepEqual(app.store.get("HNewhere:blocked_sites"), [site]);
		assert.equal(await app.page.getByText(site, { exact: true }).count(), 0);
		assert.deepEqual(await app.page.evaluate(() => window.settingsKeys), []);
		assert.equal(await sites.evaluate(() => self.origin), "null");
		assert.equal(await app.page.evaluate(() => {
			try {
				return Boolean(window.frames["backchannel-sidebar-settings"]?.document);
			} catch {
				return false;
			}
		}), false);
		await sites.getByRole("button", { name: "Turn Backchannel back on for the chosen site" }).click();
		await sites.getByText("No sites disabled yet.").waitFor();
		assert.deepEqual(app.store.get("HNewhere:blocked_sites"), []);
		assert.deepEqual(app.context.pages(), [app.page]);
	} finally {
		await app.browser.close();
	}
});

test("A publisher that blocks the Sidebar settings frame opens only the requested Backchannel settings", async () => {
	const source = await readFile(process.env.BC_SCRIPT || new URL("../../HNewhere.user.js", import.meta.url), "utf8");
	const hash = createHash("sha256").update(source).digest("base64");
	const app = await launchApp({
		source, topHosts: [new URL(article.url).hostname], sharedStore: true,
		settings: { autoOpenSidebar: true, updateCheck: false },
		pages: { [article.url]: {
			html: "<title>Article with strict CSP</title><article><p>The publisher applies a script policy.</p></article>",
			headers: { "content-security-policy": `script-src 'sha256-${hash}'` },
		} },
	});
	try {
		const { page } = app;
		page.setDefaultTimeout(6000);
		await page.goto(article.url);
		await page.getByRole("button", { name: "Open Backchannel settings" }).click();
		await page.getByRole("button", { name: "Filters", exact: true }).click();
		const [settings] = await Promise.all([
			app.context.waitForEvent("page"),
			page.getByRole("link", { name: "Open Filters settings", exact: true }).click(),
		]);
		await settings.getByRole("searchbox", { name: "Search topics" }).waitFor({ timeout: 5000 });
		assert.equal(settings.url(), "https://backchnnl.app/#settings/filters");
		assert.equal(await settings.locator("#app-rail").count(), 0);
		assert.equal(page.url(), article.url);
		assert(await page.getByRole("dialog", { name: "Settings" }).isVisible());
	} finally {
		await app.browser.close();
	}
});

test("A publisher that blocks the saved-list frame opens Collection directly in Backchannel", async () => {
	const source = await readFile(process.env.BC_SCRIPT || new URL("../../HNewhere.user.js", import.meta.url), "utf8");
	const hash = createHash("sha256").update(source).digest("base64");
	const title = "A private saved link on a publisher with strict CSP";
	const app = await launchApp({
		source, topHosts: [new URL(article.url).hostname], sharedStore: true,
		settings: { autoOpenSidebar: true, updateCheck: false },
		values: {
			"HNewhere:collected": [{ url: "https://saved.example.net/private", key: "saved.example.net/private", title, addedAt: Date.now() }],
			"HNewhere:collected_migrated": true,
			"HNewhere:collection_filed": true,
		},
		pages: { [article.url]: {
			html: "<title>Publisher with strict CSP</title><article><p>Publisher content</p></article>",
			headers: { "content-security-policy": `script-src 'sha256-${hash}'` },
		} },
	});
	try {
		const { page, context } = app;
		page.setDefaultTimeout(5000);
		await page.goto(article.url);
		await page.locator("#browse-toggle .wordmark-root").click();
		await page.getByRole("tab", { name: "Collection", exact: true }).click();
		const [library] = await Promise.all([
			context.waitForEvent("page", { timeout: 5500 }),
			page.getByRole("link", { name: "Open Collection", exact: true }).click(),
		]);
		await library.waitForURL("https://backchnnl.app/#library/collection");
		assert(await waitFor(() => library.frame("backchannel-saved-list"), 3500));
		await library.frame("backchannel-saved-list").getByRole("link", { name: title, exact: true }).waitFor({ timeout: 5000 });
		assert.equal(await library.locator("#app-rail").count(), 0);
		assert.equal(page.url(), article.url);
		assert(await page.locator("#panel.browsing").isVisible());
	} finally {
		await app.browser.close();
	}
});

test("The docked Sidebar saves a note without sending the draft to the publisher or opening Reader", async () => {
	const app = await launchApp({
		topHosts: [new URL(article.url).hostname], sharedStore: true, resubmissions: 2,
		settings: { autoOpenSidebar: true, updateCheck: false, sources: { hn: true } },
		values: { "HNewhere:width": 280 },
	});
	try {
		await app.page.addInitScript(() => {
			window.sidebarMessages = [];
			window.addEventListener("message", (event) => window.sidebarMessages.push(JSON.stringify(event.data)));
		});
		await app.page.goto(article.url);
		const bar = app.page.locator("#sidebar-discussion-compose");
		const editor = await sidebarComposer(app.page);
		const draft = "Private draft typed in the docked Sidebar";
		const send = editor.locator(".compose-send-row");
		const comment = editor.getByRole("button", { name: "Add a comment" });
		const input = editor.getByRole("textbox");
		await input.waitFor();
		const fieldStyle = (field) => field.evaluate((node) => {
			const style = getComputedStyle(node);
			const frame = getComputedStyle(node.closest(".compose-field"));
			return { font: style.fontSize, line: style.lineHeight, padding: style.padding,
				background: frame.backgroundColor, border: frame.borderColor, radius: frame.borderRadius };
		});
		const sidebarField = await fieldStyle(input);
		const controlsLayout = (field) => field.evaluate((node) => {
			const box = node.closest(".compose-box");
			const fieldBounds = node.getBoundingClientRect();
			const format = box.querySelector(".composer-format-toggle");
			const note = box.querySelector(".compose-send-note");
			const comment = box.querySelector(".compose-send-comment");
			const toolbar = box.querySelector(".composer-formatting")?.getBoundingClientRect();
			const controls = [format, note, comment].map((button) => button.getBoundingClientRect());
			const region = box.querySelector(".compose-field").getBoundingClientRect();
			return {
				labels: [note.innerText.trim(), comment.innerText.trim()],
				arrow: Boolean(comment.querySelector("svg")),
				aligned: controls.every(({ top, height }) => top >= fieldBounds.bottom - 1 &&
					Math.abs(top - controls[0].top) <= 1 && Math.abs(height - controls[0].height) <= 1),
				fits: controls.every(({ left, right, width }) => width > 0 && left >= region.left && right <= region.right && right <= innerWidth),
				toolbarAbove: Boolean(toolbar?.height && toolbar.bottom <= fieldBounds.top),
			};
		});
		const expectedControls = { labels: ["Note", "Comment"], arrow: false, aligned: true, fits: true, toolbarAbove: false };
		const verifyTextSpacing = async (field) => {
			const spacing = await field.evaluate((node) => {
				const region = node.closest(".compose-field");
				const toolbar = region.querySelector(".composer-formatting");
				const actions = region.querySelector(".composer-actions");
				const bounds = node.getBoundingClientRect();
				const { paddingTop, paddingBottom } = getComputedStyle(node);
				const preceding = toolbar.hidden
					? region.getBoundingClientRect().top + parseFloat(getComputedStyle(region).borderTopWidth)
					: toolbar.getBoundingClientRect().bottom - parseFloat(getComputedStyle(toolbar).paddingBottom);
				const following = actions.getBoundingClientRect().top + parseFloat(getComputedStyle(actions).paddingTop);
				return { above: bounds.top + parseFloat(paddingTop) - preceding, below: following - bounds.bottom + parseFloat(paddingBottom) };
			});
			assert(spacing.above >= 8 && Math.abs(spacing.above - spacing.below) <= 1, JSON.stringify(spacing));
		};
		const verifyFormatting = async (field, composer) => {
			const formatting = composer.getByRole("button", { name: "Formatting", exact: true });
			const toolbar = composer.getByRole("group", { name: "Text formatting" });
			await formatting.waitFor({ timeout: 5000 });
			assert(await toolbar.isHidden());
			assert.deepEqual(await controlsLayout(field), expectedControls);
			await formatting.click();
			await toolbar.waitFor();
			assert.deepEqual(await controlsLayout(field), { ...expectedControls, toolbarAbove: true });
			const buttons = toolbar.getByRole("button");
			assert.deepEqual(await buttons.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label"))),
				["Bold", "Italic", "Underline", "Strikethrough", "Quote", "Code block"]);
			assert(await buttons.evaluateAll((nodes) => nodes.every((node) => {
				const bounds = node.getBoundingClientRect();
				const row = node.parentElement.getBoundingClientRect();
				return node.querySelector("svg[aria-hidden='true']") &&
					bounds.top >= row.top && bounds.bottom <= row.bottom &&
					bounds.left >= row.left && bounds.right <= row.right && bounds.right <= innerWidth;
			})));
			await fillComposer(field, "Emphasis");
			await verifyTextSpacing(field);
			for (const [name, tags] of [["Bold", "b, strong"], ["Underline", "u"], ["Strikethrough", "s, strike, del"]]) {
				await field.press("Shift+ArrowLeft");
				const style = toolbar.getByRole("button", { name, exact: true });
				await style.click();
				assert.equal(await field.locator(tags).innerText({ timeout: 3000 }), "s");
				await style.click();
				assert.equal(await field.locator(tags).count(), 0);
				await field.press("ArrowRight");
			}
			await field.press("Shift+ArrowLeft");
			await toolbar.getByRole("button", { name: "Italic" }).click();
			assert.equal(await field.locator("em, i").innerText(), "s");
			await toolbar.getByRole("button", { name: "Quote" }).click();
			assert.equal(await field.locator("blockquote").innerText(), "Emphasis");
			const code = toolbar.getByRole("button", { name: "Code block" });
			await code.click();
			assert.equal(await field.locator("pre").innerText(), "Emphasis");
			await code.click();
			assert.equal(await field.locator("pre").count(), 0);
			await fillComposer(field, Array.from({ length: 9 }, (_, index) => "Line " + (index + 1)).join("\n"));
			const size = await field.evaluate((node) => {
				const style = getComputedStyle(node);
				const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
				return { lines: Math.round((node.clientHeight - padding) / parseFloat(style.lineHeight)), scrolls: node.scrollHeight > node.clientHeight };
			});
			assert.deepEqual(size, { lines: 6, scrolls: true });
			await formatting.click();
			assert(await toolbar.isHidden());
			await fillComposer(field, "Emphasis");
			await verifyTextSpacing(field);
			await fillComposer(field, "");
		};
		assert(await bar.evaluate((node) => {
			const panel = node.closest("#panel").getBoundingClientRect();
			const box = node.getBoundingClientRect();
			return Math.abs(panel.bottom - box.bottom) <= 1 && box.height <= 80;
		}));
		assert.equal(await editor.evaluate(() => self.origin), "null");
		assert.equal(await app.page.evaluate(() => {
			try { return Boolean(window.frames["backchannel-sidebar-composer"].document); } catch { return false; }
		}), false);
		await input.click();
		assert.deepEqual(app.context.pages(), [app.page]);
		await verifyFormatting(input, editor);
		assert(await send.isVisible(), "the action row is visible before typing");
		assert(await comment.isDisabled());
		await fillComposer(input, draft);
		await comment.press("Enter");
		const targets = editor.getByRole("group", { name: "Choose a discussion" });
		await targets.waitFor({ timeout: 6000 });
		assert.equal(await targets.getByRole("button").count(), 3);
		assert(await waitFor(() => targets.evaluate((node) => {
			const { left, right, top, bottom } = node.getBoundingClientRect();
			return left >= 0 && right <= innerWidth && top >= 0 && bottom <= innerHeight;
		})), "the chooser fits in the private frame");
		const firstTarget = targets.getByRole("button").first();
		assert(await firstTarget.evaluate((node) => node === document.activeElement));
		await firstTarget.press("Escape");
		await targets.waitFor({ state: "hidden" });
		assert(await comment.evaluate((node) => node === document.activeElement));
		assert.equal(await input.innerText(), draft);
		await fillComposer(input, "");
		assert(await comment.isDisabled());
		await fillComposer(input, draft);
		await editor.getByRole("button", { name: "Formatting", exact: true }).click();
		await input.press("ControlOrMeta+a");
		await editor.getByRole("button", { name: "Italic" }).click();
		assert.equal(await app.page.locator(".composer-text").count(), 0);
		await editor.getByRole("button", { name: "Keep a note" }).click();
		assert(await waitFor(() => app.store.get(`HNewhere:notes:url:${articleKey}`)?.notes?.some(({ text }) => text === draft)));
		const savedNote = app.store.get(`HNewhere:notes:url:${articleKey}`).notes.find(({ text }) => text === draft);
		assert.match(savedNote.rich, /<(?:i|em)>Private draft typed in the docked Sidebar<\/(?:i|em)>/);
		await editor.getByRole("status").getByText("Note saved.").waitFor({ timeout: 6000 });
		assert.equal(await input.innerText(), "");
		assert(!await app.page.evaluate((value) => window.sidebarMessages.some((message) => message?.includes(value)), draft));
		assert.equal(await app.page.getByText(draft).count(), 0);
		assert.deepEqual(app.context.pages(), [app.page]);

		await app.page.goto("https://backchnnl.app/");
		await app.page.locator("#app-list-body .browse-title-link").first().click({ timeout: 6000 });
		const readerComposer = app.page.locator("#app-discussion-compose");
		const readerField = readerComposer.locator(".composer-text");
		await readerField.waitFor({ timeout: 6000 });
		assert.deepEqual(sidebarField, await fieldStyle(readerField));
		await verifyFormatting(readerField, readerComposer);
	} finally {
		await app.browser.close();
	}
});

for (const responsive of [true, false]) test(`the phone Sidebar composer starts compact on a ${responsive ? "responsive" : "desktop-width"} page`, async (t) => {
	const fixture = articleFor(article.url);
	const html = responsive
		? fixture.html.replace("<head>", '<head><meta name="viewport" content="width=device-width, initial-scale=1">')
		: fixture.html;
	const app = await launchApp({
		topHosts: [new URL(article.url).hostname], sharedStore: true, hasTouch: true, isMobile: true,
		viewport: { width: 393, height: 852 }, pages: { [article.url]: { ...fixture, html } },
		settings: { autoOpenSidebar: true, sources: { hn: true }, notepad: true, updateCheck: false },
	});
	t.after(() => app.browser.close());
	app.page.setDefaultTimeout(5000);
	await app.page.goto(article.url);
	const editor = await sidebarComposer(app.page);
	const field = editor.locator('.composer-text[contenteditable="true"][data-placeholder*="comment"]');
	await field.waitFor();
	const actions = editor.locator(".composer-actions");
	const scale = () => app.page.evaluate(() => visualViewport.scale);
	const originalScale = await scale();
	const tap = async (control) => {
		if (originalScale === 1 || app.browser.browserType().name() !== "webkit") return control.tap();
		// The WebKit test driver takes viewport pixels for taps on zoomed pages.
		const { x, y, width, height } = await control.boundingBox();
		await app.page.touchscreen.tap((x + width / 2) * originalScale, (y + height / 2) * originalScale);
	};
	assert((await field.evaluate((node) => parseFloat(getComputedStyle(node).fontSize))) * originalScale >= 15.9,
		"the editable font meets Safari's 16px focus threshold at the current viewport scale");
	assert(await actions.isHidden());
	const bar = app.page.locator("#sidebar-discussion-compose");
	const compact = await bar.boundingBox();
	await tap(field);
	await actions.waitFor();
	assert.equal(await scale(), originalScale);
	assert.equal(await actions.locator(".compose-send-note").innerText(), "Note");
	assert.equal(await actions.locator(".compose-send-comment").innerText(), "Comment");
	assert(await waitFor(async () => (await bar.boundingBox()).height > compact.height + 20));
	const format = actions.getByRole("button", { name: "Formatting", exact: true });
	const toolbar = editor.getByRole("group", { name: "Text formatting" });
	await tap(format);
	await toolbar.waitFor();
	await format.click();
	await toolbar.waitFor({ state: "hidden" });
	await fillComposer(field, "Keep the draft when focus leaves.");
	await field.evaluate((node) => node.blur());
	assert(await actions.isVisible());
	await fillComposer(field, "");
	await field.evaluate((node) => node.blur());
	await actions.waitFor({ state: "hidden" });
	assert.deepEqual(app.errors, []);
});

for (const blocksFrames of [false, true]) test(blocksFrames ?
	"The Sidebar opens a dedicated private composer when the publisher blocks both editor frames" :
	"The Sidebar shows an inline private composer under a strict script policy", async (t) => {
	const source = await readFile(process.env.BC_SCRIPT || new URL("../../HNewhere.user.js", import.meta.url), "utf8");
	const hash = createHash("sha256").update(source).digest("base64");
	const editorURL = "https://topics.backchnnl.app/sidebar-composer";
	const sourceHost = "news.ycombinator.com";
	const discussionURL = `https://${sourceHost}/item?id=${article.id}`;
	const { default: topicsWorker } = await import("../../topics/worker.mjs");
	const response = await topicsWorker.fetch(new Request(editorURL), {}, {});
	const body = await response.text();
	const app = await launchApp({
		source, topHosts: [new URL(article.url).hostname, new URL(editorURL).hostname, sourceHost], sharedStore: true, contentPages: [editorURL],
		settings: { autoOpenSidebar: true, updateCheck: false, sources: { hn: true } },
		pages: { [article.url]: {
			html: "<title>Article with strict CSP</title><article><p>The publisher applies a script policy.</p></article>",
			headers: { "content-security-policy": `script-src 'sha256-${hash}'${blocksFrames ? "; frame-src 'none'" : ""}` },
		} },
	});
	t.after(() => app.browser.close());
	await app.context.route(editorURL, async (route) => {
		assert.equal(route.request().headers().referer, undefined);
		assert.equal(route.request().postData(), null);
		await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body });
	});
	const { page } = app;
	await page.addInitScript(() => {
		if (window.top !== window) return;
		window.composerKeys = [];
		document.addEventListener("keydown", (event) => window.composerKeys.push(event.key), true);
	});
	await page.goto(article.url);
	if (blocksFrames) {
		const posted = "A fixture comment from the separate Backchannel composer";
		const submissions = [];
		await app.context.route(discussionURL, (route) => route.fulfill({
			contentType: "text/html",
			body: '<form action="/comment" method="post"><textarea name="text"></textarea></form>',
		}));
		await app.context.route(`https://${sourceHost}/comment`, (route) => {
			submissions.push(new URLSearchParams(route.request().postData()).get("text"));
			return route.fulfill({ contentType: "text/html", body: '<div class="commtext">' + posted + "</div>" });
		});
		const bar = page.locator("#sidebar-discussion-compose");
		const open = bar.getByRole("button", { name: "Open composer in Backchannel" });
		await open.waitFor({ timeout: 8000 });
		assert.deepEqual(app.context.pages(), [page], "the separate composer requires a click");
		const [editor] = await Promise.all([app.context.waitForEvent("page"), open.click()]);
		await editor.waitForURL((url) => url.origin + url.pathname === editorURL);
		const input = editor.getByRole("textbox");
		await input.waitFor();
		assert.equal(await editor.evaluate(() => window.opener), null);
		await fillComposer(input, privateNote);
		const comment = editor.getByRole("button", { name: "Add a comment" });
		await comment.waitFor();
		await editor.getByRole("button", { name: "Keep a note" }).click();
		await editor.getByRole("status").getByText("Note saved.").waitFor();
		assert(await waitFor(() => app.store.get(`HNewhere:notes:url:${articleKey}`)?.notes?.some(({ text }) => text === privateNote)));
		await fillComposer(input, posted);
		await comment.click();
		await editor.getByRole("status").getByText("Comment posted.").waitFor();
		assert.deepEqual(submissions, [posted]);
		assert.equal(await page.getByText(privateNote).count(), 0);
		assert.deepEqual(await page.evaluate(() => window.composerKeys), []);
		assert.equal(page.url(), article.url);
		assert(await page.locator("#panel").isVisible());
		return;
	}
	const editor = () => page.frames().find((frame) => frame.url().startsWith(editorURL));
	assert(await waitFor(editor, 6000), "the composer loads in the Sidebar");
	const input = editor().getByRole("textbox");
	await input.waitFor({ timeout: 6000 });
	await input.click();
	await input.pressSequentially(privateNote);
	await editor().getByRole("button", { name: "Keep a note" }).click();
	await editor().getByRole("status").getByText("Note saved.").waitFor();
	assert(await waitFor(() => app.store.get(`HNewhere:notes:url:${articleKey}`)?.notes?.some(({ text }) => text === privateNote)));
	assert.equal(await input.innerText(), "");
	assert.equal(await page.getByText(privateNote).count(), 0);
	assert.deepEqual(await page.evaluate(() => window.composerKeys), []);
	assert.equal(await page.evaluate(() => {
		try { return Boolean(window.frames["backchannel-sidebar-composer"].document); } catch { return false; }
	}), false);
	assert.equal(page.url(), article.url);
	assert.deepEqual(app.context.pages(), [page]);
});

test("A Sidebar note can be kept when the discussion source goes offline", async (t) => {
	const outage = { match: () => false, status: 503 };
	const app = await launchApp({
		topHosts: [new URL(article.url).hostname], sharedStore: true,
		settings: { autoOpenSidebar: true, updateCheck: false, sources: { hn: true } },
		responses: [outage],
	});
	t.after(() => app.browser.close());
	await app.page.goto(article.url);
	await app.page.locator(".comment[data-comment-id]").first().waitFor();
	const editor = await sidebarComposer(app.page);
	await fillComposer(editor.getByRole("textbox"), privateNote);
	outage.match = (url) => ["hn.algolia.com", "hacker-news.firebaseio.com"].includes(new URL(url).hostname) ||
		url.startsWith("https://news.ycombinator.com/news");
	await editor.getByRole("button", { name: "Keep a note" }).click();
	await editor.getByRole("status").getByText("Note saved.").waitFor({ timeout: 6000 });
	assert(await waitFor(() => app.store.get(`HNewhere:notes:url:${articleKey}`)?.notes?.some(({ text }) => text === privateNote)));
	assert.deepEqual(app.context.pages(), [app.page]);
	assert.deepEqual(app.errors, []);
});

test("The Sidebar composer posts to the discussion and keeps a draft after a failed attempt", { timeout: 25000 }, async (t) => {
	const discussion = "https://news.ycombinator.com/item?id=" + article.id;
	const posted = "A fixture comment from the Sidebar";
	const app = await launchApp({
		topHosts: [new URL(article.url).hostname, "news.ycombinator.com"], sharedStore: true,
		settings: { autoOpenSidebar: true, updateCheck: false, sources: { hn: true } },
		launchOptions: process.env.ENGINE === "chromium" || !process.env.ENGINE ? { ignoreDefaultArgs: ["--disable-popup-blocking"] } : {},
	});
	t.after(() => app.browser.close());
	let hasForm = false;
	const submissions = [];
	await app.context.route(discussion, (route) => route.fulfill({
		contentType: "text/html",
		body: hasForm ? '<form action="/comment" method="post"><textarea name="text"></textarea></form>' : "<p>Discussion is unavailable.</p>",
	}));
	await app.context.route("https://news.ycombinator.com/comment", (route) => {
		submissions.push(new URLSearchParams(route.request().postData()).get("text"));
		return route.fulfill({ contentType: "text/html", body: '<div class="commtext">' + posted + "</div>" });
	});
	const visits = [];
	app.context.on("page", (popup) => popup.on("framenavigated", (frame) => {
		if (frame === popup.mainFrame()) visits.push(frame.url());
	}));
	await app.page.goto(article.url);
	await app.page.locator(".comment[data-comment-id]").first().waitFor();
	const editor = await sidebarComposer(app.page);
	const field = editor.getByRole("textbox");
	await fillComposer(field, posted);
	await editor.getByRole("button", { name: "Formatting", exact: true }).click();
	for (const name of ["Bold", "Underline", "Strikethrough", "Italic"]) {
		await field.press("ControlOrMeta+a");
		await editor.getByRole("button", { name, exact: true }).click();
	}
	const submit = editor.getByRole("button", { name: "Add a comment" });
	await submit.click();
	await editor.getByRole("status").getByText(/Could not find the comment box/).waitFor({ timeout: 6000 });
	assert.equal(await field.innerText(), posted);
	assert.deepEqual(submissions, []);
	hasForm = true;
	await submit.click();
	await editor.getByRole("status").getByText("Comment posted.").waitFor({ timeout: 6000 });
	assert.equal(await field.innerText(), "");
	assert.deepEqual(submissions, ["*" + posted + "*"]);
	assert(await waitFor(() => app.context.pages().length === 1), app.context.pages().map((page) => page.url()).join(", "));
	assert.equal(app.page.url(), article.url);
	assert(visits.some((url) => url.startsWith(discussion)));
	assert(visits.every((url) => url === "about:blank" || new URL(url).hostname === "news.ycombinator.com"));
	assert.deepEqual(app.errors, []);
});

test("Sidebar saves keep the identity of the rendered discussion", async () => {
	const app = await launchApp({
		appHost: new URL(article.url).hostname, sharedStore: true,
		settings: { autoOpenSidebar: true, updateCheck: false, sources: { hn: true } },
	});
	try {
		await app.page.goto(article.url);
		const save = app.page.locator("#sidebar-save-page");
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
		const frame = app.page.locator(".app-article-frame");
		const publisherLink = frame.contentFrame().locator("#onward-link");
		await publisherLink.focus();
		assert(await publisherLink.evaluate((link) => document.activeElement === link), "keyboard focus enters the publisher");
		assert(await frame.evaluate((node) => node.getRootNode().activeElement === node));
		await app.page.keyboard.press("s");
		assert.equal(app.store.get("HNewhere:favorites")?.length ?? 0, 0, "the publisher keystroke does not save the article");

		const save = app.page.locator('#app-article-actions [data-item-action="save"]');
		await save.focus();
		assert(await save.evaluate((button) => button.getRootNode().activeElement === button), "keyboard focus returns to Reader");
		await app.page.keyboard.press("s");
		assert(await waitFor(() => app.store.get("HNewhere:favorites")?.some((item) => item.url === article.url)),
			"Reader keyboard focus enables the Save shortcut for the open article");
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
	const original = await readFile(process.env.BC_SCRIPT || new URL("../../HNewhere.user.js", import.meta.url), "utf8");
	const beforeNotes = "await paintCollectionTag(ui, stories, seenTimes, { counted: false });";
	assert(original.includes(beforeNotes));
	const source = original.replace(beforeNotes, "if (appState) await window.__holdInitialDiscussion();\n\t\t" + beforeNotes);
	const discussion = Promise.withResolvers();
	let initialRenderWaiting = false;
	const app = await launchApp({
		source,
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
		await app.context.exposeFunction("__holdInitialDiscussion", () => {
			initialRenderWaiting = true;
			return discussion.promise;
		});
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
		assert(await waitFor(() => initialRenderWaiting, 6000), "initial Discussion rendering is still in progress");
		await composer.getByRole("button", { name: "Save note" }).click();
		const notepad = reader.locator("[data-notes-section]");
		await notepad.getByText(privateNote, { exact: true }).waitFor({ timeout: 6000 });
		discussion.resolve();
		await reader.locator('#comments-content .comment[data-comment-id^="hn:"]').first().waitFor();
		assert.equal(await notepad.count(), 1, "initial rendering reuses the Notepad populated by the save");
		assert.equal(await notepad.getByText(privateNote, { exact: true }).count(), 1);
		const notes = app.store.get(key).notes;
		assert.deepEqual(notes.map(({ text, page }) => [text, page]), [[previousNote, 6], [privateNote, 7]]);
		assert.equal(app.store.get(other).notes.length, 1);
		assert.equal(app.store.has("HNewhere:notes:pdf:edition-viewer-test"), false);
		assert.equal(app.store.has("HNewhere:notes:url:edition.example.org/research.pdf"), false);
	} finally {
		discussion.resolve();
		await app.browser.close();
	}
});
