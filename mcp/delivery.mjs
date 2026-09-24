import net from 'node:net';
import tls from 'node:tls';

/**
 * Result delivery over the four MCP channels of this server:
 *
 *   stdio      JSON-RPC notification on stdout; response_path = method
 *              (default `notifications/codebox/result`)
 *   rest       HTTP POST of the JSON document; response_path = URL
 *   websocket  one text frame to a WebSocket; response_path = ws(s):// URL
 *   nats       PUB to a subject; response_path = subject, or
 *              nats://host:port/<subject> to target another server
 */
export const CHANNELS = ['stdio', 'rest', 'websocket', 'nats'];

const CHANNEL_ALIASES = {
  stdio: 'stdio',
  rest: 'rest', http: 'rest', https: 'rest',
  websocket: 'websocket', ws: 'websocket', wss: 'websocket',
  nats: 'nats',
};

export function normalizeChannel(name) {
  if (name === undefined || name === null || name === '') return null;
  const channel = CHANNEL_ALIASES[String(name).toLowerCase()];
  if (!channel) throw new Error(`unsupported response_channel "${name}" (use: ${CHANNELS.join(', ')})`);
  return channel;
}

/** Validates { response_channel, response_path } and fills channel defaults. */
export function resolveTarget({ channel, path, defaults = {} }) {
  const normalized = normalizeChannel(channel);
  if (!normalized) return null;
  let target = path || null;
  if (!target && normalized === 'stdio') target = defaults.stdioMethod || 'notifications/codebox/result';
  if (!target && normalized === 'nats') target = defaults.natsSubject || 'codebox.results';
  if (!target) throw new Error(`response_path is required for response_channel "${normalized}"`);
  if (normalized === 'rest' && !/^https?:\/\//i.test(target)) throw new Error('rest response_path must be an http(s):// URL');
  if (normalized === 'websocket' && !/^wss?:\/\//i.test(target)) throw new Error('websocket response_path must be a ws(s):// URL');
  if (normalized === 'nats' && !/^nats:\/\//i.test(target) && !/^[\w.*>-]+$/.test(target)) {
    throw new Error('nats response_path must be a subject or nats://host:port/<subject>');
  }
  return { channel: normalized, path: target };
}

export async function deliver({ channel, path, payload, stdioWrite, natsUrl, timeoutMs = 10_000 }) {
  switch (channel) {
    case 'stdio':
      if (!stdioWrite) throw new Error('stdio transport is not enabled');
      stdioWrite({ jsonrpc: '2.0', method: path, params: payload });
      return;
    case 'rest':
      return deliverRest(path, payload, timeoutMs);
    case 'websocket':
      return deliverWebSocket(path, payload, timeoutMs);
    case 'nats':
      return deliverNats(path, payload, natsUrl, timeoutMs);
    default:
      throw new Error(`unsupported channel ${channel}`);
  }
}

async function deliverRest(url, payload, timeoutMs) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`POST ${url} → HTTP ${res.status}`);
}

function deliverWebSocket(url, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`websocket ${url}: timeout`));
    }, timeoutMs);
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify(payload));
      // Let the frame flush before closing.
      setTimeout(() => {
        clearTimeout(timer);
        ws.close(1000);
        resolve();
      }, 50);
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error(`websocket ${url}: connection failed`));
    });
  });
}

/** One-shot NATS publish: CONNECT, PUB, PING → waits for PONG (flush), closes. */
function deliverNats(target, payload, defaultUrl, timeoutMs) {
  let serverUrl = defaultUrl || 'nats://127.0.0.1:4222';
  let subject = target;
  if (/^nats:\/\//i.test(target)) {
    const parsed = new URL(target);
    subject = parsed.pathname.replace(/^\/+/, '');
    serverUrl = `nats://${parsed.username ? `${parsed.username}${parsed.password ? `:${parsed.password}` : ''}@` : ''}${parsed.host}`;
    if (!subject) throw new Error('nats URL must include a /<subject>');
  }
  const parsed = new URL(serverUrl);
  return new Promise((resolve, reject) => {
    const port = Number(parsed.port) || 4222;
    const onConnect = () => {
      const opts = { verbose: false, pedantic: false, name: 'codebox-delivery', lang: 'node', protocol: 1 };
      if (parsed.password) {
        opts.user = decodeURIComponent(parsed.username);
        opts.pass = decodeURIComponent(parsed.password);
      } else if (parsed.username) {
        opts.auth_token = decodeURIComponent(parsed.username);
      }
      const data = JSON.stringify(payload);
      socket.write(`CONNECT ${JSON.stringify(opts)}\r\nPUB ${subject} ${Buffer.byteLength(data)}\r\n${data}\r\nPING\r\n`);
    };
    const socket = parsed.protocol === 'tls:'
      ? tls.connect({ host: parsed.hostname, port, servername: parsed.hostname }, onConnect)
      : net.connect({ host: parsed.hostname, port }, onConnect);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`nats ${parsed.host}: timeout`));
    }, timeoutMs);
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (/^-ERR.*$/m.test(buffer)) {
        clearTimeout(timer);
        socket.destroy();
        reject(new Error(`nats: ${/^-ERR.*$/m.exec(buffer)[0]}`));
      } else if (/^PONG\r?$/m.test(buffer)) {
        clearTimeout(timer);
        socket.end();
        resolve();
      }
    });
    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`nats ${parsed.host}: ${err.message}`));
    });
  });
}
