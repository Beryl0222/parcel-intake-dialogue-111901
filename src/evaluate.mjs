// 评估：把「某方案某业态某阶段」放到楼栋条目与清单条目下判断。
// 三类判断分开：能否开展（禁止/例外）、投运前提（验收等）、手续（可免/需办）。
// 地点或楼层未定时按全部候选场景折叠：结论一致的直接给出，分歧的如实列出并提问。

import { ACTIVITIES, PHASES } from './lexicon.mjs';

const ACTIVITY_LABEL = Object.fromEntries(ACTIVITIES.map(a => [a.id, a.label]));
const PHASE_LABEL = Object.fromEntries(PHASES.map(p => [p.id, p.label]));

function compare(value, op, threshold) {
  if (op === 'lt') return value < threshold;
  if (op === 'gt') return value > threshold;
  if (op === 'gte') return value >= threshold;
  return false;
}

function toKg(value, unit) {
  const factor = { 公斤: 1, 千克: 1, 斤: 0.5, 克: 0.001 }[unit] ?? 1;
  return value * factor;
}

function checkCondition(cond, scaleKg, features) {
  if (cond.fact === 'scale') {
    if (scaleKg == null) return { status: 'unknown', missing: '设备每批规模' };
    const thresholdKg = toKg(cond.value, cond.unit);
    return compare(scaleKg, cond.op, thresholdKg)
      ? { status: 'met' }
      : { status: 'failed', detail: `每批${scaleKg}公斤不满足「${cond.text}」` };
  }
  if (cond.fact === 'feature') {
    const feature = features?.get?.(cond.value) ?? null;
    if (!feature) return { status: 'unknown', missing: `是否${cond.value}` };
    return feature.present ? { status: 'met' } : { status: 'failed', detail: `未设${cond.value}` };
  }
  return { status: 'unknown', missing: cond.text };
}

// 单场景评估：place 与 floor 均已确定。
export function evaluateScenario({ places, rules, place, floor, activity, phase, scale, features }) {
  const landUse = floor != null ? (place.uses[String(floor)] ?? null) : null;
  const scaleKg = scale?.kg ?? null;
  const out = {
    placeId: place.id,
    placeLabel: place.aliases[0],
    floor,
    landUse,
    activity,
    phase,
    prohibitions: [],
    obligations: [], // 投运前提（不是手续）
    exemptions: [], // 可免办的手续
    procedures: [], // 需办理的手续
    unknowns: [],
    adjustments: [],
    notes: [],
    verdict: 'feasible',
  };

  if (landUse == null) {
    out.unknowns.push({
      fact: 'landUse',
      detail: floor == null ? '楼层未定' : `${place.aliases[0]}条目未列${floor}层用途`,
    });
  }

  for (const rule of rules) {
    if (rule.kind === 'unparsed') {
      out.unknowns.push({ fact: 'rule', detail: `清单条目 ${rule.id} 需人工查实：${rule.text}` });
      continue;
    }
    if (rule.kind === 'prohibition' && matchRule(rule, landUse, activity)) {
      out.prohibitions.push(checkProhibition(rule, rules, place, floor, phase, scaleKg, features, out));
    }
    if (rule.kind === 'operation-condition' && matchRule(rule, landUse, activity)) {
      const threshold = rule.match.scale;
      if (scaleKg == null) {
        out.unknowns.push({ fact: 'scale', detail: `设备每批规模未定，无法判断是否触及 ${rule.id}` });
      } else if (compare(scaleKg, threshold.op, toKg(threshold.value, threshold.unit))) {
        for (const req of rule.effect.requires) {
          out.obligations.push({ rule, item: req.item, before: req.before, kind: '投运条件' });
        }
      } else {
        out.notes.push(`${rule.id} 未触发（每批${scaleKg}公斤未超过界限），规模变化后须重估`);
      }
    }
    if (rule.kind === 'procedure-exemption' && matchRule(rule, landUse, activity)) {
      for (const item of rule.effect.exempts) {
        out.exemptions.push({ rule, item, kind: '手续' });
      }
    }
  }

  // 手续维度：无免除条目时按常规办理。
  if (out.exemptions.length === 0) {
    out.procedures.push({ item: '一般咨询材料', kind: '手续', reason: '无免除条目适用' });
  }

  if (out.prohibitions.some(p => p.status === 'applies')) out.verdict = 'blocked';
  else if (out.prohibitions.some(p => p.status === 'unknown') || out.unknowns.length > 0) out.verdict = 'pending';
  else out.verdict = 'feasible';

  if (out.verdict === 'blocked') out.adjustments = suggestAdjustments(out, places, rules, activity, phase);
  if (out.verdict === 'feasible') out.nextSteps = composeNextSteps(out);
  return out;
}

function matchRule(rule, landUse, activity) {
  return rule.match.landUse === landUse && rule.match.activity === activity;
}

