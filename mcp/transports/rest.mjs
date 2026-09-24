import http from 'node:http';

/**
 * REST transport for this module's MCP JSON-RPC dispatcher — `node:http`
 * only, no dependencies. Identical across every module; only configs/core.yml differs.
 *
 *   POST /rpc      body = one JSON-RPC 2.0 request object
 *   GET  /healthz  → { ok: true, module }
 */
export function restTransport({ host, port, moduleId, maxBodyBytes = 256 * 1024 }) {
  let server = null;

  async function onRequest(req, res, dispatch) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/healthz') {
      return json(res, 200, { ok: true, module: moduleId });
    }

    if (req.method !== 'POST' || url.pathname !== '/rpc') {
      return json(res, 404, { ok: false, error: 'not_found' });
    }

    let body = '';
    let tooBig = false;
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > maxBodyBytes) {
        tooBig = true;
        req.destroy();
      }
    });
    req.on('end', async () => {
      if (tooBig) return json(res, 413, { ok: false, error: 'payload_too_large' });
      let request;
      try {
        request = JSON.parse(body);
      } catch (cause) {
        return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: cause.message } });
      }
      const response = await dispatch(request, { transport: 'rest' });
      json(res, 200, response ?? { jsonrpc: '2.0', id: request?.id ?? null, result: null });
    });
  }

  return {
    name: `rest(${host}:${port})`,
    address: () => (server ? server.address() : null),
    async start(dispatch) {
      server = http.createServer((req, res) => onRequest(req, res, dispatch));
      server.headersTimeout = 5000;
      server.requestTimeout = 10_000;
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, resolve);
      });
    },
    async stop() {
      if (server) await new Promise((resolve) => server.close(resolve));
    },
  };
}

function json(res, status, obj) {
  const data = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store',
  });
  res.end(data);
}
