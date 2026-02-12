const API = window.location.origin;

const state = {
  selectedNewsletterDoc: null,
  selectedNewsletterDocId: null,
  selectedCollection: null,
  selectedLanguage: "en",
  selectedVersionId: null,
  selectedSourceIndex: 0,
  newsletterDocs: [],
  runLogsCache: {},
  versionStudioLayout: "stacked",
};

const tabs = document.querySelectorAll("nav button[data-tab]");
const tabSections = document.querySelectorAll(".tab");

function loadVersionStudioLayout() {
  try {
    const stored = window.localStorage.getItem("versionStudioLayout");
    if (stored === "split" || stored === "stacked") {
      return stored;
    }
  } catch {
    // ignore storage errors in privacy-restricted environments
  }
  return "stacked";
}

function applyVersionStudioLayout(layout) {
  const nextLayout = layout === "split" ? "split" : "stacked";
  state.versionStudioLayout = nextLayout;

  const versionsTab = document.getElementById("tab-versions");
  const switchButton = document.getElementById("versionLayoutSwitch");
  versionsTab?.classList.remove("vs-layout-stacked", "vs-layout-split");
  versionsTab?.classList.add(nextLayout === "split" ? "vs-layout-split" : "vs-layout-stacked");

  if (switchButton) {
    switchButton.textContent = `Layout: ${nextLayout === "split" ? "Split" : "Stacked"}`;
    switchButton.setAttribute("aria-label", `Version Studio layout is ${nextLayout}. Click to switch.`);
  }

  try {
    window.localStorage.setItem("versionStudioLayout", nextLayout);
  } catch {
    // ignore storage errors
  }
}

function activateTab(tabName) {
  tabs.forEach((item) => item.classList.toggle("active", item.dataset.tab === tabName));
  tabSections.forEach((section) => section.classList.toggle("active", section.id === `tab-${tabName}`));
}

for (const tab of tabs) {
  tab.addEventListener("click", async () => {
    const tabName = tab.dataset.tab;
    activateTab(tabName);
    if (tabName === "versions") {
      await refreshVersionStudio();
    }
  });
}

async function fetchJson(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!response.ok) {
    const payload = await response.text();
    throw new Error(`${response.status} ${path} ${payload}`);
  }
  return response.status === 204 ? null : response.json();
}

function renderTable(containerId, rows) {
  const root = document.getElementById(containerId);
  if (!root) return;
  if (!rows || !rows.length) {
    root.innerHTML = "<p>No data</p>";
    return;
  }

  const columns = Object.keys(rows[0]);
  const head = `<tr>${columns.map((column) => `<th>${column}</th>`).join("")}</tr>`;
  const body = rows
    .map((row) => `<tr>${columns.map((column) => `<td>${formatCell(row[column])}</td>`).join("")}</tr>`)
    .join("");

  root.innerHTML = `<div class=\"table\"><table>${head}${body}</table></div>`;
}

function formatCell(value) {
  if (value == null) return "";
  if (typeof value === "object") return `<pre>${JSON.stringify(value, null, 2)}</pre>`;
  return String(value);
}

function formatDateTime(value) {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toLocaleString();
}

function normalizeText(value) {
  return String(value || "").toLowerCase();
}

function extractCitationIds(content) {
  const matches = String(content || "").toUpperCase().match(/\[(A\d+)\]/g) ?? [];
  return new Set(matches.map((match) => match.replace(/[\[\]]/g, "")));
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractContextSnippet(content, probes, radius = 200) {
  const source = String(content || "").replace(/\s+/g, " ").trim();
  if (!source) return "";
  const normalizedSource = source.toLowerCase();
  const normalizedProbes = probes.map((probe) => String(probe || "").trim().toLowerCase()).filter(Boolean);

  for (const probe of normalizedProbes) {
    const at = normalizedSource.indexOf(probe);
    if (at >= 0) {
      const start = Math.max(0, at - radius);
      const end = Math.min(source.length, at + probe.length + radius);
      const prefix = start > 0 ? "..." : "";
      const suffix = end < source.length ? "..." : "";
      return `${prefix}${source.slice(start, end)}${suffix}`;
    }
  }

  if (source.length <= radius * 2) {
    return source;
  }
  return `${source.slice(0, radius * 2)}...`;
}

function emphasizeProbes(content, probes) {
  let rendered = escapeHtml(content);
  for (const probe of probes.map((value) => String(value || "").trim()).filter(Boolean)) {
    const pattern = new RegExp(escapeRegex(probe), "ig");
    rendered = rendered.replace(pattern, (value) => `<mark>${value}</mark>`);
  }
  return rendered;
}

function renderInlineMarkdown(value) {
  const escaped = escapeHtml(value);
  return escaped.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_all, label, href) => {
    const safeLabel = escapeHtml(label);
    const safeHref = escapeHtml(href);
    return `<a href="${safeHref}" target="_blank" rel="noreferrer">${safeLabel}</a>`;
  });
}

function renderMarkdownLite(markdown) {
  const lines = String(markdown || "").replaceAll("\r", "").split("\n");
  const chunks = [];
  let inList = false;

  const closeList = () => {
    if (inList) {
      chunks.push("</ul>");
      inList = false;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      closeList();
      continue;
    }

    if (line.startsWith("### ")) {
      closeList();
      chunks.push(`<h4>${renderInlineMarkdown(line.slice(4))}</h4>`);
      continue;
    }
    if (line.startsWith("## ")) {
      closeList();
      chunks.push(`<h3>${renderInlineMarkdown(line.slice(3))}</h3>`);
      continue;
    }
    if (line.startsWith("# ")) {
      closeList();
      chunks.push(`<h2>${renderInlineMarkdown(line.slice(2))}</h2>`);
      continue;
    }
    if (line.startsWith("- ")) {
      if (!inList) {
        chunks.push("<ul>");
        inList = true;
      }
      chunks.push(`<li>${renderInlineMarkdown(line.slice(2))}</li>`);
      continue;
    }

    closeList();
    chunks.push(`<p>${renderInlineMarkdown(line)}</p>`);
  }

  closeList();
  return chunks.join("") || "<p>No markdown content.</p>";
}

