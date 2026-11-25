import assert from "node:assert/strict";
import test from "node:test";
import { webkit } from "playwright";

const origin = "https://topics.test";
const token = "fixture-operator-token";
const article = "https://news.example.org/chess";
const historicalArticle = "https://blog.example.com/chess";
const unknown = "https://news.example.org/outside-the-index";
const reportPageId = "1".repeat(32);
const umbrella = { id: "topic:chess", label: "Chess", kind: "topic" };
const canonicalUmbrella = { ...umbrella, id: "topic:chess-current" };
const match = { id: "story:match", label: "Championship match", kind: "story" };
const reportTitle = "<em>Chess feed</em>";
const postedAt = "2026-11-21T12:00:00.000Z";
const image = {
  url: "https://upload.wikimedia.org/wikipedia/commons/0/00/Chess.jpg",
  source: "https://commons.wikimedia.org/wiki/File:Chess.jpg",
  credit: "Fixture photographer · CC BY 4.0",
  subject: "Chess board",
};

test("operators can resolve reports and curate published topics in WebKit", { timeout: 30_000 }, async (t) => {
  const { serveTopicReviewPage } = await import("../../topics/review-page.mjs");
  const browser = await webkit.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 850 } });
  page.setDefaultTimeout(4_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const requests = [];
  const decisions = [];
  let reports = [
    { url: article, title: reportTitle, topic: "Chess", topicId: umbrella.id, suggestedTopic: match.label, count: 2, lastReportedAt: Date.parse(postedAt) },
    { url: unknown, reportPageId, title: null, topic: "Chess", suggestedTopic: "", count: 1, lastReportedAt: Date.parse(postedAt) },
    { url: "https://news.example.org/third", title: "Third pending link", topic: "Chess", suggestedTopic: "", count: 1, lastReportedAt: Date.parse(postedAt) },
  ];
  let simulateSaveFailure = true;
  let simulateQueueRefreshFailure = false;

  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const authorization = await request.headerValue("authorization");
    requests.push({ url, method, authorization });
    if (url.origin !== origin) return route.abort();
    if (url.pathname === "/internal/review") {
      const response = serveTopicReviewPage();
      return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
    }
    if (url.pathname.startsWith("/internal/") && authorization !== "Bearer " + token) {
      return route.fulfill({ status: 401, json: { error: "unauthorized" } });
    }
    if (url.pathname === "/internal/topic-reports" && method === "GET") {
      if (simulateQueueRefreshFailure) {
        simulateQueueRefreshFailure = false;
        return route.abort();
      }
      const offset = Number(url.searchParams.get("offset"));
      return route.fulfill({ json: { reports: reports.slice(offset, offset + 1), nextOffset: offset + 1 < reports.length ? offset + 1 : null } });
    }
    if (url.pathname === "/internal/topic-reports" && method === "POST") {
      const decision = request.postDataJSON();
      decisions.push(decision);
      if (simulateSaveFailure) {
        simulateSaveFailure = false;
        return route.abort();
      }
      if (decision.reportUrl) reports = reports.filter(({ url }) => url !== decision.reportUrl);
      if (decision.reportPageId) reports = reports.filter((report) => report.reportPageId !== decision.reportPageId);
      if (decision.action === "dismiss") simulateQueueRefreshFailure = true;
      return route.fulfill({ status: 201, json: { id: decision.requestId, ...(decision.action === "split" ? { topicId: "story:new" } : {}) } });
    }
    if (url.pathname === "/api/topics") {
      return route.fulfill({ json: { version: 1, generatedAt: postedAt, topics: [umbrella, match], pages: [] } });
    }
    if (url.pathname === "/api/topics/coverage") {
      const id = url.searchParams.get("id");
      const offset = url.searchParams.get("offset");
      if (id === umbrella.id && offset === null) {
        return route.fulfill({ json: { version: 1, topic: canonicalUmbrella, generatedAt: postedAt, nextOffset: 1, links: [
          { url: article, title: "Tournament results", domain: "news.example.org", postedAt, posts: [] },
        ] } });
      }
      if (id === canonicalUmbrella.id && offset === "1") {
        return route.fulfill({ json: { version: 1, topic: canonicalUmbrella, generatedAt: postedAt, links: [
          { url: historicalArticle, title: "Chess history", domain: "blog.example.com", postedAt: null, posts: [] },
        ] } });
      }
    }
    if (url.pathname === "/internal/publish-topics" && method === "POST") {
      return route.fulfill({ json: { generatedAt: postedAt, sources: [], stats: {} } });
    }
    return route.fulfill({ status: 404 });
  });

  const response = await page.goto(origin + "/internal/review");
  assert.equal(response.headers()["cache-control"], "no-store");
  assert.match(response.headers()["content-security-policy"], /frame-ancestors 'none'/);
  assert.equal(await page.getByText(reportTitle, { exact: true }).count(), 0);
  assert.equal(requests.filter(({ url }) => url.pathname === "/internal/topic-reports").length, 0);

  const password = page.getByLabel("Operator token");
  await password.fill("incorrect-token");
  await password.press("Enter");
  await page.getByText("The operator token was rejected.").waitFor();
  assert.equal(await password.inputValue(), "");

  await password.fill(token);
  await password.press("Enter");
  const firstReport = page.getByRole("button", { name: /Chess feed/ });
  await firstReport.waitFor();
  assert.equal(await page.locator("em").count(), 0);
  assert.match(await firstReport.textContent(), /2 reports/);
  await page.getByRole("button", { name: "Load more reports" }).click();
  await page.getByRole("button", { name: /outside-the-index/ }).waitFor();
  assert.ok(requests.some(({ url }) => url.search === "?pending=1&offset=1"));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

  await page.reload();
  await password.waitFor();
  assert.equal(await password.inputValue(), "");
  assert.equal(await page.getByText(reportTitle, { exact: true }).count(), 0);
  await password.fill(token);
  await password.press("Enter");
  await page.getByRole("button", { name: "Load more reports" }).click();
  const secondReport = page.getByRole("button", { name: /outside-the-index/ });
  await secondReport.waitFor();

  const action = page.getByLabel("Action", { exact: true });
  const topic = page.getByLabel("Topic", { exact: true });
  const save = page.getByRole("button", { name: "Save decision" });

  function lastDecision(expected) {
    const { requestId, ...decision } = decisions.at(-1);
    assert.match(requestId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i);
    assert.deepEqual(decision, expected);
  }

  await firstReport.click();
  assert.equal(await page.getByRole("link", { name: article }).getAttribute("href"), article);
  assert.ok((await action.boundingBox()).height >= 42, "the action selector has a usable touch target");
  await page.waitForFunction((id) => document.getElementById("topic").value === id, match.id);
  await save.click();
  await page.getByText("The request failed. Try again.").waitFor();
  const requestsBeforeMove = requests.length;
  await save.click();
  await firstReport.waitFor({ state: "hidden" });
  lastDecision({ action: "move", url: article, topicId: match.id, reportUrl: article });
  assert.equal(decisions[0].requestId, decisions[1].requestId);

  await secondReport.click();
  const reportOffsetsAfterMove = requests.slice(requestsBeforeMove)
    .filter(({ url, method }) => url.pathname === "/internal/topic-reports" && method === "GET")
    .map(({ url }) => url.search);
  assert.deepEqual(reportOffsetsAfterMove, ["?pending=1&offset=0"]);

  await action.selectOption("dismiss");
  await save.click();
  await page.getByText("Report dismissed.").waitFor();
  lastDecision({ action: "dismiss", reportPageId });
  await page.locator("#reports-status").getByText("The request failed. Try again.").waitFor();
  const requestsBeforeQueueRetry = requests.length;
  await page.getByRole("button", { name: "Reload reports" }).click();
  await page.getByRole("button", { name: /Third pending link/ }).waitFor();
  assert.equal(requests[requestsBeforeQueueRetry].url.search, "?pending=1&offset=0");

  await action.selectOption("merge");
  await topic.selectOption(umbrella.id);
  await page.getByLabel("Destination topic").selectOption(match.id);
  await save.click();
  await page.getByText("Decision saved. It will appear after the next refresh.").waitFor();
  lastDecision({ action: "merge", topicId: umbrella.id, targetTopicId: match.id });

  await action.selectOption("split");
  await topic.selectOption(umbrella.id);
  await page.getByLabel("New topic name").fill("Chess results");
  const firstLink = page.getByRole("checkbox", { name: "Tournament results" });
  await firstLink.check();
  const beforeSplit = decisions.length;
  const otherLink = page.getByRole("checkbox", { name: "Chess history" });
  await otherLink.check();
  await save.click();
  await page.locator("#decision-status").getByText("Choose 1 to 240 links and leave at least one in the original topic.").waitFor();
  assert.equal(decisions.length, beforeSplit);
  await firstLink.uncheck();
  await save.click();
  await page.getByText("Decision saved. It will appear after the next refresh.").waitFor();
  lastDecision({ action: "split", topicId: umbrella.id, urls: [historicalArticle], label: "Chess results" });

  await action.selectOption("edit");
  await topic.selectOption(umbrella.id);
  await page.getByLabel("Topic name", { exact: true }).fill("Professional chess");
  await save.click();
  await page.getByText("Decision saved. It will appear after the next refresh.").waitFor();
  lastDecision({ action: "edit", topicId: umbrella.id, label: "Professional chess" });

  await action.selectOption("edit");
  await topic.selectOption(umbrella.id);
  await page.getByLabel("Edit", { exact: true }).selectOption("image");
  await page.getByLabel("Image URL").fill(image.url);
  await page.getByLabel("Commons file page").fill(image.source);
  await page.getByLabel("Credit and license").fill(image.credit);
  await page.getByLabel("Image subject").fill(image.subject);
  await save.click();
  await page.getByText("Decision saved. It will appear after the next refresh.").waitFor();
  lastDecision({ action: "edit", topicId: umbrella.id, image });

  await action.selectOption("edit");
  await topic.selectOption(umbrella.id);
  await page.getByLabel("Edit", { exact: true }).selectOption("automatic");
  await save.click();
  await page.getByText("Decision saved. It will appear after the next refresh.").waitFor();
  lastDecision({ action: "edit", topicId: umbrella.id, image: null });

  await action.selectOption("remove");
  await page.getByLabel("Link URL").fill(article);
  await save.click();
  await page.getByText("Decision saved. It will appear after the next refresh.").waitFor();
  lastDecision({ action: "remove", url: article });

  assert.equal(requests.some(({ url }) => url.pathname === "/internal/publish-topics"), false);
  await page.getByRole("button", { name: "Publish now" }).click();
  await page.getByText("Topics published.").waitFor();
  assert.ok(requests.some(({ url, method, authorization }) => url.pathname === "/internal/publish-topics" && method === "POST" && authorization === "Bearer " + token));
  assert.ok(requests.filter(({ url }) => url.pathname.startsWith("/api/")).every(({ authorization }) => !authorization));
  assert.deepEqual(await page.evaluate(() => [localStorage.length, sessionStorage.length, document.cookie]), [0, 0, ""]);

  await page.getByRole("button", { name: "Sign out" }).click();
  await password.waitFor();
  assert.equal(await password.inputValue(), "");
  assert.equal(await page.getByText("Third pending link", { exact: true }).count(), 0);
  assert.deepEqual(errors, []);
});
