"use strict";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);
const SEND_SHORTCUT = IS_MAC ? "⌘ ↵" : "Ctrl ↵";
const DRAFT_KEY = "dev_requests:draft";
const THEME_KEY = "dev_requests:theme";
const VIEW_KEY = "dev_requests:viewMode";
const HISTORY_COLLAPSED_KEY = "dev_requests:historyCollapsed";
const HIGHLIGHT_LIMIT = 400_000;

let projectsUI = null;

const state = {
  params: [],
  headers: [],
  bodyType: "none",
  authType: "none",
  viewMode: "pretty",
  graph: null,
  lastResponse: null,
  history: [],
  activeHistory: -1,
  abort: null,
  search: { query: "", index: 0, total: 0, timer: null },
};

// ---------- utilidades ----------

function storageGet(key) {
  try {
    // Cai na chave antiga para não perder o que foi salvo quando o app se chamava reqresp.
    return localStorage.getItem(key) ?? localStorage.getItem(key.replace(/^dev_requests:/, "reqresp:"));
  } catch {
    return null;
  }
}
function storageSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* armazenamento indisponível */ }
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function formatSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(ms) {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

function statusClass(status, error) {
  return error ? "c-err" : `c-${Math.floor(status / 100)}`;
}

let toastTimer;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 1800);
}

function highlightJson(text) {
  // Aspas não são escapadas aqui: o regex precisa delas e o resultado só vai para conteúdo de texto.
  const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  if (text.length > HIGHLIGHT_LIMIT) return escaped;
  return escaped.replace(
    /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    (m, str, colon) => {
      if (str) return colon ? `<span class="j-key">${str.slice(0, -colon.length)}</span>${colon}` : `<span class="j-str">${m}</span>`;
      if (/^(true|false|null)$/.test(m)) return `<span class="j-lit">${m}</span>`;
      return `<span class="j-num">${m}</span>`;
    },
  );
}

// ---------- URL <-> params ----------

function decodePart(s) {
  try { return decodeURIComponent(s.replace(/\+/g, " ")); } catch { return s; }
}

function encodePart(s) {
  return encodeURIComponent(s).replace(/%(2C|3A|2F|40|24|5B|5D|7B|7D|2A|21|27|28|29)/gi, (m) => decodeURIComponent(m));
}

function splitUrl(url) {
  const hashAt = url.indexOf("#");
  const hash = hashAt >= 0 ? url.slice(hashAt) : "";
  const noHash = hashAt >= 0 ? url.slice(0, hashAt) : url;
  const qAt = noHash.indexOf("?");
  return {
    base: qAt >= 0 ? noHash.slice(0, qAt) : noHash,
    query: qAt >= 0 ? noHash.slice(qAt + 1) : null,
    hash,
  };
}

function parseQuery(query) {
  if (!query) return [];
  return query.split("&").filter(Boolean).map((part) => {
    const eq = part.indexOf("=");
    return eq >= 0
      ? { key: decodePart(part.slice(0, eq)), value: decodePart(part.slice(eq + 1)), enabled: true }
      : { key: decodePart(part), value: "", enabled: true };
  });
}

function syncParamsFromUrl() {
  const { query } = splitUrl($("#url").value);
  const disabled = state.params.filter((p) => !p.enabled);
  state.params = [...parseQuery(query), ...disabled];
  renderKv("params");
}

function syncUrlFromParams() {
  const { base, hash } = splitUrl($("#url").value);
  const query = state.params
    .filter((p) => p.enabled && p.key)
    .map((p) => (p.value === "" ? encodePart(p.key) : `${encodePart(p.key)}=${encodePart(p.value)}`))
    .join("&");
  $("#url").value = base + (query ? `?${query}` : "") + hash;
}

// ---------- editor chave/valor ----------

