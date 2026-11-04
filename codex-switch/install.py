"""Install two standalone Codex configuration switches for one Windows user.

The official switch never calls CMP. This installer does not edit active
config.toml or any authentication database.
"""
from __future__ import annotations

import argparse
import base64
from datetime import datetime
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tomllib


def load_toml(file: Path) -> dict:
    return tomllib.loads(file.read_text(encoding="utf-8-sig"))


def quote(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def active_official_model(home: Path) -> tuple[str, str]:
    choices = [home / "config.toml", home / "config_official.toml"]
    for file in choices:
        if not file.is_file():
            continue
        config = load_toml(file)
        provider_id = config.get("model_provider", "")
        provider = config.get("model_providers", {}).get(provider_id, {})
        model = config.get("model", "")
        if (
            isinstance(provider_id, str)
            and provider_id.casefold() == "openai"
            and not config.get("openai_base_url")
            and not provider.get("base_url")
            and isinstance(model, str)
            and model.startswith("gpt-")
        ):
            effort = config.get("model_reasoning_effort", "medium")
            return model, effort if isinstance(effort, str) else "medium"
    return "gpt-6.1-sol", "medium"


def first_selected_model(cmp_root: Path) -> str:
    file = cmp_root / "models.txt"
    if file.is_file():
        for line in file.read_text(encoding="utf-8-sig").splitlines():
            match = re.match(r"^\s*\*\s+([^\s#]+)", line)
            if match:
                return match.group(1)
    return "ds/deepseek-flash"


def active_cmp_model(home: Path, cmp_url: str, cmp_root: Path) -> str:
    for file in (home / 'config.toml', home / 'config_cmp.toml'):
        if not file.is_file():
            continue
        try:
            config = load_toml(file)
        except (ValueError, OSError):
            continue
        provider_id = config.get('model_provider', '')
        native_url = config.get('openai_base_url', '')
        custom_url = config.get('model_providers', {}).get(provider_id, {}).get('base_url', '')
        base = native_url or custom_url
        model = config.get('model')
        if isinstance(base, str) and base.startswith(cmp_url.removesuffix('/v1') + '/'):
            if isinstance(model, str) and model.strip():
                return model
    return first_selected_model(cmp_root)


def get_local_proxy_settings(home: Path, cmp_root: Path) -> tuple[str, dict]:
    env = {}
    local = cmp_root / "proxy-local.env"
    if local.exists():
        for line in local.read_text(encoding="utf-8-sig").splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                key, value = line.split("=", 1)
                env[key.strip()] = value.strip()
    port = env.get("PORT", "8787")
    if not port.isdigit() or not (1 <= int(port) <= 65535):
        raise ValueError("CMP PORT must be a valid TCP port")
    url = f"http://127.0.0.1:{port}/v1"

    # Reuse the user's current CMP access header if configured, without output.
    headers: dict[str, str] = {}
    candidates = [home / "config.toml"]
    candidates += sorted(home.glob("config_*.toml"), key=lambda f: f.stat().st_mtime, reverse=True)
    for file in candidates:
        try:
            conf = load_toml(file)
        except (ValueError, OSError):
            continue
        for provider in conf.get("model_providers", {}).values():
            base = provider.get("base_url") or ""
            if base.rstrip("/") == url.rstrip("/") and isinstance(provider.get("http_headers"), dict):
                headers = dict(provider["http_headers"])
                break
        if headers:
            break
    access_token = env.get("PROXY_ACCESS_TOKEN") or os.getenv("PROXY_ACCESS_TOKEN")
    if access_token and not any(k.casefold() == "x-proxy-access-token" for k in headers):
        headers["X-Proxy-Access-Token"] = access_token
    if not all(isinstance(k, str) and isinstance(v, str) for k, v in headers.items()):
        raise ValueError("CMP http_headers must contain only text keys and values")
    return url, headers


def render_profile(model: str, effort: str, url: str | None, headers: dict) -> str:
    lines = [
        'model_provider = "openai"',
        f"model = {quote(model)}",
        f"model_reasoning_effort = {quote(effort)}",
        'forced_login_method = "chatgpt"',
    ]
    if url:
        unknown_headers = [key for key in headers if key.casefold() != 'x-proxy-access-token']
        if unknown_headers:
            raise ValueError('Built-in openai provider cannot forward custom CMP headers')
        access_token = next((value for key, value in headers.items()
                             if key.casefold() == 'x-proxy-access-token'), '')
        if access_token:
            # Built-in openai ignores custom http_headers. Carry the existing
            # local CMP access secret in an opaque path segment instead.
            credential = base64.urlsafe_b64encode(access_token.encode('utf-8')).decode('ascii').rstrip('=')
            url = url.removesuffix('/v1') + '/_cmp-auth/' + credential + '/v1'
        lines.append(f"openai_base_url = {quote(url)}")
    return "\n".join(lines) + "\n"


def render_switch(template: str) -> str:
    return (
        "@echo off\r\n"
        "setlocal\r\n"
        f'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0switch_config.ps1" -TargetPath "%~dp0{template}"\r\n'
        "if errorlevel 1 (\r\n"
        "  echo [ERROR] Codex profile switch failed. Current config was preserved.\r\n"
        "  pause\r\n"
        "  exit /b 1\r\n"
        ")\r\n"
        "echo [OK] Codex profile switched. Restart Codex when convenient.\r\n"
        "timeout /t 3 /nobreak >nul\r\n"
        "exit /b 0\r\n"
    )


def atomic_write(file: Path, data: str, *, newline: str = "") -> None:
    tmp = file.with_name(file.name + ".new")
    try:
        with tmp.open("w", encoding="utf-8", newline=newline) as handle:
            handle.write(data)
        tmp.replace(file)
    finally:
        if tmp.exists():
            tmp.unlink()


def write_shortcuts(home: Path, cmp_root: Path) -> None:
    if not cmp_root.is_dir() or os.name != "nt":
        return
    links = [
        ("Codex-官方直连.lnk", home / "官方直连.cmd", "", str(home)),
        ("Codex-CMP模式.lnk", home / "CMP模式.cmd", "", str(home)),
        ("CMP-模型精选.lnk", Path(os.environ.get("WINDIR", "C:\\Windows")) / "System32" / "notepad.exe",
         f'"{cmp_root / "models.txt"}"', str(cmp_root)),
    ]

    def ps_quote(value: str) -> str:
        return "'" + value.replace("'", "''") + "'"

    instructions = ["$w = New-Object -ComObject WScript.Shell"]
    for title, target, arguments, workdir in links:
        instructions += [
            f"$s = $w.CreateShortcut({ps_quote(str(cmp_root / title))})",
            f"$s.TargetPath = {ps_quote(str(target))}",
            f"$s.Arguments = {ps_quote(arguments)}",
            f"$s.WorkingDirectory = {ps_quote(workdir)}",
            "$s.Save()",
        ]
    encoded = base64.b64encode(";\n".join(instructions).encode("utf-16le")).decode("ascii")
    try:
        subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
            timeout=25, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
        )
    except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        print("SHORTCUT_SETUP_WARNING", type(error).__name__)


