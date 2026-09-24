import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';
import { CodeboxConfigError, loadCodeboxConfig, resolveBox } from '../tools/codebox/lib/boxes.mjs';
import { renderBox } from '../tools/codebox/render.mjs';

function tmpConfig(doc) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebox-cfg-'));
  const file = path.join(dir, 'codebox.yml');
  fs.writeFileSync(file, YAML.stringify(doc));
  return { dir, file };
}

test('repository config: every declared box is valid', () => {
  const config = loadCodeboxConfig();
  for (const alias of Object.keys(config.boxes)) {
    const box = resolveBox(config, alias);
    assert.ok(box.languages.length >= 1, alias);
    assert.ok(box.init.length >= 1, alias);
  }
});

test('resolveBox: normalizes language aliases and merges defaults', () => {
  const { file } = tmpConfig({
    defaults: { resources: { cpus: '1.0' } },
    boxes: { demo: { languages: ['ts', 'py', 'rs', 'golang', 'zig'], resources: { memory: '1g' }, init: [{ path: 'a.py', content: 'print(1)' }] } },
  });
  const box = resolveBox(loadCodeboxConfig(file), 'demo');
  assert.deepEqual(box.languages, ['typescript', 'python', 'rust', 'go', 'zig']);
  assert.equal(box.resources.cpus, '1.0');
  assert.equal(box.resources.memory, '1g');
  assert.equal(box.container, 'codebox-demo');
});

test('resolveBox: requires at least one language and one init code', () => {
  const { file } = tmpConfig({ boxes: { empty: { languages: [], init: [] } } });
  assert.throws(() => resolveBox(loadCodeboxConfig(file), 'empty'), (err) => {
    assert.ok(err instanceof CodeboxConfigError);
    assert.match(err.message, /at least one language/);
    assert.match(err.message, /at least one init code/);
    return true;
  });
});

test('resolveBox: rejects unknown languages, escaping paths and init files of other languages', () => {
  const { file } = tmpConfig({
    boxes: {
      bad: {
        languages: ['python', 'cobol'],
        init: [
          { path: '../evil.py', content: 'x' },
          { path: 'main.go', content: 'package main' },
          { path: 'ok.py' },
        ],
      },
    },
  });
  assert.throws(() => resolveBox(loadCodeboxConfig(file), 'bad'), (err) => {
    assert.match(err.message, /unsupported language "cobol"/);
    assert.match(err.message, /escapes codes/);
    assert.match(err.message, /main\.go is go, which is not in languages/);
    assert.match(err.message, /"content" \(string\) or "source" \(file\) is required/);
    return true;
  });
});

test('resolveBox: init "source" is read relative to the config file', () => {
  const { dir, file } = tmpConfig({ boxes: { src: { languages: ['python'], init: [{ path: 'main.py', source: 'seed.py' }] } } });
  fs.writeFileSync(path.join(dir, 'seed.py'), 'print("seed")\n');
  const box = resolveBox(loadCodeboxConfig(file), 'src');
  assert.equal(box.init[0].content, 'print("seed")\n');
});

test('renderBox: writes Dockerfile, docker-compose.yml, config.yml, .env and codes/', () => {
  const { file } = tmpConfig({
    boxes: {
      demo: {
        languages: ['python', 'go'],
        env: { APP_ENV: 'test' },
        init: [
          { path: 'py/main.py', content: 'print(1)\n' },
          { path: 'go/main.go', content: 'package main\nfunc main() {}\n' },
        ],
      },
    },
  });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codebox-boxes-'));
  const summary = renderBox('demo', { configPath: file, root, runtime: 'runsc' });
  const dir = path.join(root, 'demo');
  for (const f of ['Dockerfile', 'docker-compose.yml', 'config.yml', '.env', 'codes/py/main.py', 'codes/go/main.go']) {
    assert.ok(fs.existsSync(path.join(dir, f)), f);
  }
  assert.deepEqual(summary.init.written, ['py/main.py', 'go/main.go']);
  assert.equal(summary.runtime, 'runsc');

  const dockerfile = fs.readFileSync(path.join(dir, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /AS python/);
  assert.match(dockerfile, /AS go/);
  assert.doesNotMatch(dockerfile, /AS rust|AS node|ziglang/);
  assert.match(dockerfile, /codebox-run-go/);

  const compose = YAML.parse(fs.readFileSync(path.join(dir, 'docker-compose.yml'), 'utf8'));
  assert.equal(compose.services.box.container_name, 'codebox-demo');
  assert.equal(compose.services.box.runtime, 'runsc');
  assert.ok(compose.services.box.volumes.includes('./codes:/workspace/codes'));

  const env = fs.readFileSync(path.join(dir, '.env'), 'utf8');
  assert.match(env, /^CODEBOX_BOX=demo$/m);
  assert.match(env, /^APP_ENV=test$/m);

  const config = YAML.parse(fs.readFileSync(path.join(dir, 'config.yml'), 'utf8'));
  assert.deepEqual(config.languages, ['python', 'go']);
  assert.ok(fs.existsSync(path.join(dir, '.codebox', 'runtime', 'bin', 'setup')));

  // Existing init codes are kept unless --force.
  fs.writeFileSync(path.join(dir, 'codes', 'py', 'main.py'), 'print("edited")\n');
  const again = renderBox('demo', { configPath: file, root });
  assert.deepEqual(again.init.kept, ['py/main.py', 'go/main.go']);
  assert.equal(fs.readFileSync(path.join(dir, 'codes', 'py', 'main.py'), 'utf8'), 'print("edited")\n');
  renderBox('demo', { configPath: file, root, force: true });
  assert.equal(fs.readFileSync(path.join(dir, 'codes', 'py', 'main.py'), 'utf8'), 'print(1)\n');
});
