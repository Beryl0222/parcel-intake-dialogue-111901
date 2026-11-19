import test from 'node:test';
import assert from 'node:assert/strict';
import { readInputs } from '../scripts/inspect.mjs';
import { compileRuleset, scaleBoundariesKg } from '../src/ruleset.mjs';

const data = await readInputs();
const rules = compileRuleset(data.rules, data.places);
const byId = Object.fromEntries(rules.map(r => [r.id, r]));

test('清单编译：通用要求（禁止/手续免除/投运条件）', () => {
  assert.equal(byId.P1.kind, 'prohibition');
  assert.deepEqual(byId.P1.match, { landUse: '研发', activity: 'roasting' });

  assert.equal(byId.P2.kind, 'procedure-exemption');
  assert.deepEqual(byId.P2.effect.exempts, ['一般咨询材料']);

  assert.equal(byId.P3.kind, 'operation-condition');
  assert.deepEqual(byId.P3.match.scale, { op: 'gt', value: 15, unit: '千克' });
  assert.equal(byId.P3.effect.requires[0].item, '隔声验收');
});

test('清单编译：定向例外只引用明确的限制', () => {
  const p4 = byId.P4;
  assert.equal(p4.kind, 'exception');
  assert.deepEqual(p4.modifies, ['P1']); // 只改变 P1，不及其他条目
  assert.equal(p4.target.placeId, 'north-a'); // 「北楼一层」按楼栋条目解析
  assert.equal(p4.target.floor, 1);
  assert.equal(p4.phase, 'trial'); // 仅试运行
  const [scaleCond, featureCond] = p4.conditions;
  assert.deepEqual([scaleCond.fact, scaleCond.op, scaleCond.value], ['scale', 'lt', 8]);
  assert.deepEqual([featureCond.fact, featureCond.value], ['feature', '封闭排气']);
});

test('清单编译：规模界限收集（供单位缺失跨界判断）', () => {
  const boundaries = scaleBoundariesKg(rules);
  const byRule = Object.fromEntries(boundaries.map(b => [b.ruleId, b.kg]));
  assert.equal(byRule.P3, 15);
  assert.equal(byRule.P4, 8);
});

test('清单编译：每条都保留引用号与原文', () => {
  for (const rule of rules) {
    assert.ok(rule.id && rule.text.length > 0);
    assert.notEqual(rule.kind, 'unparsed');
  }
});
