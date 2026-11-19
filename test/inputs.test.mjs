import test from 'node:test';
import assert from 'node:assert/strict';
import { readInputs } from '../scripts/inspect.mjs';

const data = await readInputs();

test("简称可以同时属于不同楼栋", () => {
  const owners = data.places.filter(p => p.aliases.includes('北馆'));
  assert.deepEqual(owners.map(p => p.id), ['north-a', 'north-b']);
  assert.ok(data.rules.some(rule => /P1/.test(rule.text) && rule.id !== 'P1'));
});
