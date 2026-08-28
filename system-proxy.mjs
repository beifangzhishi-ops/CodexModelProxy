// Windows 当前用户手动系统代理解析器。
// 只读取 WinINet 的 ProxyEnable / ProxyServer，不处理 PAC、WPAD 或 WinHTTP。
import { execFile } from 'node:child_process';

const INTERNET_SETTINGS_KEY = String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`;
export const DEFAULT_SYSTEM_PROXY_CACHE_TTL_MS = 2000;

function execFileText(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: 'utf8', windowsHide: true }, (err, stdout) => {
      if (err) {
        reject(new Error(err.message));
        return;
      }
      resolve(stdout);
    });
  });
}

export function parseWindowsInternetSettings(raw) {
  const text = String(raw || '');
  const enableMatch = text.match(/^\s*ProxyEnable\s+REG_DWORD\s+(0x[0-9a-f]+|\d+)\s*$/im);
  if (!enableMatch) {
    throw new Error('Windows 系统代理设置缺少 ProxyEnable');
  }
  const enabled = Number.parseInt(enableMatch[1], enableMatch[1].toLowerCase().startsWith('0x') ? 16 : 10) !== 0;
  const serverMatch = text.match(/^\s*ProxyServer\s+REG_SZ\s+(.+?)\s*$/im);
  return {
    enabled,
    proxyServer: serverMatch ? serverMatch[1].trim() : '',
  };
}

export function normalizeWindowsProxyUrl(proxyServer, targetProtocol = 'https:') {
  const raw = String(proxyServer || '').trim();
  if (!raw) throw new Error('Windows 系统代理已启用，但 ProxyServer 为空');

  let selected = raw;
  if (raw.includes('=')) {
    const entries = new Map();
    for (const part of raw.split(';')) {
      const separator = part.indexOf('=');
      if (separator <= 0) continue;
      const key = part.slice(0, separator).trim().toLowerCase();
      const value = part.slice(separator + 1).trim();
      if (key && value) entries.set(key, value);
    }
    const protocolKey = String(targetProtocol).replace(/:$/, '').toLowerCase();
    selected = entries.get(protocolKey) || entries.get('https') || entries.get('http') || '';
    if (!selected) throw new Error(`Windows 系统代理没有可用于 ${targetProtocol} 的 HTTP 代理`);
  }

  const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(selected)
    ? selected
    : `http://${selected}`;
  let parsed;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error('Windows 系统代理地址格式无效');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error('Windows 系统代理仅支持 HTTP 或 HTTPS 地址');
  }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('Windows 系统代理地址不能包含路径、查询参数或片段');
  }
  return parsed.toString().replace(/\/$/, '');
}

export async function readWindowsManualProxy({
  platform = process.platform,
  queryRegistry = () => execFileText('reg.exe', ['query', INTERNET_SETTINGS_KEY]),
} = {}) {
  if (platform !== 'win32') {
    throw new Error('系统代理自动读取仅支持 Windows');
  }
  let raw;
  try {
    raw = await queryRegistry();
  } catch (err) {
    throw new Error(`无法读取 Windows 系统代理：${err.message}`);
  }
  const settings = parseWindowsInternetSettings(raw);
  if (!settings.enabled) return { url: '', mode: 'direct' };
  return {
    url: normalizeWindowsProxyUrl(settings.proxyServer, 'https:'),
    mode: 'system-proxy',
  };
}

export function createWindowsSystemProxyResolver({
  readProxy = readWindowsManualProxy,
  cacheTtlMs = DEFAULT_SYSTEM_PROXY_CACHE_TTL_MS,
  now = Date.now,
  logger = console,
} = {}) {
  let cached;
  let refreshPromise;

  return async function resolveWindowsSystemProxy() {
    const currentTime = now();
    if (cached && currentTime - cached.updatedAt < cacheTtlMs) return cached.value;
    if (refreshPromise) return refreshPromise;

    refreshPromise = (async () => {
      try {
        const value = await readProxy();
        cached = { value, updatedAt: now() };
        return value;
      } catch (err) {
        if (cached) {
          logger.warn(`[codex-proxy] Windows 系统代理刷新失败，暂用上次有效设置：${err.message}`);
          return cached.value;
        }
        throw err;
      } finally {
        refreshPromise = undefined;
      }
    })();
    return refreshPromise;
  };
}
