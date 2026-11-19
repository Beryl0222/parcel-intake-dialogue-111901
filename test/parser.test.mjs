import test from 'node:test';
import assert from 'node:assert/strict';
import { readInputs } from '../scripts/inspect.mjs';
import { parseUtterance } from '../src/parser.mjs';

const data = await readInputs();
const [U1, U2, U3, U4] = data.utterances;

test('解析：业态、空间、规模、阶段与备选/选定', () => {
  const [s1, s2] = parseUtterance(U1, data.places);
  const c1 = s1.clauses[0];
  assert.deepEqual(c1.place.candidates, ['north-a']);
  assert.equal(c1.place.ambiguous, false);
  assert.equal(c1.floor.value, 1);
  assert.equal(c1.activity, 'cafe');
  assert.ok(!c1.directives.includes('alternative')); // 无备选标记 → 选定

  const c2 = s1.clauses[1];
  assert.equal(c2.activity, 'roasting');
  assert.ok(c2.directives.includes('alternative')); // 「也可以备选」→ 提出备选

  const c3 = s2.clauses[0];
  assert.equal(c3.phase, 'trial');
  assert.deepEqual([c3.scale.value, c3.scale.kg], [10, 10]);

  const c4 = s2.clauses[1];
  assert.equal(c4.phase, 'expansion');
  assert.equal(c4.scale.kg, 20);
  assert.ok(c4.directives.includes('tentative')); // 「再说」
});

test('解析：更正、清楼层与设备承前', () => {
  const [s1, s2] = parseUtterance(U2, data.places);
  assert.ok(s1.clauses[0].directives.includes('correction'));
  assert.ok(s1.clauses[1].directives.includes('reaffirm'));
  const unset = s2.clauses[0];
  assert.equal(unset.floor.unset, true);
  assert.ok(unset.directives.includes('unset'));
  const equipment = s2.clauses[1];
  assert.ok(equipment.directives.includes('equipment-anaphora'));
  assert.equal(equipment.scale.kg, 20);
});

test('解析：简称指多栋楼时不选定', () => {
  const [s1] = parseUtterance(U3, data.places);
  const place = s1.clauses[0].place;
  assert.equal(place.text, '北馆');
  assert.deepEqual(place.candidates, ['north-a', 'north-b']);
  assert.equal(place.ambiguous, true);
  // 「先不做焙豆」否定范围清楚，不误报
  assert.equal(s1.clauses[0].negation.scopeAmbiguous, false);
});

test('解析：假设问句与条件', () => {
  const [, s2] = parseUtterance(U4, data.places);
  assert.equal(s2.hypothetical, true);
  assert.equal(s2.question, true);
  const cond = s2.clauses[0];
  assert.equal(cond.scale.kg, 7);
  assert.deepEqual(cond.features, [{ id: '封闭排气', present: true }]);
  assert.equal(s2.clauses[1].phase, 'trial');
});

test('解析：单位缺失与否定范围不清的识别', () => {
  const [s1] = parseUtterance({ id: 'X1', text: '南楼二层焙豆，设备二十的。' }, data.places);
  const scale = s1.clauses[1].scale;
  assert.equal(scale.unitMissing, true);
  assert.equal(scale.kg, null);

  const [s2] = parseUtterance({ id: 'X2', text: '南楼二层不做焙豆扩到二十公斤。' }, data.places);
  assert.equal(s2.clauses[0].negation.scopeAmbiguous, true);

  // 楼层数字不被误当规模
  const [s3] = parseUtterance({ id: 'X3', text: '北楼一层开咖啡馆。' }, data.places);
  assert.equal(s3.clauses[0].scale, null);
});
