@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0switch_config.ps1" -TargetPath "%~dp0config_unified.toml"
exit /b %errorlevel%
