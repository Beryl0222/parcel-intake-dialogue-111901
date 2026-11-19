// 对话编排：逐句处理经办人发言。
// 流程：解析 → 登记解释（带原句）→ 应用方案变更 → 评估受影响对象 →
// 签发/沿用答复 → 检出须收回或恢复可引用的早先答复。
// 歧义（多选楼栋、单位跨界、否定范围）只提问，不替经办人选定。

import { parseUtterance } from './parser.mjs';
import { evaluateSubject } from './evaluate.mjs';
import { scaleBoundariesKg } from './ruleset.mjs';
import { PLAUSIBLE_UNITS, UNITS, ACTIVITIES, PHASES } from './lexicon.mjs';

const ACTIVITY_LABEL = Object.fromEntries(ACTIVITIES.map(a => [a.id, a.label]));
const PHASE_LABEL = Object.fromEntries(PHASES.map(p => [p.id, p.label]));

export class Dialogue {
  constructor({ places, rules }) {
    this.places = places;
    this.rules = rules;
    this.boundaries = scaleBoundariesKg(rules);
    this.state = null; // 由调用方注入 DialogueState
    this.archive = null; // 由调用方注入 AnswerArchive
    this.lastEquipment = null; // 最近提到设备规模的对象，供「那台」承前
  }

  // 处理一句发言，返回本轮结果（供呈现）。
  process(utterance) {
    const { state, archive } = this;
    state.revision += 1;
    const turn = {
      utterance,
      revision: state.revision,
      interpretations: [],
      questions: [],
      evaluations: [],
      conditionalAnswers: [],
      changes: [],
    };
    const sentences = parseUtterance(utterance, this.places);

    for (const sentence of sentences) {
      // 句内地点继承：没提地点的子句跟随本句先出现的地点。
      const sentencePlace = sentence.clauses.map(c => c.place).find(p => p) ?? null;
      if (sentence.hypothetical || sentence.question) {
        this.processHypothetical(sentence, sentencePlace, turn);
        continue;
      }
      for (const clause of sentence.clauses) {
        this.applyClause(clause, sentencePlace, turn);
      }
    }

    this.evaluateAll(turn);
    turn.changes = archive.refresh(state);
    return turn;
  }

  interpret(turn, text, source) {
    turn.interpretations.push({ text, source });
  }

  // ---- 方案变更的应用 ----