function computeArticleTrace(article, variant) {
  const citationId = String(article?.citation_id || "").trim().toUpperCase();
  const markdownCitations = extractCitationIds(variant?.content_markdown);
  const textCitations = extractCitationIds(variant?.content_text);
  if (/^A\d+$/.test(citationId)) {
    const markdownHit = markdownCitations.has(citationId);
    const textHit = textCitations.has(citationId);
    return {
      citationId,
      markdownHit,
      textHit,
      anyHit: markdownHit || textHit,
    };
  }

  const markdown = normalizeText(variant?.content_markdown);
  const text = normalizeText(variant?.content_text);
  const articleUrl = normalizeText(article?.url);
  const title = normalizeText(article?.title);
  const titleProbe = title.length > 52 ? title.slice(0, 52) : title;

  const markdownHit = Boolean((articleUrl && markdown.includes(articleUrl)) || (titleProbe && markdown.includes(titleProbe)));
  const textHit = Boolean((articleUrl && text.includes(articleUrl)) || (titleProbe && text.includes(titleProbe)));

  return {
    citationId: null,
    markdownHit,
    textHit,
    anyHit: markdownHit || textHit,
  };
}

function parseTsMs(value) {
  const parsed = new Date(String(value || ""));
  return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
}

function renderJsonPre(value) {
  return `<pre>${escapeHtml(JSON.stringify(value ?? null, null, 2))}</pre>`;
}

function extractVersionPayload(version) {
  return {
    headline: version?.headline || "",
    content_markdown: version?.content_markdown || "",
    content_text: version?.content_text || "",
    tone: version?.tone || "",
    context_level: version?.context_level || "",
    citation_validation: version?.citation_validation || null,
  };
}

function deriveTransactionEvents(doc, version) {
  const audit = Array.isArray(doc?.audit) ? doc.audit : [];
  const versionTs = parseTsMs(version?.at);
  const action = String(version?.action || "").toLowerCase();
  const actor = String(version?.actor || "").toLowerCase();
  const note = String(version?.note || "").toLowerCase();

  const matched = audit.filter((event) => {
    const eventAction = String(event?.action || "").toLowerCase();
    const eventActor = String(event?.actor || "").toLowerCase();
    const eventNote = String(event?.note || "").toLowerCase();
    const eventTs = parseTsMs(event?.at);

    const nearInTime = versionTs != null && eventTs != null && Math.abs(eventTs - versionTs) <= 20 * 60 * 1000;
    const actionMatch = action && (eventAction.includes(action) || action.includes(eventAction));
    const actorMatch = actor && eventActor && actor === eventActor;
    const noteMatch = note && eventNote && (eventNote.includes(note) || note.includes(eventNote));

    return nearInTime || actionMatch || actorMatch || noteMatch;
  });

  if (matched.length) {
    return matched.sort((a, b) => String(b.at || "").localeCompare(String(a.at || ""))).slice(0, 40);
  }

  return audit.slice(-20).reverse();
}

function deriveIntegrationLogs(logs, version) {
  const rows = Array.isArray(logs) ? logs : [];
  const versionTs = parseTsMs(version?.at);
  const action = String(version?.action || "").toLowerCase();
  const note = String(version?.note || "").toLowerCase();
  const language = String(version?.language || "").toLowerCase();

  const filtered = rows.filter((row) => {
    const rowTs = parseTsMs(row?.ts);
    const payloadProbe = row?.payloadJson && typeof row.payloadJson === "object" ? JSON.stringify(row.payloadJson) : String(row?.payloadJson || "");
    const probe = `${String(row?.step || "")} ${String(row?.message || "")} ${payloadProbe}`.toLowerCase();

    const nearInTime = versionTs != null && rowTs != null && Math.abs(rowTs - versionTs) <= 45 * 60 * 1000;
    const actionMatch = action && probe.includes(action);
    const noteMatch = note && probe.includes(note);
    const langMatch = language && probe.includes(language);
    return nearInTime || actionMatch || noteMatch || langMatch;
  });

  const result = filtered.length ? filtered : rows;
  return result
    .slice()
    .sort((a, b) => String(b.ts || "").localeCompare(String(a.ts || "")))
    .slice(0, 120);
}

async function getPipelineLogsForRun(runId) {
  if (!runId) return [];
  if (Array.isArray(state.runLogsCache[runId])) {
    return state.runLogsCache[runId];
  }
  const page = await fetchJson(`/pipeline/runs/${encodeURIComponent(runId)}/logs/page?limit=600&offset=0`);
  const items = Array.isArray(page?.items) ? page.items : [];
  state.runLogsCache[runId] = items;
  return items;
}

function renderNewsletterDocs(rows) {
  const root = document.getElementById("newsletterDocs");
  if (!root) return;
  if (!rows?.length) {
    root.innerHTML = "<p>No newsletter documents</p>";
    return;
  }

  root.innerHTML = `
    <div class="table newsletter-docs-table">
      <table>
        <tr><th></th><th>id</th><th>status</th><th>post date</th><th>updated</th></tr>
        ${rows
          .map((item) => {
            const selected = item.id === state.selectedNewsletterDocId;
            return `<tr class="${selected ? "selected" : ""}">
              <td><button data-select-doc="${escapeHtml(item.id)}">${selected ? "Selected" : "Open"}</button></td>
              <td title="${escapeHtml(item.id)}"><code>${escapeHtml(item.id.slice(0, 12))}...</code></td>
              <td><span class="status-chip status-${escapeHtml(item.status)}">${escapeHtml(item.status)}</span></td>
              <td>${escapeHtml(item.post_date)}</td>
              <td>${escapeHtml(formatDateTime(item.updated_at))}</td>
            </tr>`;
          })
          .join("")}
      </table>
    </div>
  `;

  root.querySelectorAll("button[data-select-doc]").forEach((button) => {
    button.addEventListener("click", async () => {
      const docId = button.getAttribute("data-select-doc");
      if (!docId) return;
      state.selectedNewsletterDocId = docId;
      const doc = await fetchJson(`/newsletter/documents/${encodeURIComponent(docId)}`);
      state.selectedNewsletterDoc = doc;
      renderNewsletterDocs(rows);
      renderNewsletterEditor(doc);
      await refreshVersionStudio();
    });
  });
}

function renderCards(containerId, cards) {
  const root = document.getElementById(containerId);
  root.innerHTML = cards.map((card) => `<div class=\"card\"><strong>${card.label}</strong><div>${card.value}</div></div>`).join("");
}

let articleChart;
let runChart;

