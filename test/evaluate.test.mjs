import test from 'node:test';
import assert from 'node:assert/strict';
import { readInputs } from '../scripts/inspect.mjs';
import { compileRuleset } from '../src/ruleset.mjs';
import { evaluateScenario, evaluateSubject } from '../src/evaluate.mjs';

const data = await readInputs();
const rules = compileRuleset(data.rules, data.places);
const place = id => data.places.find(p => p.id === id);
const withExhaust = new Map([['封闭排气', { present: true }]]);

function scenario(over) {
  return evaluateScenario({
    places: data.places,
    rules,
    place: place('north-a'),
    floor: 1,
    activity: 'roasting',
    phase: 'trial',
    scale: { kg: 7 },
    features: withExhaust,
    ...over,
  });
}

test('评估：定向例外在条件成立时解除禁止（仅试运行）', () => {
  const s = scenario({});
  assert.equal(s.verdict, 'feasible');
  assert.equal(s.prohibitions[0].status, 'lifted');
  assert.deepEqual(s.prohibitions[0].liftedBy, ['P4']);
});

test('评估：例外条件不满足时禁止成立，并给出可尝试的调整', () => {
  const eight = scenario({ scale: { kg: 8 } }); // 八公斤不满足「不足八千克」
  assert.equal(eight.verdict, 'blocked');
  assert.equal(eight.prohibitions[0].status, 'applies');
  assert.ok(eight.adjustments.some(a => a.includes('P4')));
  assert.ok(eight.adjustments.some(a => a.includes('非研发用地')));

  const twenty = scenario({ scale: { kg: 20 } });
  assert.equal(twenty.verdict, 'blocked');
});

test('评估：例外适用条件未明时不能确认，须查实', () => {
  const s = scenario({ features: new Map() }); // 未提封闭排气
  assert.equal(s.verdict, 'pending');
  assert.equal(s.prohibitions[0].status, 'unknown');
  assert.ok(s.unknowns.some(u => u.fact === 'exception-condition'));
});

test('评估：例外不覆盖的阶段仍受禁止', () => {
  const s = scenario({ phase: 'operation' }); // P4 仅试运行
  assert.equal(s.verdict, 'blocked');
});

test('评估：投运条件与手续是两种判断', () => {
  const over = scenario({ place: place('south-a'), floor: 2, scale: { kg: 20 } });
  assert.equal(over.verdict, 'feasible');
  assert.deepEqual(over.obligations.map(o => [o.item, o.kind]), [['隔声验收', '投运条件']]);
  assert.ok(over.procedures.some(p => p.item === '一般咨询材料')); // 手续不免

  const atBoundary = scenario({ place: place('south-a'), floor: 2, scale: { kg: 15 } });
  assert.equal(atBoundary.obligations.length, 0); // 十五公斤整不触发「超过十五千克」

  const cafeStreet = scenario({ place: place('south-a'), floor: 1, activity: 'cafe', phase: 'general', scale: null, features: new Map() });
  assert.deepEqual(cafeStreet.exemptions.map(e => e.item), ['一般咨询材料']); // 街铺咖啡馆可免手续
  assert.equal(cafeStreet.obligations.length, 0); // 免手续不等于有投运许可，两者分列
});

test('评估：楼层未定时按候选折叠，分歧不替人选', () => {
  const folded = evaluateSubject({
    places: data.places,
    rules,
    candidates: ['south-a'],
    floor: null,
    activity: 'roasting',
    phase: 'trial',
    scale: { kg: 20 },
    features: new Map(),
  });
  assert.equal(folded.scenarios.length, 2);
  assert.equal(folded.consistent, false); // 一层街铺与二层生产结论细节不同
  assert.equal(folded.verdict, 'feasible'); // 方向一致可先说
});
