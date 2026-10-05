import assert from "node:assert/strict";
import { test } from "node:test";

import ReqSearch from "../../src/reqresp/web/static/search.js";

const { findMatches, splitRanges } = ReqSearch;

test("findMatches ignora maiúsculas e não sobrepõe ocorrências", () => {
  assert.deepEqual(findMatches("Ana ana ANA", "ana"), [[0, 3], [4, 7], [8, 11]]);
  assert.deepEqual(findMatches("aaaa", "aa"), [[0, 2], [2, 4]]);
});

test("findMatches com termo vazio ou sem ocorrência", () => {
  assert.deepEqual(findMatches("abc", ""), []);
  assert.deepEqual(findMatches("abc", "x"), []);
});

test("findMatches trata o termo como texto literal", () => {
  assert.deepEqual(findMatches("a.b axb", "a.b"), [[0, 3]]);
  assert.deepEqual(findMatches("[1]", "["), [[0, 1]]);
});

test("findMatches respeita o limite", () => {
  assert.equal(findMatches("x".repeat(50), "x", 10).length, 10);
});

test("splitRanges mantém ocorrência dentro de um node", () => {
  // nodes: "abc" | "def"
  assert.deepEqual(splitRanges([3, 3], [[4, 6]]), [{ node: 1, start: 1, end: 3, hit: 0 }]);
});

test("splitRanges parte ocorrência que atravessa nodes", () => {
  // '"name"' | ': ' | '"Ana"'  — buscar 'name": "a'
  const lengths = [6, 2, 5];
  assert.deepEqual(splitRanges(lengths, [[1, 10]]), [
    { node: 0, start: 1, end: 6, hit: 0 },
    { node: 1, start: 0, end: 2, hit: 0 },
    { node: 2, start: 0, end: 2, hit: 0 },
  ]);
});

test("splitRanges com várias ocorrências e nodes vazios", () => {
  assert.deepEqual(splitRanges([2, 0, 4], [[0, 1], [3, 5]]), [
    { node: 0, start: 0, end: 1, hit: 0 },
    { node: 2, start: 1, end: 3, hit: 1 },
  ]);
});