  applyClause(clause, sentencePlace, turn) {
    const { state } = this;
    const place = clause.place ?? sentencePlace;
    const src = clause.source;

    if (clause.negation?.scopeAmbiguous) {
      state.ask({
        kind: 'negation-scope',
        text: `「${clause.text}」中否定的范围到哪？（涉及：${clause.negation.activities.map(a => ACTIVITY_LABEL[a]).join('、')}${clause.negation.phases.map(p => PHASE_LABEL[p]).join('、')}）`,
        source: src,
      });
      this.interpret(turn, `否定范围不清，暂不改动方案，待经办人划定`, src);
      return;
    }

    if (clause.directives.includes('unset') && clause.floor) {
      const option = place ? state.ensureOption(place) : this.focusOption();
      if (!option) return;
      const { superseded } = state.addFact('floor', option.key, { value: null }, src, '经办人表示楼层还没定');
      option.floor = null;
      this.interpret(turn, `清掉「${option.label}」原先确认的楼层${superseded.length ? `（原为${superseded[0].payload.value}层）` : ''}`, src);
      state.focus = { optionKey: option.key, activity: state.focus?.activity ?? null };
      return;
    }

    if (clause.directives.includes('withdraw')) {
      const phase = clause.phase;
      let count = 0;
      for (const option of state.options.values()) {
        for (const activity of option.activities.values()) {
          const active = [...state.activeFacts(option.key)].find(f =>
            f.kind === 'phase-status' && f.payload.activity === activity.id &&
            (phase == null || f.payload.phase === phase) && f.payload.status === 'active');
          if (!active) continue;
          state.addFact('phase-status', option.key,
            { activity: activity.id, phase: active.payload.phase, status: 'withdrawn' }, src, '经办人删除该阶段');
          const entry = activity.phases.get(active.payload.phase);
          if (entry) entry.status = 'withdrawn';
          count += 1;
        }
      }
      this.interpret(turn, `删除${phase ? PHASE_LABEL[phase] : '相关'}阶段（影响 ${count} 处方案内容）`, src);
      return;
    }

    if (clause.directives.includes('drop') && clause.activity) {
      const option = place ? state.ensureOption(place) : this.focusOption();
      if (!option) return;
      const activity = state.ensureActivity(option, clause.activity);
      state.addFact('activity-status', option.key, { activity: activity.id, status: 'dropped' }, src, '经办人表示先不做');
      activity.status = 'dropped';
      this.interpret(turn, `「${option.label}」暂不做${ACTIVITY_LABEL[clause.activity]}`, src);
      if (place?.ambiguous) this.askAlias(place, turn);
      // 已明确不可行的结论立刻给出，不等楼栋确认等无关信息。
      const advisory = evaluateSubject({
        places: this.places,
        rules: this.rules,
        candidates: option.candidates,
        floor: option.floor?.value ?? null,
        activity: clause.activity,
        phase: 'general',
        scale: null,
        features: activity.features,
      });
      if (advisory) {
        (turn.advisories ??= []).push({
          text: `若日后要在「${option.label}」做${ACTIVITY_LABEL[clause.activity]}，现有条目下的结论`,
          evaluation: advisory,
        });
      }
      return;
    }

    if (clause.directives.includes('equipment-anaphora') && clause.scale) {
      const target = this.lastEquipment;
      if (!target) {
        this.interpret(turn, `「那台」无所指，暂存规模待确认`, src);
        return;
      }
      const scale = this.resolveScale(clause.scale, turn, src);
      const option = state.options.get(target.optionKey);
      const activity = state.ensureActivity(option, target.activity);
      // 设备只有一台：指明阶段就改该阶段，否则覆盖该业态全部在册阶段，
      // 这样「改回原来的规模」能与早先事实逐条对上，早先答复才可恢复引用。
      const phases = clause.phase
        ? [clause.phase]
        : [...activity.phases.entries()].filter(([, p]) => p.status === 'active').map(([id]) => id);
      for (const phase of phases.length > 0 ? phases : ['any']) {
        state.addFact('scale', option.key,
          { activity: activity.id, phase, ...scale }, src, '「那台」承前指该设备');
        activity.scales.set(phase, scale);
      }
      state.answerWhere(q => q.kind === 'scale' && q.optionKey === option.key);
      const scaleText = scale.kg != null ? `每批${scale.kg}公斤` : `${scale.value}（单位未定）`;
      this.interpret(turn, `「${option.label}」${ACTIVITY_LABEL[activity.id]}的设备按${scaleText}算（承前句）`, src);
      return;
    }

    // 常规陈述：地点/楼层/业态/规模/阶段/备选或选定。
    if (place) {
      const option = state.ensureOption(place);
      if (place.ambiguous) this.askAlias(place, turn);

      state.addFact('place', option.key,
        { placeId: option.resolved, placeText: place.text, candidates: place.candidates }, src);
      if (clause.floor && !clause.floor.unset) {
        state.addFact('floor', option.key, { value: clause.floor.value }, src);
        option.floor = { value: clause.floor.value };
        state.answerWhere(q => q.kind === 'floor' && q.optionKey === option.key);
      }
      const modality = clause.directives.includes('alternative') ? 'alternative' : 'decided';
      if (clause.activity || clause.directives.includes('alternative') || clause.directives.includes('correction')) {
        state.addFact('modality', option.key, { modality }, src);
        option.modality = modality;
      }
      if (clause.activity) {
        const activity = state.ensureActivity(option, clause.activity);
        state.addFact('activity', option.key, { activity: clause.activity }, src);
        if (activity.status !== 'dropped') activity.status = 'planned';
        state.focus = { optionKey: option.key, activity: clause.activity };
        if (clause.activity === 'roasting') this.lastEquipment = { optionKey: option.key, activity: clause.activity };
      } else {
        state.focus = { optionKey: option.key, activity: state.focus?.activity ?? null };
      }

      const notes = [];
      notes.push(`「${option.label}」${clause.floor ? `${clause.floor.value}层` : ''}${clause.activity ? ACTIVITY_LABEL[clause.activity] : ''}`);
      if (clause.activity || clause.directives.includes('alternative') || clause.directives.includes('correction')) {
        notes.push(modality === 'alternative' ? '作为备选提出' : '作为选定陈述');
      }
      if (clause.directives.includes('correction')) notes.push('（对前述发言的归并更正）');
      if (clause.directives.includes('reaffirm')) notes.push('（重申维持原安排）');
      this.interpret(turn, notes.join('，'), src);
    }

    if (clause.scale && !clause.directives.includes('equipment-anaphora')) {
      const target = this.scaleTarget(clause, place);
      if (!target) {
        this.interpret(turn, `规模「${clause.scale.text}」找不到所属业态，待经办人指明`, src);
      } else {
        const scale = this.resolveScale(clause.scale, turn, src);
        const option = state.options.get(target.optionKey);
        const activity = state.ensureActivity(option, target.activity);
        const phase = clause.phase ?? 'any';
        if (clause.phase) this.ensurePhase(option, activity, clause.phase, src, clause);
        state.addFact('scale', option.key, { activity: activity.id, phase, ...scale }, src);
        activity.scales.set(phase, scale);
        state.answerWhere(q => q.kind === 'scale' && q.optionKey === option.key);
        this.lastEquipment = { optionKey: target.optionKey, activity: activity.id };
        this.interpret(turn,
          `「${option.label}」${ACTIVITY_LABEL[activity.id]}${clause.phase ? `·${PHASE_LABEL[clause.phase]}` : ''}规模：每批${scale.kg ?? `${scale.value}（单位未定）`}公斤${clause.directives.includes('tentative') ? '（经办人表示再说，暂缓）' : ''}`,
          src);
      }
    } else if (clause.phase && clause.activity) {
      const option = state.options.get(state.focus?.optionKey);
      if (option) this.ensurePhase(option, state.ensureActivity(option, clause.activity), clause.phase, src, clause);
    }
  }

