// 把园区合成清单的原文编译成结构化条目。
// 每条编译结果都保留清单引用号 id 与原文 text，答复引用时两者一起给出。
// 编译不出的条目不丢弃，标记为 unparsed，评估时按「仍须查实」处理。

import { ACTIVITIES, LAND_USES, PHASES, parseNumber } from './lexicon.mjs';

function mapActivity(text) {
  for (const a of ACTIVITIES) {
    if (a.terms.some(t => text.includes(t))) return a.id;
  }
  return null;
}

function mapPhase(text) {
  for (const p of PHASES) {
    if (p.terms.some(t => text.includes(t))) return p.id;
  }
  return null;
}

function mapLandUse(text) {
  for (const u of LAND_USES) {
    if (text.includes(u)) return u;
  }
  return null;
}

// 解析「北楼一层」这类例外适用位置：别名 → 楼栋，层 → 楼层号。
// 别名若指向多栋楼，例外目标存疑，整条按 unparsed 处理并说明原因。
function resolveTarget(text, places) {
  for (const place of places) {
    for (const alias of place.aliases) {
      if (text.includes(alias)) {
        const m = text.match(/([一二两三四五六七八九十\d]+)\s*(?:层|楼)/);
        return { placeId: place.id, floor: m ? parseNumber(m[1]) : null, text };
      }
    }
  }
  return null;
}

// 解析例外条件段，如「设备每批不足八千克且有封闭排气」。
function parseConditions(text) {
  const conditions = [];
  for (const seg of text.split('且')) {
    const scale = seg.match(/每批(不足|超过|达到)([零一二两三四五六七八九十百\d]+)(千克|公斤|斤|克)/);
    if (scale) {
      conditions.push({
        fact: 'scale',
        op: scale[1] === '不足' ? 'lt' : scale[1] === '超过' ? 'gt' : 'gte',
        value: parseNumber(scale[2]),
        unit: scale[3],
        text: seg.trim(),
      });
      continue;
    }
    const feature = seg.match(/有(.+)/);
    if (feature) {
      conditions.push({ fact: 'feature', value: feature[1].trim(), text: seg.trim() });
      continue;
    }
    conditions.push({ fact: 'unparsed', text: seg.trim() });
  }
  return conditions;
}

function compileException(rule, match, places) {
  const [, whereText, condText, refId, scopeText] = match;
  const target = resolveTarget(whereText, places);
  if (!target) {
    return { ...base(rule, 'unparsed'), notes: [`例外适用位置「${whereText}」无法对应楼栋条目`] };
  }
  return {
    ...base(rule, 'exception'),
    scope: 'targeted',
    target,
    modifies: [refId],
    phase: mapPhase(scopeText),
    conditions: parseConditions(condText),
    notes: [`仅改变 ${refId} 在适用条件成立时的结论，其余条目不受影响`],
  };
}

function base(rule, kind) {
  return {
    id: rule.id,
    text: rule.text,
    kind,
    scope: 'general',
    target: null,
    modifies: [],
    match: {},
    conditions: [],
    effect: {},
    phase: null,
    notes: [],
  };
}

// 支持的清单句式：
//   禁止：    「研发用地禁止营业性烘焙。」
//   手续免除：「街铺开设咖啡馆可免一般咨询材料。」
//   投运条件：「生产用地焙豆设备超过每批十五千克的，须完成隔声验收后才能投运。」
//   定向例外：「北楼一层只有设备每批不足八千克且有封闭排气时，P1 对该设备试运行不适用。」
export function compileRule(rule, places) {
  const text = rule.text.trim();

  let m = text.match(/^(.+?)只有(.+?)时，(P\d+)\s*对(.+?)不适用。$/);
  if (m) return compileException(rule, m, places);

  m = text.match(/^(.+?)禁止(.+?)。$/);
  if (m) {
    const activity = mapActivity(m[2]);
    const landUse = mapLandUse(m[1]);
    if (activity && landUse) {
      return {
        ...base(rule, 'prohibition'),
        match: { landUse, activity },
        effect: { prohibits: '开展该经营' },
      };
    }
    return { ...base(rule, 'unparsed'), notes: ['禁止对象或用地类别无法识别'] };
  }

  m = text.match(/^(.+?)开设(.+?)可免(.+?)。$/);
  if (m) {
    const activity = mapActivity(m[2]);
    const landUse = mapLandUse(m[1]);
    if (activity && landUse) {
      return {
        ...base(rule, 'procedure-exemption'),
        match: { landUse, activity },
        effect: { exempts: [m[3].trim()] },
        notes: ['免办手续不等于准许投运，两者分开判断'],
      };
    }
    return { ...base(rule, 'unparsed'), notes: ['免除对象或用地类别无法识别'] };
  }

  m = text.match(/^(.+?)设备超过每批([零一二两三四五六七八九十百\d]+)(千克|公斤|斤|克)的，须完成(.+?)后才能投运。$/);
  if (m) {
    const activity = mapActivity(m[1]);
    const landUse = mapLandUse(m[1]);
    if (activity && landUse) {
      return {
        ...base(rule, 'operation-condition'),
        match: { landUse, activity, scale: { op: 'gt', value: parseNumber(m[2]), unit: m[3] } },
        effect: { requires: [{ item: m[4].trim(), before: '投运' }] },
        notes: ['这是投运前提，不是手续'],
      };
    }
    return { ...base(rule, 'unparsed'), notes: ['投运条件的对象或用地类别无法识别'] };
  }

  return { ...base(rule, 'unparsed'), notes: ['句式不在已支持的清单句型内'] };
}

export function compileRuleset(rules, places) {
  return rules.map(rule => compileRule(rule, places));
}

// 从已编译条目收集全部规模界限（千克），用于「单位缺失是否跨过界限」的判断。
export function scaleBoundariesKg(compiled) {
  const toKg = { 公斤: 1, 千克: 1, 斤: 0.5, 克: 0.001 };
  const out = [];
  for (const rule of compiled) {
    if (rule.match?.scale) {
      out.push({ kg: rule.match.scale.value * toKg[rule.match.scale.unit], ruleId: rule.id, op: rule.match.scale.op });
    }
    for (const c of rule.conditions ?? []) {
      if (c.fact === 'scale') out.push({ kg: c.value * toKg[c.unit], ruleId: rule.id, op: c.op });
    }
  }
  return out;
}
