import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { createResult, finishResult } from '../mcp/codebox.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = (rel) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(load('schemas/codebox-telemetry.schema.json'));
ajv.addSchema(load('schemas/codebox-result.schema.json'));

function check(id, doc) {
  const validate = ajv.getSchema(id);
  assert.ok(validate(doc), JSON.stringify(validate.errors, null, 2));
}

for (const lang of ['ts', 'py', 'go', 'rs', 'zig']) {
  test(`telemetry document of the ${lang} runner matches codebox.telemetry/v1`, () => {
    check('urn:codebox:telemetry:v1', load(`test/fixtures/telemetry/${lang}.json`));
  });
}

test('aggregated run result matches codebox.result/v1', () => {
  check('urn:codebox:result:v1', load('test/fixtures/codebox-result.json'));
});

test('a fresh result document matches codebox.result/v1', () => {
  const doc = finishResult(createResult({ tool: 'codebox_index', box: 'demo', receivedVia: 'websocket', responseChannel: 'nats', responsePath: 'x.y' }));
  check('urn:codebox:result:v1', doc);
});
