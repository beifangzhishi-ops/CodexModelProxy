// Windows 手动系统代理解析与缓存测试，不读取真实注册表。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createWindowsSystemProxyResolver,
  normalizeWindowsProxyUrl,
  parseWindowsInternetSettings,
  readWindowsManualProxy,
} from '../system-proxy.mjs';

function registryText({ enabled = true, proxyServer = '127.0.0.1:7890' } = {}) {
  return [
    String.raw`HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Internet Settings`,
    `    ProxyEnable    REG_DWORD    ${enabled ? '0x1' : '0x0'}`,
    proxyServer === null ? '' : `    ProxyServer    REG_SZ    ${proxyServer}`,
  ].join('\r\n');
}

test('解析 Windows ProxyEnable 与 ProxyServer', () => {
  assert.deepEqual(parseWindowsInternetSettings(registryText()), {
    enabled: true,
    proxyServer: '127.0.0.1:7890',
  });
  assert.deepEqual(parseWindowsInternetSettings(registryText({ enabled: false, proxyServer: null })), {
    enabled: false,
    proxyServer: '',
  });
  assert.throws(() => parseWindowsInternetSettings('ProxyServer REG_SZ 127.0.0.1:7890'), /ProxyEnable/);
});

test('规范化单地址、带协议地址和按协议拆分的代理地址', () => {
  assert.equal(normalizeWindowsProxyUrl('127.0.0.1:7890'), 'http://127.0.0.1:7890');
  assert.equal(normalizeWindowsProxyUrl('http://proxy.example:8080'), 'http://proxy.example:8080');
  assert.equal(normalizeWindowsProxyUrl('https://proxy.example:8443'), 'https://proxy.example:8443');
  assert.equal(
    normalizeWindowsProxyUrl('http=proxy-http.example:8080;https=proxy-https.example:8443'),
    'http://proxy-https.example:8443',
  );
  assert.equal(
    normalizeWindowsProxyUrl('http=proxy-http.example:8080;socks=127.0.0.1:1080'),
    'http://proxy-http.example:8080',
  );
  assert.throws(() => normalizeWindowsProxyUrl(''), /ProxyServer 为空/);
  assert.throws(() => normalizeWindowsProxyUrl('socks=127.0.0.1:1080'), /没有可用于/);
  assert.throws(() => normalizeWindowsProxyUrl('ftp://proxy.example:21'), /仅支持 HTTP 或 HTTPS/);
  assert.throws(() => normalizeWindowsProxyUrl('http://proxy.example:8080/path'), /不能包含路径/);
});

test('读取 Windows 手动代理，关闭时直连，查询失败时给出明确错误', async () => {
  assert.deepEqual(
    await readWindowsManualProxy({ platform: 'win32', queryRegistry: async () => registryText() }),
    { url: 'http://127.0.0.1:7890', mode: 'system-proxy' },
  );
  assert.deepEqual(
    await readWindowsManualProxy({
      platform: 'win32',
      queryRegistry: async () => registryText({ enabled: false }),
    }),
    { url: '', mode: 'direct' },
  );
  await assert.rejects(
    readWindowsManualProxy({ platform: 'linux', queryRegistry: async () => registryText() }),
    /仅支持 Windows/,
  );
  await assert.rejects(
    readWindowsManualProxy({ platform: 'win32', queryRegistry: async () => { throw new Error('拒绝访问'); } }),
    /无法读取 Windows 系统代理：拒绝访问/,
  );
});

test('解析器缓存两秒、合并并发刷新并自动采用新端口', async () => {
  let currentTime = 0;
  let calls = 0;
  const resolver = createWindowsSystemProxyResolver({
    cacheTtlMs: 2000,
    now: () => currentTime,
    readProxy: async () => {
      calls += 1;
      await Promise.resolve();
      return {
        url: `http://127.0.0.1:${calls === 1 ? 7890 : 7891}`,
        mode: 'system-proxy',
      };
    },
  });

  const first = await Promise.all([resolver(), resolver(), resolver()]);
  assert.equal(calls, 1);
  assert.ok(first.every((value) => value.url === 'http://127.0.0.1:7890'));
  currentTime = 1999;
  assert.equal((await resolver()).url, 'http://127.0.0.1:7890');
  assert.equal(calls, 1);
  currentTime = 2000;
  assert.equal((await resolver()).url, 'http://127.0.0.1:7891');
  assert.equal(calls, 2);
});

test('刷新失败时复用已有缓存，首次读取失败则拒绝请求', async () => {
  let currentTime = 0;
  let calls = 0;
  const warnings = [];
  const resolver = createWindowsSystemProxyResolver({
    cacheTtlMs: 2000,
    now: () => currentTime,
    logger: { warn: (message) => warnings.push(message) },
    readProxy: async () => {
      calls += 1;
      if (calls > 1) throw new Error('临时失败');
      return { url: 'http://127.0.0.1:7890', mode: 'system-proxy' };
    },
  });
  assert.equal((await resolver()).url, 'http://127.0.0.1:7890');
  currentTime = 2000;
  assert.equal((await resolver()).url, 'http://127.0.0.1:7890');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /暂用上次有效设置/);

  const failingResolver = createWindowsSystemProxyResolver({
    readProxy: async () => { throw new Error('首次失败'); },
  });
  await assert.rejects(failingResolver(), /首次失败/);
});
