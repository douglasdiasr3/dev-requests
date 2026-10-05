"use strict";

// Projetos (requisições salvas) e variáveis de ambiente.
// As funções puras de variáveis ficam no topo e são testadas no Node.
(function () {
  const VAR_RE = /\{\{\s*([A-Za-z0-9_.\-]+)\s*\}\}/g;
  const MAX_PASSES = 3;
  const SAVE_DELAY = 400;
  const OPEN_KEY = "reqresp:open";

  // ---------- funções puras ----------

  // Mesma regra do backend (variables.py): até 3 passadas, desconhecidas ficam como estão.
  function resolveText(text, vars) {
    let out = text;
    for (let i = 0; i < MAX_PASSES; i++) {
      const next = out.replace(VAR_RE, (m, name) => (Object.hasOwn(vars, name) ? vars[name] : m));
      if (next === out) break;
      out = next;
    }
    const missing = [...new Set([...out.matchAll(VAR_RE)].map((m) => m[1]).filter((n) => !Object.hasOwn(vars, n)))];
    return { text: out, missing };
  }

  function findVariables(text) {
    return [...text.matchAll(VAR_RE)].map((m) => ({ name: m[1], start: m.index, end: m.index + m[0].length }));
  }

  // Ambiente sobrescreve globais; variáveis desabilitadas ou sem nome são ignoradas.
  function buildVariables(...lists) {
    const values = {};
    const secrets = new Set();
    for (const list of lists) {
      for (const v of list || []) {
        if (!v.enabled || !v.key) continue;
        values[v.key] = v.value;
        if (v.secret) secrets.add(v.key);
        else secrets.delete(v.key);
      }
    }
    return { values, secrets };
  }

  // Para validar um body JSON que contém {{variáveis}}: resolve as conhecidas e
  // troca as restantes por 0, que é válido tanto dentro quanto fora de aspas.
  function jsonForValidation(text, vars) {
    return resolveText(text, vars).text.replace(VAR_RE, "0");
  }

  function newId() {
    return (crypto.randomUUID?.() ?? Math.random().toString(16).slice(2) + Date.now().toString(16))
      .replace(/-/g, "").slice(0, 12);
  }

  function comparable(spec) {
    return JSON.stringify([
      spec.method, spec.url, spec.headers || [], spec.body || "", spec.body_type || "none",
      [spec.auth?.type || "none", spec.auth?.token || "", spec.auth?.username || "", spec.auth?.password || ""],
    ]);
  }

  // ---------- diálogo (substitui prompt/confirm nativos) ----------

  function showDialog({ title, message = "", details = [], input = false, value = "", confirmLabel = "OK", danger = false, cancel = true }) {
    return new Promise((resolve) => {
      const root = document.querySelector("#dialog");
      root.querySelector(".dialog-title").textContent = title;
      const msg = root.querySelector(".dialog-message");
      msg.textContent = message;
      msg.hidden = !message;
      const list = root.querySelector(".dialog-details");
      list.replaceChildren(...details.map((d) => Object.assign(document.createElement("li"), { textContent: d })));
      list.hidden = !details.length;
      root.querySelector(".dialog-cancel").hidden = !cancel;
      const field = root.querySelector(".dialog-input");
      field.hidden = !input;
      field.value = value;
      const ok = root.querySelector(".dialog-confirm");
      ok.textContent = confirmLabel;
      ok.className = `dialog-confirm ${danger ? "danger" : "primary"}`;
      root.hidden = false;
      (input ? field : ok).focus();
      if (input) field.select();

      function close(result) {
        root.hidden = true;
        ok.removeEventListener("click", onOk);
        root.removeEventListener("click", onBackdrop);
        root.removeEventListener("keydown", onKey);
        root.querySelector(".dialog-cancel").removeEventListener("click", onCancel);
        resolve(result);
      }
      function onOk() {
        if (input && !field.value.trim()) { field.focus(); return; }
        close(input ? field.value.trim() : true);
      }
      function onCancel() { close(null); }
      function onBackdrop(e) { if (e.target === root) close(null); }
      function onKey(e) {
        if (e.key === "Escape") { e.stopPropagation(); close(null); }
        if (e.key === "Enter") { e.preventDefault(); onOk(); }
      }
      ok.addEventListener("click", onOk);
      root.querySelector(".dialog-cancel").addEventListener("click", onCancel);
      root.addEventListener("click", onBackdrop);
      root.addEventListener("keydown", onKey);
    });
  }

  // ---------- interface ----------

  function createProjectsUI(ctx) {
    const { api, toast, collectSpec, loadSpec, escapeHtml, storageGet, storageSet } = ctx;
    const $ = (sel, root = document) => root.querySelector(sel);

    const s = {
      projects: [],
      project: null,
      globals: [],
      savedId: null,
      editing: "globals", // ambiente aberto no modal de variáveis ("globals" ou id)
      saveTimer: null,
      pendingSave: null,
      globalsTimer: null,
      dragIndex: null,
    };

    // ----- persistência -----

    function persistProject(immediate = false) {
      clearTimeout(s.saveTimer);
      const project = s.project;
      if (!project) return Promise.resolve();
      const run = () => {
        s.pendingSave = null;
        return api(`/api/projects/${project.id}`, { method: "PUT", body: JSON.stringify(project) })
          .catch((e) => toast(`Erro ao salvar o projeto: ${e.message}`));
      };
      if (immediate) return run();
      s.pendingSave = run;
      s.saveTimer = setTimeout(run, SAVE_DELAY);
      return Promise.resolve();
    }

    // Grava na hora um salvamento que ainda estava esperando o debounce.
    function flushProject() {
      clearTimeout(s.saveTimer);
      return s.pendingSave ? s.pendingSave() : Promise.resolve();
    }

    function persistGlobals() {
      clearTimeout(s.globalsTimer);
      s.globalsPending = true;
      s.globalsTimer = setTimeout(() => {
        s.globalsPending = false;
        api("/api/globals", { method: "PUT", body: JSON.stringify(s.globals) })
          .catch((e) => toast(`Erro ao salvar variáveis globais: ${e.message}`));
      }, SAVE_DELAY);
    }

    function rememberOpen() {
      storageSet(OPEN_KEY, JSON.stringify({ projectId: s.project?.id ?? null, savedId: s.savedId }));
    }

    // ----- variáveis -----

    function activeEnv() {
      return s.project?.environments.find((e) => e.id === s.project.active_env_id) ?? null;
    }

    function variables() {
      return buildVariables(s.globals, activeEnv()?.variables);
    }

    function renderPreview() {
      const el = $("#url-preview");
      const url = $("#url").value;
      const vars = findVariables(url);
      if (!vars.length) {
        el.hidden = true;
        return;
      }
      const { values, secrets } = variables();
      let html = "";
      let pos = 0;
      for (const v of vars) {
        html += escapeHtml(url.slice(pos, v.start));
        if (Object.hasOwn(values, v.name)) {
          const shown = secrets.has(v.name) ? "••••••" : resolveText(values[v.name], values).text;
          html += `<mark class="var-ok" title="{{${escapeHtml(v.name)}}}">${escapeHtml(shown)}</mark>`;
        } else {
          html += `<mark class="var-missing" title="Variável não definida no ambiente atual nem nas globais">${escapeHtml(url.slice(v.start, v.end))}</mark>`;
        }
        pos = v.end;
      }
      html += escapeHtml(url.slice(pos));
      const env = activeEnv();
      el.innerHTML = `<span class="preview-label">${escapeHtml(env ? env.name : "globais")} →</span> ${html}`;
      el.hidden = false;
    }

    // ----- requisições salvas -----

    function savedRequest() {
      return s.project?.requests.find((r) => r.id === s.savedId) ?? null;
    }

    function isDirty() {
      const saved = savedRequest();
      return saved ? comparable(collectSpec()) !== comparable(saved.request) : false;
    }

    function refresh() {
      const saved = savedRequest();
      if (!saved && s.savedId) s.savedId = null;
      const dirty = isDirty();
      $("#save").classList.toggle("dirty", dirty);
      $("#save").title = saved
        ? (dirty ? `Salvar alterações em "${saved.name}"` : `"${saved.name}" está salva`)
        : "Salvar no projeto";
      $("#current-name").textContent = saved ? saved.name : "";
      $("#current-name").hidden = !saved;
      $$("#saved-list li").forEach((li) => {
        li.classList.toggle("active", li.dataset.id === s.savedId);
        li.classList.toggle("dirty", li.dataset.id === s.savedId && dirty);
      });
      renderPreview();
      rememberOpen();
    }

    const $$ = (sel) => [...document.querySelectorAll(sel)];

    function defaultName(spec) {
      // "{{base}}/users/1?x=1" -> "GET /users/1"
      const path = spec.url.split(/[?#]/)[0].replace(/^[a-z]+:\/\/[^/]+/i, "").replace(/^\{\{\s*[\w.\-]+\s*\}\}/, "");
      return `${spec.method} ${path || "/"}`.slice(0, 60);
    }

    async function save() {
      if (!s.project) return;
      const spec = collectSpec();
      const saved = savedRequest();
      if (saved) {
        saved.request = spec;
        await persistProject(true);
        toast(`"${saved.name}" salva`);
      } else {
        const name = await showDialog({
          title: "Salvar requisição",
          message: `No projeto "${s.project.name}"`,
          input: true,
          value: defaultName(spec),
          confirmLabel: "Salvar",
        });
        if (!name) return;
        const entry = { id: newId(), name, request: spec };
        s.project.requests.push(entry);
        s.savedId = entry.id;
        await persistProject(true);
        toast(`"${name}" salva em ${s.project.name}`);
      }
      renderSaved();
      refresh();
    }

    async function confirmDiscard() {
      if (!isDirty()) return true;
      return !!(await showDialog({
        title: "Descartar alterações?",
        message: `"${savedRequest().name}" tem alterações que não foram salvas.`,
        confirmLabel: "Descartar",
        danger: true,
      }));
    }

    function detach() {
      s.savedId = null;
      refresh();
    }

    async function open(id) {
      if (id === s.savedId) return;
      if (!(await confirmDiscard())) return;
      const entry = s.project.requests.find((r) => r.id === id);
      if (!entry) return;
      s.savedId = id;
      loadSpec(entry.request);
      ctx.onOpen?.();
      refresh();
    }

    function renderSaved() {
      const list = $("#saved-list");
      list.innerHTML = "";
      const requests = s.project?.requests ?? [];
      $("#saved-count").textContent = requests.length || "";
      $("#saved-empty").hidden = requests.length > 0;
      requests.forEach((r, i) => {
        const li = document.createElement("li");
        li.dataset.id = r.id;
        li.draggable = true;
        li.title = `${r.request.method} ${r.request.url}`;
        li.innerHTML = `
          <span class="method-tag m-${escapeHtml(r.request.method)}">${escapeHtml(r.request.method)}</span>
          <span class="s-name">${escapeHtml(r.name)}<span class="s-dirty" aria-label="alterações não salvas">●</span></span>
          <span class="s-actions">
            <button type="button" data-act="rename" title="Renomear">✎</button>
            <button type="button" data-act="duplicate" title="Duplicar">⧉</button>
            <button type="button" data-act="delete" title="Excluir">✕</button>
          </span>`;
        li.addEventListener("click", (e) => {
          const act = e.target.closest("button")?.dataset.act;
          if (act) itemAction(act, r);
          else open(r.id);
        });
        li.addEventListener("dragstart", (e) => {
          s.dragIndex = i;
          li.classList.add("dragging");
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", r.id);
        });
        li.addEventListener("dragend", () => {
          li.classList.remove("dragging");
          $$("#saved-list li").forEach((x) => x.classList.remove("drop-before", "drop-after"));
        });
        li.addEventListener("dragover", (e) => {
          if (s.dragIndex === null) return;
          e.preventDefault();
          const after = e.offsetY > li.offsetHeight / 2;
          li.classList.toggle("drop-before", !after);
          li.classList.toggle("drop-after", after);
        });
        li.addEventListener("dragleave", () => li.classList.remove("drop-before", "drop-after"));
        li.addEventListener("drop", (e) => {
          e.preventDefault();
          if (s.dragIndex === null) return;
          const after = li.classList.contains("drop-after");
          const items = s.project.requests;
          const [moved] = items.splice(s.dragIndex, 1);
          let target = items.indexOf(r);
          if (target === -1) target = s.dragIndex; // soltou sobre si mesmo
          items.splice(after ? target + 1 : target, 0, moved);
          s.dragIndex = null;
          persistProject(true);
          renderSaved();
          refresh();
        });
        list.appendChild(li);
      });
    }

    async function itemAction(act, r) {
      if (act === "rename") {
        const name = await showDialog({ title: "Renomear requisição", input: true, value: r.name, confirmLabel: "Renomear" });
        if (!name) return;
        r.name = name;
      } else if (act === "duplicate") {
        const copy = { id: newId(), name: `${r.name} (cópia)`, request: structuredClone(r.request) };
        s.project.requests.splice(s.project.requests.indexOf(r) + 1, 0, copy);
      } else if (act === "delete") {
        const ok = await showDialog({
          title: "Excluir requisição?",
          message: `"${r.name}" será removida do projeto ${s.project.name}.`,
          confirmLabel: "Excluir",
          danger: true,
        });
        if (!ok) return;
        s.project.requests = s.project.requests.filter((x) => x !== r);
        if (s.savedId === r.id) s.savedId = null;
      }
      await persistProject(true);
      renderSaved();
      refresh();
    }

    // ----- projetos -----

    function renderProjectSelect() {
      const sel = $("#project-select");
      sel.innerHTML = s.projects
        .map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`)
        .join("");
      if (s.project) sel.value = s.project.id;
    }

    function renderEnvSelect() {
      const sel = $("#env-select");
      const envs = s.project?.environments ?? [];
      sel.innerHTML = `<option value="">Sem ambiente</option>` +
        envs.map((e) => `<option value="${escapeHtml(e.id)}">${escapeHtml(e.name)}</option>`).join("");
      sel.value = s.project?.active_env_id ?? "";
      sel.classList.toggle("no-env", !sel.value);
    }

    async function loadProjects() {
      s.projects = await api("/api/projects");
    }

    async function selectProject(id, { keepSaved = false } = {}) {
      await flushProject();
      try {
        s.project = await api(`/api/projects/${id}`);
      } catch {
        s.project = await api(`/api/projects/${s.projects[0].id}`);
      }
      if (!keepSaved) s.savedId = null;
      renderProjectSelect();
      renderEnvSelect();
      renderSaved();
      refresh();
      ctx.onVariablesChanged?.();
    }

    const EXPORTS = {
      reqresp: { ext: "reqresp.json", type: "application/json", label: "reqresp" },
      "insomnia-v5": { ext: "insomnia.yaml", type: "application/yaml", label: "Insomnia (YAML v5)" },
      "insomnia-v4": { ext: "insomnia.json", type: "application/json", label: "Insomnia (JSON v4)" },
    };

    async function exportProject(format) {
      const info = EXPORTS[format] ?? EXPORTS.reqresp;
      const res = await fetch(`/api/projects/${s.project.id}/export?format=${encodeURIComponent(format)}`, {
        headers: { "X-ReqResp": "1" },
      });
      if (!res.ok) throw new Error(`Servidor respondeu ${res.status}`);
      let text = await res.text();
      if (info.type === "application/json") text = JSON.stringify(JSON.parse(text), null, 2);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([text], { type: info.type }));
      a.download = `${s.project.name.replace(/[^\w\- ]+/g, "_")}.${info.ext}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      toast(`Exportado para ${info.label} (variáveis secretas vão vazias)`);
    }

    async function projectAction(act, format) {
      if (act === "new") {
        const name = await showDialog({ title: "Novo projeto", input: true, confirmLabel: "Criar" });
        if (!name) return;
        if (!(await confirmDiscard())) return;
        const created = await api("/api/projects", { method: "POST", body: JSON.stringify({ name }) });
        await loadProjects();
        await selectProject(created.id);
        toast(`Projeto "${name}" criado`);
      } else if (act === "rename") {
        const name = await showDialog({ title: "Renomear projeto", input: true, value: s.project.name, confirmLabel: "Renomear" });
        if (!name) return;
        s.project.name = name;
        await persistProject(true);
        await loadProjects();
        renderProjectSelect();
      } else if (act === "export") {
        await exportProject(format).catch((e) => toast(`Não foi possível exportar: ${e.message}`));
      } else if (act === "import") {
        $("#import-file").click();
      } else if (act === "delete") {
        const ok = await showDialog({
          title: "Excluir projeto?",
          message: `"${s.project.name}" e suas ${s.project.requests.length} requisições salvas serão apagados. Não dá para desfazer.`,
          confirmLabel: "Excluir projeto",
          danger: true,
        });
        if (!ok) return;
        await api(`/api/projects/${s.project.id}`, { method: "DELETE" });
        await loadProjects();
        await selectProject(s.projects[0].id);
        toast("Projeto excluído");
      }
    }

    const FORMAT_LABELS = { reqresp: "reqresp", "insomnia-v4": "Insomnia (JSON v4)", "insomnia-v5": "Insomnia (YAML v5)" };

    async function importFile(file) {
      if (!(await confirmDiscard())) return;
      let result;
      try {
        const res = await fetch("/api/import", {
          method: "POST",
          headers: { "X-ReqResp": "1", "Content-Type": "text/plain; charset=utf-8" },
          body: await file.text(),
        });
        result = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(result.detail || `servidor respondeu ${res.status}`);
      } catch (e) {
        await showDialog({ title: "Não foi possível importar", message: `${file.name}: ${e.message}`, confirmLabel: "OK", cancel: false });
        return;
      }
      await loadProjects();
      await selectProject(result.projects[0].id);
      const names = result.projects.map((p) => `"${p.name}" (${p.request_count} requisições)`).join(", ");
      const summary = `Formato ${FORMAT_LABELS[result.format] ?? result.format}: ${names}.`;
      if (result.warnings.length) {
        await showDialog({
          title: "Importado com avisos",
          message: summary,
          details: result.warnings,
          confirmLabel: "OK",
          cancel: false,
        });
      } else {
        toast(`Importado: ${names}`);
      }
    }

    // ----- modal de variáveis -----

    function editingList() {
      if (s.editing === "globals") return s.globals;
      return s.project.environments.find((e) => e.id === s.editing)?.variables ?? s.globals;
    }

    function onVarsChanged() {
      if (s.editing === "globals") persistGlobals();
      else persistProject();
      refresh();
      ctx.onVariablesChanged?.();
    }

    function renderVarsModal() {
      if (s.editing !== "globals" && !s.project.environments.some((e) => e.id === s.editing)) s.editing = "globals";
      const envList = $("#env-list");
      const item = (id, name, extra = "") =>
        `<li data-id="${escapeHtml(id)}" class="${id === s.editing ? "active" : ""}">${escapeHtml(name)}${extra}</li>`;
      envList.innerHTML =
        item("globals", "Globais", ' <span class="env-badge">todos os projetos</span>') +
        `<li class="env-sep">Ambientes de ${escapeHtml(s.project.name)}</li>` +
        s.project.environments
          .map((e) => item(e.id, e.name, e.id === s.project.active_env_id ? ' <span class="env-badge">ativo</span>' : ""))
          .join("");
      envList.querySelectorAll("li[data-id]").forEach((li) =>
        li.addEventListener("click", () => { s.editing = li.dataset.id; renderVarsModal(); }));

      const isGlobals = s.editing === "globals";
      const env = s.project.environments.find((e) => e.id === s.editing);
      $("#vars-title").textContent = isGlobals ? "Variáveis globais" : `Ambiente: ${env.name}`;
      $("#vars-hint").textContent = isGlobals
        ? "Valem em todos os projetos. Um ambiente com uma variável de mesmo nome tem prioridade."
        : "Use como {{nome}} na URL, params, headers, body e auth.";
      $$(".env-only").forEach((b) => { b.hidden = isGlobals; });

      const rows = $("#vars-rows");
      rows.innerHTML = "";
      const list = editingList();
      list.forEach((v) => rows.appendChild(varRow(v, list)));
      rows.appendChild(varRow(null, list));
    }

    function varRow(v, list) {
      const el = document.createElement("div");
      el.className = "var-row" + (v ? (v.enabled ? "" : " disabled") : " placeholder-row");
      el.innerHTML = `
        <input type="checkbox" checked title="Ativar/desativar">
        <input type="text" class="k" spellcheck="false" placeholder="nome">
        <span class="secret"><input type="text" class="v" spellcheck="false" placeholder="valor"><button type="button" class="reveal" tabindex="-1" hidden>mostrar</button></span>
        <button type="button" class="lock" title="Marcar como secreta (fica mascarada e vai vazia ao exportar)">🔓</button>
        <button type="button" class="remove" title="Remover">×</button>`;
      const [check, k] = el.querySelectorAll("input");
      const val = el.querySelector(".v");
      const reveal = el.querySelector(".reveal");
      const lock = el.querySelector(".lock");

      function paintSecret() {
        const secret = !!v?.secret;
        lock.textContent = secret ? "🔒" : "🔓";
        lock.classList.toggle("on", secret);
        val.type = secret ? "password" : "text";
        reveal.hidden = !secret;
        reveal.textContent = "mostrar";
      }
      if (v) {
        check.checked = v.enabled;
        k.value = v.key;
        val.value = v.value;
      }
      paintSecret();

      const ensure = () => {
        if (v) return;
        v = { key: "", value: "", secret: false, enabled: true };
        list.push(v);
        el.classList.remove("placeholder-row");
        el.after(varRow(null, list));
      };
      k.addEventListener("input", () => { ensure(); v.key = k.value.trim(); onVarsChanged(); });
      val.addEventListener("input", () => { ensure(); v.value = val.value; onVarsChanged(); });
      check.addEventListener("change", () => {
        if (!v) return;
        v.enabled = check.checked;
        el.classList.toggle("disabled", !v.enabled);
        onVarsChanged();
      });
      lock.addEventListener("click", () => {
        ensure();
        v.secret = !v.secret;
        paintSecret();
        onVarsChanged();
      });
      reveal.addEventListener("click", () => {
        const show = val.type === "password";
        val.type = show ? "text" : "password";
        reveal.textContent = show ? "ocultar" : "mostrar";
      });
      el.querySelector(".remove").addEventListener("click", () => {
        if (!v) return;
        list.splice(list.indexOf(v), 1);
        el.remove();
        onVarsChanged();
      });
      return el;
    }

    async function envAction(act) {
      const envs = s.project.environments;
      const env = envs.find((e) => e.id === s.editing);
      if (act === "new") {
        const name = await showDialog({ title: "Novo ambiente", message: "Por exemplo: dev, staging, prod", input: true, confirmLabel: "Criar" });
        if (!name) return;
        const created = { id: newId(), name, variables: [] };
        envs.push(created);
        s.editing = created.id;
        if (!s.project.active_env_id) s.project.active_env_id = created.id;
      } else if (act === "rename" && env) {
        const name = await showDialog({ title: "Renomear ambiente", input: true, value: env.name, confirmLabel: "Renomear" });
        if (!name) return;
        env.name = name;
      } else if (act === "duplicate" && env) {
        const copy = { id: newId(), name: `${env.name} (cópia)`, variables: structuredClone(env.variables) };
        envs.splice(envs.indexOf(env) + 1, 0, copy);
        s.editing = copy.id;
      } else if (act === "activate" && env) {
        s.project.active_env_id = env.id;
      } else if (act === "delete" && env) {
        const ok = await showDialog({
          title: "Excluir ambiente?",
          message: `"${env.name}" e suas ${env.variables.length} variáveis serão apagados.`,
          confirmLabel: "Excluir",
          danger: true,
        });
        if (!ok) return;
        s.project.environments = envs.filter((e) => e !== env);
        if (s.project.active_env_id === env.id) s.project.active_env_id = s.project.environments[0]?.id ?? null;
        s.editing = "globals";
      }
      await persistProject(true);
      renderVarsModal();
      renderEnvSelect();
      refresh();
      ctx.onVariablesChanged?.();
    }

    function openVarsModal() {
      s.editing = s.project.active_env_id ?? "globals";
      renderVarsModal();
      $("#vars-modal").hidden = false;
      $("#vars-modal .k")?.focus();
    }

    function closeVarsModal() {
      $("#vars-modal").hidden = true;
      // Remove variáveis totalmente vazias deixadas pelo caminho.
      const clean = (list) => list.filter((v) => v.key || v.value);
      const before = JSON.stringify([s.globals, s.project.environments]);
      s.globals = clean(s.globals);
      s.project.environments.forEach((e) => { e.variables = clean(e.variables); });
      if (JSON.stringify([s.globals, s.project.environments]) !== before) {
        persistGlobals();
        persistProject();
      }
      refresh();
    }

    // ----- inicialização -----

    async function init() {
      $("#project-select").addEventListener("change", async (e) => {
        const id = e.target.value;
        if (!(await confirmDiscard())) { e.target.value = s.project.id; return; }
        await selectProject(id);
      });
      $("#env-select").addEventListener("change", (e) => {
        s.project.active_env_id = e.target.value || null;
        e.target.classList.toggle("no-env", !e.target.value);
        persistProject(true);
        refresh();
        ctx.onVariablesChanged?.();
      });

      const menu = $("#project-menu");
      $("#project-menu-btn").addEventListener("click", (e) => {
        e.stopPropagation();
        menu.hidden = !menu.hidden;
      });
      document.addEventListener("click", () => { menu.hidden = true; });
      menu.addEventListener("click", (e) => {
        const act = e.target.closest("button")?.dataset.act;
        menu.hidden = true;
        if (act) {
          projectAction(act, e.target.closest("button").dataset.format)
            .catch((err) => toast(`Erro: ${err.message}`));
        }
      });
      $("#import-file").addEventListener("change", (e) => {
        const file = e.target.files[0];
        e.target.value = "";
        if (file) importFile(file);
      });

      // Fechar/recarregar a aba logo após editar não pode perder o que estava no debounce.
      window.addEventListener("pagehide", () => {
        const send = (url, body) => fetch(url, {
          method: "PUT", keepalive: true, body: JSON.stringify(body),
          headers: { "X-ReqResp": "1", "Content-Type": "application/json" },
        });
        if (s.pendingSave && s.project) send(`/api/projects/${s.project.id}`, s.project);
        if (s.globalsPending) send("/api/globals", s.globals);
      });

      $("#save").addEventListener("click", save);
      $("#vars-btn").addEventListener("click", openVarsModal);
      $("#vars-close").addEventListener("click", closeVarsModal);
      $("#vars-modal").addEventListener("click", (e) => { if (e.target.id === "vars-modal") closeVarsModal(); });
      $("#vars-modal").addEventListener("keydown", (e) => {
        if (e.key === "Escape" && $("#dialog").hidden) closeVarsModal();
      });
      document.querySelectorAll("[data-env-act]").forEach((b) =>
        b.addEventListener("click", () => envAction(b.dataset.envAct)));

      $("#saved-head").addEventListener("click", (e) => {
        if (e.target.closest("button")) return;
        $("#saved-section").classList.toggle("collapsed");
      });

      const [projects, globals] = await Promise.all([api("/api/projects"), api("/api/globals")]);
      s.projects = projects;
      s.globals = globals;
      let open = {};
      try { open = JSON.parse(storageGet(OPEN_KEY) || "{}"); } catch { /* sem estado salvo */ }
      const id = s.projects.some((p) => p.id === open.projectId) ? open.projectId : s.projects[0]?.id;
      s.savedId = open.savedId ?? null;
      if (id) await selectProject(id, { keepSaved: true });
    }

    return {
      init,
      refresh,
      save,
      detach,
      confirmDiscard,
      variables,
      context: () => ({ project_id: s.project?.id ?? null, environment_id: s.project?.active_env_id ?? null }),
    };
  }

  const api = { resolveText, findVariables, buildVariables, jsonForValidation, comparable, createProjectsUI, showDialog };
  globalThis.ReqProjects = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