  scaleTarget(clause, place) {
    const { state } = this;
    if (place && clause.activity) return { optionKey: state.optionKeyFor(place), activity: clause.activity };
    if (clause.activity && state.focus) return { optionKey: state.focus.optionKey, activity: clause.activity };
    if (state.focus?.activity) return state.focus;
    if (this.lastEquipment) return this.lastEquipment;
    return null;
  }

  ensurePhase(option, activity, phase, src, clause) {
    const { state } = this;
    const existing = [...state.activeFacts(option.key)].find(f =>
      f.kind === 'phase-status' && f.payload.activity === activity.id && f.payload.phase === phase);
    if (!existing) {
      state.addFact('phase-status', option.key, { activity: activity.id, phase, status: 'active' }, src,
        clause?.directives.includes('tentative') ? '经办人表示再说，暂缓' : null);
    }
    if (!activity.phases.has(phase)) activity.phases.set(phase, { status: 'active' });
  }

  focusOption() {
    const { state } = this;
    return state.focus ? state.options.get(state.focus.optionKey) : null;
  }

  // 单位缺失：跨过清单界限则提问，未跨过才按默认单位并注明。
  resolveScale(scale, turn, src) {
    if (!scale.unitMissing) return { value: scale.value, unit: scale.unit, kg: scale.kg };
    const outcomes = PLAUSIBLE_UNITS.map(unit => ({
      unit,
      kg: scale.value * UNITS[unit],
    }));
    const crosses = this.boundaries.some(b =>
      new Set(outcomes.map(o => compareOp(o.kg, b.op, b.kg))).size > 1);
    if (crosses) {
      const boundary = this.boundaries.find(b =>
        new Set(outcomes.map(o => compareOp(o.kg, b.op, b.kg))).size > 1);
      this.state.ask({
        kind: 'unit',
        text: `「${scale.text}」缺单位：是公斤还是斤？（影响是否触及 ${boundary.ruleId} 的界限）`,
        source: src,
      });
      this.interpret(turn, `规模「${scale.text}」单位缺失且会跨过清单界限，不替经办人默认`, src);
      return { value: scale.value, unit: null, kg: null };
    }
    this.interpret(turn, `规模「${scale.text}」未带单位，按各可能单位均不跨界限，暂按公斤计`, src);
    return { value: scale.value, unit: '公斤', kg: scale.value };
  }

