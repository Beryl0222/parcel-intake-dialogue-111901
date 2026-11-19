// 领域词表与中文数词解析。
// 只认清单、楼栋条目和现场发言中出现过的说法，不替经办人臆造词义。

export const ACTIVITIES = [
  { id: 'roasting', label: '焙豆（营业性烘焙）', terms: ['营业性烘焙', '焙豆', '烘焙'] },
  { id: 'cafe', label: '开咖啡馆', terms: ['咖啡馆', '咖啡'] },
];

export const PHASES = [
  { id: 'trial', label: '试营业（试运行）', terms: ['试营业', '试运行'] },
  { id: 'expansion', label: '扩容', terms: ['扩容', '扩到'] },
  { id: 'operation', label: '正式投运', terms: ['正式投运', '投运'] },
];

export const FEATURES = [
  { id: '封闭排气', terms: ['封闭排气'] },
];

// 用地类别来自楼栋条目（places.uses）的取值集合。
export const LAND_USES = ['研发', '街铺', '生产'];

// 规模单位 → 千克换算。设备批量的合理单位只考虑公斤与斤；
// 单位缺失且不同单位会跨过清单界限时，必须提问而不是默认。
export const UNITS = { 公斤: 1, 千克: 1, 斤: 0.5, 克: 0.001 };
export const DEFAULT_UNIT = '公斤';
export const PLAUSIBLE_UNITS = ['公斤', '斤'];

const CN_DIGIT = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

// 解析中文或阿拉伯数字（覆盖清单与发言中出现的：七、八、十、十五、二十等）。
export function parseNumber(text) {
  if (text == null) return null;
  const t = String(text).trim();
  if (t === '') return null;
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  if (t.includes('十')) {
    const [left, right] = t.split('十');
    const tens = left === '' ? 1 : CN_DIGIT[left];
    const ones = right === '' ? 0 : CN_DIGIT[right];
    if (tens == null || ones == null) return null;
    return tens * 10 + ones;
  }
  if (t.length === 1 && CN_DIGIT[t] != null) return CN_DIGIT[t];
  return null;
}

export function formatKg(kg) {
  return `${kg}公斤`;
}

// 按词条长度从长到短扫描，避免「咖啡」抢在「咖啡馆」前面。
export function matchByTerms(text, entries) {
  const hits = [];
  for (const entry of entries) {
    for (const term of [...entry.terms].sort((a, b) => b.length - a.length)) {
      const at = text.indexOf(term);
      if (at >= 0) hits.push({ entry, term, at });
    }
  }
  hits.sort((a, b) => a.at - b.at || b.term.length - a.term.length);
  return hits;
}
