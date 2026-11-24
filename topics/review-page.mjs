const styles = `
  :root {
    color-scheme: light dark;
    --background: #f1f3eb;
    --paper: #fffefa;
    --ink: #192e23;
    --muted: #4d6357;
    --border: #c8d4cb;
    --accent: #1c6242;
    --accent-ink: #fff;
    --tint: #e7f2e9;
    --danger: #a22d35;
    font: 16px/1.5 system-ui, sans-serif;
  }

  @media (prefers-color-scheme: dark) {
    :root {
      --background: #14211a;
      --paper: #1d2c23;
      --ink: #edf5ec;
      --muted: #b3c6b8;
      --border: #496254;
      --accent: #a3d9b4;
      --accent-ink: #163721;
      --tint: #2a4334;
      --danger: #ffb3b3;
    }
  }

  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  body { margin: 0; background: var(--background); color: var(--ink); }
  button, input, select { font: inherit; color: inherit; }
  button {
    min-height: 42px;
    padding: 7px 13px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--paper);
    cursor: pointer;
    font-weight: 600;
  }
  button:hover:enabled { background: var(--tint); }
  button:disabled { opacity: .65; cursor: default; }
  a { color: var(--accent); text-underline-offset: 3px; }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
  h1, h2, h3, p, dl, dd, figure { margin: 0; }
  h1 { font-size: clamp(2rem, 5vw, 3.25rem); line-height: 1.1; letter-spacing: -.035em; }
  h2 { font-size: 1.25rem; line-height: 1.25; letter-spacing: -.025em; }
  h3 { font-size: 1.1rem; line-height: 1.35; overflow-wrap: anywhere; }
  fieldset { border: 0; min-inline-size: 0; margin: 0; padding: 0; }
  legend { padding: 0; font-weight: 650; }
  label { display: block; font-weight: 650; }
  input:not([type=checkbox]), select {
    display: block;
    width: 100%;
    min-width: 0;
    min-height: 42px;
    margin-top: 4px;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background-color: var(--paper);
    font-weight: 400;
  }
  select {
    appearance: none;
    padding-inline-end: 32px;
    background-image: linear-gradient(45deg, transparent 50%, var(--muted) 50%),
      linear-gradient(135deg, var(--muted) 50%, transparent 50%);
    background-position: calc(100% - 18px) center, calc(100% - 12px) center;
    background-size: 6px 6px;
    background-repeat: no-repeat;
  }
  input[type=checkbox] { accent-color: var(--accent); }
  .shell { width: min(100% - 40px, 1120px); margin-inline: auto; }
  .site-header { border-bottom: 1px solid var(--border); background: var(--paper); }
  .brand-row, .page-heading, .actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
  }
  .brand-row { min-height: 62px; }
  .brand { color: var(--accent); font-weight: 800; letter-spacing: -.04em; font-size: 1.25rem; }
  main { padding-block: clamp(28px, 6vw, 58px); }
  .page-heading { margin-bottom: 24px; }
  .panel {
    min-width: 0;
    background: var(--paper);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: clamp(16px, 3vw, 24px);
  }
  #login { max-width: 420px; }
  .stack > * + * { margin-top: 15px; }
  .columns { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr); gap: 18px; align-items: start; }
  .primary { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
  .primary:hover:enabled { background: var(--accent); filter: brightness(.91); }
  .quiet {
    min-height: 28px;
    padding: 2px 5px;
    border: 0;
    color: var(--accent);
    font-size: .875rem;
  }
  .scroll-list { margin: 0; padding: 4px; list-style: none; max-height: min(50vh, 28rem); overflow: auto; }
  .scroll-list > li + li { margin-top: 6px; }
  .report-card {
    display: block;
    width: 100%;
    padding: 10px 12px;
    text-align: start;
    overflow-wrap: anywhere;
  }
  .report-card[aria-pressed=true] { background: var(--tint); border-color: var(--accent); }
  .metadata, .status { color: var(--muted); font-size: .875rem; }
  .metadata { display: block; font-weight: 400; overflow-wrap: anywhere; }
  .status[data-error] { color: var(--danger); }
  .stack > .status:empty { margin-top: 0; }
  .report-detail {
    display: grid;
    gap: 12px;
    padding: 14px;
    border-radius: 9px;
    background: var(--tint);
  }
  .report-detail a { overflow-wrap: anywhere; }
  .report-detail dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 4px 12px; }
  .report-detail dd { overflow-wrap: anywhere; }
  .coverage { border: 1px solid var(--border); border-radius: 8px; padding: 6px; }
  .coverage li { padding: 4px 6px; }
  .coverage li + li { border-top: 1px solid var(--border); }
  .coverage label { display: flex; align-items: start; gap: 8px; overflow-wrap: anywhere; }
  .coverage input { margin: .35em 0 0; }
  .coverage .metadata { margin-inline-start: 21px; }
  .cover-preview { display: flex; align-items: center; gap: 12px; }
  .cover-preview img { border-radius: 6px; width: 96px; height: 64px; object-fit: cover; background: var(--background); }

  @media (max-width: 760px) {
    .columns { grid-template-columns: minmax(0, 1fr); }
    .scroll-list { max-height: 17rem; }
  }
  @media (max-width: 420px) {
    .shell { width: calc(100% - 24px); }
  }
  @media (max-width: 360px) {
    .report-detail dl { grid-template-columns: minmax(0, 1fr); }
  }
`;

