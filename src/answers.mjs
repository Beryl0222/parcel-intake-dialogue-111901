// 答复档案：每次答复按当时的选项、事实及依据存档，永不改写。
// 可引用性按当前状态现算：依据事实仍全部生效 → 仍可引用；
// 任一依据被替代/撤回 → 必须收回，并说明是哪条事实变了。
// 假设情形的条件答复不随方案变化收回（其依据就是所述条件本身）。

import { factMatches } from './state.mjs';
import { ACTIVITIES, PHASES } from './lexicon.mjs';

const ACTIVITY_LABEL = Object.fromEntries(ACTIVITIES.map(a => [a.id, a.label]));
const PHASE_LABEL = Object.fromEntries(PHASES.map(p => [p.id, p.label]));

export class AnswerArchive {
  constructor() {
    this.answers = [];
    this.seq = 0;
    this.lastCitable = new Map(); // answerId → bool，供检出「本轮新被收回/恢复可引用」
  }

  // 同一对象结论未变时不重复签发，返回 { answer, isNew }。
  issue({ revision, inResponseTo, subject, evaluation, basis, conditional = false }) {
    const fingerprint = JSON.stringify({
      verdict: evaluation.verdict,
      scenarios: evaluation.scenarios.map(s => [s.placeId, s.floor, s.verdict,
        s.prohibitions.map(p => [p.rule.id, p.status]),
        s.obligations.map(o => o.item),
        s.exemptions.map(e => e.item),
        s.unknowns.map(u => u.detail)]),
    });
    // 同一对象已有内容一致的答复时沿用最早那条：
    // 方案改回原样后，早先答复本身恢复效力，而不是另发新答复。
    const existing = this.answers.find(a => a.subject.key === subject.key && a.fingerprint === fingerprint);
    if (existing) {
      return { answer: existing, isNew: false };
    }
    const answer = {
      id: `A${++this.seq}`,
      revisionIssued: revision,
      inResponseTo,
      subject,
      evaluation,
      basis, // { facts: [...], rules: [...], stateRevision }
      conditional,
      fingerprint,
    };
    this.answers.push(answer);
    return { answer, isNew: true };
  }

  // 答复当前是否仍可引用：依据事实逐条与当前生效事实比对。
  citability(answer, state) {
    if (answer.conditional) {
      return { citable: true, reasons: ['条件答复：依据为所述假设条件本身，不随方案变动'] };
    }
    const reasons = [];
    for (const basisFact of answer.basis.facts) {
      const current = state.facts.find(f => f.status === 'active' && f.identity === basisFact.identity);
      if (!current) {
        reasons.push(`依据事实「${describeFact(basisFact)}」已失效`);
      } else if (!factMatches(current, basisFact.payload)) {
        reasons.push(`依据事实「${describeFact(basisFact)}」已变为「${describeFact(current)}」`);
      }
    }
    return { citable: reasons.length === 0, reasons };
  }

  // 每轮发言后调用，找出可引用性发生变化的答复。
  refresh(state) {
    const changes = [];
    for (const answer of this.answers) {
      const { citable, reasons } = this.citability(answer, state);
      const before = this.lastCitable.get(answer.id);
      this.lastCitable.set(answer.id, citable);
      if (before === undefined) continue; // 新答复，不算变化
      if (before === citable) continue;
      changes.push({ answer, nowCitable: citable, reasons });
    }
    return changes;
  }

  list(state) {
    return this.answers.map(answer => ({ answer, ...this.citability(answer, state) }));
  }

  find(id) {
    return this.answers.find(a => a.id === id) ?? null;
  }
}

export function describeFact(fact) {
  const p = fact.payload;
  const activityLabel = ACTIVITY_LABEL[p.activity] ?? p.activity;
  const phaseLabel = PHASE_LABEL[p.phase] ?? p.phase;
  const parts = {
    place: `地点=${p.placeText ?? p.placeId ?? '?'}`,
    modality: `方案性质=${p.modality === 'alternative' ? '备选' : '选定'}`,
    floor: p.value == null ? '楼层=未定' : `楼层=${p.value}层`,
    activity: `业态=${activityLabel}`,
    'activity-status': `${activityLabel}=${p.status === 'dropped' ? '暂不做' : p.status}`,
    scale: `${phaseLabel === 'any' ? '' : `${phaseLabel}·`}规模=每批${p.kg != null ? `${p.kg}公斤` : `${p.value}（单位未定）`}`,
    feature: `设施=${p.feature}`,
    'phase-status': `阶段${phaseLabel}=${p.status === 'withdrawn' ? '已删除' : '进行中'}`,
  };
  return parts[fact.kind] ?? `${fact.kind}:${JSON.stringify(p)}`;
}
