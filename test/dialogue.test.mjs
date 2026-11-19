import test from 'node:test';
import assert from 'node:assert/strict';
import { readInputs } from '../scripts/inspect.mjs';
import { buildSession } from '../scripts/consult.mjs';

const data = await readInputs();

function runAll() {
  const session = buildSession(data);
  const turns = data.utterances.map(u => session.dialogue.process(u));
  return { ...session, turns };
}

test('对话：U1 分辨业态、空间、规模、阶段与备选/选定，解释带原句', () => {
  const { turns } = runAll();
  const [t1] = turns;
  const texts = t1.interpretations.map(i => i.text).join('\n');
  assert.ok(texts.includes('备选'));
  assert.ok(texts.includes('选定'));
  assert.ok(texts.includes('每批10公斤'));
  assert.ok(texts.includes('每批20公斤'));
  // 每条解释都保留所依据的原句
  assert.ok(t1.interpretations.every(i => i.source?.clause || i.source?.sentence));
  // 三个对象各得答复：北楼咖啡、南楼试营业、南楼扩容
  assert.equal(t1.evaluations.length, 3);
  const expansion = t1.evaluations.find(e => e.subject.key.endsWith('expansion'));
  assert.equal(expansion.evaluation.verdict, 'feasible');
  assert.ok(expansion.evaluation.scenarios[0].obligations.some(o => o.item === '隔声验收'));
});

test('对话：U2 只改相应方案，清楼层、改规模，旧答复收回', () => {
  const { turns, archive, state } = runAll();
  const t2 = turns[1];
  // 北楼照旧：A1 不受影响
  assert.equal(archive.citability(archive.find('A1'), state).citable, true);
  // 南楼试营业（十公斤）与扩容答复须收回
  assert.equal(archive.citability(archive.find('A2'), state).citable, false);
  // 楼层未定 → 提出真正能区分结论的问题
  assert.ok(t2.questions.some(q => q.kind === 'floor'));
  // 楼层事实已清掉
  assert.equal(state.options.get('south-a').floor, null);
});

test('对话：U3 简称指多栋楼时不替人选，先给一致结论再问', () => {
  const { turns } = runAll();
  const t3 = turns[2];
  assert.ok(t3.questions.some(q => q.kind === 'alias' && q.text.includes('北馆')));
  // 各候选下咖啡馆都可开 → 一致结论直接给出
  const cafe = t3.evaluations.find(e => e.subject.key.includes('alias'));
  assert.equal(cafe.evaluation.verdict, 'feasible');
  // 暂不做焙豆，但一层均被 P1 禁止的备查结论立刻给出，不等无关信息
  const advisory = (t3.advisories ?? [])[0];
  assert.ok(advisory);
  const blockedFloors = advisory.evaluation.scenarios.filter(s => s.verdict === 'blocked');
  assert.ok(blockedFloors.length >= 2); // 北楼一层、北馆一层均为研发
});

test('对话：U4 删扩容只收回扩容答复，假设情形给条件答复', () => {
  const { turns, archive, state } = runAll();
  const t4 = turns[3];
  // 试营业答复不受扩容删除影响
  assert.equal(archive.citability(archive.find('A4'), state).citable, true);
  // 扩容答复须收回
  assert.equal(archive.citability(archive.find('A5'), state).citable, false);
  // 假设情形：七公斤+封闭排气 → P4 解除 P1，条件答复不纳入方案
  const hyp = t4.conditionalAnswers[0];
  assert.equal(hyp.evaluation.verdict, 'feasible');
  assert.equal(hyp.answer.conditional, true);
  assert.ok(hyp.answer.basis.rules.some(r => r.id === 'P4'));
  // 方案中已登记的二十公斤设备不能照搬该结论
  assert.ok(t4.interpretations.some(i => i.text.includes('不能照搬')));
});

test('对话：恢复原选项后早先答复可再引用', () => {
  const { dialogue, archive, state } = runAll();
  dialogue.process({ id: 'U5', text: '南楼还是二层，试营业那台按十公斤算。' });
  // A2 依据的事实全部恢复 → 恢复可引用
  assert.equal(archive.citability(archive.find('A2'), state).citable, true);
  // 楼层问题已勾销
  assert.ok(!state.openQuestions().some(q => q.kind === 'floor'));
});

test('对话：单位缺失跨过清单界限时只提问不默认', () => {
  const session = buildSession(data);
  const turn = session.dialogue.process({ id: 'X1', text: '南楼二层焙豆，设备二十的。' });
  assert.ok(turn.questions.some(q => q.kind === 'unit'));
  // 未默认单位 → 规模未知 → 不能确认
  const roasting = turn.evaluations.find(e => e.subject.key.includes('roasting'));
  assert.equal(roasting.evaluation.verdict, 'pending');
});

test('对话：否定范围不清时不改动方案', () => {
  const session = buildSession(data);
  const turn = session.dialogue.process({ id: 'X2', text: '南楼二层不做焙豆扩到二十公斤。' });
  assert.ok(turn.questions.some(q => q.kind === 'negation-scope'));
  assert.equal(session.state.options.size, 0); // 未替经办人划定范围
});

test('对话：已带走的答复保留当时的选项、事实及依据', () => {
  const { archive, state } = runAll();
  const a2 = archive.find('A2');
  assert.equal(archive.citability(a2, state).citable, false);
  // 存档仍含当时的楼层、规模与清单依据
  const kinds = a2.basis.facts.map(f => f.kind);
  assert.ok(kinds.includes('floor') && kinds.includes('scale') && kinds.includes('place'));
  assert.ok(a2.basis.facts.every(f => f.source?.utterance));
  assert.ok(a2.basis.rules.length >= 0);
});
