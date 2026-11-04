"""Isolated tests for generating the two Windows Codex switches."""
from __future__ import annotations

import importlib.util
import base64
from pathlib import Path
import os
import shutil
import subprocess
import tempfile
import tomllib
import unittest
from unittest import mock


FILE = Path(__file__).with_name("install.py")
SPEC = importlib.util.spec_from_file_location("cmp_switch_installer", FILE)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class SwitchInstallerTests(unittest.TestCase):
    def test_stale_codex_header_cannot_force_tokenized_cmp_url(self):
        with tempfile.TemporaryDirectory(dir=FILE.parent.parent) as directory:
            root = Path(directory)
            home = root / '.codex'
            project = root / 'cmp'
            home.mkdir()
            project.mkdir()
            (project / 'proxy-local.env').write_text('PORT=8787\n', encoding='utf-8')
            (project / 'proxy-config.json').write_text('{}\n', encoding='utf-8')
            (home / 'config.toml').write_text(
                'model_provider = "OpenAI"\n'
                '[model_providers.OpenAI]\n'
                'base_url = "http://127.0.0.1:8787/v1"\n'
                'http_headers = { "X-Proxy-Access-Token" = "unused-stale-header" }\n',
                encoding='utf-8',
            )
            with mock.patch.dict(os.environ, {'PROXY_ACCESS_TOKEN': ''}):
                url, headers = MODULE.get_local_proxy_settings(project)
            self.assertEqual(url, 'http://127.0.0.1:8787/v1')
            self.assertEqual(headers, {})
            cmp_profile = tomllib.loads(MODULE.render_profile('gpt-test', 'medium', url, headers))
            self.assertEqual(cmp_profile['openai_base_url'], url)

            (project / 'proxy-config.json').write_text(
                '{"access_token": "real-current-token"}', encoding='utf-8',
            )
            with mock.patch.dict(os.environ, {'PROXY_ACCESS_TOKEN': ''}):
                _, headers = MODULE.get_local_proxy_settings(project)
            self.assertEqual(headers, {'X-Proxy-Access-Token': 'real-current-token'})

    def test_two_profiles_are_independent_and_existing_configuration_is_untouched(self):
        with tempfile.TemporaryDirectory(dir=FILE.parent.parent) as directory:
            root = Path(directory)
            home = root / ".codex"
            project = root / "cmp"
            home.mkdir()
            project.mkdir()
            (project / "AGENTS.md").write_text("CMP rules", encoding="utf-8")
            (project / "proxy-local.env").write_text(
                "PORT=9777\nPROXY_ACCESS_TOKEN=local-test-token\n", encoding="utf-8",
            )
            (project / "models.txt").write_text(
                "* kimi/kimi-selected\n  ds/deepseek-flash\n", encoding="utf-8",
            )
            active = (
                'model_provider = "openai"\nmodel = "gpt-current"\n'
                'model_reasoning_effort = "high"\nforced_login_method = "chatgpt"\n'
            )
            (home / "config.toml").write_text(active, encoding="utf-8")
            (home / "switch_config.ps1").write_text("unchanged", encoding="utf-8")
            (home / "config_older.cmd").write_text("old", encoding="utf-8")
            (home / "config_older.toml").write_text("model = 'unused'", encoding="utf-8")
            (home / "switch_config_older.ps1").write_text("retired", encoding="utf-8")
            MODULE.install(home, project)

            self.assertEqual((home / "config.toml").read_text(encoding="utf-8"), active)
            official = tomllib.loads((home / "config_official.toml").read_text(encoding="utf-8"))
            cmp_profile = tomllib.loads((home / "config_cmp.toml").read_text(encoding="utf-8"))
            self.assertEqual(official["model"], "gpt-current")
            self.assertEqual(official["model_reasoning_effort"], "high")
            self.assertEqual(official["model_provider"], "openai")
            self.assertNotIn("openai_base_url", official)
            self.assertNotIn("model_providers", official)
            self.assertEqual(cmp_profile["model"], "kimi/kimi-selected")
            self.assertEqual(cmp_profile["model_provider"], "openai")
            expected_secret = base64.urlsafe_b64encode(b"local-test-token").decode('ascii').rstrip('=')
            self.assertEqual(cmp_profile["openai_base_url"],
                             f"http://127.0.0.1:9777/_cmp-auth/{expected_secret}/v1")
            self.assertNotIn("model_providers", cmp_profile)
            self.assertEqual({p.name for p in home.glob("*.cmd")},
                             {"官方直连.cmd", "CMP模式.cmd"})
            retired = list((home / "backup-switch").glob("retired-*"))
            self.assertEqual(len(retired), 1)
            self.assertEqual(sorted(p.name for p in retired[0].iterdir()),
                             ["config_older.cmd", "config_older.toml", "switch_config_older.ps1"])

            # Reinstalling refreshes the managed switch templates.
            (home / "config_cmp.toml").write_text('model = "custom"\n', encoding="utf-8")
            MODULE.install(home, project)
            self.assertEqual(tomllib.loads((home / "config_cmp.toml").read_text(encoding="utf-8")),
                             cmp_profile)

            with mock.patch.object(MODULE, "write_shortcuts") as create_shortcuts:
                MODULE.install(home, project, create_shortcuts=True)
                create_shortcuts.assert_called_once_with(home, project)

    @unittest.skipUnless(os.name == "nt", "Windows shortcut creation requires Windows")
    def test_shortcuts_live_in_project_root_and_keep_their_targets(self):
        with tempfile.TemporaryDirectory(dir=FILE.parent.parent) as directory:
            root = Path(directory)
            home = root / ".codex"
            project = root / "cmp"
            home.mkdir()
            project.mkdir()
            with mock.patch.object(MODULE.subprocess, "run") as run:
                MODULE.write_shortcuts(home, project)

            command = run.call_args.args[0]
            self.assertEqual(command[:3], ["powershell.exe", "-NoProfile", "-NonInteractive"])
            script = base64.b64decode(command[-1]).decode("utf-16le")
            for name in ("Codex-官方直连.lnk", "Codex-CMP模式.lnk", "CMP-模型精选.lnk"):
                self.assertIn(str(project / name), script)
            for target in (home / "官方直连.cmd", home / "CMP模式.cmd", project / "models.txt"):
                self.assertIn(str(target), script)
            self.assertNotIn(str(root / "Desktop"), script)

    @unittest.skipUnless(os.name == "nt" and shutil.which("powershell.exe"), "Requires Windows PowerShell")
    def test_real_switcher_roundtrips_without_changing_mcp_configuration(self):
        with tempfile.TemporaryDirectory(dir=FILE.parent.parent) as directory:
            root = Path(directory)
            home = root / ".codex"
            project = root / "cmp"
            home.mkdir()
            project.mkdir()
            (project / "AGENTS.md").write_text("CMP rules", encoding="utf-8")
            (project / "proxy-local.env").write_text("PORT=8787\n", encoding="utf-8")
            original = (
                'model_provider = "openai"\nmodel = "gpt-current"\n'
                'model_reasoning_effort = "medium"\nforced_login_method = "chatgpt"\n'
                '\n[model_providers.deepseek]\nname = "DeepSeek"\n'
                'base_url = "https://api.deepseek.com/v1"\nwire_api = "responses"\n'
                '\n[mcp_servers.fixture]\ncommand = "python"\nargs = []\n'
            )
            (home / "config.toml").write_text(original, encoding="utf-8")
            shutil.copyfile(FILE.with_name("switch_config.ps1"), home / "switch_config.ps1")
            MODULE.install(home, project)

            def activate(name):
                result = subprocess.run(
                    ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass",
                     "-File", str(home / "switch_config.ps1"),
                     "-TargetPath", str(home / name)],
                    capture_output=True, timeout=35, text=True,
                )
                self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
                return load_toml(home / "config.toml")

            def load_toml(file):
                return tomllib.loads(file.read_text(encoding="utf-8-sig"))

            changed = activate("config_cmp.toml")
            self.assertEqual(changed["model"], "ds/deepseek-flash")
            self.assertEqual(changed["model_provider"], "openai")
            self.assertEqual(changed["openai_base_url"], "http://127.0.0.1:8787/v1")
            self.assertEqual(changed["mcp_servers"]["fixture"]["command"], "python")
            self.assertIn("deepseek", changed["model_providers"])
            legacy = changed["model_providers"]["OpenAI"]
            self.assertEqual(legacy["base_url"], "https://chatgpt.com/backend-api/codex")
            self.assertEqual(legacy["wire_api"], "responses")
            self.assertIs(legacy["requires_openai_auth"], True)
            self.assertIs(legacy["supports_websockets"], True)

            restored = activate("config_official.toml")
            self.assertEqual(restored["model"], "gpt-current")
            self.assertEqual(restored["model_provider"], "openai")
            self.assertNotIn("openai_base_url", restored)
            self.assertEqual(restored["mcp_servers"]["fixture"]["command"], "python")
            self.assertIn("deepseek", restored["model_providers"])
            self.assertEqual(restored["model_providers"]["OpenAI"], legacy)
            self.assertGreaterEqual(len(list((home / "backup-switch").glob("config.toml.*.bak"))), 2)

    @unittest.skipUnless(os.name == "nt" and shutil.which("powershell.exe"), "Requires Windows PowerShell")
    def test_native_provider_switch_preserves_legacy_official_provider(self):
        with tempfile.TemporaryDirectory(dir=FILE.parent.parent) as directory:
            root = Path(directory)
            home = root / ".codex"
            project = root / "cmp"
            home.mkdir()
            project.mkdir()
            (project / "AGENTS.md").write_text("CMP rules", encoding="utf-8")
            (project / "models.txt").write_text("* ds/deepseek-flash\n", encoding="utf-8")
            (project / "proxy-local.env").write_text("PORT=8787\n", encoding="utf-8")
            old_case = "openai".title()
            legacy_table = (
                f'[model_providers.{old_case}]\nname = "OpenAI"\n'
                'base_url = "https://chatgpt.com/backend-api/codex"\n'
                'wire_api = "responses"\nrequires_openai_auth = true\n'
                'supports_websockets = true\n'
            )
            (home / "config.toml").write_text(
                f'model_provider = "{old_case}"\nmodel = "gpt-6.1-sol"\n'
                f'\n{legacy_table}'
                '\n[model_providers.openai]\nname = "invalid override"\n'
                '\n[plugins.fixture]\nenabled = true\n', encoding="utf-8",
            )
            MODULE.install(home, project)
            command = ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
                       str(home / "switch_config.ps1"), "-TargetPath", str(home / "config_official.toml")]
            result = subprocess.run(command, capture_output=True, text=True, timeout=35)
            self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
            current = tomllib.loads((home / "config.toml").read_text(encoding="utf-8-sig"))
            self.assertEqual(current["model_provider"], "openai")
            self.assertIn(legacy_table, (home / "config.toml").read_text(encoding="utf-8-sig"))
            self.assertEqual(current["model_providers"]["OpenAI"]["base_url"],
                             "https://chatgpt.com/backend-api/codex")
            self.assertNotIn("openai", current["model_providers"])
            self.assertNotIn("openai_base_url", current)
            self.assertEqual(current["plugins"]["fixture"]["enabled"], True)

            command[-1] = str(home / "config_cmp.toml")
            result = subprocess.run(command, capture_output=True, text=True, timeout=35)
            self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
            cmp_config = tomllib.loads((home / "config.toml").read_text(encoding="utf-8-sig"))
            self.assertEqual(cmp_config["model_provider"], "openai")
            self.assertEqual(cmp_config["openai_base_url"], "http://127.0.0.1:8787/v1")
            self.assertEqual(cmp_config["model_providers"]["OpenAI"],
                             current["model_providers"]["OpenAI"])


if __name__ == "__main__":
    unittest.main()
