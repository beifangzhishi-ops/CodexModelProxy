"""Isolated tests for generating the two Windows Codex switches."""
from __future__ import annotations

import importlib.util
from pathlib import Path
import os
import shutil
import subprocess
import tempfile
import tomllib
import unittest


FILE = Path(__file__).with_name("install.py")
SPEC = importlib.util.spec_from_file_location("cmp_switch_installer", FILE)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class SwitchInstallerTests(unittest.TestCase):
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
                'model_provider = "OpenAI"\nmodel = "gpt-current"\n'
                'model_reasoning_effort = "high"\nforced_login_method = "chatgpt"\n'
                '\n[model_providers.OpenAI]\nname = "OpenAI"\n'
                'wire_api = "responses"\nrequires_openai_auth = true\n'
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
            self.assertNotIn("base_url", official["model_providers"]["OpenAI"])
            self.assertEqual(cmp_profile["model"], "kimi/kimi-selected")
            self.assertEqual(cmp_profile["model_providers"]["OpenAI"]["base_url"],
                             "http://127.0.0.1:9777/v1")
            self.assertEqual(cmp_profile["model_providers"]["OpenAI"]["http_headers"],
                             {"X-Proxy-Access-Token": "local-test-token"})
            self.assertEqual({p.name for p in home.glob("*.cmd")},
                             {"官方直连.cmd", "CMP模式.cmd"})
            retired = list((home / "backup-switch").glob("retired-*"))
            self.assertEqual(len(retired), 1)
            self.assertEqual(sorted(p.name for p in retired[0].iterdir()),
                             ["config_older.cmd", "config_older.toml", "switch_config_older.ps1"])

            # Reinstalling must not override a user-edited profile.
            (home / "config_cmp.toml").write_text('model = "custom"\n', encoding="utf-8")
            MODULE.install(home, project)
            self.assertEqual((home / "config_cmp.toml").read_text(encoding="utf-8"),
                             'model = "custom"\n')

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
                'model_provider = "OpenAI"\nmodel = "gpt-current"\n'
                'model_reasoning_effort = "medium"\nforced_login_method = "chatgpt"\n'
                '\n[model_providers.OpenAI]\nname = "OpenAI"\n'
                'wire_api = "responses"\nrequires_openai_auth = true\n'
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
            self.assertEqual(changed["model_providers"]["OpenAI"]["base_url"],
                             "http://127.0.0.1:8787/v1")
            self.assertEqual(changed["mcp_servers"]["fixture"]["command"], "python")

            restored = activate("config_official.toml")
            self.assertEqual(restored["model"], "gpt-current")
            self.assertNotIn("base_url", restored["model_providers"]["OpenAI"])
            self.assertEqual(restored["mcp_servers"]["fixture"]["command"], "python")
            self.assertGreaterEqual(len(list((home / "backup-switch").glob("config.toml.*.bak"))), 2)


if __name__ == "__main__":
    unittest.main()