function renderCharts(metrics) {
  const articleCanvas = document.getElementById("articlesChart");
  const runCanvas = document.getElementById("runsChart");
  if (typeof Chart === "undefined") {
    document.getElementById("recoveryMetrics").innerHTML = "<p>Chart.js unavailable. Metrics charts are disabled.</p>";
    return;
  }

  if (articleChart) articleChart.destroy();
  if (runChart) runChart.destroy();

  articleChart = new Chart(articleCanvas, {
    type: "line",
    data: {
      labels: metrics.articlesByDay.map((row) => row.label),
      datasets: [{ label: "Articles/day", data: metrics.articlesByDay.map((row) => row.value), borderColor: "#176f5a" }],
    },
  });

  runChart = new Chart(runCanvas, {
    type: "bar",
    data: {
      labels: metrics.runsByDay.map((row) => row.label),
      datasets: [
        { label: "Success", data: metrics.runsByDay.map((row) => row.success), backgroundColor: "#2aa67d" },
        { label: "Failed", data: metrics.runsByDay.map((row) => row.failed), backgroundColor: "#c04b58" },
      ],
    },
  });

  document.getElementById("recoveryMetrics").innerHTML = `
    <div class="cards">
      <div class="card"><strong>Recovered steps</strong><div>${metrics.recovery?.recoveredSteps ?? 0}</div></div>
      <div class="card"><strong>Failed steps</strong><div>${metrics.recovery?.failedSteps ?? 0}</div></div>
      <div class="card"><strong>Retry attempts</strong><div>${metrics.recovery?.totalRetryAttempts ?? 0}</div></div>
    </div>
  `;
}

async function refreshOverview() {
  const [stats, latestPost, runs] = await Promise.all([
    fetchJson("/stats"),
    fetchJson("/posts/latest"),
    fetchJson("/pipeline/runs/page?limit=20&offset=0"),
  ]);

  renderCards("statsCards", [
    { label: "Sources", value: stats.sources },
    { label: "Articles", value: stats.articles },
    { label: "Runs", value: stats.runs },
    { label: "Duplicates", value: stats.duplicates },
  ]);

  document.getElementById("latestPost").textContent = latestPost
    ? `${latestPost.headline}\n\n${latestPost.contentMarkdown}`
    : "No daily post yet.";

  renderTable("runsTable", runs.items || []);
}

async function refreshSources() {
  const [sources, health] = await Promise.all([fetchJson("/sources"), fetchJson("/sources/health?window=100")]);
  const healthBySource = new Map((health || []).map((row) => [row.sourceId, row]));
  const rows = (sources || []).map((source) => {
    const sourceHealth = healthBySource.get(source.id) || {};
    return {
      ...source,
      successCount: sourceHealth.successCount ?? null,
      errorCount: sourceHealth.errorCount ?? null,
      warningCount: sourceHealth.warningCount ?? null,
      successRate: sourceHealth.successRate ?? null,
      lastError: sourceHealth.lastError ?? null,
    };
  });
  renderTable("sourcesTable", rows);
}

async function refreshNews() {
  const rows = await fetchJson("/articles/page?limit=100&offset=0");
  renderTable("newsTable", rows.items || []);
}

function bindNewsActions() {
  const statusBtn = document.getElementById("newsStatusBtn");
  const clusterBtn = document.getElementById("newsClusterBtn");

  statusBtn.addEventListener("click", async () => {
    const articleId = document.getElementById("newsArticleIdInput").value.trim();
    const status = document.getElementById("newsStatusInput").value;
    if (!articleId) return;

    await fetchJson(`/articles/${encodeURIComponent(articleId)}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    });
    await refreshNews();
  });

  clusterBtn.addEventListener("click", async () => {
    const clusterId = document.getElementById("newsClusterIdInput").value.trim();
    const root = document.getElementById("newsClusterDetails");
    if (!clusterId) {
      root.innerHTML = "";
      return;
    }

    const cluster = await fetchJson(`/clusters/${encodeURIComponent(clusterId)}`);
    root.innerHTML = `<pre>${escapeHtml(JSON.stringify(cluster, null, 2))}</pre>`;
  });
}

async function refreshObservability() {
  const metrics = await fetchJson("/system/metrics?days=14");
  renderCharts(metrics);
}

async function refreshConfig() {
  const [configs, secrets] = await Promise.all([fetchJson("/system/config"), fetchJson("/system/secrets")]);
  renderTable("configTable", configs);
  renderTable("secretsTable", secrets);
}

function bindAdminActions() {
  const configUpdateBtn = document.getElementById("configUpdateBtn");
  const secretSetBtn = document.getElementById("secretSetBtn");
  const secretClearBtn = document.getElementById("secretClearBtn");

  configUpdateBtn.addEventListener("click", async () => {
    const key = document.getElementById("configKeyInput").value.trim();
    const value = document.getElementById("configValueInput").value;
    if (!key || !value) return;

    await fetchJson(`/system/config/${encodeURIComponent(key)}`, {
      method: "PUT",
      body: JSON.stringify({ value }),
    });
    await refreshConfig();
  });

  secretSetBtn.addEventListener("click", async () => {
    const key = document.getElementById("secretKeyInput").value.trim();
    const value = document.getElementById("secretValueInput").value;
    if (!key || !value) return;

    await fetchJson(`/system/secrets/${encodeURIComponent(key)}`, {
      method: "PUT",
      body: JSON.stringify({ value }),
    });
    document.getElementById("secretValueInput").value = "";
    await refreshConfig();
  });

  secretClearBtn.addEventListener("click", async () => {
    const key = document.getElementById("secretKeyInput").value.trim();
    if (!key) return;

    await fetchJson(`/system/secrets/${encodeURIComponent(key)}`, {
      method: "DELETE",
    });
    document.getElementById("secretValueInput").value = "";
    await refreshConfig();
  });
}

function parseJsonInput(value, fallbackValue) {
  const raw = (value || "").trim();
  if (!raw) return fallbackValue;
  try {
    return JSON.parse(raw);
  } catch {
    return fallbackValue;
  }
}

function bindSourceActions() {
  const sourceSaveBtn = document.getElementById("sourceSaveBtn");
  const sourceToggleBtn = document.getElementById("sourceToggleBtn");
  const sourceDeleteBtn = document.getElementById("sourceDeleteBtn");

  sourceSaveBtn.addEventListener("click", async () => {
    const sourceId = document.getElementById("sourceIdInput").value.trim();
    const sourceType = document.getElementById("sourceTypeInput").value;
    const name = document.getElementById("sourceNameInput").value.trim();
    const pollingMinutes = Number(document.getElementById("sourcePollingInput").value || 1440);
    const enabled = document.getElementById("sourceEnabledInput").value === "true";
    const tagsJson = parseJsonInput(document.getElementById("sourceTagsInput").value, []);
    const configJson = parseJsonInput(document.getElementById("sourceConfigInput").value, {});
    const authJsonRaw = parseJsonInput(document.getElementById("sourceAuthInput").value, null);
    const authJson = authJsonRaw === null ? null : authJsonRaw;

    if (!name) return;

    const payload = {
      sourceType,
      name,
      enabled,
      pollingMinutes,
      tagsJson,
      configJson,
      authJson,
    };

    if (sourceId) {
      await fetchJson(`/sources/${encodeURIComponent(sourceId)}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
    } else {
      await fetchJson("/sources", {
        method: "POST",
        body: JSON.stringify(payload),
      });
    }
    await refreshSources();
  });

  sourceToggleBtn.addEventListener("click", async () => {
    const sourceId = document.getElementById("sourceToggleIdInput").value.trim();
    const enabled = document.getElementById("sourceToggleEnabledInput").value;
    if (!sourceId) return;

    await fetchJson(`/sources/${encodeURIComponent(sourceId)}/toggle?enabled=${encodeURIComponent(enabled)}`, {
      method: "POST",
    });
    await refreshSources();
  });

  sourceDeleteBtn.addEventListener("click", async () => {
    const sourceId = document.getElementById("sourceDeleteIdInput").value.trim();
    if (!sourceId) return;

    await fetchJson(`/sources/${encodeURIComponent(sourceId)}`, {
      method: "DELETE",
    });
    await refreshSources();
  });
}

