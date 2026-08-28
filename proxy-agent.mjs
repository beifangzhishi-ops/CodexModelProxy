// 为 HTTPS 上游创建经 HTTP(S) 代理 CONNECT 隧道的 Agent。
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';

export function createProxyAgent(proxyUrl) {
  const proxy = new URL(proxyUrl);
  if (!['http:', 'https:'].includes(proxy.protocol)) {
    throw new Error(`不支持的代理协议：${proxy.protocol}`);
  }

  const agent = new https.Agent({ keepAlive: false });
  agent.createConnection = (options, callback) => {
    let done = false;
    let connected = false;
    const finish = (err, socket) => {
      if (done) return;
      done = true;
      callback(err, socket);
    };
    const targetHost = options.host || options.servername || '';
    const targetPort = options.port || 443;
    const proxyPort = Number(proxy.port || (proxy.protocol === 'https:' ? 443 : 80));
    const socket = proxy.protocol === 'https:'
      ? tls.connect({ host: proxy.hostname, port: proxyPort, servername: proxy.hostname })
      : net.connect(proxyPort, proxy.hostname);
    const connectEvent = proxy.protocol === 'https:' ? 'secureConnect' : 'connect';

    socket.once(connectEvent, () => {
      const headers = [
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1`,
        `Host: ${targetHost}:${targetPort}`,
      ];
      if (proxy.username || proxy.password) {
        const credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
        headers.push(`Proxy-Authorization: Basic ${Buffer.from(credentials).toString('base64')}`);
      }
      socket.write(`${headers.join('\r\n')}\r\n\r\n`);
    });

    let buffer = '';
    const onData = (chunk) => {
      if (done || connected) return;
      buffer += chunk.toString('latin1');
      const endOfHeaders = buffer.indexOf('\r\n\r\n');
      if (endOfHeaders === -1) return;
      const head = buffer.slice(0, endOfHeaders);
      if (!/^HTTP\/1\.[01] 200/.test(head)) {
        socket.destroy();
        finish(new Error(`proxy CONNECT failed: ${head.split('\r\n')[0]}`));
        return;
      }
      connected = true;
      socket.removeListener('data', onData);
      const tlsSocket = tls.connect({ socket, servername: targetHost });
      tlsSocket.once('secureConnect', () => finish(null, tlsSocket));
      tlsSocket.once('error', finish);
    };
    socket.on('data', onData);
    socket.once('error', finish);
  };
  return agent;
}