function renderKv(name) {
  const container = $(`#kv-${name}`);
  container.innerHTML = "";
  state[name].forEach((row) => container.appendChild(makeKvRow(name, row)));
  container.appendChild(makeKvRow(name, null));
  updateCounts();
}

// Cada linha guarda a referência do seu objeto; a última linha é sempre um
// "placeholder" vazio que vira linha de verdade quando o usuário digita nela.
function makeKvRow(name, row) {
  const el = document.createElement("div");
  el.className = "kv-row" + (row ? (row.enabled ? "" : " disabled") : " placeholder-row");
  el.innerHTML = `
    <input type="checkbox" checked title="Ativar/desativar">
    <input type="text" class="k" spellcheck="false" placeholder="${name === "headers" ? "Header" : "Nome"}">
    <input type="text" class="v" spellcheck="false" placeholder="Valor">
    <button type="button" class="remove" title="Remover">×</button>`;
  const [check, k, v] = $$("input", el);
  if (row) {
    check.checked = row.enabled;
    k.value = row.key;
    v.value = row.value;
  }

  const ensureRow = () => {
    if (row) return;
    row = { key: "", value: "", enabled: true };
    state[name].push(row);
    el.classList.remove("placeholder-row");
    el.after(makeKvRow(name, null));
  };
  k.addEventListener("input", () => { ensureRow(); row.key = k.value; onKvChanged(name); });
  v.addEventListener("input", () => { ensureRow(); row.value = v.value; onKvChanged(name); });
  check.addEventListener("change", () => {
    if (!row) return;
    row.enabled = check.checked;
    el.classList.toggle("disabled", !check.checked);
    onKvChanged(name);
  });
  $(".remove", el).addEventListener("click", () => {
    if (!row) return;
    state[name] = state[name].filter((r) => r !== row);
    el.remove();
    onKvChanged(name);
  });
  return el;
}

function onKvChanged(name) {
  if (name === "params") syncUrlFromParams();
  updateCounts();
  saveDraft();
}

function updateCounts() {
  const n = (rows) => rows.filter((r) => r.enabled && r.key).length || "";
  $("#count-params").textContent = n(state.params);
  $("#count-headers").textContent = n(state.headers);
  $("#dot-body").classList.toggle("on", state.bodyType !== "none");
  $("#dot-auth").classList.toggle("on", state.authType !== "none");
}

// ---------- abas e segmentados ----------

function setupTabs() {
  $$(".tabs").forEach((nav) => {
    const group = nav.dataset.tabs;
    $$("button[data-tab]", nav).forEach((btn) => {
      btn.addEventListener("click", () => activateTab(group, btn.dataset.tab));
    });
  });
}

function activateTab(group, tab) {
  $$(`.tabs[data-tabs="${group}"] button[data-tab]`).forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  $$(`.tab-panel[data-panel^="${group}:"]`).forEach((p) => p.classList.toggle("active", p.dataset.panel === `${group}:${tab}`));
  if (group === "resp") {
    $("#view-mode").style.display = tab === "body" ? "" : "none";
    $("#copy-body").style.display = tab === "body" ? "" : "none";
    // O grafo é medido com o painel visível; ao voltar para a aba, re-enquadra.
    if (tab === "body" && state.graph) requestAnimationFrame(() => state.graph?.fit());
    // Depois do fit, para a busca poder centralizar a ocorrência atual.
    applySearch();
  }
}

function setupSegmented(id, onChange) {
  const el = $(`#${id}`);
  $$("button", el).forEach((btn) => btn.addEventListener("click", () => {
    setSegmented(id, btn.dataset.value);
    onChange(btn.dataset.value);
  }));
}

function setSegmented(id, value) {
  $$(`#${id} button`).forEach((b) => b.classList.toggle("active", b.dataset.value === value));
}

function setBodyType(type) {
  state.bodyType = type;
  setSegmented("body-type", type);
  $("#body-editor").style.display = type === "none" ? "none" : "";
  $("#body-empty").style.display = type === "none" ? "" : "none";
  $("#format-json").style.display = type === "json" ? "" : "none";
  validateBody();
  updateCounts();
}

