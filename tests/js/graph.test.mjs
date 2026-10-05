import assert from "node:assert/strict";
import { test } from "node:test";

import ReqGraph from "../../src/dev_requests/web/static/graph.js";

const { buildGraph, layout, autoCollapse } = ReqGraph;

test("objeto aninhado vira nós ligados pela chave", () => {
  const g = buildGraph({ id: 1, nome: "ana", endereco: { cidade: "SP", geo: { lat: 1 } } });
  assert.equal(g.nodes.length, 3);
  assert.deepEqual(g.root.rows.map((r) => [r.key, r.value, r.type]), [["id", "1", "num"], ["nome", '"ana"', "str"]]);
  assert.deepEqual(g.edges.map((e) => e.label).sort(), ["endereco", "geo"]);
  assert.equal(g.nodes[2].path, "$.endereco.geo");
});

test("array de primitivos fica dentro de um único nó", () => {
  const g = buildGraph({ tags: ["a", true, null] });
  const arr = g.root.children[0];
  assert.equal(arr.kind, "array");
  assert.deepEqual(arr.rows.map((r) => [r.key, r.value]), [["0", '"a"'], ["1", "true"], ["2", "null"]]);
  assert.equal(arr.children.length, 0);
});

test("array de objetos gera filhos rotulados com o índice", () => {
  const g = buildGraph([{ a: 1 }, { "chave com espaço": 2 }]);
  assert.deepEqual(g.edges.map((e) => e.label), ["[0]", "[1]"]);
  assert.equal(g.root.children[1].path, "$[1]");
  const nested = buildGraph({ x: { "chave com espaço": {} } });
  assert.equal(nested.nodes[2].path, '$.x["chave com espaço"]');
});

test("raiz primitiva vira um nó só", () => {
  const g = buildGraph("ok");
  assert.equal(g.nodes.length, 1);
  assert.equal(g.root.rows[0].value, '"ok"');
});

test("layout põe filhos à direita do pai e sem sobreposição", () => {
  const g = buildGraph({ a: { x: 1 }, b: { y: [1, 2] }, c: [{ z: 1 }, { z: 2 }] });
  const { boxes } = layout(g);
  for (const n of boxes) {
    for (const c of n.children ?? []) assert.ok(c.x > n.x + n.box.width, "filho deve ficar à direita");
  }
  const byCol = Map.groupBy(boxes, (b) => b.x);
  for (const col of byCol.values()) {
    col.sort((p, q) => p.y - q.y);
    for (let i = 1; i < col.length; i++) {
      assert.ok(col[i].y >= col[i - 1].y + col[i - 1].box.height, "nós da mesma coluna não se sobrepõem");
    }
  }
});

test("recolher esconde os descendentes", () => {
  const g = buildGraph({ a: { b: { c: {} } } });
  assert.equal(layout(g).boxes.length, 4);
  g.root.children[0].collapsed = true;
  assert.equal(layout(g).boxes.length, 2);
});

test("respostas grandes são recolhidas e paginadas", () => {
  const big = Array.from({ length: 5000 }, (_, i) => ({ id: i, meta: { n: i } }));
  const g = buildGraph(big);
  assert.equal(autoCollapse(g), true);
  const visible = layout(g).boxes.length;
  assert.ok(visible <= 302, `esperava no máximo ~300 nós visíveis, veio ${visible}`);
  g.root.collapsed = false;
  const { boxes } = layout(g);
  assert.ok(boxes.some((b) => b.kind === "more" && b.count === 4900), "deve mostrar '+4900 mais'");
});

test("findHits acha chaves, valores e arestas, inclusive em ramos recolhidos", () => {
  const g = buildGraph({ nome: "Ana", endereco: { cidade: "Gwenborough" }, tags: ["ana"] });
  g.nodes[1].collapsed = true;
  assert.deepEqual(ReqGraph.findHits(g, "ANA"), [{ node: 0, row: 0 }, { node: 2, row: 0 }]);
  assert.deepEqual(ReqGraph.findHits(g, "gwen"), [{ node: 1, row: 0 }]);
  assert.deepEqual(ReqGraph.findHits(g, "ender"), [{ node: 1, row: -1 }]);
  assert.deepEqual(ReqGraph.findHits(g, ""), []);
  assert.equal(ReqGraph.findHits(g, "a", 2).length, 2);
});

test("reveal expande ancestrais e mostra só a página com o item", () => {
  const g = buildGraph({ itens: Array.from({ length: 250 }, (_, i) => ({ i, sub: { alvo: i === 230 } })) });
  const itens = g.nodes[1];
  itens.collapsed = true;
  const alvo = g.nodes.find((n) => n.path === "$.itens[230].sub");
  ReqGraph.reveal(g, alvo.id);
  assert.equal(itens.collapsed, false);
  assert.deepEqual([itens.offset, itens.limit], [200, 300]);
  assert.equal(g.root.collapsed, false);
  // Já visível: a janela não muda.
  ReqGraph.reveal(g, g.nodes.find((n) => n.path === "$.itens[249]").id);
  assert.deepEqual([itens.offset, itens.limit], [200, 300]);
});

test("layout com janela de filhos tem cartões de anteriores e de mais", () => {
  const g = buildGraph(Array.from({ length: 350 }, (_, i) => ({ i })));
  g.root.offset = 100;
  g.root.limit = 200;
  const { boxes } = layout(g);
  const pagers = boxes.filter((b) => b.kind === "more").map((b) => [b.before, b.count]);
  assert.deepEqual(pagers.sort(), [[false, 150], [true, 100]]);
  assert.equal(boxes.filter((b) => b.kind === "object").length, 100);
});
