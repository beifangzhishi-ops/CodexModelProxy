@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [codex-proxy] 未找到 node，请先安装 Node.js 并加入 PATH。
  exit /b 1
)

if not exist "proxy-secrets.env" (
  echo [codex-proxy] 缺少 proxy-secrets.env，请先填写 OPENCODE_API_KEY 与 DEEPSEEK_API_KEY。
  exit /b 1
)

powershell -NoProfile -Command "$c=Get-Content -LiteralPath 'proxy-secrets.env' -Raw -ErrorAction SilentlyContinue; if(-not ($c -match '(?m)^OPENCODE_API_KEY\s*=.*\S') -or -not ($c -match '(?m)^DEEPSEEK_API_KEY\s*=.*\S')){ Write-Error 'proxy-secrets.env 缺少 OPENCODE_API_KEY 或 DEEPSEEK_API_KEY'; exit 1 }"
if errorlevel 1 exit /b 1

powershell -NoProfile -Command "try { $r=Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8787/healthz' -TimeoutSec 2; if ($r.StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }"
if %errorlevel% equ 0 (
  echo [codex-proxy] 中转已在运行：http://127.0.0.1:8787
  exit /b 0
)

echo [codex-proxy] 正在后台启动中转服务（日志见 proxy.log / proxy.err.log）...
powershell -NoProfile -Command "$ws=New-Object -ComObject WScript.Shell; $null = $ws.Run('cmd /c cd /d ""%~dp0"" && node server.mjs > proxy.log 2> proxy.err.log', 0, $false)"
powershell -NoProfile -Command "Start-Sleep -Seconds 2; try { $r=Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8787/healthz' -TimeoutSec 5; Write-Output ('[codex-proxy] 已启动：http://127.0.0.1:8787  PID=' + (Get-Content -LiteralPath '%~dp0proxy.pid' -ErrorAction SilentlyContinue)) } catch { Write-Output ('[codex-proxy] 启动失败，请查看 proxy.err.log：' + $_.Exception.Message); exit 1 }"
exit /b %errorlevel%