function setAuthType(type) {
  state.authType = type;
  setSegmented("auth-type", type);
  $$("[data-auth]").forEach((el) => {
    const show = el.dataset.auth === type;
    el.classList.toggle("show", show);
    if (el.classList.contains("empty-note")) el.style.display = show ? "" : "none";
  });
  updateCounts();
}

function validateBody() {
  const out = $("#body-validation");
  const text = $("#body").value;
  out.className = "validation";
  out.textContent = "";
  if (state.bodyType !== "json" || !text.trim()) return true;
  try {
    const vars = projectsUI ? projectsUI.variables().values : {};
    JSON.parse(ReqProjects.jsonForValidation(text, vars));
    out.className = "validation ok";
    out.textContent = "✓ JSON válido";
    return true;
  } catch (e) {
    out.textContent = `JSON inválido: ${e.message}`;
    return false;
  }
}

// ---------- requisição ----------

function collectSpec() {
  return {
    method: $("#method").value,
    url: $("#url").value.trim(),
    params: [],
    headers: state.headers.filter((h) => h.enabled && h.key).map((h) => [h.key, h.value]),
    body: state.bodyType === "none" ? "" : $("#body").value,
    body_type: state.bodyType,
    auth: {
      type: state.authType,
      token: $("#auth-token").value,
      username: $("#auth-username").value,
      password: $("#auth-password").value,
    },
  };
}

function loadSpec(spec) {
  $("#method").value = spec.method || "GET";
  $("#url").value = spec.url || "";
  state.params = [];
  syncParamsFromUrl();
  if (spec.params?.length) {
    state.params.push(...spec.params.map(([key, value]) => ({ key, value, enabled: true })));
    syncUrlFromParams();
    renderKv("params");
  }
  state.headers = (spec.headers || []).map((h) =>
    Array.isArray(h) ? { key: h[0], value: h[1], enabled: true } : h);
  renderKv("headers");
  $("#body").value = spec.body || "";
  setBodyType(spec.body_type || "none");
  const auth = spec.auth || {};
  $("#auth-token").value = auth.token || "";
  $("#auth-username").value = auth.username || "";
  $("#auth-password").value = auth.password || "";
  setAuthType(auth.type || "none");
  updateMethodColor();
}

function updateMethodColor() {
  const sel = $("#method");
  sel.className = `m-${sel.value}`;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { "X-Dev-Requests": "1", "Content-Type": "application/json", ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`Servidor respondeu ${res.status}`);
  return res.json();
}

async function sendRequest() {
  if (state.abort) return;
  const spec = collectSpec();
  if (!spec.url) {
    $("#url").focus();
    toast("Digite uma URL");
    return;
  }
  if (!validateBody()) {
    activateTab("req", "body");
    toast("Corrija o JSON do body antes de enviar");
    return;
  }

  state.abort = new AbortController();
  setLoading(true);
  try {
    const resp = await api("/api/send", {
      method: "POST",
      body: JSON.stringify({ request: spec, ...(projectsUI?.context() ?? {}) }),
      signal: state.abort.signal,
    });
    showResponse(resp);
    await loadHistory();
    state.activeHistory = 0;
    renderHistory();
  } catch (e) {
    if (e.name === "AbortError") toast("Requisição cancelada");
    else showResponse({ error: `Não foi possível falar com o servidor local: ${e.message}` });
  } finally {
    state.abort = null;
    setLoading(false);
  }
}

function setLoading(on) {
  $("#resp-loading").classList.toggle("show", on);
  $("#resp-placeholder").classList.add("hide");
  $("#send").disabled = on;
}

