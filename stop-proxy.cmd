@echo off
setlocal
cd /d "%~dp0"

set "PIDFILE=proxy.pid"
if exist "%PIDFILE%" goto :bypid
goto :byport

:bypid
set /p PID=<"%PIDFILE%"
if not defined PID goto :byport
powershell -NoProfile -Command "Stop-Process -Id %PID% -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 300"
del /q "%PIDFILE%" >nul 2>nul
echo [codex-proxy] 已停止进程 PID=%PID%
exit /b 0

:byport
powershell -NoProfile -Command "$c=Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue; Write-Output ('已按端口 8787 停止进程 PID=' + $c.OwningProcess) } else { Write-Output '未发现监听 8787 的中转进程' }"
exit /b %errorlevel%
