@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [codex-proxy] ERROR: node not found. Please install Node.js and add it to PATH.
  exit /b 1
)

if not exist "proxy-secrets.env" if not exist "providers.local.json" (
  echo [codex-proxy] ERROR: no local credentials found. Copy proxy-secrets.env.example or providers.local.json.example and fill the required keys.
  exit /b 1
)

rem Read only the listener port through the same Node environment loader as server.mjs.
for /f "delims=" %%P in ('node --input-type=module -e "import { loadRuntimeEnv } from './provider-registry.mjs'; console.log(loadRuntimeEnv().PORT || 8787)"') do set "PORT=%%P"
if not defined PORT set "PORT=8787"

rem Already running?
curl.exe --noproxy "*" --silent --show-error --fail --max-time 2 "http://127.0.0.1:%PORT%/healthz" >nul 2>nul
if %errorlevel% equ 0 (
  echo [codex-proxy] Proxy is already running: http://127.0.0.1:%PORT%
  exit /b 0
)

echo [codex-proxy] Starting proxy in background (logs: proxy.log / proxy.err.log)...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ws=New-Object -ComObject WScript.Shell; $null = $ws.Run('cmd /c cd /d ""%~dp0"" && node server.mjs > proxy.log 2> proxy.err.log', 0, $false)"
timeout /t 2 /nobreak >nul
curl.exe --noproxy "*" --silent --show-error --fail --max-time 5 "http://127.0.0.1:%PORT%/healthz" >nul 2>nul
if errorlevel 1 (
  echo [codex-proxy] FAILED: health check failed. See proxy.err.log.
  exit /b 1
)
echo [codex-proxy] Started. PID=%~dp0proxy.pid
exit /b 0
