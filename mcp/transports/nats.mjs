import net from 'node:net';
import tls from 'node:tls';

/**
 * Minimal NATS client (text protocol over TCP), zero dependencies. Adapted
 * from packages/Tools/UbiQonfig/src/transports/nats.js, but carries this
 * module's JSON-RPC 2.0 request/reply instead of the UbiQonfig `refresh`
 * command, and also exposes `publish()` so the kernel can mirror every
 * dispatched route as a NATS event (see mcp/server.mjs).
 *
 * Supports: CONNECT with token/user-pass, PING/PONG, simple reconnect.
 * Does not support: clustering, JetStream, nkeys/jwt.
 */
export function natsTransport({ url, rpcSubject, queue }) {
  const parsed = new URL(url);
  let socket = null;
  let buffer = '';
  let stopped = false;
  let dispatchFn = null;

  function connect() {
    if (stopped) return;
    const useTls = parsed.protocol === 'tls:';
    const port = Number(parsed.port) || 4222;
    const onConnect = () => {
      const connectOpts = { verbose: false, pedantic: false, name: 'mychappie-mcp', lang: 'node', protocol: 1 };
      if (parsed.password) {
        connectOpts.user = decodeURIComponent(parsed.username);
        connectOpts.pass = decodeURIComponent(parsed.password);
      } else if (parsed.username) {
        connectOpts.auth_token = decodeURIComponent(parsed.username);
      }
      send(`CONNECT ${JSON.stringify(connectOpts)}`);
      if (rpcSubject) send(`SUB ${rpcSubject} ${queue || 'mcp'} 1`);
      send('PING');
    };
    socket = useTls
      ? tls.connect({ host: parsed.hostname, port, servername: parsed.hostname }, onConnect)
      : net.connect({ host: parsed.hostname, port }, onConnect);

    socket.setEncoding('utf8');
    socket.on('data', onData);
    socket.on('error', () => {
      /* swallowed — reconnect loop on 'close' handles recovery */
    });
    socket.on('close', () => {
      if (stopped) return;
      setTimeout(connect, 2000);
    });
  }

  function send(line) {
    if (socket && !socket.destroyed) socket.write(`${line}\r\n`);
  }

  async function onData(chunk) {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\r\n')) !== -1) {
      const line = buffer.slice(0, nl);
      const op = line.split(' ')[0].toUpperCase();

      if (op === 'PING') {
        buffer = buffer.slice(nl + 2);
        send('PONG');
        continue;
      }
      if (op === 'MSG') {
        // MSG <subject> <sid> [reply-to] <#bytes>\r\n<payload>\r\n
        const parts = line.split(/\s+/);
        const bytes = Number(parts[parts.length - 1]);
        const replyTo = parts.length === 5 ? parts[3] : null;
        const headerEnd = nl + 2;
        if (buffer.length < headerEnd + bytes + 2) return; // wait for full payload
        const payload = buffer.slice(headerEnd, headerEnd + bytes);
        buffer = buffer.slice(headerEnd + bytes + 2);
        await handleMessage(payload, replyTo);
        continue;
      }
      // INFO, +OK, -ERR, PONG: ignored
      buffer = buffer.slice(nl + 2);
    }
  }

  async function handleMessage(payload, replyTo) {
    let request;
    try {
      request = JSON.parse(payload);
    } catch (cause) {
      if (replyTo) publish(replyTo, { jsonrpc: '2.0', id: null, error: { code: -32700, message: cause.message } });
      return;
    }
    const response = await dispatchFn(request);
    if (replyTo && response) publish(replyTo, response);
  }

  /** Publishes an arbitrary JSON payload to a subject. No-op if disconnected. */
  function publish(subject, obj) {
    if (!socket || socket.destroyed) return false;
    const data = JSON.stringify(obj);
    send(`PUB ${subject} ${Buffer.byteLength(data)}`);
    send(data);
    return true;
  }

  return {
    name: `nats(${parsed.host}${rpcSubject ? `:${rpcSubject}` : ''})`,
    publish,
    async start(dispatch) {
      dispatchFn = dispatch;
      stopped = false;
      connect();
    },
    async stop() {
      stopped = true;
      if (socket) socket.destroy();
    },
  };
}