async function refreshLogs() {
  const level = document.getElementById("logsLevel")?.value || "";
  const limit = Number(document.getElementById("logsLimit")?.value || 100);
  const query = new URLSearchParams({ limit: String(Math.max(1, Math.min(limit, 1000))) });
  if (level) query.set("level", level);
  const logs = await fetchJson(`/system/logs/recent?${query.toString()}`);
  renderTable("logsTable", logs);
}

function renderArticleTraceCards(news, variant) {
  const articles = news || [];
  if (!articles.length) {
    return "<p>No source articles in this collection.</p>";
  }

  return articles
    .map((article, index) => {
      const trace = computeArticleTrace(article, variant);
      const url = String(article?.url || "");
      const href = /^https?:\/\//i.test(url) ? escapeHtml(url) : "#";
      const title = escapeHtml(article?.title || "Untitled");
      const summary = escapeHtml(article?.summary || "");
      const publishedAt = formatDateTime(article?.published_at);
      const language = escapeHtml(article?.language || "");
      const topic = escapeHtml(article?.topic || "Other");
      const active = index === state.selectedSourceIndex;

      return `
        <article class="nl-source-card ${trace.anyHit ? "linked" : "missing"} ${active ? "active" : ""}">
          <div class="nl-source-header">
            <span class="nl-badge">#${index + 1}</span>
            <span class="nl-badge">${trace.citationId || "A?"}</span>
            <span class="nl-badge">${topic}</span>
            <span class="nl-badge">${language}</span>
          </div>
          <h4><a href="${href}" target="_blank" rel="noreferrer">${title}</a></h4>
          <p>${summary}</p>
          <div class="nl-source-flags">
            <span class="nl-flag ${trace.markdownHit ? "ok" : "warn"}">Markdown: ${trace.markdownHit ? "linked" : "missing"}</span>
            <span class="nl-flag ${trace.textHit ? "ok" : "warn"}">Text: ${trace.textHit ? "linked" : "missing"}</span>
          </div>
          <div class="nl-source-footer">
            <code>${escapeHtml(url)}</code>
            ${publishedAt ? `<span>${escapeHtml(publishedAt)}</span>` : ""}
          </div>
          <div class="nl-source-actions">
            <button type="button" data-focus-source="${index}">Compare in Draft</button>
          </div>
        </article>
      `;
    })
    .join("");
}