def install(home: Path, cmp_root: Path, *, create_shortcuts: bool = False) -> None:
    if not home.is_dir() or not (home / "config.toml").is_file():
        raise FileNotFoundError(f"Codex config directory not found: {home}")
    if not (cmp_root / "AGENTS.md").is_file():
        raise FileNotFoundError("CMP project directory is invalid")
    switch_script = home / "switch_config.ps1"
    template = Path(__file__).with_name("switch_config.ps1")
    if not template.is_file():
        raise FileNotFoundError("Missing switch_config.ps1")

    model, effort = active_official_model(home)
    url, headers = get_local_proxy_settings(home, cmp_root)
    cmp_model = active_cmp_model(home, url, cmp_root)
    official = render_profile(model, effort, None, {})
    cmp_profile = render_profile(cmp_model, "medium", url, headers)
    for data in (official, cmp_profile):
        tomllib.loads(data)

    switch_code = template.read_text(encoding="utf-8-sig")
    if not switch_script.is_file() or switch_script.read_text(encoding="utf-8-sig") != switch_code:
        atomic_write(switch_script, switch_code)

    # Generate first; retire only files that are no longer used by the switches.
    for name, data in [
        ("config_official.toml", official),
        ("config_cmp.toml", cmp_profile),
        ("官方直连.cmd", render_switch("config_official.toml")),
        ("CMP模式.cmd", render_switch("config_cmp.toml")),
    ]:
        target = home / name
        if not target.is_file() or target.read_text(encoding="utf-8-sig") != data:
            atomic_write(target, data)

    retired = [
        *home.glob("config_*.cmd"),
        *(f for f in home.glob("config_*.toml") if f.name not in ("config_cmp.toml", "config_official.toml")),
        *(f for f in home.glob("switch_config_*.ps1") if f.name != "switch_config.ps1"),
    ]
    retired = [f for f in retired if f.is_file()]
    if retired:
        directory = home / "backup-switch" / ("retired-" + datetime.now().strftime("%Y%m%d-%H%M%S"))
        directory.mkdir(parents=True, exist_ok=False)
        for source in retired:
            shutil.move(str(source), str(directory / source.name))

    readme = home / "README.md"
    documentation = (
        "# Codex 双模式切换\n\n"
        "只有两个切换入口：`官方直连.cmd` 与 `CMP模式.cmd`。\n"
        "双击官方直连可在 CMP 出错、未启动或网络故障时完全绕开 CMP。\n"
        "双击 CMP 模式则把 Codex 指向本机 CMP 的 Responses API。\n\n"
        "两个 CMD 都调用 `switch_config.ps1`，且仅修改当前 `config.toml` 的"
        "模型、认证和活动 Provider 区段；不会覆盖其他 MCP、插件或项目设置。"
        "切换前会在 `backup-switch/` 自动保存快照。\n\n"
        "CMP 的下拉列表在 CMP 项目目录里的 `models.txt` 编辑："
        "行首加 `* ` 表示显示，去掉表示隐藏。模型名从上游自动补全；"
        "隐藏不影响按完整 ID 调用。编辑后让 Codex 刷新模型目录即可。\n"
        "首次生成和日后追加模型均由 CMP 负责；该文件仅保存在本机。\n"
        "切换后 Codex 桌面版可能需要重新打开才会读取新配置；CMD 不会自动结束 Codex。\n"
    )
    if not readme.exists() or "配置切换模板" in readme.read_text(encoding="utf-8-sig"):
        atomic_write(readme, documentation)
    if create_shortcuts:
        write_shortcuts(home, cmp_root)

    print("OFFICIAL_PROFILE_READY", (home / "config_official.toml").is_file())
    print("CMP_PROFILE_READY", (home / "config_cmp.toml").is_file())
    print("ACTIVE_CONFIG_UNCHANGED", (home / "config.toml").is_file())
    print("RETIRED_SWITCHER_COUNT", len(retired))
    print("CMP_FAVORITES_FILE", cmp_root / "models.txt")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--codex-home", type=Path, default=Path.home() / ".codex")
    parser.add_argument("--cmp-root", type=Path, default=Path(__file__).resolve().parent.parent)
    args = parser.parse_args()
    install(args.codex_home.resolve(), args.cmp_root.resolve(), create_shortcuts=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