  askAlias(place, turn) {
    const { state } = this;
    const detail = place.candidates.map(id => {
      const p = state.placeById(id);
      const uses = Object.entries(p.uses).map(([f, u]) => `${f}层${u}`).join('、');
      const exceptions = this.rules.filter(r => r.kind === 'exception' && r.target?.placeId === id).map(r => r.id);
      return `${p.aliases[0]}（${uses}${exceptions.length ? `；有定向例外 ${exceptions.join('、')}` : ''}）`;
    }).join('；');
    state.ask({
      kind: 'alias',
      text: `「${place.text}」指哪一栋？候选：${detail}`,
      source: null,
    });
  }

  // ---- 假设情形（要是……吗）：只评估，不改动方案 ----

  processHypothetical(sentence, sentencePlace, turn) {
    const merged = {
      place: null, floor: null, activity: null, phase: null, scale: null, features: [],
    };
    for (const clause of sentence.clauses) {
      merged.place ??= clause.place;
      merged.floor ??= clause.floor;
      merged.activity ??= clause.activity;
      merged.phase ??= clause.phase;
      merged.scale ??= clause.scale;
      merged.features.push(...clause.features);
    }
    merged.place ??= sentencePlace;
    const src = { utterance: sentence.utteranceId, sentence: sentence.text, clause: sentence.text };

    let activity = merged.activity;
    let inference = null;
    if (!activity && merged.scale) {
      activity = this.lastEquipment?.activity ?? 'roasting';
      inference = `未明说业态，按公斤级设备推断为${ACTIVITY_LABEL[activity]}`;
    }
    if (!merged.place || !activity || !merged.phase) {
      this.interpret(turn, '假设情形缺少地点、业态或阶段，无法评估，待经办人补足', src);
      return;
    }

    const scale = merged.scale ? this.resolveScale(merged.scale, turn, src) : null;
    const features = new Map(merged.features.map(f => [f.id, { present: f.present }]));
    const candidates = merged.place.candidates;
    const evaluation = evaluateSubject({
      places: this.places,
      rules: this.rules,
      candidates,
      floor: merged.floor?.value ?? null,
      activity,
      phase: merged.phase,
      scale,
      features,
    });
    const subject = {
      key: `hyp|${sentence.utteranceId}|${activity}|${merged.phase}`,
      label: `假设：${merged.place.text}${merged.floor ? `${merged.floor.value}层` : ''} ${ACTIVITY_LABEL[activity]}·${PHASE_LABEL[merged.phase] ?? merged.phase}`,
      hypothetical: true,
    };
    const basisFacts = [
      { kind: 'place', identity: '-', payload: { placeText: merged.place.text, candidates }, source: src, hypothetical: true },
      merged.floor ? { kind: 'floor', identity: '-', payload: { value: merged.floor.value }, source: src, hypothetical: true } : null,
      scale ? { kind: 'scale', identity: '-', payload: { activity, phase: merged.phase, ...scale }, source: src, hypothetical: true } : null,
      ...merged.features.map(f => ({ kind: 'feature', identity: '-', payload: { activity, feature: f.id, present: f.present }, source: src, hypothetical: true })),
    ].filter(Boolean);
    const { answer, isNew } = this.archive.issue({
      revision: this.state.revision,
      inResponseTo: sentence.utteranceId,
      subject,
      evaluation,
      basis: { facts: basisFacts, rules: citedRules(evaluation), stateRevision: this.state.revision },
      conditional: true,
    });
    turn.conditionalAnswers.push({ answer, isNew, evaluation, subject });
    this.interpret(turn, `假设情形：${subject.label}${inference ? `（${inference}）` : ''}，仅作条件答复，不纳入方案`, src);
    // 方案中已登记的同类设备规模与本假设不同时，提醒不能照搬结论。
    if (evaluation.verdict === 'feasible' &&
        evaluation.scenarios.some(s => s.prohibitions.some(p => p.status === 'lifted'))) {
      for (const option of this.state.options.values()) {
        for (const act of option.activities.values()) {
          if (act.id !== activity) continue;
          for (const committed of act.scales.values()) {
            if (committed.kg != null && scale?.kg != null && committed.kg !== scale.kg) {
              this.interpret(turn,
                `提醒：方案中已登记的同类设备为每批${committed.kg}公斤，不满足本假设的条件，该设备不能照搬本结论`, src);
            }
          }
        }
      }
    }
  }

