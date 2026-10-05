"use strict";

// Visualização do JSON como grafo (no estilo do JSON Crack): cada objeto/array
// vira um cartão com seus campos primitivos, e os filhos aninhados viram
// cartões ligados por arestas com o nome da chave.
(function () {
  const CHAR_W = 7.3;
  const ROW_H = 20;
  const HEADER_H = 28;
  const PAD_X = 12;
  const PAD_BOTTOM = 8;
  const MIN_W = 150;
  const MAX_W = 340;
  const COL_GAP = 90;
  const ROW_GAP = 18;
  const VISIBLE_BUDGET = 300;
  const PAGE_SIZE = 100;
  const MIN_SCALE = 0.1;
  const MAX_SCALE = 3;
  const READABLE_SCALE = 0.75;

  // ---------- modelo ----------

  function isContainer(v) {
    return v !== null && typeof v === "object";
  }

  function primitiveType(v) {
    if (typeof v === "string") return "str";
    if (typeof v === "number") return "num";
    return "lit";
  }

  function displayValue(v) {
    return typeof v === "string" ? JSON.stringify(v) : String(v);
  }

  function childPath(path, key, inArray) {
    if (inArray) return `${path}[${key}]`;
    return /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
  }

  function buildGraph(value) {
    const nodes = [];
    const edges = [];

    function visit(val, path, depth, label, parent) {
      const node = {
        id: nodes.length,
        parent,
        path,
        depth,
        label,
        kind: Array.isArray(val) ? "array" : isContainer(val) ? "object" : "value",
        rows: [],
        children: [],
        collapsed: false,
        offset: 0, // filhos visíveis: children.slice(offset, limit)
        limit: PAGE_SIZE,
      };
      nodes.push(node);

      if (node.kind === "value") {
        node.rows.push({ key: null, value: displayValue(val), type: primitiveType(val) });
        return node;
      }

      const entries = node.kind === "array" ? val.map((v, i) => [String(i), v]) : Object.entries(val);
      node.size = entries.length;
      for (const [key, v] of entries) {
        if (isContainer(v)) {
          const edgeLabel = node.kind === "array" ? `[${key}]` : key;
          const child = visit(v, childPath(path, key, node.kind === "array"), depth + 1, edgeLabel, node.id);
          node.children.push(child);
          edges.push({ from: node.id, to: child.id, label: edgeLabel });
        } else {
          node.rows.push({ key, value: displayValue(v), type: primitiveType(v) });
        }
      }
      return node;
    }

    const root = visit(value, "$", 0, null, null);
    return { root, nodes, edges };
  }

  // Recolhe em largura até um orçamento de nós visíveis, para respostas grandes
  // não travarem o navegador. Retorna true se algo foi recolhido.
  function autoCollapse(graph, budget = VISIBLE_BUDGET) {
    if (graph.nodes.length <= budget) return false;
    let visible = 1;
    const queue = [graph.root];
    while (queue.length) {
      const node = queue.shift();
      const shown = Math.min(node.children.length, node.limit);
      if (!shown) continue;
      if (visible + shown > budget) {
        node.collapsed = true;
        continue;
      }
      visible += shown;
      queue.push(...node.children.slice(0, shown));
    }
    return true;
  }

  function setAllCollapsed(graph, collapsed) {
    for (const node of graph.nodes) {
      if (node.children.length) node.collapsed = collapsed && node !== graph.root;
    }
  }

  // ---------- busca ----------

  function rowText(row) {
    return row.key === null ? row.value : `${row.key}: ${row.value}`;
  }

  // Ocorrências na ordem do JSON: { node, row } com row = -1 para o nome da
  // aresta que chega no nó. Procura também em ramos recolhidos e não carregados.
  function findHits(graph, query, limit = Infinity) {
    const hits = [];
    if (!query) return hits;
    const q = query.toLowerCase();
    for (const node of graph.nodes) {
      if (node.label?.toLowerCase().includes(q)) hits.push({ node: node.id, row: -1 });
      node.rows.forEach((r, i) => {
        if (rowText(r).toLowerCase().includes(q)) hits.push({ node: node.id, row: i });
      });
      if (hits.length >= limit) return hits.slice(0, limit);
    }
    return hits;
  }

  // Expande os ancestrais até o nó ficar visível. Se ele estiver fora da
  // janela de filhos carregada, mostra só a página que o contém, para não
  // desenhar milhares de cartões.
  function reveal(graph, id) {
    let node = graph.nodes[id];
    while (node.parent !== null) {
      const parent = graph.nodes[node.parent];
      parent.collapsed = false;
      const index = parent.children.indexOf(node);
      if (index < parent.offset || index >= parent.limit) {
        parent.offset = Math.floor(index / PAGE_SIZE) * PAGE_SIZE;
        parent.limit = parent.offset + PAGE_SIZE;
      }
      node = parent;
    }
  }

  // ---------- layout ----------

  function headerText(node) {
    if (node.kind === "array") return `[ ] ${node.size} ${node.size === 1 ? "item" : "itens"}`;
    if (node.kind === "object") return `{ } ${node.size} ${node.size === 1 ? "chave" : "chaves"}`;
    return "valor";
  }

  function truncate(text, maxChars) {
    return text.length > maxChars ? text.slice(0, Math.max(1, maxChars - 1)) + "…" : text;
  }

  function measure(node) {
    const head = headerText(node).length + 6;
    const longest = node.rows.reduce(
      (m, r) => Math.max(m, (r.key === null ? 0 : r.key.length + 2) + r.value.length),
      0,
    );
    const width = Math.min(MAX_W, Math.max(MIN_W, Math.max(head, longest) * CHAR_W + PAD_X * 2));
    const height = HEADER_H + node.rows.length * ROW_H + (node.rows.length ? PAD_BOTTOM : 0);
    return { width, height, maxChars: Math.floor((width - PAD_X * 2) / CHAR_W) };
  }

  function visibleChildren(node) {
    return node.collapsed ? [] : node.children.slice(node.offset, node.limit);
  }

  function layout(graph) {
    const boxes = [];
    const links = [];
    const colWidth = [];

    // 1ª passada: mede os nós visíveis e a largura de cada coluna (profundidade).
    (function walk(node) {
      node.box = measure(node);
      colWidth[node.depth] = Math.max(colWidth[node.depth] || 0, node.box.width);
      for (const c of visibleChildren(node)) walk(c);
      const pager = (count, before) => {
        if (count <= 0) return null;
        colWidth[node.depth + 1] = Math.max(colWidth[node.depth + 1] || 0, MIN_W);
        return {
          kind: "more", before, parent: node, count, depth: node.depth + 1,
          box: { width: MIN_W, height: HEADER_H, maxChars: 30 },
        };
      };
      node.less = node.collapsed ? null : pager(node.offset, true);
      node.more = node.collapsed ? null : pager(node.children.length - node.limit, false);
    })(graph.root);

    const colX = [];
    colWidth.forEach((w, i) => { colX[i] = i === 0 ? 0 : colX[i - 1] + colWidth[i - 1] + COL_GAP; });

    const kids = (n) => (n.kind === "more" ? [] : [n.less, ...visibleChildren(n), n.more].filter(Boolean));

    // 2ª passada: altura de cada subárvore, de baixo para cima.
    (function span(node) {
      const cs = kids(node);
      cs.forEach(span);
      const childrenH = cs.reduce((s, c) => s + c.span, 0) + ROW_GAP * Math.max(0, cs.length - 1);
      node.span = Math.max(node.box.height, childrenH);
    })(graph.root);

    // 3ª passada: posiciona; o pai fica centralizado em relação aos filhos.
    (function place(node, top) {
      const cs = kids(node);
      const childrenH = cs.reduce((s, c) => s + c.span, 0) + ROW_GAP * Math.max(0, cs.length - 1);
      let y = top + (node.span - childrenH) / 2;
      for (const c of cs) {
        place(c, y);
        y += c.span + ROW_GAP;
      }
      node.x = colX[node.depth];
      node.y = top + (node.span - node.box.height) / 2;
      boxes.push(node);
      for (const c of cs) {
        links.push({ from: node, to: c, label: c.kind === "more" ? "" : c.label });
      }
    })(graph.root, 0);

    const width = colX[colX.length - 1] + colWidth[colWidth.length - 1];
    return { boxes, links, width, height: graph.root.span };
  }

  // ---------- renderização ----------

  const SVG_NS = "http://www.w3.org/2000/svg";

  function el(tag, attrs = {}, parent) {
    const e = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (parent) parent.appendChild(e);
    return e;
  }

  function html(tag, attrs = {}, text) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function render(container, value, { onCopyPath, onFullscreen } = {}) {
    container.innerHTML = "";
    container.classList.add("graph");

    const graph = buildGraph(value);
    let warned = autoCollapse(graph);
    let selected = null;
    let view = { x: 0, y: 0, k: 1 };
    let hits = [];
    let current = null; // ocorrência atual da busca

    // Barra de ferramentas
    const bar = html("div", { class: "graph-bar" });
    const btn = (label, title, onClick) => {
      const b = html("button", { type: "button", class: "ghost small", title }, label);
      b.addEventListener("click", onClick);
      bar.appendChild(b);
      return b;
    };
    btn("−", "Diminuir zoom", () => zoomBy(1 / 1.25));
    btn("+", "Aumentar zoom", () => zoomBy(1.25));
    btn("Ajustar", "Encaixar o diagrama inteiro na área", () => fit());
    btn("Expandir tudo", "Expandir todos os nós", () => { setAllCollapsed(graph, false); redraw(); fit(); });
    btn("Recolher tudo", "Recolher todos os nós", () => { setAllCollapsed(graph, true); redraw(); fit(); });
    const fullBtn = btn("Tela cheia", "Tela cheia (Esc para sair)", () => toggleFullscreen());
    const pathBox = html("span", { class: "graph-path" });
    const pathText = html("code", {}, "");
    const copyPath = html("button", { type: "button", class: "ghost small" }, "Copiar caminho");
    copyPath.addEventListener("click", () => selected && onCopyPath?.(selected.path));
    pathBox.append(pathText, copyPath);
    bar.appendChild(pathBox);

    const notice = html("div", { class: "graph-notice" }, "Resposta grande: o diagrama mostra uma parte por vez. Use ▸ para expandir ramos e “+N mais” para carregar mais itens.");
    const viewport = html("div", { class: "graph-viewport" });
    const svg = el("svg", { class: "graph-svg" });
    const scene = el("g", {}, svg);
    viewport.appendChild(svg);
    container.append(bar, notice, viewport);

    function applyView() {
      scene.setAttribute("transform", `translate(${view.x},${view.y}) scale(${view.k})`);
    }

    function updatePath() {
      pathBox.classList.toggle("show", !!selected);
      pathText.textContent = selected ? selected.path : "";
    }

    function redraw() {
      notice.classList.toggle("show", warned);
      scene.textContent = "";
      const { boxes, links } = layout(graph);
      const edgesG = el("g", { class: "g-edges" }, scene);
      const nodesG = el("g", { class: "g-nodes" }, scene);

      for (const { from, to, label } of links) {
        const x1 = from.x + from.box.width;
        const y1 = from.y + Math.min(HEADER_H / 2, from.box.height / 2);
        const x2 = to.x;
        const y2 = to.y + to.box.height / 2;
        const mx = (x1 + x2) / 2;
        el("path", { class: "g-edge", d: `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}` }, edgesG);
        if (label) {
          const t = el("text", { class: "g-edge-label", x: mx, y: (y1 + y2) / 2 - 5, "text-anchor": "middle" }, edgesG);
          t.textContent = truncate(label, 18);
          const hit = to.hitRows?.has(-1);
          if (hit) t.classList.add("hit");
          if (hit && current?.node === to.id && current.row === -1) t.classList.add("current");
        }
      }

      for (const node of boxes) {
        const g = el("g", { class: "g-node", transform: `translate(${node.x},${node.y})` }, nodesG);
        if (node.kind === "more") {
          g.classList.add("g-more");
          el("rect", { width: node.box.width, height: node.box.height, rx: 8 }, g);
          const t = el("text", { x: node.box.width / 2, y: HEADER_H / 2 + 4, "text-anchor": "middle", class: "g-head" }, g);
          t.textContent = node.before ? `↑ ${node.count} anteriores…` : `+${node.count} mais…`;
          g.addEventListener("click", (e) => {
            if (e.defaultPrevented) return;
            if (node.before) node.parent.offset = Math.max(0, node.parent.offset - PAGE_SIZE);
            else node.parent.limit += PAGE_SIZE;
            redraw();
          });
          continue;
        }

        if (node === selected) g.classList.add("selected");
        if (current?.node === node.id) g.classList.add("g-current");
        el("rect", { class: "g-card", width: node.box.width, height: node.box.height, rx: 8 }, g);
        el("line", { class: "g-sep", x1: 0, x2: node.box.width, y1: HEADER_H, y2: HEADER_H }, g)
          .style.display = node.rows.length ? "" : "none";

        const head = el("text", { class: "g-head", x: PAD_X, y: HEADER_H / 2 + 4 }, g);
        head.textContent = headerText(node);

        if (node.children.length) {
          const tg = el("g", { class: "g-toggle", transform: `translate(${node.box.width - PAD_X},${HEADER_H / 2})` }, g);
          el("title", {}, tg).textContent = node.collapsed ? "Expandir" : "Recolher";
          const tt = el("text", { "text-anchor": "end", y: 4 }, tg);
          tt.textContent = `${node.collapsed ? "▸" : "▾"} ${node.children.length}`;
          tg.addEventListener("click", (e) => {
            if (e.defaultPrevented) return;
            e.stopPropagation();
            node.collapsed = !node.collapsed;
            warned = false;
            redraw();
          });
        }

        node.rows.forEach((row, i) => {
          if (node.hitRows?.has(i)) {
            const isCurrent = current?.node === node.id && current.row === i;
            el("rect", {
              class: `g-hit${isCurrent ? " current" : ""}`,
              x: 4, y: HEADER_H + i * ROW_H + 2, width: node.box.width - 8, height: ROW_H - 2, rx: 3,
            }, g);
          }
          const y = HEADER_H + i * ROW_H + ROW_H / 2 + 6;
          const t = el("text", { x: PAD_X, y }, g);
          const keyText = row.key === null ? "" : `${row.key}: `;
          const full = keyText + row.value;
          const shown = truncate(full, node.box.maxChars);
          if (keyText) {
            const k = el("tspan", { class: "g-key" }, t);
            k.textContent = truncate(keyText, node.box.maxChars);
          }
          if (shown.length > keyText.length) {
            const v = el("tspan", { class: `g-${row.type}` }, t);
            v.textContent = shown.slice(keyText.length);
          }
          if (shown !== full) el("title", {}, t).textContent = full;
        });

        g.addEventListener("click", (e) => {
          if (e.defaultPrevented) return;
          selected = selected === node ? null : node;
          updatePath();
          redraw();
        });
      }
    }

    // ---------- busca ----------

    function search(query, limit) {
      for (const node of graph.nodes) node.hitRows = null;
      hits = findHits(graph, query, limit + 1);
      const capped = hits.length > limit;
      if (capped) hits.length = limit;
      for (const h of hits) (graph.nodes[h.node].hitRows ??= new Set()).add(h.row);
      current = null;
      redraw();
      return { total: hits.length, capped };
    }

    // Mostra a ocorrência: expande o caminho até ela e centraliza.
    function goTo(index) {
      current = hits[index] ?? null;
      if (!current) { redraw(); return; }
      reveal(graph, current.node);
      warned = false;
      redraw();
      const node = graph.nodes[current.node];
      // Depois do fit() inicial, que também roda no próximo frame.
      requestAnimationFrame(() => {
        const r = viewport.getBoundingClientRect();
        if (!r.width || node.x === undefined) return;
        const k = Math.min(MAX_SCALE, Math.max(view.k, READABLE_SCALE));
        const cy = current.row >= 0 ? HEADER_H + current.row * ROW_H + ROW_H / 2 : node.box.height / 2;
        view = { k, x: r.width / 2 - (node.x + node.box.width / 2) * k, y: r.height / 2 - (node.y + cy) * k };
        applyView();
      });
    }

    // ---------- pan e zoom ----------

    function zoomAt(factor, cx, cy) {
      const k = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.k * factor));
      const f = k / view.k;
      view = { k, x: cx - (cx - view.x) * f, y: cy - (cy - view.y) * f };
      applyView();
    }

    function zoomBy(factor) {
      const r = viewport.getBoundingClientRect();
      zoomAt(factor, r.width / 2, r.height / 2);
    }

    // Encaixa o diagrama inteiro na área. Com `readable`, não reduz abaixo de
    // READABLE_SCALE: se não couber, ancora a raiz à esquerda, centralizada.
    function fit({ readable = false } = {}) {
      const { width, height } = layout(graph);
      const r = viewport.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const margin = 32;
      const fitK = Math.min((r.width - margin * 2) / width, (r.height - margin * 2) / height);
      const k = Math.min(1, Math.max(readable ? READABLE_SCALE : MIN_SCALE, fitK));
      if (k <= fitK) {
        view = { k, x: (r.width - width * k) / 2, y: (r.height - height * k) / 2 };
      } else {
        const root = graph.root;
        view = { k, x: margin, y: r.height / 2 - (root.y + root.box.height / 2) * k };
      }
      applyView();
    }

    viewport.addEventListener("wheel", (e) => {
      e.preventDefault();
      const r = viewport.getBoundingClientRect();
      zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });

    let drag = null;
    viewport.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      drag = { sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y, moved: false };
    });
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    function onMove(e) {
      if (!drag) return;
      const dx = e.clientX - drag.sx;
      const dy = e.clientY - drag.sy;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      if (!drag.moved) viewport.classList.add("dragging");
      drag.moved = true;
      view.x = drag.vx + dx;
      view.y = drag.vy + dy;
      applyView();
    }
    function onUp() {
      if (drag?.moved) {
        // Evita que soltar o arraste em cima de um nó conte como clique.
        viewport.addEventListener("click", (e) => e.preventDefault(), { capture: true, once: true });
      }
      viewport.classList.remove("dragging");
      drag = null;
    }

    // ---------- tela cheia ----------

    function onKey(e) {
      if (e.key === "Escape" && container.classList.contains("fullscreen")) toggleFullscreen();
    }
    function toggleFullscreen() {
      const on = container.classList.toggle("fullscreen");
      fullBtn.textContent = on ? "Sair da tela cheia" : "Tela cheia";
      onFullscreen?.(on, bar);
      requestAnimationFrame(() => fit({ readable: true }));
    }
    document.addEventListener("keydown", onKey);

    redraw();
    updatePath();
    requestAnimationFrame(() => fit({ readable: true }));

    return {
      fit: () => fit({ readable: true }),
      search,
      goTo,
      destroy() {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        document.removeEventListener("keydown", onKey);
        // Devolve o que foi emprestado para a tela cheia antes de limpar o container.
        if (container.classList.contains("fullscreen")) onFullscreen?.(false, bar);
        container.classList.remove("fullscreen");
        container.innerHTML = "";
      },
    };
  }

  const api = { buildGraph, layout, autoCollapse, findHits, reveal, render };
  globalThis.ReqGraph = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