function showResponse(resp) {
  state.lastResponse = resp;
  const pane = $(".response");
  pane.classList.add("has-response");
  $("#resp-placeholder").classList.add("hide");

  const pill = $("#resp-pill");
  pill.className = `pill ${statusClass(resp.status, resp.error)}`;
  $("#resp-status").classList.add("show");

  const errBox = $("#resp-error");
  if (resp.error) {
    showUnresolved(resp.unresolved);
    pill.textContent = "Erro";
    $("#resp-time").textContent = "";
    $("#resp-size").textContent = "";
    errBox.textContent = resp.error;
    errBox.classList.add("show");
    $("#resp-body").innerHTML = "";
    destroyGraph();
    $("#resp-headers").innerHTML = "";
    $("#count-resp-headers").textContent = "";
    pane.classList.remove("has-response");
    applySearch();
    return;
  }

  errBox.classList.remove("show");
  showUnresolved(resp.unresolved);
  pill.textContent = `${resp.status} ${resp.reason}`;
  $("#resp-time").textContent = formatTime(resp.elapsed_ms);
  $("#resp-size").textContent = formatSize(resp.size_bytes);
  renderResponseBody();

  $("#resp-headers").innerHTML = resp.headers
    .map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`)
    .join("");
  $("#count-resp-headers").textContent = resp.headers.length || "";
  applySearch();
}

function showUnresolved(names) {
  const warn = $("#resp-warn");
  warn.hidden = !names?.length;
  if (names?.length) {
    warn.textContent = `⚠ não definidas: ${names.map((n) => `{{${n}}}`).join(", ")}`;
    warn.title = "Essas variáveis não existem no ambiente ativo nem nas globais e foram enviadas como texto.";
  }
}

function resetResponse() {
  showUnresolved([]);
  state.lastResponse = null;
  $(".response").classList.remove("has-response");
  $("#resp-status").classList.remove("show");
  $("#resp-error").classList.remove("show");
  $("#resp-body").innerHTML = "";
  destroyGraph();
  $("#resp-headers").innerHTML = "";
  $("#count-resp-headers").textContent = "";
  $("#resp-placeholder").classList.remove("hide");
  applySearch();
}

function parseJson(text) {
  try { return { ok: true, value: JSON.parse(text) }; } catch { return { ok: false }; }
}

function destroyGraph() {
  state.graph?.destroy();
  state.graph = null;
  $("#resp-graph").hidden = true;
  $("#resp-body").hidden = false;
  $("[data-panel='resp:body']").classList.remove("graph-mode");
}

function renderResponseBody() {
  const resp = state.lastResponse;
  if (!resp || resp.error) return;
  const out = $("#resp-body");
  const text = resp.body_text;
  const json = text ? parseJson(text) : { ok: false };

  const graphBtn = $("#view-mode button[data-value='graph']");
  graphBtn.disabled = !json.ok;
  graphBtn.title = json.ok ? "Ver o JSON como diagrama" : "A resposta não é JSON";
  const mode = state.viewMode === "graph" && !json.ok ? "pretty" : state.viewMode;
  setSegmented("view-mode", mode);

  destroyGraph();
  if (!text) {
    out.innerHTML = `<span style="color:var(--muted)">(resposta sem body)</span>`;
    return;
  }
  if (mode === "graph") {
    out.hidden = true;
    $("[data-panel='resp:body']").classList.add("graph-mode");
    const container = $("#resp-graph");
    container.hidden = false;
    state.graph = ReqGraph.render(container, json.value, {
      // Em tela cheia o gráfico cobre a página; a barra de busca vai junto para dentro dele.
      onFullscreen: (on, bar) => {
        const search = $("#resp-search");
        if (on) bar.after(search);
        else $(".tabs[data-tabs='resp']").after(search);
      },
      onCopyPath: async (path) => {
        try {
          await navigator.clipboard.writeText(path);
          toast(`Caminho copiado: ${path}`);
        } catch {
          toast("Não foi possível copiar");
        }
      },
    });
    applySearch();
    return;
  }
  out.innerHTML = mode === "pretty" && json.ok
    ? highlightJson(JSON.stringify(json.value, null, 2))
    : escapeHtml(text);
  applySearch();
}

function prettyBodyText() {
  const resp = state.lastResponse;
  if (!resp || resp.error) return "";
  if (state.viewMode !== "raw") {
    try { return JSON.stringify(JSON.parse(resp.body_text), null, 2); } catch { /* texto puro */ }
  }
  return resp.body_text;
}

// ---------- busca na resposta ----------

function activeRespTab() {
  return $(".tabs[data-tabs='resp'] button[data-tab].active")?.dataset.tab ?? "body";
}

// Refaz os destaques para o termo atual na aba visível.
function applySearch({ keepIndex = false } = {}) {
  const sr = state.search;
  const input = $("#resp-search-input");
  const body = $("#resp-body");
  const rows = $$("#resp-headers tr");
  ReqSearch.clearHighlights(body);
  rows.forEach((tr) => { ReqSearch.clearHighlights(tr); tr.hidden = false; });

  const graphMode = activeRespTab() === "body" && !!state.graph;
  input.placeholder = graphMode ? "Buscar no gráfico (chaves, valores e arestas)" : "Buscar na resposta";

  let total = 0;
  let capped = false;
  if (graphMode) {
    ({ total, capped } = state.graph.search(sr.query, ReqSearch.MAX_HITS));
  } else if (sr.query && state.lastResponse && !state.lastResponse.error) {
    if (activeRespTab() === "body") {
      ({ total, capped } = ReqSearch.highlightMatches(body, sr.query));
    } else {
      // Célula por célula, para um termo não "atravessar" nome e valor.
      for (const tr of rows) {
        let found = 0;
        for (const td of tr.cells) {
          const r = ReqSearch.highlightMatches(td, sr.query, ReqSearch.MAX_HITS - total - found);
          found += r.total;
          capped ||= r.capped;
        }
        tr.hidden = !found;
        total += found;
      }
      // Cada célula numera as próprias ocorrências; renumera na ordem do documento.
      let n = -1;
      let last = null;
      $$("#resp-headers mark.hit").forEach((m) => {
        const key = `${m.closest("td").cellIndex}:${m.closest("tr").rowIndex}:${m.dataset.hit}`;
        if (key !== last) n++;
        last = key;
        m.dataset.hit = n;
      });
    }
  }
  sr.total = total;
  sr.index = keepIndex && sr.index < total ? sr.index : 0;
  const count = $("#resp-search-count");
  count.textContent = !sr.query ? "" : total ? `${sr.index + 1}/${total}${capped ? "+" : ""}` : "0 resultados";
  count.classList.toggle("none", !!sr.query && !total);
  $("#resp-search-prev").disabled = $("#resp-search-next").disabled = total < 2;
  goToHit(sr.index);
}

function goToHit(index) {
  const sr = state.search;
  const root = $(".resp-content");
  $$("mark.hit.current", root).forEach((m) => m.classList.remove("current"));
  if (!sr.total) return;
  sr.index = (index + sr.total) % sr.total;
  if (activeRespTab() === "body" && state.graph) state.graph.goTo(sr.index);
  const target = $$(`mark.hit[data-hit="${sr.index}"]`, root);
  target.forEach((m) => m.classList.add("current"));
  target[0]?.scrollIntoView({ block: "center" });
  const count = $("#resp-search-count");
  count.textContent = count.textContent.replace(/^\d+/, String(sr.index + 1));
}

function setupSearch() {
  const input = $("#resp-search-input");
  input.addEventListener("input", () => {
    clearTimeout(state.search.timer);
    state.search.timer = setTimeout(() => {
      state.search.query = input.value;
      applySearch();
    }, 120);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      clearTimeout(state.search.timer);
      if (state.search.query !== input.value) {
        state.search.query = input.value;
        applySearch();
      } else {
        goToHit(state.search.index + (e.shiftKey ? -1 : 1));
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      // O primeiro Esc só limpa a busca; não sai da tela cheia do gráfico.
      e.stopPropagation();
      input.value = "";
      state.search.query = "";
      applySearch();
      input.blur();
    }
  });
  $("#resp-search-prev").addEventListener("click", () => goToHit(state.search.index - 1));
  $("#resp-search-next").addEventListener("click", () => goToHit(state.search.index + 1));
}

// ---------- histórico ----------

async function loadHistory() {
  try {
    state.history = await api("/api/history");
  } catch {
    state.history = [];
  }
  renderHistory();
}

function renderHistory() {
  const filter = $("#history-search").value.trim().toLowerCase();
  const list = $("#history");
  list.innerHTML = "";
  state.history.forEach((entry, i) => {
    const req = entry.request;
    if (filter && !`${req.method} ${req.url}`.toLowerCase().includes(filter)) return;
    let host = "", path = req.url;
    try {
      const u = new URL(req.url.includes("://") ? req.url : `http://${req.url}`);
      host = u.host;
      path = u.pathname + u.search;
    } catch { /* URL inválida: mostra como veio */ }
    const li = document.createElement("li");
    if (i === state.activeHistory) li.classList.add("active");
    li.title = `${req.method} ${req.url}`;
    li.innerHTML = `
      <span class="method-tag m-${escapeHtml(req.method)}">${escapeHtml(req.method)}</span>
      <span class="h-url">${escapeHtml(path || "/")}<span class="h-host">${escapeHtml(host)}</span></span>
      <span class="h-status ${statusClass(entry.status, entry.error)}">${entry.error ? "ERR" : entry.status}</span>`;
    li.addEventListener("click", async () => {
      if (projectsUI && !(await projectsUI.confirmDiscard())) return;
      projectsUI?.detach();
      state.activeHistory = i;
      loadSpec(req);
      saveDraft();
      renderHistory();
      $("#url").focus();
    });
    list.appendChild(li);
  });
  $("#history-empty").style.display = state.history.length ? "none" : "";
}

