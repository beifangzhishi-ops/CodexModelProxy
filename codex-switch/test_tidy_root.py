from datetime import datetime, timedelta, timezone
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).with_name("tidy_root.py")
SPEC = importlib.util.spec_from_file_location("cmp_tidy_root", SCRIPT)
TIDY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(TIDY)


class TidyRootTests(unittest.TestCase):
    def test_classifications_only_match_known_old_root_files(self):
        self.assertEqual(TIDY.classify("models_deepseek.json"), "archive-old-file")
        self.assertEqual(TIDY.classify("config.toml.bak-20260810"), "archive-old-file")
        self.assertEqual(TIDY.classify("AGENTS.md.261007"), "archive-old-file")
        self.assertEqual(TIDY.classify("config1.toml"), "archive-old-file")
        self.assertEqual(TIDY.classify("..codex-global-state.json.tmp-123"), "discard-stale-temp")
        for name in (
            "config.toml", "config_cmp.toml", "config_official.toml",
            "auth.json", "models_cache.json", "AGENTS.md", "hooks.json",
            ".codex-global-state.json.bak", "switch_config.ps1",
            "tencent-memory-hook.cmd", "key.txt", "state_5.sqlite",
            "thread_history_1.sqlite", "session_index.jsonl",
        ):
            self.assertIsNone(TIDY.classify(name), name)

    def test_dry_run_preserves_all_files(self):
        now = datetime(2026, 11, 3, tzinfo=timezone.utc)
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory) / ".codex"
            home.mkdir()
            (home / "config.toml").write_text('model = "fixture"', encoding="utf-8")
            for name in ("config1.toml", "..codex-global-state.json.tmp-legacy", "auth.json.kiki"):
                file = home / name
                file.write_text("fixture", encoding="utf-8")
                old = (now - timedelta(days=45)).timestamp()
                os.utime(file, (old, old))
            (home / "models_cache.json").write_text("active", encoding="utf-8")
            self.assertEqual(TIDY.tidy_root(home, apply=False, now=now), (2, 1))
            self.assertEqual(len(list(home.iterdir())), 5)
            with self.assertRaises(ValueError):
                TIDY.tidy_root(home, apply=True, now=now)

    def test_apply_archives_known_old_files_and_only_deletes_abandoned_temp(self):
        now = datetime(2026, 11, 3, tzinfo=timezone.utc)
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            home = base / ".codex"
            home.mkdir()
            (home / "config.toml").write_text('model = "active"', encoding="utf-8")
            (home / "config_cmp.toml").write_text("current cmp", encoding="utf-8")
            (home / "models_cache.json").write_text("live", encoding="utf-8")
            (home / "auth.json").write_text("live auth", encoding="utf-8")
            old = (now - timedelta(days=70)).timestamp()
            for name in (
                "config.toml.bak-20260810", "models_deepseek.json",
                "..codex-global-state.json.bak.tmp-older",
            ):
                file = home / name
                file.write_text("stale", encoding="utf-8")
                os.utime(file, (old, old))
            with patch.object(TIDY.Path, "home", return_value=base):
                self.assertEqual(TIDY.tidy_root(home, apply=True, now=now), (2, 1))
            archive = home / "backup-switch" / "root-archive-20261103"
            self.assertTrue((archive / "config.toml.bak-20260810").is_file())
            self.assertTrue((archive / "models_deepseek.json").is_file())
            self.assertFalse((home / "..codex-global-state.json.bak.tmp-older").exists())
            self.assertEqual((home / "config.toml").read_text(encoding="utf-8"), 'model = "active"')
            self.assertTrue((home / "config_cmp.toml").exists())
            self.assertTrue((home / "models_cache.json").exists())
            self.assertTrue((home / "auth.json").exists())


if __name__ == "__main__":
    unittest.main()
