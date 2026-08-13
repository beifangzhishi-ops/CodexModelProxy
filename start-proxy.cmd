@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [codex-proxy] ERROR: node not found. Please install Node.js and add it to PATH.
  exit /b 1
)

if not exist "proxy-secrets.env" (
  echo [codex-proxy] ERROR: proxy-secrets.env missing. Copy proxy-secrets.env.example and fill OPENCODE_API_KEY / DEEPSEEK_API_KEY.
  exit /b 1
)

rem Load machine-local overrides (gitignored; may be absent)
if exist "proxy-local.env" (
  for /f "usebackq eol=# tokens=1,* delims==" %%A in ("proxy-local.env") do set "%%A=%%B"
)

rem Resolve port: PORT (from proxy-local.env) > proxy-config.json > 8787
if not defined PORT (
  for /f %%P in ('powershell -NoProfile -ExecutionPolicy Bypass -Command "(Get-Content -Raw -LiteralPath 'proxy-config.json' -ErrorAction SilentlyContinue | ConvertFrom-Json).port"') do set "PORT=%%P"
)
if not defined PORT set "PORT=8787"

powershell -NoProfile -ExecutionPolicy Bypass -Command "$c=Get-Content -LiteralPath 'proxy-secrets.env' -Raw -ErrorAction SilentlyContinue; if(-not ($c -match '(?m)^OPENCODE_API_KEY\s*=.*\S') -or -not ($c -match '(?m)^DEEPSEEK_API_KEY\s*=.*\S')){ Write-Error 'proxy-secrets.env is missing OPENCODE_API_KEY or DEEPSEEK_API_KEY'; exit 1 }"
if errorlevel 1 exit /b 1

rem Already running?
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $r=Invoke-WebRequest -UseBasicParsing -Uri ('http://127.0.0.1:' + $env:PORT + '/healthz') -TimeoutSec 2; if ($r.StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }"
if %errorlevel% equ 0 (
  echo [codex-proxy] Proxy is already running: http://127.0.0.1:%PORT%
  exit /b 0
)

echo [codex-proxy] Starting proxy in background (logs: proxy.log / proxy.err.log)...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ws=New-Object -ComObject WScript.Shell; $null = $ws.Run('cmd /c cd /d ""%~dp0"" && node server.mjs > proxy.log 2> proxy.err.log', 0, $false)"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Sleep -Seconds 2; try { $r=Invoke-WebRequest -UseBasicParsing -Uri ('http://127.0.0.1:' + $env:PORT + '/healthz') -TimeoutSec 5; Write-Output ('[codex-proxy] Started. PID=' + (Get-Content -LiteralPath '%~dp0proxy.pid' -ErrorAction SilentlyContinue)) } catch { Write-Output ('[codex-proxy] FAILED: ' + $_.Exception.Message); exit 1 }"
exit /b %errorlevel%
