// 对话状态：方案（含并行备选）、事实日志（每条带出处原句与生效状态）、待答问题。
// 事实一旦被替代或撤回不删除，只改状态，供答复档案追溯「当时的选项、事实及依据」。

export class DialogueState {
  constructor(places) {
    this.places = places;
    this.revision = 0;
    this.options = new Map(); // optionKey → option
    this.facts = []; // 全部事实（含已被替代/撤回的）
    this.factSeq = 0;
    this.questions = []; // 已向经办人提出、尚未回答的问题
    this.focus = null; // 最近一次谈到的 { optionKey, activity }，供「那台」等承前指代
  }

  placeById(id) {
    return this.places.find(p => p.id === id) ?? null;
  }

  // 别名解析：唯一 → 楼栋键；多候选 → 挂到 alias: 键下，不替经办人选定。
  optionKeyFor(place) {
    return place.candidates.length === 1 ? place.candidates[0] : `alias:${place.text}`;
  }

  ensureOption(place) {
    const key = this.optionKeyFor(place);
    if (!this.options.has(key)) {
      const resolved = place.candidates.length === 1 ? place.candidates[0] : null;
      this.options.set(key, {
        key,
        placeText: place.text,
        candidates: [...place.candidates],
        resolved,
        label: resolved ? (this.placeById(resolved)?.aliases[0] ?? place.text) : `${place.text}（待确认）`,
        modality: null,
        floor: null, // { value } | null（未定）
        activities: new Map(),
      });
    }
    return this.options.get(key);
  }

  ensureActivity(option, activityId) {
    if (!option.activities.has(activityId)) {
      option.activities.set(activityId, {
        id: activityId,
        status: 'planned', // planned | dropped
        scales: new Map(), // phase|'any' → { value, unit, kg, unitMissing, factId }
        features: new Map(), // featureId → { present, factId }
        phases: new Map(), // phase → { status: 'active'|'withdrawn', factId }
      });
    }
    return option.activities.get(activityId);
  }

  // 登记事实并替代同身份的旧事实。身份 = 种类 + 方案 + 业态 + 阶段。
  addFact(kind, optionKey, payload, source, note = null) {
    const identity = factIdentity({ kind, optionKey, ...payload });
    const superseded = [];
    for (const fact of this.facts) {
      if (fact.status === 'active' && fact.identity === identity) {
        fact.status = 'superseded';
        superseded.push(fact);
      }
    }
    const fact = {
      id: `F${++this.factSeq}`,
      kind,
      optionKey,
      payload,
      identity,
      source, // { utterance, sentence, clause }
      note,
      status: 'active', // active | superseded | withdrawn
      revision: this.revision,
    };
    this.facts.push(fact);
    return { fact, superseded };
  }

  withdrawFacts(identityPrefix, source, note) {
    const withdrawn = [];
    for (const fact of this.facts) {
      if (fact.status === 'active' && fact.identity.startsWith(identityPrefix)) {
        fact.status = 'withdrawn';
        fact.withdrawnAt = this.revision;
        fact.withdrawSource = source;
        withdrawn.push(fact);
      }
    }
    return withdrawn;
  }

  activeFacts(optionKey = null) {
    return this.facts.filter(f => f.status === 'active' && (optionKey === null || f.optionKey === optionKey));
  }

  ask(question) {
    // 同一问题不重复追问
    if (!this.questions.some(q => q.text === question.text)) {
      this.questions.push({ ...question, atRevision: this.revision, answered: false });
    }
  }

  // 事实到达后勾销已答问题（如楼层、规模得到确认）。
  answerWhere(predicate) {
    const answered = [];
    for (const q of this.questions) {
      if (!q.answered && predicate(q)) {
        q.answered = true;
        answered.push(q);
      }
    }
    return answered;
  }

  openQuestions() {
    return this.questions.filter(q => !q.answered);
  }
}

export function factIdentity(parts) {
  return [parts.kind, parts.optionKey, parts.activity ?? '-', parts.phase ?? '-', parts.feature ?? '-'].join('|');
}

// 当前生效事实是否与某条历史事实同身份同取值（答复可引用性判断用）。
export function factMatches(fact, payload) {
  return JSON.stringify(fact.payload) === JSON.stringify(payload);
}
