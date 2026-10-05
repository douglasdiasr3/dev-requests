"use strict";

// Busca na resposta: acha ocorrências e destaca com <mark>, mesmo quando uma
// ocorrência atravessa os <span> do realce de JSON.
// As funções puras ficam no topo e são testadas no Node.
(function () {
  const MAX_HITS = 1000;

  // Intervalos [início, fim) de cada ocorrência, sem diferenciar maiúsculas.
  function findMatches(text, query, limit = MAX_HITS) {
    if (!query) return [];
    const hay = text.toLowerCase();
    const needle = query.toLowerCase();
    const out = [];
    let at = hay.indexOf(needle);
    while (at !== -1 && out.length < limit) {
      out.push([at, at + needle.length]);
      at = hay.indexOf(needle, at + needle.length);
    }
    return out;
  }

  // Dado o tamanho de cada text node (na ordem do documento), parte cada
  // ocorrência em pedaços que cabem num único node.
  function splitRanges(nodeLengths, matches) {
    const segments = [];
    let node = 0;
    let nodeStart = 0;
    matches.forEach(([start, end], hit) => {
      while (node < nodeLengths.length && nodeStart + nodeLengths[node] <= start) {
        nodeStart += nodeLengths[node++];
      }
      let n = node;
      let ns = nodeStart;
      while (n < nodeLengths.length && ns < end) {
        const from = Math.max(start, ns) - ns;
        const to = Math.min(end, ns + nodeLengths[n]) - ns;
        if (to > from) segments.push({ node: n, start: from, end: to, hit });
        ns += nodeLengths[n++];
      }
    });
    return segments;
  }

  // ---------- DOM ----------

  function clearHighlights(root) {
    const marks = root.querySelectorAll("mark.hit");
    if (!marks.length) return;
    marks.forEach((m) => m.replaceWith(...m.childNodes));
    root.normalize();
  }

  // Retorna { total, capped }.
  function highlightMatches(root, query, limit = MAX_HITS) {
    clearHighlights(root);
    if (!query) return { total: 0, capped: false };
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    const matches = findMatches(nodes.map((n) => n.data).join(""), query, limit + 1);
    const capped = matches.length > limit;
    if (capped) matches.length = limit;
    const segments = splitRanges(nodes.map((n) => n.data.length), matches);
    // De trás para frente: partir um node não muda os offsets dos pedaços anteriores.
    for (let i = segments.length - 1; i >= 0; i--) {
      const { node, start, end, hit } = segments[i];
      const text = nodes[node];
      const range = document.createRange();
      range.setStart(text, start);
      range.setEnd(text, end);
      const mark = document.createElement("mark");
      mark.className = "hit";
      mark.dataset.hit = hit;
      range.surroundContents(mark);
    }
    return { total: matches.length, capped };
  }

  const api = { MAX_HITS, findMatches, splitRanges, clearHighlights, highlightMatches };
  globalThis.ReqSearch = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
