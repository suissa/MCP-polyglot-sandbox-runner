import http from 'node:http';
import crypto from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 256 * 1024;

/**
 * WebSocket transport for this module's MCP JSON-RPC dispatcher (RFC 6455),
 * built only with `node:http` + `node:crypto`. Identical across every module;
 * only configs/core.yml differs. Text frames only, no permessage-deflate,
 * no fragmentation of large messages — enough for a JSON-RPC control channel.
 */
export function webSocketTransport({ host, port, path = '/' }) {
  let server = null;
  const sockets = new Set();

  function onUpgrade(req, socket, dispatch) {
    if (req.headers.upgrade?.toLowerCase() !== 'websocket' || req.url !== path) {
      socket.destroy();
      return;
    }
    const accept = crypto
      .createHash('sha1')
      .update(req.headers['sec-websocket-key'] + GUID)
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());

    let buf = Buffer.alloc(0);
    socket.on('data', async (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      let frame;
      while ((frame = decodeFrame(buf))) {
        buf = frame.rest;
        if (frame.opcode === 0x8) {
          socket.end(encodeFrame(Buffer.alloc(0), 0x8));
          return;
        }
        if (frame.opcode === 0x9) {
          socket.write(encodeFrame(frame.payload, 0xa));
          continue;
        }
        if (frame.opcode === 0xa) continue;
        if (frame.opcode !== 0x1 && frame.opcode !== 0x0) continue;
        if (frame.payload.length > MAX_MESSAGE) {
          send(socket, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'message too large' } });
          continue;
        }
        let request;
        try {
          request = JSON.parse(frame.payload.toString('utf8'));
        } catch (cause) {
          send(socket, { jsonrpc: '2.0', id: null, error: { code: -32700, message: cause.message } });
          continue;
        }
        const response = await dispatch(request);
        if (response) send(socket, response);
      }
    });
  }

  return {
    name: `websocket(${host}:${port}${path})`,
    address: () => (server ? server.address() : null),
    async start(dispatch) {
      server = http.createServer((_req, res) => {
        res.writeHead(426, { 'content-type': 'text/plain' });
        res.end('Upgrade Required');
      });
      server.on('upgrade', (req, socket) => onUpgrade(req, socket, dispatch));
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, resolve);
      });
    },
    async stop() {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      if (server) await new Promise((resolve) => server.close(resolve));
    },
  };
}

function send(socket, obj) {
  socket.write(encodeFrame(Buffer.from(JSON.stringify(obj), 'utf8'), 0x1));
}

function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < offset + 2) return null;
    len = buf.readUInt16BE(offset);
    offset += 2;
  } else if (len === 127) {
    if (buf.length < offset + 8) return null;
    len = Number(buf.readBigUInt64BE(offset));
    offset += 8;
  }
  const maskLen = masked ? 4 : 0;
  if (buf.length < offset + maskLen + len) return null;
  const mask = masked ? buf.subarray(offset, offset + 4) : null;
  offset += maskLen;
  const payload = Buffer.from(buf.subarray(offset, offset + len));
  if (mask) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i & 3];
  return { opcode, payload, rest: buf.subarray(offset + len) };
}

function encodeFrame(payload, opcode) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}
