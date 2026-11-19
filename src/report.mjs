// 呈现：把每轮结果与答复档案渲染成窗口用语。
// 四类结论分栏：确定可行 / 调整才可能解除阻碍 / 仍须查实 / 可行后还要做什么。

const VERDICT_LABEL = { feasible: '确定可行', blocked: '不可行', pending: '仍须查实' };

export function renderTurn(turn) {
  const lines = [];
  lines.push(`\n════════ 发言 ${turn.utterance.id} ════════`);
  lines.push(`原句：${turn.utterance.text}`);

  if (turn.interpretations.length > 0) {
    lines.push('\n【理解】（每条附所依据的原句）');
    turn.interpretations.forEach((it, i) => {
      lines.push(`  ${i + 1}. ${it.text}`);
      lines.push(`     依据原句：「${it.source.clause ?? it.source.sentence}」`);
    });
  }

  const answerBlocks = [];
  for (const ev of turn.evaluations) {
    answerBlocks.push(...renderEvaluation(ev.subject, ev.evaluation, ev.answer, ev.isNew));
  }
  for (const ca of turn.conditionalAnswers) {
    answerBlocks.push(...renderEvaluation(ca.subject, ca.evaluation, ca.answer, ca.isNew));
  }
  for (const ad of turn.advisories ?? []) {
    answerBlocks.push(`  ◇ 备查：${ad.text}`);
    answerBlocks.push(...renderScenarios(ad.evaluation, '    '));
  }
  if (answerBlocks.length > 0) {
    lines.push('\n【答复】');
    lines.push(...answerBlocks);
  }

  if (turn.changes.length > 0) {
    lines.push('\n【早先答复的处置】');
    for (const change of turn.changes) {
      if (change.nowCitable) {
        lines.push(`  ↻ ${change.answer.id}（${change.answer.subject.label}）恢复可引用`);
      } else {
        lines.push(`  ✕ ${change.answer.id}（${change.answer.subject.label}）必须收回：`);
        for (const r of change.reasons) lines.push(`      - ${r}`);
        lines.push(`      已带走的答复仍按当时依据存档，可供查询`);
      }
    }
  }

  const fresh = turn.questions.filter(q => q.atRevision === turn.revision);
  const standing = turn.questions.filter(q => q.atRevision !== turn.revision);
  if (fresh.length > 0 || standing.length > 0) {
    lines.push('\n【待经办人确认】（先给出上列现有事实允许的结论，再问能区分结论的问题）');
    for (const q of fresh) lines.push(`  ？ ${q.text}`);
    for (const q of standing) lines.push(`  ？（仍未回答）${q.text}`);
  }
  return lines.join('\n');
}

function renderEvaluation(subject, evaluation, answer, isNew) {
  const lines = [];
  const tag = answer ? `${answer.id}${isNew ? '' : '（沿用）'}` : '';
  lines.push(`  ■ ${tag} ${subject.label}：${VERDICT_LABEL[evaluation.verdict]}`);
  lines.push(...renderScenarios(evaluation, '    '));
  return lines;
}

function renderScenarios(evaluation, indent) {
  const lines = [];
  const multi = evaluation.scenarios.length > 1;
  for (const s of evaluation.scenarios) {
    const where = multi ? `${s.placeLabel}${s.floor}层（${s.landUse ?? '用途未列'}）：` : '';
    if (multi) lines.push(`${indent}· 若指${where}${VERDICT_LABEL[s.verdict]}`);
    for (const p of s.prohibitions) {
      const mark = p.status === 'applies' ? '禁止' : p.status === 'lifted' ? '解除' : '待定';
      lines.push(`${indent}  - [${mark}] ${p.detail}`);
    }
    for (const u of s.unknowns) lines.push(`${indent}  - 待查实：${u.detail}`);
    for (const n of s.notes) lines.push(`${indent}  - 提示：${n}`);
    for (const a of s.adjustments ?? []) lines.push(`${indent}  - 可尝试的调整：${a}`);
    for (const st of s.nextSteps ?? []) lines.push(`${indent}  - 还要做：${st}`);
  }
  if (evaluation.divergent) {
    lines.push(`${indent}  → 各候选结论方向一致但细节有别，差异部分仍须查实`);
  }
  return lines;
}

export function renderArchive(archive, state) {
  const lines = ['\n════════ 答复档案 ════════'];
  const list = archive.list(state);
  if (list.length === 0) return `${lines[0]}\n（空）`;
  for (const { answer, citable, reasons } of list) {
    const status = answer.conditional ? '条件答复（假设情形）' : citable ? '仍可引用' : '必须收回';
    lines.push(`  ${answer.id} [${status}] ${answer.subject.label} —— 答复于 ${answer.inResponseTo}（状态修订 ${answer.revisionIssued}）`);
    lines.push(`    结论：${VERDICT_LABEL[answer.evaluation.verdict]}`);
    if (!citable && !answer.conditional) {
      for (const r of reasons) lines.push(`    收回原因：${r}`);
    }
  }
  return lines.join('\n');
}

export function renderAnswerDetail(answer, state, citability) {
  const lines = [`答复 ${answer.id} —— ${answer.subject.label}`];
  lines.push(`答复于发言 ${answer.inResponseTo}，当时状态修订 ${answer.basis.stateRevision}`);
  lines.push(`当前状态：${answer.conditional ? '条件答复（依据为假设条件本身）' : citability.citable ? '仍可引用' : '必须收回'}`);
  if (!citability.citable) for (const r of citability.reasons) lines.push(`  收回原因：${r}`);
  lines.push('当时的选项、事实及依据（已带走的答复按此存档）：');
  for (const f of answer.basis.facts) {
    const src = f.source ? `（${f.source.utterance}：「${f.source.clause ?? f.source.sentence}」）` : '';
    lines.push(`  · ${f.kind} ${JSON.stringify(f.payload)}${f.hypothetical ? '［假设］' : ''} ${src}`);
  }
  for (const r of answer.basis.rules) {
    lines.push(`  · 清单 ${r.id}：${r.text}`);
  }
  lines.push(`结论：${VERDICT_LABEL[answer.evaluation.verdict]}`);
  lines.push(...renderScenarios(answer.evaluation, '  '));
  return lines.join('\n');
}

export function renderState(state) {
  const lines = ['\n════════ 当前方案 ════════'];
  for (const option of state.options.values()) {
    const modality = option.modality === 'alternative' ? '备选' : option.modality === 'decided' ? '选定' : '未定性';
    const floor = option.floor ? `${option.floor.value}层` : '楼层未定';
    lines.push(`  「${option.label}」（${modality}，${floor}，候选：${option.candidates.join('/')}）`);
    for (const activity of option.activities.values()) {
      const scales = [...activity.scales.entries()].map(([p, s]) => `${p}:每批${s.kg ?? `${s.value}?`}公斤`).join('，');
      lines.push(`    - ${activity.id}：${activity.status === 'dropped' ? '暂不做' : '计划'}${scales ? `；规模 ${scales}` : ''}`);
    }
  }
  if (state.questions.length > 0) {
    lines.push('  待确认问题：');
    for (const q of state.questions) lines.push(`    ？ ${q.text}`);
  }
  return lines.join('\n');
}
