// 窗口咨询演练入口。
//   node scripts/consult.mjs [run] [--inputs 路径]   批量演练资料中的发言（默认）
//   node scripts/consult.mjs repl [--inputs 路径]    交互演练：先跑资料发言，再逐句输入
//   node scripts/consult.mjs answers [--inputs 路径] 演练后列出答复档案
//   node scripts/consult.mjs answer A2 [--inputs 路径] 查看单条答复当时的选项、事实及依据
import { createInterface } from 'node:readline/promises';
import { stdin, stdout, argv } from 'node:process';
import { pathToFileURL } from 'node:url';
import { readInputs } from './inspect.mjs';
import { compileRuleset } from '../src/ruleset.mjs';
import { DialogueState } from '../src/state.mjs';
import { AnswerArchive } from '../src/answers.mjs';
import { Dialogue } from '../src/dialogue.mjs';
import { renderTurn, renderArchive, renderAnswerDetail, renderState } from '../src/report.mjs';

function argValue(args, name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

export function buildSession(data) {
  const rules = compileRuleset(data.rules, data.places);
  const state = new DialogueState(data.places);
  const archive = new AnswerArchive();
  const dialogue = new Dialogue({ places: data.places, rules });
  dialogue.state = state;
  dialogue.archive = archive;
  return { dialogue, state, archive, rules };
}

function runUtterances(dialogue, utterances, { quiet = false } = {}) {
  const turns = [];
  for (const utterance of utterances) {
    const turn = dialogue.process(utterance);
    turns.push(turn);
    if (!quiet) console.log(renderTurn(turn));
  }
  return turns;
}

async function main() {
  const args = argv.slice(2);
  const command = ['run', 'repl', 'answers', 'answer'].includes(args[0]) ? args[0] : 'run';
  const inputsPath = argValue(args, '--inputs', new URL('../data/inputs.json', import.meta.url).pathname);
  const data = await readInputs(inputsPath);
  const { dialogue, state, archive } = buildSession(data);

  if (command === 'run') {
    runUtterances(dialogue, data.utterances);
    console.log(renderArchive(archive, state));
    return;
  }

  if (command === 'answers') {
    runUtterances(dialogue, data.utterances, { quiet: true });
    console.log(renderArchive(archive, state));
    return;
  }

  if (command === 'answer') {
    const id = args[1];
    runUtterances(dialogue, data.utterances, { quiet: true });
    const answer = archive.find(id);
    if (!answer) {
      console.log(`查无答复 ${id}。现有：${archive.answers.map(a => a.id).join('、')}`);
      process.exitCode = 1;
      return;
    }
    console.log(renderAnswerDetail(answer, state, archive.citability(answer, state)));
    return;
  }

  // repl：先按资料演练，再由经办人逐句续谈。
  runUtterances(dialogue, data.utterances);
  console.log(renderArchive(archive, state));
  console.log('\n进入交互演练。输入发言继续咨询；:state 看方案，:answers 看档案，:answer A1 看依据，:rules 看清单，:quit 退出。');
  const rl = createInterface({ input: stdin, output: stdout, prompt: '经办> ' });
  let seq = data.utterances.length;
  rl.prompt();
  for await (const line of rl) {
    const text = line.trim();
    if (!text) { rl.prompt(); continue; }
    if (text === ':quit') break;
    if (text === ':state') console.log(renderState(state));
    else if (text === ':answers') console.log(renderArchive(archive, state));
    else if (text.startsWith(':answer ')) {
      const answer = archive.find(text.slice(8).trim());
      console.log(answer ? renderAnswerDetail(answer, state, archive.citability(answer, state)) : '查无此答复');
    } else if (text === ':rules') {
      for (const r of dialogue.rules) console.log(`  ${r.id} [${r.kind}] ${r.text}`);
    } else {
      seq += 1;
      const turn = dialogue.process({ id: `U${seq}`, text });
      console.log(renderTurn(turn));
    }
    rl.prompt();
  }
  rl.close();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