const script = `
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const reportsPath = "/internal/topic-reports";
  const login = $("login");
  const tokenInput = $("operator-token");
  const loginButton = $("sign-in");
  const workspace = $("workspace");
  const signOutButton = $("sign-out");
  const publishButton = $("publish");
  const reportList = $("report-list");
  const loadReports = $("load-reports");
  const decisionForm = $("decision-form");
  const decisionFields = $("decision-fields");
  const action = $("action");
  const linkURL = $("link-url");
  const topicFilter = $("topic-filter");
  const topicChoice = $("topic");
  const targetChoice = $("target-topic");
  const edit = $("edit");
  const coverageList = $("coverage-list");
  const coverFields = {
    url: $("image-url"), source: $("image-source"), credit: $("image-credit"), subject: $("image-subject"),
  };
  const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
  const splitHint = "Choose 1 to 240 links and leave at least one in the original topic.";

  let session;
  let reports = [];
  let nextReportOffset = null;
  let selectedReport = null;
  let topics = new Map();
  let topicLabelCounts = new Map();
  let topicRequest;
  let coverageRequest;

  function status(id, message = "", error = false) {
    const node = $(id);
    node.textContent = message;
    node.toggleAttribute("data-error", error);
  }

  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function httpURL(value) {
    try {
      const url = new URL(value);
      if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password) return url;
    } catch {}
    return null;
  }

  function articleLink(value, text) {
    const url = httpURL(value);
    if (!url) return element("span", text);
    const link = element("a", text);
    link.href = url.href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    return link;
  }

  function errorText(error) {
    if (error.status === 401 || error.status === 403) return "The operator token was rejected.";
    if (error.status === 409 && error.code === "refresh-in-progress") return "A topics refresh is already running.";
    if (error.status === 503 && error.code === "sources-unavailable") return "Public sources are unavailable. Try publishing again later.";
    if (typeof error.code === "string" && error.code.includes(" ")) return error.code;
    if (error.status === 400) return "The server could not validate this decision. Check the fields and try again.";
    if (error.status === 404) return "This link, report, or topic is no longer available.";
    if (error.status === 409) return "The topics have changed. Reload the published topics and check your decision.";
    return "The request failed. Try again.";
  }

  async function request(active, path, { operator = false, method = "GET", payload } = {}) {
    const headers = { Accept: "application/json" };
    if (operator) headers.Authorization = "Bearer " + active.token;
    if (payload) headers["Content-Type"] = "application/json";
    const response = await fetch(path, {
      method, headers, body: payload && JSON.stringify(payload), cache: "no-store",
      credentials: "omit", mode: "same-origin", redirect: "error", signal: active.controller.signal,
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data) {
      throw Object.assign(new Error("Topics request failed"), {
        status: response.status, code: data?.error ?? data?.status,
      });
    }
    return data;
  }

  function readReports(active, offset) {
    return request(active, reportsPath + "?pending=1&offset=" + offset, { operator: true });
  }

  function setBusy(busy) {
    decisionFields.disabled = busy;
    publishButton.disabled = busy;
    loadReports.disabled = busy;
    $("clear-report").disabled = busy;
    for (const button of reportList.querySelectorAll("button")) button.disabled = busy;
  }

  function signOut(message = "", focus = true) {
    session?.controller.abort();
    session = null;
    reports = [];
    nextReportOffset = null;
    topics.clear();
    topicLabelCounts.clear();
    renderReports();
    selectReport(null);
    publishButton.hidden = true;
    signOutButton.hidden = true;
    workspace.hidden = true;
    login.hidden = false;
    tokenInput.value = "";
    const secure = location.protocol === "https:";
    tokenInput.disabled = loginButton.disabled = !secure;
    status("workspace-status");
    status("reports-status");
    status("topic-status");
    status("login-status", message, Boolean(message));
    $("reload-topics").hidden = true;
    if (focus && secure) tokenInput.focus();
  }

  function handleFailure(active, id, error) {
    if (session !== active) return;
    const message = errorText(error);
    if (error.status === 401 || error.status === 403) {
      signOut(message);
    } else {
      status(id, message, true);
    }
  }

  function updateReportButtons() {
    for (const [index, button] of [...reportList.querySelectorAll("button")].entries()) {
      button.setAttribute("aria-pressed", String(reports[index] === selectedReport));
    }
  }

  function renderReports() {
    reportList.replaceChildren();
    for (const report of reports) {
      const button = element("button", report.title || report.url, "report-card");
      button.type = "button";
      button.disabled = loadReports.disabled;
      const host = report.title ? httpURL(report.url)?.host : "";
      const number = report.count === 1 ? "1 report" : report.count + " reports";
      button.append(element("span", [host, number].filter(Boolean).join(" · "), "metadata"));
      button.addEventListener("click", () => selectReport(report, true));
      const item = element("li");
      item.append(button);
      reportList.append(item);
    }
    loadReports.hidden = nextReportOffset == null;
    loadReports.textContent = nextReportOffset === 0 ? "Reload reports" : "Load more reports";
    updateReportButtons();
  }

  function showReportPage(data, offset) {
    reports = offset === 0 ? data.reports : [...reports, ...data.reports];
    nextReportOffset = Number.isSafeInteger(data.nextOffset) && data.nextOffset > offset ? data.nextOffset : null;
    renderReports();
    status("reports-status", reports.length ? "" : "No pending reports.");
  }

  function reportTopicId() {
    if (!selectedReport) return "";
    if (action.value !== "move" && topics.has(selectedReport.topicId)) return selectedReport.topicId;
    const reportedName = action.value === "move" ? selectedReport.suggestedTopic : selectedReport.topic;
    if (!reportedName) return "";
    const normalized = reportedName.trim().toLowerCase();
    const matches = [...topics.values()].filter(({ label }) => label.toLowerCase() === normalized);
    return matches.length === 1 ? matches[0].id : "";
  }

  function renderTopicChoices() {
    const query = topicFilter.value.trim().toLowerCase();
    function populate(select, defaultId, exclude) {
      const selected = select.value || defaultId || "";
      const options = [new Option("Choose a topic", "")];
      for (const topic of topics.values()) {
        if (topic.id === exclude) continue;
        if (topic.id !== selected && query && ![topic.label, topic.id, ...(topic.aliases || [])].some((value) => value.toLowerCase().includes(query))) continue;
        const label = topicLabelCounts.get(topic.label) > 1 ? topic.label + " · " + topic.id : topic.label;
        options.push(new Option(label, topic.id));
      }
      select.replaceChildren(...options);
      select.value = topics.has(selected) && selected !== exclude ? selected : "";
    }
    populate(topicChoice, reportTopicId());
    populate(targetChoice, "", topicChoice.value);
  }

  function showFields(attribute, value) {
    for (const group of decisionForm.querySelectorAll("[" + attribute + "]")) {
      group.disabled = group.hidden = !group.getAttribute(attribute).split(" ").includes(value);
    }
  }

  function showTopic() {
    const topic = topics.get(topicChoice.value);
    $("topic-name").value = topic?.label || "";
    const image = topic?.image;
    for (const [key, input] of Object.entries(coverFields)) input.value = image?.[key] || "";
    const preview = $("cover-preview");
    preview.replaceChildren();
    preview.hidden = true;
    const url = httpURL(image?.url);
    if (action.value !== "edit" || !url || url.protocol !== "https:" ||
        !["upload.wikimedia.org", "thumb.wikimedia.org"].includes(url.host)) return;
    const img = element("img");
    img.alt = image.subject || "";
    img.loading = "lazy";
    img.src = url.href;
    const credit = element("figcaption", null, "metadata");
    credit.append(articleLink(image.source, image.credit || "Current cover image"));
    preview.append(img, credit);
    preview.hidden = false;
  }

  async function showCoverage() {
    const active = session;
    const pending = coverageRequest = Symbol();
    coverageList.replaceChildren();
    coverageList.hidden = true;
    status("coverage-status");
    if (!active || action.value !== "split") return;
    const id = topicChoice.value;
    if (!id) {
      status("coverage-status", "Choose a topic to see its published links.");
      return;
    }
    status("coverage-status", "Loading published links…");
    try {
      const links = new Map();
      let topicId = id;
      let generatedAt;
      let offset = 0;
      while (true) {
        const params = new URLSearchParams({ id: topicId });
        if (offset) params.set("offset", String(offset));
        const page = await request(active, "/api/topics/coverage?" + params);
        if (session !== active || coverageRequest !== pending) return;
        if (offset === 0) {
          topicId = page.topic.id;
          generatedAt = page.generatedAt;
        } else if (page.topic.id !== topicId ||
            (generatedAt != null && page.generatedAt != null && page.generatedAt !== generatedAt)) {
          status("coverage-status", "Coverage changed while loading. Reload topics to try again.", true);
          return;
        }
        for (const { url, title, domain } of page.links) links.set(url, { url, title, domain });
        if (page.nextOffset == null) break;
        if (!Number.isSafeInteger(page.nextOffset) || page.nextOffset <= offset) {
          status("coverage-status", "Coverage could not be loaded. Reload topics to try again.", true);
          return;
        }
        offset = page.nextOffset;
      }
      if (links.size < 2) {
        status("coverage-status", "This topic needs at least two published links to split.");
        return;
      }
      for (const link of links.values()) {
        const item = element("li");
        const label = element("label");
        const checkbox = element("input");
        checkbox.type = "checkbox";
        checkbox.value = link.url;
        label.append(checkbox, element("span", link.title || link.url));
        const source = element("span", null, "metadata");
        source.append(articleLink(link.url, link.domain || httpURL(link.url)?.host || "Open link"));
        item.append(label, source);
        coverageList.append(item);
      }
      coverageList.hidden = false;
      status("coverage-status", splitHint);
    } catch (error) {
      if (session === active && coverageRequest === pending) handleFailure(active, "coverage-status", error);
    }
  }

  function showAction() {
    showFields("data-actions", action.value);
    if (selectedReport) $("link-fields").disabled = $("link-fields").hidden = true;
    showFields("data-edits", edit.value);
    renderTopicChoices();
    showTopic();
    showCoverage();
  }

  function selectReport(report, focus = false) {
    selectedReport = report;
    updateReportButtons();
    const detail = $("report-detail");
    detail.replaceChildren();
    detail.hidden = !report;
    $("clear-report").hidden = !report;
    const heading = $("decision-heading");
    heading.textContent = report ? "Review report" : "Curate topics";
    if (report) {
      const summary = element("dl");
      const date = new Date(report.lastReportedAt);
      const fields = [
        ["Reported topic", report.topic || "None"],
        ["Suggested topic", report.suggestedTopic || "None"],
        ...(report.lastReportedAt != null && Number.isFinite(date.valueOf()) ? [["Last reported", dateFormat.format(date)]] : []),
      ];
      for (const [label, value] of fields) summary.append(element("dt", label, "metadata"), element("dd", value));
      const url = report.title ? articleLink(report.url, report.url) : articleLink(report.url, "Open reported link");
      detail.append(element("h3", report.title || report.url), url, summary);
    }
    decisionForm.reset();
    action.querySelector('[value="dismiss"]').hidden = !report;
    action.querySelector('[value="dismiss"]').disabled = !report;
    action.value = report ? "move" : "edit";
    status("decision-status");
    showAction();
    if (focus) heading.focus();
  }

  async function loadTopics(active) {
    const pending = topicRequest = Symbol();
    status("topic-status", "Loading published topics…");
    $("reload-topics").disabled = true;
    try {
      const data = await request(active, "/api/topics");
      if (session !== active || topicRequest !== pending) return;
      topics = new Map(data.topics.sort((a, b) => a.label.localeCompare(b.label)).map((topic) => [topic.id, topic]));
      topicLabelCounts = new Map();
      for (const { label } of topics.values()) topicLabelCounts.set(label, (topicLabelCounts.get(label) || 0) + 1);
      renderTopicChoices();
      showTopic();
      showCoverage();
      status("topic-status", topics.size ? "" : "No topics are published yet.");
    } catch (error) {
      if (session === active && topicRequest === pending) handleFailure(active, "topic-status", error);
    } finally {
      if (session === active && topicRequest === pending) $("reload-topics").disabled = false;
    }
  }

  login.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (session || location.protocol !== "https:") return;
    const token = tokenInput.value.trim();
    tokenInput.value = "";
    if (!token) {
      status("login-status", "Enter the operator token.", true);
      tokenInput.focus();
      return;
    }
    const active = { token, controller: new AbortController(), retry: null };
    session = active;
    tokenInput.disabled = loginButton.disabled = true;
    status("login-status", "Signing in…");
    try {
      const pending = await readReports(active, 0);
      if (session !== active) return;
      showReportPage(pending, 0);
      login.hidden = true;
      publishButton.hidden = signOutButton.hidden = workspace.hidden = false;
      $("reload-topics").hidden = false;
      setBusy(false);
      $("reports-heading").focus();
      loadTopics(active);
    } catch (error) {
      if (session === active) signOut(errorText(error));
    }
  });

  signOutButton.addEventListener("click", () => signOut());
  window.addEventListener("pagehide", () => signOut("", false));
  loadReports.addEventListener("click", async () => {
    const active = session;
    const offset = nextReportOffset;
    if (!active || offset == null) return;
    const firstNewRow = offset === 0 ? 0 : reports.length;
    setBusy(true);
    status("reports-status", "Loading reports…");
    let loaded = false;
    try {
      const page = await readReports(active, offset);
      if (session !== active) return;
      showReportPage(page, offset);
      loaded = true;
    } catch (error) {
      handleFailure(active, "reports-status", error);
    } finally {
      if (session === active) {
        setBusy(false);
        if (loaded) (reportList.children[firstNewRow]?.firstElementChild || $("reports-heading")).focus();
      }
    }
  });

  $("clear-report").addEventListener("click", () => selectReport(null, true));
  $("reload-topics").addEventListener("click", () => { if (session) loadTopics(session); });
  action.addEventListener("change", () => {
    status("decision-status");
    topicFilter.value = "";
    targetChoice.value = "";
    if (selectedReport) topicChoice.value = reportTopicId();
    showAction();
  });
  topicFilter.addEventListener("input", renderTopicChoices);
  topicChoice.addEventListener("change", () => {
    renderTopicChoices();
    showTopic();
    showCoverage();
  });
  edit.addEventListener("change", () => showFields("data-edits", edit.value));

  function readDecision() {
    const decision = { action: action.value };
    if (selectedReport) decision.reportUrl = selectedReport.url;
    if (["move", "remove"].includes(decision.action)) {
      decision.url = selectedReport?.url || linkURL.value.trim();
      if (!httpURL(decision.url)) throw new Error("Enter an HTTP or HTTPS link URL.");
    }
    if (["move", "merge", "split", "edit"].includes(decision.action)) decision.topicId = topicChoice.value;
    if (decision.action === "merge") decision.targetTopicId = targetChoice.value;
    if (decision.action === "split") {
      decision.urls = [...coverageList.querySelectorAll("input:checked")].map((input) => input.value);
      if (decision.urls.length < 1 || decision.urls.length > 240 || decision.urls.length === coverageList.children.length) {
        throw new Error(splitHint);
      }
      decision.label = $("split-name").value.trim();
    }
    if (decision.action === "edit") {
      if (edit.value === "label") decision.label = $("topic-name").value.trim();
      if (edit.value === "image") decision.image = Object.fromEntries(Object.entries(coverFields).map(([key, input]) => [key, input.value.trim()]));
      if (edit.value === "automatic") decision.image = null;
    }
    if ("label" in decision && !decision.label) throw new Error("Enter a topic name.");
    return decision;
  }

  decisionForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const active = session;
    if (!active || decisionFields.disabled) return;
    let decision;
    try {
      decision = readDecision();
    } catch (error) {
      status("decision-status", error.message, true);
      return;
    }
    const serialized = JSON.stringify(decision);
    if (active.retry?.serialized !== serialized) active.retry = { serialized, id: crypto.randomUUID() };
    decision.requestId = active.retry.id;
    setBusy(true);
    status("decision-status", "Saving decision…");
    let saved = false;
    try {
      await request(active, reportsPath, { operator: true, method: "POST", payload: decision });
      if (session !== active) return;
      saved = true;
      active.retry = null;
      selectReport(null);
      status("decision-status", decision.action === "dismiss" ? "Report dismissed." : "Decision saved. It will appear after the next refresh.");
      if (decision.reportUrl) {
        reports = reports.filter(({ url }) => url !== decision.reportUrl);
        nextReportOffset = 0;
        renderReports();
        status("reports-status", "Loading reports…");
        try {
          const pending = await readReports(active, 0);
          if (session === active) showReportPage(pending, 0);
        } catch (error) {
          handleFailure(active, "reports-status", error);
        }
      }
    } catch (error) {
      handleFailure(active, "decision-status", error);
    } finally {
      if (session === active) {
        setBusy(false);
        if (saved) $(decision.reportUrl ? "reports-heading" : "decision-heading").focus();
        else if (document.activeElement === document.body) event.submitter?.focus();
      }
    }
  });

  publishButton.addEventListener("click", async () => {
    const active = session;
    if (!active) return;
    setBusy(true);
    status("workspace-status", "Publishing topics…");
    try {
      await request(active, "/internal/refresh", { operator: true, method: "POST" });
      if (session !== active) return;
      status("workspace-status", "Topics published.");
      await loadTopics(active);
    } catch (error) {
      handleFailure(active, "workspace-status", error);
    } finally {
      if (session === active) {
        setBusy(false);
        publishButton.focus();
      }
    }
  });

  signOut(location.protocol === "https:" ? "" : "Open this page over HTTPS to sign in.", false);
})();
`;