function renderNewsletterEditor(doc) {
  const root = document.getElementById("newsletterEditor");
  if (!doc) {
    root.innerHTML = "<p>Select a document</p>";
    return;
  }

  const collections = doc.newsletter?.news_collections || [];
  if (!collections.length) {
    root.innerHTML = "<p>No collections</p>";
    return;
  }

  const collection = collections.find((item) => item.collection_id === state.selectedCollection) || collections[0];
  state.selectedCollection = collection.collection_id;

  const variants = collection.language_variants || [];
  const variant = variants.find((item) => (item.language || "").toLowerCase() === state.selectedLanguage) || variants[0] || {
    language: "en",
    headline: "",
    content_markdown: "",
    content_text: "",
    tone: "neutral",
    context_level: "standard",
  };

  state.selectedLanguage = variant.language || "en";
  if (!Array.isArray(collection.news) || !collection.news.length) {
    state.selectedSourceIndex = 0;
  } else if (state.selectedSourceIndex >= collection.news.length) {
    state.selectedSourceIndex = 0;
  }
  const variantPostStatus = String(
    variant.post_status ||
      (doc.status === "posted" ? "posted" : doc.status === "authorized" ? "authorized" : "draft"),
  ).toLowerCase();
  const refineTargetLanguage = state.selectedLanguage === "tr" ? "en" : "tr";
  const traceRows = (collection.news || []).map((article) => computeArticleTrace(article, variant));
  const linkedCount = traceRows.filter((item) => item.anyHit).length;
  const totalSources = traceRows.length;
  const variantValidation = variant.citation_validation || null;
  const initialMissing = Array.isArray(variantValidation?.missing_citations) ? variantValidation.missing_citations : [];
  const initialOrphan = Array.isArray(variantValidation?.orphan_citations) ? variantValidation.orphan_citations : [];

  root.innerHTML = `
    <div class="newsletter-shell">
      <div class="row nl-toolbar">
        <label>Collection
          <select id="nlCollection">${collections.map((item) => `<option value="${item.collection_id}" ${item.collection_id === collection.collection_id ? "selected" : ""}>${item.collection_id}</option>`).join("")}</select>
        </label>
        <label>Language
          <select id="nlLanguage">${["en", "tr"].map((item) => `<option value="${item}" ${item === state.selectedLanguage ? "selected" : ""}>${item}</option>`).join("")}</select>
        </label>
        <button id="nlAuthorize">Authorize</button>
        <button id="nlPostManual">Post Manually</button>
        <button id="nlDelete">Delete</button>
        <button id="nlPostX">Post to X</button>
      </div>

      <div class="nl-meta row">
        <span class="status-chip status-${escapeHtml(doc.status)}">${escapeHtml(doc.status)}</span>
        <span class="status-chip status-${escapeHtml(variantPostStatus)}">variant:${escapeHtml(variantPostStatus)}</span>
        <span class="nl-badge">Document: ${escapeHtml(doc.id)}</span>
        <span class="nl-badge">Post date: ${escapeHtml(doc.post_date)}</span>
        <span class="nl-badge">Updated: ${escapeHtml(formatDateTime(doc.updated_at))}</span>
      </div>
      <div id="nlActionResult" class="nl-trace-summary"></div>

      <div class="nl-layout">
        <section class="nl-main">
          <section class="nl-panel">
            <label class="nl-field">Headline
              <input id="nlHeadline" value="${escapeHtml(variant.headline || "")}" />
            </label>
            <div class="row">
              <label class="nl-field">Tone
                <input id="nlTone" value="${escapeHtml(variant.tone || "neutral")}" />
              </label>
              <label class="nl-field">Context
                <input id="nlContext" value="${escapeHtml(variant.context_level || "standard")}" />
              </label>
            </div>
            <label class="nl-field">Chatbot instruction
              <textarea id="nlInstruction" rows="2" placeholder="Refine style, tighten facts, keep citations..."></textarea>
            </label>
          </section>

          <section class="nl-panel">
            <div class="nl-editor-grid">
              <label class="nl-field">Markdown
                <textarea id="nlMarkdown" rows="16">${escapeHtml(variant.content_markdown || "")}</textarea>
              </label>
              <label class="nl-field">Text
                <textarea id="nlText" rows="16">${escapeHtml(variant.content_text || "")}</textarea>
              </label>
            </div>
            <div class="row">
              <label>Source language
                <select id="nlSourceLang">
                  ${["en", "tr"].map((item) => `<option value="${item}" ${item === state.selectedLanguage ? "selected" : ""}>${item}</option>`).join("")}
                </select>
              </label>
              <label>Target language
                <select id="nlTargetLang">
                  ${["en", "tr"].map((item) => `<option value="${item}" ${item === refineTargetLanguage ? "selected" : ""}>${item}</option>`).join("")}
                </select>
              </label>
              <button id="nlRefine">Refine with Chatbot</button>
              <button id="nlSave">Save Draft</button>
            </div>
          </section>

          <section class="nl-panel">
            <h3>Final Version Preview</h3>
            <div id="nlRenderedPreview" class="nl-rendered">${renderMarkdownLite(variant.content_markdown)}</div>
          </section>
        </section>

        <aside class="nl-side">
          <section class="nl-panel">
            <h3>Source Articles in Draft</h3>
            <p class="muted">Exact collection items and whether the final draft references them.</p>
            <div id="nlTraceSummary" class="nl-trace-summary">${linkedCount}/${totalSources} sources linked in final version</div>
            <div id="nlTraceDetails" class="nl-trace-summary">${initialMissing.length || initialOrphan.length ? `Missing: ${initialMissing.join(", ") || "none"} | Orphan: ${initialOrphan.join(", ") || "none"}` : "Citation validation: clean"}</div>
            <div id="nlArticleTrace" class="nl-article-list">
              ${renderArticleTraceCards(collection.news || [], variant)}
            </div>
          </section>

          <section class="nl-panel">
            <h3>Article to Final Comparator</h3>
            <p class="muted">Inspect one source article against markdown/text output with highlighted citation matches.</p>
            <div id="nlComparePanel"></div>
          </section>

          <section class="nl-panel">
            <h3>Revision Governance</h3>
            <p class="muted">Version history has moved to <strong>Version Studio</strong> for focused audit and traceability workflows.</p>
            <button id="nlOpenVersionStudio">Open Version Studio</button>
          </section>
        </aside>
      </div>
    </div>
  `;

  const refreshTraceAndPreview = () => {
    const liveVariant = {
      ...variant,
      content_markdown: document.getElementById("nlMarkdown").value,
      content_text: document.getElementById("nlText").value,
    };
    const liveTraceRows = (collection.news || []).map((article) => computeArticleTrace(article, liveVariant));
    const liveLinkedCount = liveTraceRows.filter((item) => item.anyHit).length;
    const missingCitations = (collection.news || [])
      .map((item, idx) => String(item?.citation_id || `A${idx + 1}`))
      .filter((citationId) => !liveTraceRows.some((trace) => trace.citationId === citationId && trace.anyHit));
    const referencedSet = new Set([
      ...extractCitationIds(liveVariant.content_markdown),
      ...extractCitationIds(liveVariant.content_text),
    ]);
    const requiredSet = new Set((collection.news || []).map((item, idx) => String(item?.citation_id || `A${idx + 1}`).toUpperCase()));
    const orphanCitations = [...referencedSet].filter((item) => !requiredSet.has(item));

    document.getElementById("nlTraceSummary").textContent =
      `${liveLinkedCount}/${liveTraceRows.length} sources linked in final version`;
    document.getElementById("nlTraceDetails").textContent =
      missingCitations.length || orphanCitations.length
        ? `Missing: ${missingCitations.join(", ") || "none"} | Orphan: ${orphanCitations.join(", ") || "none"}`
        : "Citation validation: clean";
    document.getElementById("nlArticleTrace").innerHTML = renderArticleTraceCards(collection.news || [], liveVariant);
    document.querySelectorAll("button[data-focus-source]").forEach((button) => {
      button.addEventListener("click", () => {
        const sourceIndex = Number(button.getAttribute("data-focus-source"));
        if (Number.isNaN(sourceIndex)) return;
        state.selectedSourceIndex = sourceIndex;
        refreshTraceAndPreview();
      });
    });
    document.getElementById("nlRenderedPreview").innerHTML = renderMarkdownLite(liveVariant.content_markdown);

    const compareRoot = document.getElementById("nlComparePanel");
    if (!compareRoot) return;

    const sourceItems = collection.news || [];
    if (!sourceItems.length) {
      compareRoot.innerHTML = "<p class=\"muted\">No source article available.</p>";
      return;
    }

    const selectedIndex = Math.max(0, Math.min(state.selectedSourceIndex, sourceItems.length - 1));
    state.selectedSourceIndex = selectedIndex;
    const selectedArticle = sourceItems[selectedIndex];
    const selectedTrace = computeArticleTrace(selectedArticle, liveVariant);
    const citationProbe = selectedTrace.citationId || selectedArticle?.citation_id || "";
    const urlProbe = selectedArticle?.url || "";
    const titleProbe = selectedArticle?.title || "";
    const probes = [citationProbe, urlProbe, titleProbe].filter(Boolean);
    const markdownSnippet = extractContextSnippet(liveVariant.content_markdown, probes, 210);
    const textSnippet = extractContextSnippet(liveVariant.content_text, probes, 210);
    const sourceSummary = selectedArticle?.summary || selectedArticle?.full_text || "";
    const sourceSnippet = extractContextSnippet(sourceSummary, probes, 170);

    compareRoot.innerHTML = `
      <div class="nl-compare-grid">
        <article class="nl-compare-panel">
          <h4>Source Article</h4>
          <div class="nl-kv">
            <span>Citation</span><span><code>${escapeHtml(String(citationProbe || "A?"))}</code></span>
            <span>Title</span><span>${escapeHtml(selectedArticle?.title || "Untitled")}</span>
            <span>URL</span><span><a href="${escapeHtml(urlProbe || "#")}" target="_blank" rel="noreferrer">${escapeHtml(urlProbe || "-")}</a></span>
            <span>Topic</span><span>${escapeHtml(selectedArticle?.topic || "Other")}</span>
          </div>
          <p>${emphasizeProbes(sourceSnippet || "No summary text available.", probes)}</p>
        </article>
        <article class="nl-compare-panel">
          <h4>Final Markdown Match</h4>
          <p>${emphasizeProbes(markdownSnippet || "No markdown match.", probes)}</p>
          <h4>Final Text Match</h4>
          <p>${emphasizeProbes(textSnippet || "No plain-text match.", probes)}</p>
          <div class="nl-source-flags">
            <span class="nl-flag ${selectedTrace.markdownHit ? "ok" : "warn"}">Markdown ${selectedTrace.markdownHit ? "linked" : "missing"}</span>
            <span class="nl-flag ${selectedTrace.textHit ? "ok" : "warn"}">Text ${selectedTrace.textHit ? "linked" : "missing"}</span>
          </div>
        </article>
      </div>
    `;
  };

  const setActionResult = (message, isError = false) => {
    const node = document.getElementById("nlActionResult");
    node.textContent = message || "";
    node.style.color = isError ? "#9f3f4a" : "#0b5f4a";
  };

  document.getElementById("nlCollection").addEventListener("change", (event) => {
    state.selectedCollection = event.target.value;
    state.selectedVersionId = null;
    state.selectedSourceIndex = 0;
    renderNewsletterEditor(doc);
    refreshVersionStudio();
  });

  document.getElementById("nlLanguage").addEventListener("change", (event) => {
    state.selectedLanguage = event.target.value;
    state.selectedVersionId = null;
    state.selectedSourceIndex = 0;
    renderNewsletterEditor(doc);
    refreshVersionStudio();
  });

  document.getElementById("nlMarkdown").addEventListener("input", refreshTraceAndPreview);
  document.getElementById("nlText").addEventListener("input", refreshTraceAndPreview);

  document.getElementById("nlSave").addEventListener("click", async () => {
    try {
      await fetchJson(`/newsletter/documents/${doc.id}/save-draft`, {
        method: "POST",
        body: JSON.stringify({
          collectionId: state.selectedCollection,
          language: state.selectedLanguage,
          headline: document.getElementById("nlHeadline").value,
          contentMarkdown: document.getElementById("nlMarkdown").value,
          contentText: document.getElementById("nlText").value,
          tone: document.getElementById("nlTone").value,
          contextLevel: document.getElementById("nlContext").value,
        }),
      });
      setActionResult("Draft saved.");
      await refreshNewsletter();
    } catch (error) {
      setActionResult(String(error), true);
    }
  });

  document.getElementById("nlRefine").addEventListener("click", async () => {
    const sourceLanguage = document.getElementById("nlSourceLang").value;
    const targetLanguage = document.getElementById("nlTargetLang").value;
    const tone = document.getElementById("nlTone").value;
    const contextLevel = document.getElementById("nlContext").value;
    const userInstruction = document.getElementById("nlInstruction").value;

    try {
      await fetchJson(`/newsletter/documents/${doc.id}/refine`, {
        method: "POST",
        body: JSON.stringify({
          collectionId: state.selectedCollection,
          sourceLanguage,
          targetLanguage,
          tone,
          contextLevel,
          userInstruction,
        }),
      });

      state.selectedLanguage = targetLanguage;
      setActionResult(`Refined ${sourceLanguage} -> ${targetLanguage}.`);
      await refreshNewsletter();
    } catch (error) {
      setActionResult(String(error), true);
    }
  });

  document.getElementById("nlAuthorize").addEventListener("click", async () => {
    try {
      await fetchJson(`/newsletter/documents/${doc.id}/authorize`, {
        method: "POST",
        body: JSON.stringify({
          collectionId: state.selectedCollection,
          language: state.selectedLanguage,
        }),
      });
      setActionResult(`Variant authorized: ${state.selectedCollection}/${state.selectedLanguage}`);
      await refreshNewsletter();
    } catch (error) {
      setActionResult(String(error), true);
    }
  });

  document.getElementById("nlPostManual").addEventListener("click", async () => {
    try {
      await fetchJson(`/newsletter/documents/${doc.id}/manual-posted`, { method: "POST", body: JSON.stringify({}) });
      setActionResult("Marked as manually posted.");
      await refreshNewsletter();
    } catch (error) {
      setActionResult(String(error), true);
    }
  });

  document.getElementById("nlDelete").addEventListener("click", async () => {
    try {
      await fetchJson(`/newsletter/documents/${doc.id}/delete`, { method: "POST", body: JSON.stringify({}) });
      setActionResult("Document deleted.");
      await refreshNewsletter();
    } catch (error) {
      setActionResult(String(error), true);
    }
  });

  document.getElementById("nlPostX").addEventListener("click", async () => {
    try {
      await fetchJson(`/newsletter/documents/${doc.id}/post-to-x`, {
        method: "POST",
        body: JSON.stringify({ collectionId: state.selectedCollection, language: state.selectedLanguage }),
      });
      setActionResult("Posted to X.");
      await refreshNewsletter();
    } catch (error) {
      setActionResult(String(error), true);
    }
  });

  document.getElementById("nlOpenVersionStudio").addEventListener("click", async () => {
    activateTab("versions");
    await refreshVersionStudio();
  });

  refreshVersionStudio();
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function refreshVersionStudio() {
  const root = document.getElementById("versionHistoryTable");
  const detailRoot = document.getElementById("versionInspector");
  const docSelect = document.getElementById("versionDocSelect");
  const collectionSelect = document.getElementById("versionCollectionSelect");
  const languageSelect = document.getElementById("versionLanguageSelect");
  if (!root || !detailRoot || !docSelect || !collectionSelect || !languageSelect) return;

  const docs = state.newsletterDocs || [];
  if (!docs.length) {
    docSelect.innerHTML = "";
    collectionSelect.innerHTML = "";
    root.innerHTML = "<p class=\"muted\">No newsletter documents.</p>";
    detailRoot.innerHTML = "<p class=\"muted\">Select a document to inspect versions.</p>";
    return;
  }

  if (!docs.some((item) => item.id === state.selectedNewsletterDocId)) {
    state.selectedNewsletterDocId = docs[0].id;
  }

  docSelect.innerHTML = docs
    .map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === state.selectedNewsletterDocId ? "selected" : ""}>${escapeHtml(item.post_date)} · ${escapeHtml(item.status)} · ${escapeHtml(item.id.slice(0, 8))}</option>`)
    .join("");

  const selectedDocId = docSelect.value || state.selectedNewsletterDocId;
  if (!selectedDocId) {
    root.innerHTML = "<p class=\"muted\">No document selected.</p>";
    return;
  }

  let doc = state.selectedNewsletterDoc;
  if (!doc || doc.id !== selectedDocId) {
    doc = await fetchJson(`/newsletter/documents/${encodeURIComponent(selectedDocId)}`);
    state.selectedNewsletterDoc = doc;
    state.selectedNewsletterDocId = doc.id;
  }

  const collections = doc.newsletter?.news_collections || [];
  if (!collections.length) {
    collectionSelect.innerHTML = "";
    root.innerHTML = "<p class=\"muted\">Selected document has no collections.</p>";
    detailRoot.innerHTML = "<p class=\"muted\">No versions available.</p>";
    return;
  }

  if (!collections.some((item) => item.collection_id === state.selectedCollection)) {
    state.selectedCollection = collections[0].collection_id;
  }
  collectionSelect.innerHTML = collections
    .map((item) => `<option value="${escapeHtml(item.collection_id)}" ${item.collection_id === state.selectedCollection ? "selected" : ""}>${escapeHtml(item.collection_id)}</option>`)
    .join("");

  const selectedCollection = collectionSelect.value || state.selectedCollection;
  state.selectedCollection = selectedCollection;

  const selectedCollectionPayload = collections.find((item) => item.collection_id === selectedCollection) || collections[0];
  const supportedLanguages = ["en", "tr"];
  const availableLanguages = new Set(
    [...(selectedCollectionPayload.language_variants || []).map((item) => String(item.language || "").toLowerCase()), ...supportedLanguages].filter(Boolean),
  );
  if (!availableLanguages.has(state.selectedLanguage)) {
    state.selectedLanguage = supportedLanguages.find((lang) => availableLanguages.has(lang)) || [...availableLanguages][0] || "en";
  }
  languageSelect.innerHTML = [...availableLanguages]
    .sort()
    .map((lang) => `<option value="${escapeHtml(lang)}" ${lang === state.selectedLanguage ? "selected" : ""}>${escapeHtml(lang)}</option>`)
    .join("");

  const selectedLanguage = languageSelect.value || state.selectedLanguage;
  state.selectedLanguage = selectedLanguage;

  const versions = await fetchJson(
    `/newsletter/documents/${state.selectedNewsletterDoc.id}/versions?collectionId=${encodeURIComponent(state.selectedCollection)}&language=${encodeURIComponent(state.selectedLanguage)}&limit=50&offset=0`,
  );

  if (!versions.items?.length) {
    root.innerHTML = "<p class=\"muted\">No versions for selected collection/language.</p>";
    detailRoot.innerHTML = "<p class=\"muted\">No version details available.</p>";
    return;
  }

  const items = versions.items;
  if (!items.some((item) => item.version_id === state.selectedVersionId)) {
    state.selectedVersionId = items[0].version_id;
  }

  root.innerHTML = `
    <div class="table"><table>
      <tr><th>versionId</th><th>at</th><th>action</th><th>tone</th><th>context</th><th></th></tr>
      ${items
        .map(
          (item) => `<tr class="${item.version_id === state.selectedVersionId ? "selected-version-row" : ""}">
        <td><button class="nl-link-btn" data-open-version="${escapeHtml(item.version_id)}">${escapeHtml(item.version_id)}</button></td><td>${escapeHtml(formatDateTime(item.at))}</td><td>${escapeHtml(item.action || "")}</td><td>${escapeHtml(item.tone || "")}</td><td>${escapeHtml(item.context_level || "")}</td>
        <td><button data-rollback="${item.version_id}">Rollback</button></td>
      </tr>`,
        )
        .join("")}
    </table></div>
  `;

  const renderVersionDetails = async (version) => {
    if (!version) {
      detailRoot.innerHTML = "<p class=\"muted\">Select a versionId to inspect details.</p>";
      return;
    }

    detailRoot.innerHTML = "<p class=\"muted\">Loading version details...</p>";
    const payload = extractVersionPayload(version);
    const transactions = deriveTransactionEvents(doc, version);

    let integrationLogs = [];
    let integrationError = "";
    try {
      const logs = await getPipelineLogsForRun(doc?.pipeline_run_id);
      integrationLogs = deriveIntegrationLogs(logs, version);
    } catch (error) {
      integrationError = String(error);
    }

    detailRoot.innerHTML = `
      <div class="nl-version-inspector">
        <h4>Version Inspector</h4>
        <div class="nl-version-grid">
          <div class="nl-panel-soft">
            <h5>Metadata & Result</h5>
            <div class="nl-kv">
              <span>versionId</span><code>${escapeHtml(version.version_id || "")}</code>
              <span>at</span><span>${escapeHtml(formatDateTime(version.at))}</span>
              <span>action</span><span>${escapeHtml(version.action || "")}</span>
              <span>actor</span><span>${escapeHtml(version.actor || "")}</span>
              <span>language</span><span>${escapeHtml(version.language || "")}</span>
              <span>collection</span><span>${escapeHtml(version.collection_id || "")}</span>
              <span>tone</span><span>${escapeHtml(version.tone || "")}</span>
              <span>context</span><span>${escapeHtml(version.context_level || "")}</span>
              <span>note</span><span>${escapeHtml(version.note || "-")}</span>
            </div>
          </div>
          <div class="nl-panel-soft">
            <h5>Payload</h5>
            ${renderJsonPre(payload)}
          </div>
        </div>

        <div class="nl-version-grid">
          <div class="nl-panel-soft">
            <h5>Result (Markdown Preview)</h5>
            <div class="nl-rendered">${renderMarkdownLite(payload.content_markdown || "")}</div>
          </div>
          <div class="nl-panel-soft">
            <h5>Result (Plain Text)</h5>
            <pre>${escapeHtml(payload.content_text || "")}</pre>
          </div>
        </div>

        <div class="nl-version-grid">
          <div class="nl-panel-soft">
            <h5>Event Transactions</h5>
            <div class="table"><table>
              <tr><th>at</th><th>action</th><th>actor</th><th>note</th></tr>
              ${
                transactions.length
                  ? transactions
                    .map((event) => `<tr><td>${escapeHtml(formatDateTime(event.at))}</td><td>${escapeHtml(event.action || "")}</td><td>${escapeHtml(event.actor || "")}</td><td>${escapeHtml(event.note || "")}</td></tr>`)
                    .join("")
                  : "<tr><td colspan=\"4\" class=\"muted\">No transaction events found.</td></tr>"
              }
            </table></div>
          </div>
          <div class="nl-panel-soft">
            <h5>Integration Logs ${doc?.pipeline_run_id ? `(run ${escapeHtml(doc.pipeline_run_id)})` : ""}</h5>
            ${
              integrationError
                ? `<p class="muted">${escapeHtml(integrationError)}</p>`
                : `<div class="table"><table>
                <tr><th>ts</th><th>level</th><th>step</th><th>message</th><th>durationMs</th><th>payload</th></tr>
                ${
                  integrationLogs.length
                    ? integrationLogs
                      .map((log) => `<tr>
                      <td>${escapeHtml(formatDateTime(log.ts))}</td>
                      <td>${escapeHtml(log.level || "")}</td>
                      <td>${escapeHtml(log.step || "")}</td>
                      <td>${escapeHtml(log.message || "")}</td>
                      <td>${escapeHtml(log.durationMs ?? "")}</td>
                      <td>${renderJsonPre(log.payloadJson || null)}</td>
                    </tr>`)
                      .join("")
                    : "<tr><td colspan=\"6\" class=\"muted\">No integration logs found for this transaction.</td></tr>"
                }
              </table></div>`
            }
          </div>
        </div>
      </div>
    `;
  };

  const selectedVersion = items.find((item) => item.version_id === state.selectedVersionId) || items[0];
  state.selectedVersionId = selectedVersion?.version_id || null;

  root.querySelectorAll("button[data-open-version]").forEach((button) => {
    button.addEventListener("click", async () => {
      const versionId = button.getAttribute("data-open-version");
      if (!versionId) return;
      state.selectedVersionId = versionId;
      await refreshVersionStudio();
    });
  });

  root.querySelectorAll("button[data-rollback]").forEach((button) => {
    button.addEventListener("click", async () => {
      const versionId = button.getAttribute("data-rollback");
      await fetchJson(`/newsletter/documents/${state.selectedNewsletterDoc.id}/rollback`, {
        method: "POST",
        body: JSON.stringify({ versionId }),
      });
      await refreshNewsletter();
      await refreshVersionStudio();
    });
  });

  await renderVersionDetails(selectedVersion);
}

function bindVersionStudioActions() {
  const refreshBtn = document.getElementById("versionRefreshBtn");
  const docSelect = document.getElementById("versionDocSelect");
  const collectionSelect = document.getElementById("versionCollectionSelect");
  const languageSelect = document.getElementById("versionLanguageSelect");
  const layoutSwitch = document.getElementById("versionLayoutSwitch");

  applyVersionStudioLayout(loadVersionStudioLayout());

  refreshBtn?.addEventListener("click", async () => {
    await refreshVersionStudio();
  });

  docSelect?.addEventListener("change", async (event) => {
    state.selectedNewsletterDocId = event.target.value;
    state.selectedCollection = null;
    state.selectedVersionId = null;
    await refreshVersionStudio();
  });

  collectionSelect?.addEventListener("change", async (event) => {
    state.selectedCollection = event.target.value;
    state.selectedVersionId = null;
    await refreshVersionStudio();
  });

  languageSelect?.addEventListener("change", async (event) => {
    state.selectedLanguage = event.target.value;
    state.selectedVersionId = null;
    await refreshVersionStudio();
  });

  layoutSwitch?.addEventListener("click", () => {
    const next = state.versionStudioLayout === "stacked" ? "split" : "stacked";
    applyVersionStudioLayout(next);
  });
}

async function refreshNewsletter() {
  const status = document.getElementById("newsletterStatus").value;
  const query = new URLSearchParams({ limit: "20", offset: "0" });
  if (status) query.set("status", status);
  const docs = await fetchJson(`/newsletter/documents/page?${query.toString()}`);
  const previousDocId = state.selectedNewsletterDoc?.id || null;

  const rows = docs.items || [];
  state.newsletterDocs = rows;
  if (rows.length && !rows.some((item) => item.id === state.selectedNewsletterDocId)) {
    state.selectedNewsletterDocId = rows[0].id;
  }
  renderNewsletterDocs(rows);

  if (!rows.length) {
    state.selectedNewsletterDoc = null;
    state.selectedNewsletterDocId = null;
    state.selectedVersionId = null;
    renderNewsletterEditor(null);
    await refreshVersionStudio();
    return;
  }

  const selectedId = state.selectedNewsletterDocId || rows[0].id;
  state.selectedNewsletterDocId = selectedId;
  if (previousDocId && previousDocId !== selectedId) {
    state.selectedVersionId = null;
  }
  const doc = await fetchJson(`/newsletter/documents/${selectedId}`);
  state.selectedNewsletterDoc = doc;
  renderNewsletterEditor(doc);
  await refreshVersionStudio();
}

async function updateHealth() {
  const badge = document.getElementById("healthBadge");
  try {
    const health = await fetchJson("/health");
    badge.textContent = `backend: ${health.status}`;
  } catch {
    badge.textContent = "backend: down";
  }
}

document.getElementById("runPipelineBtn").addEventListener("click", async () => {
  const outputLanguage = document.getElementById("outputLanguage").value;
  await fetchJson("/pipeline/run/async", {
    method: "POST",
    body: JSON.stringify({ outputLanguage, forcePost: false }),
  });
  await refreshOverview();
});

document.getElementById("refreshNewsletter").addEventListener("click", refreshNewsletter);
document.getElementById("newsletterStatus").addEventListener("change", refreshNewsletter);
document.getElementById("logsRefreshBtn").addEventListener("click", refreshLogs);

async function bootstrap() {
  bindNewsActions();
  bindSourceActions();
  bindAdminActions();
  bindVersionStudioActions();
  await updateHealth();
  await Promise.all([
    refreshOverview(),
    refreshSources(),
    refreshNews(),
    refreshObservability(),
    refreshConfig(),
    refreshLogs(),
    refreshNewsletter(),
    refreshVersionStudio(),
  ]);
}

bootstrap().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
});
