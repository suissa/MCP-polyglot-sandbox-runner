/**
 * Codebox config model — shared by the renderer (`./codebox up`) and the
 * MCP server. Reads configs/codebox.yml, validates it and resolves one box
 * (defaults merged, languages normalized, init codes loaded).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const DEFAULT_CONFIG = path.join(REPO_ROOT, 'configs', 'codebox.yml');

/** Canonical language → file extensions handled by its telemetry runner. */
export const LANGUAGES = {
  typescript: { extensions: ['ts', 'tsx', 'mts', 'cts', 'js', 'mjs', 'cjs'] },
  python: { extensions: ['py'] },
  go: { extensions: ['go'] },
  rust: { extensions: ['rs'] },
  zig: { extensions: ['zig'] },
};

const LANGUAGE_ALIASES = {
  ts: 'typescript', typescript: 'typescript', js: 'typescript', javascript: 'typescript', node: 'typescript',
  py: 'python', python: 'python', python3: 'python',
  go: 'go', golang: 'go',
  rs: 'rust', rust: 'rust',
  zig: 'zig',
};

const BUILTIN_DEFAULTS = {
  runtime: 'auto',
  network: 'bridge',
  proxy: 'none',
  resources: { cpus: '2.0', memory: '2g', pids: 512 },
  timeout_ms: 60000,
  images: {
    base: 'buildpack-deps:bookworm',
    node: 'node:22-bookworm-slim',
    python: 'python:3.12-slim-bookworm',
    go: 'golang:1.26-bookworm',
    rust: 'rust:1-bookworm',
  },
  zig_version: '0.16.0',
};

const ALIAS_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export class CodeboxConfigError extends Error {}

export function normalizeLanguage(name) {
  return LANGUAGE_ALIASES[String(name).toLowerCase()] || null;
}

export function languageForFile(file) {
  const ext = path.extname(file).slice(1).toLowerCase();
  return Object.keys(LANGUAGES).find((lang) => LANGUAGES[lang].extensions.includes(ext)) || null;
}

function merge(base, override) {
  if (override === undefined) return base;
  if (Array.isArray(base) || Array.isArray(override) || typeof base !== 'object' || typeof override !== 'object' || !base || !override) {
    return override;
  }
  const out = { ...base };
  for (const key of Object.keys(override)) out[key] = merge(base[key], override[key]);
  return out;
}

/** Rejects absolute paths and anything escaping the codes/ folder. */
export function safeRelativePath(input) {
  if (typeof input !== 'string' || !input.trim()) throw new CodeboxConfigError('path must be a non-empty string');
  const normalized = path.posix.normalize(input.replace(/\\/g, '/')).replace(/^\.\/+/, '');
  if (path.posix.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../') || normalized === '.') {
    throw new CodeboxConfigError(`path escapes codes/: ${input}`);
  }
  return normalized;
}

export function loadCodeboxConfig(configPath = process.env.CODEBOX_CONFIG || DEFAULT_CONFIG) {
  if (!fs.existsSync(configPath)) throw new CodeboxConfigError(`config not found: ${configPath}`);
  const doc = YAML.parse(fs.readFileSync(configPath, 'utf8')) || {};
  if (!doc.boxes || typeof doc.boxes !== 'object') throw new CodeboxConfigError(`${configPath}: missing "boxes"`);
  return { path: path.resolve(configPath), defaults: merge(BUILTIN_DEFAULTS, doc.defaults || {}), boxes: doc.boxes };
}

/** Resolves and validates a single box; throws CodeboxConfigError listing every problem. */
export function resolveBox(config, alias) {
  const raw = config.boxes[alias];
  if (!raw) {
    throw new CodeboxConfigError(`box "${alias}" not found in ${config.path} (available: ${Object.keys(config.boxes).join(', ') || 'none'})`);
  }
  const problems = [];
  if (!ALIAS_RE.test(alias)) problems.push(`alias "${alias}" must match ${ALIAS_RE}`);

  const box = merge(config.defaults, raw);
  const languages = [];
  for (const name of [].concat(box.languages || [])) {
    const lang = normalizeLanguage(name);
    if (!lang) problems.push(`unsupported language "${name}" (use: ${Object.keys(LANGUAGES).join(', ')})`);
    else if (!languages.includes(lang)) languages.push(lang);
  }
  if (languages.length === 0) problems.push('at least one language is required');

  const init = [];
  const initList = Array.isArray(box.init) ? box.init : [];
  if (initList.length === 0) problems.push('at least one init code is required (init: [{ path, content | source }])');
  const configDir = path.dirname(config.path);
  initList.forEach((item, index) => {
    const where = `init[${index}]`;
    if (!item || typeof item !== 'object') return problems.push(`${where} must be an object`);
    let rel;
    try {
      rel = safeRelativePath(item.path);
    } catch (err) {
      return problems.push(`${where}: ${err.message}`);
    }
    let content = item.content;
    if (content === undefined && item.source) {
      const source = path.resolve(configDir, item.source);
      if (!fs.existsSync(source)) return problems.push(`${where}: source not found: ${item.source}`);
      content = fs.readFileSync(source, 'utf8');
    }
    if (typeof content !== 'string') return problems.push(`${where}: "content" (string) or "source" (file) is required`);
    const lang = languageForFile(rel);
    if (lang && !languages.includes(lang)) problems.push(`${where}: ${rel} is ${lang}, which is not in languages`);
    if (init.some((other) => other.path === rel)) problems.push(`${where}: duplicate path ${rel}`);
    init.push({ path: rel, content });
  });

  if (!['auto', 'runsc', 'runc'].includes(box.runtime)) problems.push(`runtime must be auto | runsc | runc`);
  if (!['none', 'inherit'].includes(box.proxy)) problems.push(`proxy must be none | inherit`);
  if (box.env && (typeof box.env !== 'object' || Array.isArray(box.env))) problems.push('env must be a map');

  if (problems.length) {
    throw new CodeboxConfigError(`invalid box "${alias}":\n  - ${problems.join('\n  - ')}`);
  }
  return {
    alias,
    container: `codebox-${alias}`,
    languages,
    init,
    env: Object.fromEntries(Object.entries(box.env || {}).map(([k, v]) => [k, String(v)])),
    runtime: box.runtime,
    network: box.network,
    proxy: box.proxy,
    build_network: box.build_network || null,
    ca_cert: box.ca_cert || process.env.CODEBOX_CA_CERT || null,
    resources: box.resources,
    timeout_ms: Number(box.timeout_ms) || 60000,
    images: box.images,
    zig_version: String(box.zig_version),
  };
}

export function boxesRoot(root = process.env.CODEBOX_BOXES_DIR) {
  return root ? path.resolve(root) : path.join(REPO_ROOT, 'boxes');
}
