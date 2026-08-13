@echo off
setlocal
cd /d "%~dp0"

rem Load machine-local overrides (gitignored; may be absent)
if exist "proxy-local.env" (
  for /f "usebackq eol=# tokens=1,* delims==" %%A in ("proxy-local.env") do set "%%A=%%B"
)

rem Resolve port: PORT (from proxy-local.env) > proxy-config.json > 8787
if not defined PORT (
  for /f %%P in ('powershell -NoProfile -ExecutionPolicy Bypass -Command "(Get-Content -Raw -LiteralPath 'proxy-config.json' -ErrorAction SilentlyContinue | ConvertFrom-Json).port"') do set "PORT=%%P"
)
if not defined PORT set "PORT=8787"

set "PIDFILE=proxy.pid"
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