// 禁止条目 + 定向例外：例外只解除它明确引用的限制，且仅在适用条件成立时。
function checkProhibition(rule, rules, place, floor, phase, scaleKg, features, out) {
  const exceptions = rules.filter(r =>
    r.kind === 'exception' &&
    r.modifies.includes(rule.id) &&
    r.target?.placeId === place.id &&
    (r.target?.floor == null || r.target?.floor === floor));

  const applicable = exceptions.filter(e => e.phase == null || e.phase === phase);
  const outOfPhase = exceptions.filter(e => e.phase != null && e.phase !== phase);
  for (const e of outOfPhase) {
    out.notes.push(`例外 ${e.id} 仅适用于${PHASE_LABEL[e.phase] ?? e.phase}，本阶段不在其内`);
  }

  if (applicable.length === 0) {
    return { rule, status: 'applies', detail: `${rule.id}：${rule.text}` };
  }
  const missing = [];
  const failed = [];
  for (const e of applicable) {
    for (const cond of e.conditions) {
      const check = checkCondition(cond, scaleKg, features);
      if (check.status === 'unknown') missing.push({ exception: e, cond, missing: check.missing });
      if (check.status === 'failed') failed.push({ exception: e, cond, detail: check.detail });
    }
  }
  if (failed.length > 0) {
    return { rule, status: 'applies', detail: `${rule.id} 未被例外解除（${failed.map(f => f.detail).join('；')}）` };
  }
  if (missing.length > 0) {
    for (const m of missing) {
      out.unknowns.push({ fact: 'exception-condition', detail: `${m.exception.id} 适用条件未明：${m.missing}` });
    }
    return { rule, status: 'unknown', detail: `${rule.id} 是否被 ${applicable.map(e => e.id).join('、')} 解除，取决于上述条件` };
  }
  return {
    rule,
    status: 'lifted',
    liftedBy: applicable.map(e => e.id),
    liftedByRules: applicable,
    detail: `${rule.id} 经 ${applicable.map(e => e.id).join('、')} 解除（仅限例外覆盖的范围）`,
  };
}

// 阻碍可能如何解除：同址的例外条件，或改到不受该禁止约束的用地。
function suggestAdjustments(out, places, rules, activity, phase) {
  const adjustments = [];
  const blocking = out.prohibitions.filter(p => p.status === 'applies').map(p => p.rule);
  for (const rule of blocking) {
    const exceptions = rules.filter(r => r.kind === 'exception' && r.modifies.includes(rule.id));
    for (const e of exceptions) {
      const condText = e.conditions.map(c => c.text).join('且');
      const where = e.target ? `${places.find(p => p.id === e.target.placeId)?.aliases[0] ?? e.target.placeId}${e.target.floor}层` : '';
      adjustments.push(`依 ${e.id}：在${where}满足「${condText}」时 ${rule.id} 不适用（仅限${PHASE_LABEL[e.phase] ?? '例外所述阶段'}）`);
    }
    const elsewhere = [];
    for (const place of places) {
      for (const [f, use] of Object.entries(place.uses)) {
        if (use !== rule.match.landUse) elsewhere.push(`${place.aliases[0]}${f}层（${use}）`);
      }
    }
    if (elsewhere.length > 0) {
      adjustments.push(`或改到非${rule.match.landUse}用地：${elsewhere.join('、')}（改址后须按该处条目重估）`);
    }
  }
  return adjustments;
}

// 确定可行之后还要做什么：投运前提、手续（可免/需办分开）、例外边界提示。
function composeNextSteps(out) {
  const steps = [];
  for (const ob of out.obligations) {
    steps.push(`${ob.kind}：先完成${ob.item}再${ob.before}（依据 ${ob.rule.id}）`);
  }
  for (const ex of out.exemptions) {
    steps.push(`手续：可免办${ex.item}（依据 ${ex.rule.id}；免办手续不等于准许投运）`);
  }
  for (const pr of out.procedures) {
    steps.push(`手续：需办理${pr.item}（${pr.reason}）`);
  }
  for (const p of out.prohibitions.filter(p => p.status === 'lifted')) {
    steps.push(`边界：${p.detail}，超出该范围（如扩容、正式投运或条件变化）须重新确认`);
  }
  return steps;
}

function scenarioKey(s) {
  return JSON.stringify({
    verdict: s.verdict,
    prohibitions: s.prohibitions.map(p => [p.rule.id, p.status]),
    obligations: s.obligations.map(o => o.item),
    exemptions: s.exemptions.map(e => e.item),
    unknowns: s.unknowns.map(u => u.fact),
  });
}

// 多候选折叠：地点或楼层未定时枚举全部场景。
// 结论一致的直接给出；有分歧时不替经办人选，列出各场景并说明区分点。
export function evaluateSubject({ places, rules, candidates, floor, activity, phase, scale, features }) {
  const scenarios = [];
  for (const placeId of candidates) {
    const place = places.find(p => p.id === placeId);
    if (!place) continue;
    const floors = floor != null ? [floor] : Object.keys(place.uses).map(Number).sort();
    for (const f of floors) {
      scenarios.push(evaluateScenario({ places, rules, place, floor: f, activity, phase, scale, features }));
    }
  }
  if (scenarios.length === 0) return null;

  const groups = new Map();
  for (const s of scenarios) {
    const key = scenarioKey(s);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  const verdicts = new Set(scenarios.map(s => s.verdict));
  const consistent = groups.size === 1;
  const sameVerdict = verdicts.size === 1;

  return {
    activity,
    activityLabel: ACTIVITY_LABEL[activity] ?? activity,
    phase,
    phaseLabel: PHASE_LABEL[phase] ?? (phase === 'general' ? '日常营业' : phase),
    scenarios,
    consistent,
    verdict: sameVerdict ? scenarios[0].verdict : 'pending',
    // 结论一致时取任一场景作代表；verdict 一致但细节不同（如手续不同）时仍需查实差异点。
    representative: scenarios[0],
    divergent: sameVerdict && !consistent,
  };
}
