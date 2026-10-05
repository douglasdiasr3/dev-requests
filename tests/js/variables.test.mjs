import assert from "node:assert/strict";
import { test } from "node:test";

import ReqProjects from "../../src/reqresp/web/static/projects.js";

const { resolveText, findVariables, buildVariables, jsonForValidation, comparable } = ReqProjects;

test("resolveText substitui, aninha e reporta faltantes", () => {
  const vars = { base: "{{host}}/api", host: "https://h", nome: "ana" };
  assert.deepEqual(resolveText("{{base}}/u?n={{ nome }}&x={{x}}", vars), {
    text: "https://h/api/u?n=ana&x={{x}}",
    missing: ["x"],
  });
});

test("resolveText não entra em loop com ciclos", () => {
  const { text } = resolveText("{{a}}", { a: "{{b}}", b: "{{a}}" });
  assert.ok(text === "{{a}}" || text === "{{b}}");
});

test("findVariables devolve posições", () => {
  assert.deepEqual(findVariables("x{{a}}y{{ b.c }}"), [
    { name: "a", start: 1, end: 6 },
    { name: "b.c", start: 7, end: 16 },
  ]);
});

test("buildVariables: ambiente sobrescreve globais e rastreia segredos", () => {
  const { values, secrets } = buildVariables(
    [{ key: "token", value: "g", secret: true, enabled: true }, { key: "off", value: "x", enabled: false }],
    [{ key: "token", value: "e", secret: false, enabled: true }, { key: "k", value: "s", secret: true, enabled: true }],
  );
  assert.deepEqual(values, { token: "e", k: "s" });
  assert.deepEqual([...secrets], ["k"]);
});

test("jsonForValidation torna válido um body com variáveis", () => {
  const body = '{"id": {{id}}, "nome": "{{nome}}", "x": {{desconhecida}}}';
  assert.doesNotThrow(() => JSON.parse(jsonForValidation(body, { id: "7", nome: "ana" })));
  assert.equal(JSON.parse(jsonForValidation(body, { id: "7" })).id, 7);
});

test("comparable ignora diferenças irrelevantes de formato", () => {
  const a = { method: "GET", url: "u", headers: [], body: "", body_type: "none", auth: { type: "none" } };
  const b = { ...a, params: [], auth: { type: "none", token: "", username: "", password: "" } };
  assert.equal(comparable(a), comparable(b));
  assert.notEqual(comparable(a), comparable({ ...a, url: "v" }));
});