export function serveTopicReviewPage() {
  const random = crypto.getRandomValues(new Uint8Array(16));
  const nonce = btoa(String.fromCharCode(...random));
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Topic review · Backchannel</title>
  <style nonce="${nonce}">${styles}</style>
</head>
<body>
  <header class="site-header">
    <div class="shell brand-row">
      <span class="brand">Backchannel</span>
      <button id="sign-out" type="button" hidden>Sign out</button>
    </div>
  </header>
  <main class="shell">
    <div class="page-heading">
      <h1>Topic review</h1>
      <button id="publish" type="button" hidden>Publish now</button>
    </div>
    <form id="login" class="panel stack" autocomplete="off">
      <label for="operator-token">Operator token</label>
      <input id="operator-token" type="password" autocomplete="off" required disabled>
      <button id="sign-in" class="primary" type="submit" disabled>Sign in</button>
      <p id="login-status" class="status" role="status"></p>
    </form>
    <div id="workspace" class="stack" hidden>
      <p id="workspace-status" class="status" role="status"></p>
      <div class="columns">
        <section class="panel stack" aria-labelledby="reports-heading">
          <h2 id="reports-heading" tabindex="-1">Pending reports</h2>
          <p id="reports-status" class="status" role="status"></p>
          <ul id="report-list" class="scroll-list"></ul>
          <button id="load-reports" type="button" hidden>Load more reports</button>
        </section>
        <section class="panel stack" aria-labelledby="decision-heading">
          <div class="actions">
            <h2 id="decision-heading" tabindex="-1">Curate topics</h2>
            <button id="clear-report" type="button" hidden>Clear selection</button>
          </div>
          <div id="report-detail" class="report-detail" hidden></div>
          <form id="decision-form" class="stack" autocomplete="off">
            <fieldset id="decision-fields" class="stack">
              <div>
                <label for="action">Action</label>
                <select id="action">
                  <option value="move">Move link</option>
                  <option value="remove">Remove link from topics</option>
                  <option value="merge">Merge topics</option>
                  <option value="split">Split topic</option>
                  <option value="edit" selected>Edit topic</option>
                  <option value="dismiss">Dismiss report</option>
                </select>
              </div>
              <fieldset id="link-fields" data-actions="move remove">
                <label for="link-url">Link URL
                  <input id="link-url" type="url" required>
                </label>
              </fieldset>
              <fieldset data-actions="move merge split edit" class="stack">
                <label for="topic-filter">Find a topic
                  <input id="topic-filter" type="search" placeholder="Filter by name or ID">
                </label>
                <div>
                  <div class="actions">
                    <label for="topic">Topic</label>
                    <button id="reload-topics" class="quiet" type="button">Reload topics</button>
                  </div>
                  <select id="topic" required></select>
                </div>
                <p id="topic-status" class="status" role="status"></p>
              </fieldset>
              <fieldset data-actions="merge">
                <label for="target-topic">Destination topic</label>
                <select id="target-topic" required></select>
              </fieldset>
              <fieldset data-actions="split" class="stack">
                <label for="split-name">New topic name
                  <input id="split-name" type="text" maxlength="512" required>
                </label>
                <fieldset class="stack">
                  <legend>Links to move</legend>
                  <p id="coverage-status" class="status" role="status"></p>
                  <ul id="coverage-list" class="scroll-list coverage" hidden></ul>
                </fieldset>
              </fieldset>
              <fieldset data-actions="edit" class="stack">
                <figure id="cover-preview" class="cover-preview" hidden></figure>
                <div>
                  <label for="edit">Edit</label>
                  <select id="edit">
                    <option value="label">Rename topic</option>
                    <option value="image">Set Wikimedia Commons cover</option>
                    <option value="automatic">Use automatic cover image</option>
                  </select>
                </div>
                <fieldset data-edits="label">
                  <label for="topic-name">Topic name
                    <input id="topic-name" type="text" maxlength="512" required>
                  </label>
                </fieldset>
                <fieldset data-edits="image" class="stack">
                  <label for="image-url">Image URL
                    <input id="image-url" type="url" maxlength="2048" required>
                  </label>
                  <label for="image-source">Commons file page
                    <input id="image-source" type="url" maxlength="2048" required>
                  </label>
                  <label for="image-credit">Credit and license
                    <input id="image-credit" type="text" maxlength="512" required>
                  </label>
                  <label for="image-subject">Image subject
                    <input id="image-subject" type="text" maxlength="160" required>
                  </label>
                </fieldset>
              </fieldset>
              <button class="primary" type="submit">Save decision</button>
            </fieldset>
            <p id="decision-status" class="status" role="status"></p>
          </form>
        </section>
      </div>
    </div>
  </main>
  <script nonce="${nonce}">${script}</script>
</body>
</html>`;
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": [
        "default-src 'none'",
        "script-src 'nonce-" + nonce + "'",
        "style-src 'nonce-" + nonce + "'",
        "connect-src 'self'",
        "img-src https://upload.wikimedia.org https://thumb.wikimedia.org",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
      ].join("; "),
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}