  // ---- 评估与答复签发 ----

  evaluateAll(turn) {
    const { state, archive } = this;
    for (const option of state.options.values()) {
      for (const activity of option.activities.values()) {
        if (activity.status === 'dropped') continue;
        const phases = activity.phases.size > 0
          ? [...activity.phases.entries()].filter(([, p]) => p.status !== 'withdrawn').map(([id]) => id)
          : ['general'];
        for (const phase of phases) {
          const scale = activity.scales.get(phase) ?? activity.scales.get('any') ?? null;
          const evaluation = evaluateSubject({
            places: this.places,
            rules: this.rules,
            candidates: option.candidates,
            floor: option.floor?.value ?? null,
            activity: activity.id,
            phase,
            scale,
            features: activity.features,
          });
          if (!evaluation) continue;
          const subject = {
            key: `${option.key}|${activity.id}|${phase}`,
            label: `「${option.label}」${ACTIVITY_LABEL[activity.id]}·${PHASE_LABEL[phase] ?? '日常营业'}`,
            hypothetical: false,
          };
          const basis = {
            // 依据按本对象（业态+阶段）收窄：其他阶段的事实变动不牵连本答复。
            facts: state.activeFacts(option.key).filter(f => {
              if (f.payload.activity != null && f.payload.activity !== activity.id) return false;
              if ((f.kind === 'scale' || f.kind === 'phase-status') &&
                  f.payload.phase !== phase && f.payload.phase !== 'any') return false;
              return true;
            }),
            rules: citedRules(evaluation),
            stateRevision: state.revision,
          };
          const { answer, isNew } = archive.issue({
            revision: state.revision,
            inResponseTo: turn.utterance.id,
            subject,
            evaluation,
            basis,
          });
          turn.evaluations.push({ subject, evaluation, answer, isNew, option });
          // 评估暴露的待查实项 → 转成真正能区分结论的问题
          for (const q of subjectQuestions(option, activity.id, phase, evaluation, this.places)) {
            state.ask(q);
          }
          // 楼层未定且结论因楼层而异 → 楼层才是真正能区分结论的问题
          if (!evaluation.consistent && option.candidates.length === 1 && option.floor == null) {
            const place = this.places.find(p => p.id === option.candidates[0]);
            const uses = Object.entries(place?.uses ?? {}).map(([f, u]) => `${f}层（${u}）`).join('、');
            state.ask({
              kind: 'floor',
              optionKey: option.key,
              text: `「${option.label}」${ACTIVITY_LABEL[activity.id] ?? activity.id}在哪一层？${option.placeText}条目：${uses}，结论因楼层而异`,
              source: null,
            });
          }
        }
      }
    }
    turn.questions = state.openQuestions();
  }
}

function compareOp(value, op, threshold) {
  if (op === 'lt') return value < threshold;
  if (op === 'gt') return value > threshold;
  if (op === 'gte') return value >= threshold;
  return false;
}

function citedRules(evaluation) {
  const seen = new Map();
  const add = rule => { if (rule && !seen.has(rule.id)) seen.set(rule.id, { id: rule.id, text: rule.text }); };
  for (const s of evaluation.scenarios) {
    for (const p of s.prohibitions) {
      add(p.rule);
      for (const e of p.liftedByRules ?? []) add(e);
    }
    for (const o of s.obligations) add(o.rule);
    for (const e of s.exemptions) add(e.rule);
  }
  return [...seen.values()];
}

// 从评估的未知项生成问题：只问能改变结论的事实。
function subjectQuestions(option, activityId, phase, evaluation, places) {
  const questions = [];
  const where = `「${option.label}」${ACTIVITY_LABEL[activityId] ?? activityId}`;
  const facts = new Set(evaluation.scenarios.flatMap(s => s.unknowns.map(u => u.fact)));
  if (facts.has('scale')) {
    questions.push({ kind: 'scale', optionKey: option.key, text: `${where}的设备每批规模是多少公斤？`, source: null });
  }
  for (const s of evaluation.scenarios) {
    for (const u of s.unknowns) {
      if (u.fact === 'exception-condition') {
        questions.push({ kind: 'exception-condition', optionKey: option.key, text: `${where}：${u.detail}，请确认`, source: null });
      }
    }
  }
  return questions;
}
