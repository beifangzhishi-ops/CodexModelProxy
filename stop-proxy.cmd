@echo off
setlocal
cd /d "%~dp0"

rem Resolve the configured PID file (the same path used by server.mjs).
for /f "delims=" %%P in ('node --input-type=module -e "import {loadConfig} from './runtime-config.mjs'; const e=process.env; const c=loadConfig(e.PROXY_CONFIG_FILE,e.MODEL_OVERRIDES_FILE); console.log(c.pid_file)"') do set "PIDFILE=%%P"
if not defined PIDFILE set "PIDFILE=proxy.pid"
for /f "delims=" %%P in ('node --input-type=module -e "import {loadConfig} from './runtime-config.mjs'; const e=process.env; console.log(Number(e.PORT) || loadConfig(e.PROXY_CONFIG_FILE,e.MODEL_OVERRIDES_FILE).port)"') do set "PORT=%%P"
if not defined PORT set "PORT=8787"

if exist "%PIDFILE%" goto :bypid
goto :byport

:bypid
set /p PID=<"%PIDFILE%"
if not defined PID goto :byport
powershell -NoProfile -ExecutionPolicy Bypass -Command "Stop-Process -Id %PID% -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 300"
del /q "%PIDFILE%" >nul 2>nul
echo [codex-proxy] Stopped by PID: %PID%
exit /b 0

:byport
powershell -NoProfile -ExecutionPolicy Bypass -Command "$c=Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue; Write-Output ('Stopped by port ' + %PORT% + ' PID=' + $c.OwningProcess) } else { Write-Output ('No proxy listening on port ' + %PORT%) }"
exit /b %errorlevel%