// ---------- rascunho e tema ----------

function saveDraft() {
  const spec = collectSpec();
  spec.headers = state.headers;
  spec.disabledParams = state.params.filter((p) => !p.enabled);
  storageSet(DRAFT_KEY, JSON.stringify(spec));
  projectsUI?.refresh();
}

function restoreDraft() {
  try {
    const raw = storageGet(DRAFT_KEY);
    if (!raw) return false;
    const spec = JSON.parse(raw);
    loadSpec(spec);
    if (spec.disabledParams?.length) {
      state.params.push(...spec.disabledParams);
      renderKv("params");
    }
    return true;
  } catch {
    return false;
  }
}

function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  const dark = theme ? theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  $("#theme-toggle").textContent = dark ? "☀" : "☾";
}

// ---------- inicialização ----------

function init() {
  $("#send-kbd").textContent = SEND_SHORTCUT;
  $("#placeholder-kbd").textContent = SEND_SHORTCUT;

  applyTheme(storageGet(THEME_KEY));
  $("#theme-toggle").addEventListener("click", () => {
    const dark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === "dark"
      : matchMedia("(prefers-color-scheme: dark)").matches;
    const next = dark ? "light" : "dark";
    storageSet(THEME_KEY, next);
    applyTheme(next);
  });

  setupTabs();
  setupSearch();
  setupSegmented("body-type", (v) => { setBodyType(v); saveDraft(); });
  setupSegmented("auth-type", (v) => { setAuthType(v); saveDraft(); });
  state.viewMode = ["pretty", "raw", "graph"].includes(storageGet(VIEW_KEY)) ? storageGet(VIEW_KEY) : "pretty";
  setSegmented("view-mode", state.viewMode);
  setupSegmented("view-mode", (v) => {
    state.viewMode = v;
    storageSet(VIEW_KEY, v);
    renderResponseBody();
  });

  $("#urlbar").addEventListener("submit", (e) => { e.preventDefault(); sendRequest(); });
  $("#url").addEventListener("input", () => { syncParamsFromUrl(); saveDraft(); });
  $("#method").addEventListener("change", () => {
    updateMethodColor();
    if (["POST", "PUT", "PATCH"].includes($("#method").value) && state.bodyType === "none") {
      setBodyType("json");
    }
    saveDraft();
  });
  $("#body").addEventListener("input", () => { validateBody(); saveDraft(); });
  $("#body").addEventListener("keydown", (e) => {
    if (e.key === "Tab") {
      e.preventDefault();
      document.execCommand("insertText", false, "  ");
    }
  });
  $$("#auth-token, #auth-username, #auth-password").forEach((el) => el.addEventListener("input", saveDraft));
  $$(".reveal").forEach((btn) => btn.addEventListener("click", () => {
    const input = btn.previousElementSibling;
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    btn.textContent = show ? "ocultar" : "mostrar";
  }));

  $("#format-json").addEventListener("click", () => {
    try {
      $("#body").value = JSON.stringify(JSON.parse($("#body").value), null, 2);
      validateBody();
      saveDraft();
    } catch {
      toast("O body não é um JSON válido");
    }
  });

  $("#copy-body").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(prettyBodyText());
      toast("Resposta copiada");
    } catch {
      toast("Não foi possível copiar");
    }
  });

  $("#cancel").addEventListener("click", () => state.abort?.abort());

  $("#new-request").addEventListener("click", async () => {
    if (projectsUI && !(await projectsUI.confirmDiscard())) return;
    projectsUI?.detach();
    state.activeHistory = -1;
    state.abort?.abort();
    loadSpec({ method: "GET", url: "" });
    resetResponse();
    saveDraft();
    renderHistory();
    $("#url").focus();
  });

  $("#history-search").addEventListener("input", renderHistory);
  $("#clear-history").addEventListener("click", async () => {
    if (!state.history.length) return;
    await api("/api/history", { method: "DELETE" });
    state.activeHistory = -1;
    await loadHistory();
    toast("Histórico limpo");
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      sendRequest();
    }
    if (e.key.toLowerCase() === "s" && (e.metaKey || e.ctrlKey) && !e.shiftKey) {
      e.preventDefault();
      if ($("#dialog").hidden) projectsUI?.save();
    }
    // Um segundo ⌘F com a busca já focada cai na busca nativa do navegador.
    const search = $("#resp-search-input");
    if (e.key.toLowerCase() === "f" && (e.metaKey || e.ctrlKey) && !e.shiftKey &&
        state.lastResponse && document.activeElement !== search) {
      e.preventDefault();
      search.focus();
      search.select();
    }
  });

  const historySection = $("#history-section");
  historySection.classList.toggle("collapsed", storageGet(HISTORY_COLLAPSED_KEY) === "1");
  $("#history-head").addEventListener("click", (e) => {
    if (e.target.closest("button")) return;
    const collapsed = historySection.classList.toggle("collapsed");
    storageSet(HISTORY_COLLAPSED_KEY, collapsed ? "1" : "0");
  });

  projectsUI = ReqProjects.createProjectsUI({
    api,
    toast,
    collectSpec,
    escapeHtml,
    storageGet,
    storageSet,
    loadSpec: (spec) => {
      loadSpec(spec);
      saveDraft();
    },
    onOpen: () => {
      state.activeHistory = -1;
      resetResponse();
      renderHistory();
    },
    onVariablesChanged: () => validateBody(),
  });
  projectsUI.init().catch((e) => toast(`Erro ao carregar projetos: ${e.message}`));

  if (!restoreDraft()) loadSpec({ method: "GET", url: "" });
  activateTab("resp", "body");
  loadHistory();
  $("#url").focus();
}

init();
