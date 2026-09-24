import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

/**
 * Local config loaders (YAML / JSON / .env). Same contract as the external
 * UbiQonfig helpers this module used to import from outside the repository:
 * a missing file returns null (or is ignored, for .env) instead of throwing.
 */

function resolve(file, { baseDir = process.cwd() } = {}) {
  return path.isAbsolute(file) ? file : path.join(baseDir, file);
}

export function loadYaml(file, options) {
  const full = resolve(file, options);
  if (!fs.existsSync(full)) return null;
  return YAML.parse(fs.readFileSync(full, 'utf8'));
}

export function loadJson(file, options) {
  const full = resolve(file, options);
  if (!fs.existsSync(full)) return null;
  return JSON.parse(fs.readFileSync(full, 'utf8'));
}

/** Loads KEY=VALUE lines into process.env without overriding existing vars. */
export function loadEnv(file, options) {
  const full = resolve(file, options);
  if (!fs.existsSync(full)) return {};
  const vars = parseEnv(fs.readFileSync(full, 'utf8'));
  for (const [key, value] of Object.entries(vars)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return vars;
}

export function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2];
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    out[match[1]] = value;
  }
  return out;
}
