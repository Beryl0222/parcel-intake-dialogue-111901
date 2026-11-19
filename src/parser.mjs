// 发言解析：一句发言 → 若干子句，每个子句抽出地点、楼层、业态、规模、阶段、
// 语气（备选/选定/假设/撤销）与否定范围。每条抽取结果都带来源原句。

import { ACTIVITIES, FEATURES, PHASES, UNITS, matchByTerms, parseNumber } from './lexicon.mjs';

// 按句末标点分句，再按逗号分子句；句级语气（疑问/假设）由子句共享。
export function parseUtterance(utterance, places) {
  const sentences = [];
  const parts = utterance.text.split(/(?<=[。！？；?])/u).map(s => s.trim()).filter(Boolean);
  parts.forEach((sentenceText, i) => {
    const sentence = {
      id: `${utterance.id}.s${i + 1}`,
      utteranceId: utterance.id,
      text: sentenceText,
      question: /吗[？?]?$|？|\?/.test(sentenceText),
      hypothetical: /要是|如果|若/.test(sentenceText),
      clauses: [],
    };
    const clauseTexts = sentenceText.split(/[，,]/).map(s => s.trim()).filter(Boolean);
    sentence.clauses = clauseTexts.map((clauseText, j) =>
      parseClause(clauseText, `${sentence.id}.c${j + 1}`, sentence, utterance, places));
    sentences.push(sentence);
  });
  return sentences;
}

function parseClause(text, id, sentence, utterance, places) {
  const clause = {
    id,
    text,
    source: { utterance: utterance.id, sentence: sentence.text, clause: text },
    place: detectPlace(text, places),
    floor: detectFloor(text),
    activity: firstMatch(text, ACTIVITIES),
    phase: firstMatch(text, PHASES),
    scale: detectScale(text),
    features: detectFeatures(text),
    directives: detectDirectives(text),
    negation: detectNegation(text),
    refersPrior: /上面说|前面说|照旧|那台|这台|该设备/.test(text),
    sentence: { question: sentence.question, hypothetical: sentence.hypothetical },
  };
  return clause;
}

function detectPlace(text, places) {
  const hits = [];
  for (const place of places) {
    for (const alias of place.aliases) {
      const at = text.indexOf(alias);
      if (at >= 0) hits.push({ alias, at, placeId: place.id });
    }
  }
  if (hits.length === 0) return null;
  hits.sort((a, b) => a.at - b.at || b.alias.length - a.alias.length);
  const alias = hits[0].alias;
  const candidates = places.filter(p => p.aliases.includes(alias)).map(p => p.id);
  return { text: alias, candidates, ambiguous: candidates.length > 1 };
}

function detectFloor(text) {
  const m = text.match(/([一二两三四五六七八九十\d]+)\s*(?:层|楼)/);
  if (!m) return null;
  const value = parseNumber(m[1]);
  if (value == null) return null;
  const unset = /还没定|未定|待定/.test(text);
  return { value, unset };
}

function firstMatch(text, entries) {
  const hits = matchByTerms(text, entries);
  return hits.length > 0 ? hits[0].entry.id : null;
}

// 规模：数字+单位；单位缺失时，仅当数字后紧跟「的/算」或句读才认作规模，
// 避免把「二层」「一楼」误当数值。
function detectScale(text) {
  const re = /([零一二两三四五六七八九十百\d]+(?:\.\d+)?)\s*(公斤|千克|克|斤)?/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const value = parseNumber(m[1]);
    if (value == null) continue;
    const unit = m[2] ?? null;
    const after = text[m.index + m[0].length] ?? '';
    if (!unit && !['的', '算', '，', '。', '', '再'].includes(after)) continue;
    // 排除楼层表达（数字后紧跟 层/楼）
    if (['层', '楼'].includes(after)) continue;
    return {
      value,
      unit,
      kg: unit ? value * UNITS[unit] : null,
      unitMissing: !unit,
      text: m[0],
    };
  }
  return null;
}

function detectFeatures(text) {
  const out = [];
  for (const feature of FEATURES) {
    for (const term of feature.terms) {
      if (!text.includes(term)) continue;
      const absent = new RegExp(`(?:无|没有|未设)${term}`).test(text);
      out.push({ id: feature.id, present: !absent });
    }
  }
  return out;
}

function detectDirectives(text) {
  const directives = [];
  if (/还没定|未定|待定/.test(text)) directives.push('unset');
  if (/删掉|取消/.test(text)) directives.push('withdraw');
  if (/先不做|不再做|不做/.test(text)) directives.push('drop');
  if (/照旧|按原计划|还是要|仍要/.test(text)) directives.push('reaffirm');
  if (/备选/.test(text)) directives.push('alternative');
  if (/上面说|前面说/.test(text)) directives.push('correction');
  if (/那台|这台|该设备/.test(text)) directives.push('equipment-anaphora');
  if (/再说/.test(text)) directives.push('tentative');
  return directives;
}

// 否定范围：否定词后同时出现业态与阶段/规模、或多个业态时，范围可能不清，
// 交给对话层提问，不替经办人划定。
function detectNegation(text) {
  const m = text.match(/不|没|别/);
  if (!m) return null;
  const rest = text.slice(m.index);
  const activities = matchByTerms(rest, ACTIVITIES).map(h => h.entry.id);
  const phases = matchByTerms(rest, PHASES).map(h => h.entry.id);
  const uniqueActivities = [...new Set(activities)];
  // 范围不清的两种典型：业态+阶段/规模连写（不知否定到哪儿）；
  // 或多个业态连写却没有「和/与」连接（不知是否都在否定内）。
  // 子句已按逗号切开，句末标点不影响判断。
  const scopeAmbiguous =
    (uniqueActivities.length >= 2 && !/和|与|以及/.test(rest)) ||
    (uniqueActivities.length === 1 && (phases.length > 0 || detectScale(rest) !== null));
  return {
    word: m[0],
    activities: uniqueActivities,
    phases: [...new Set(phases)],
    scopeAmbiguous,
  };
}
