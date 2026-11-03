"""Safety tests for the allowlisted Codex cache cleanup."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("cleanup_codex.py")
SPEC = importlib.util.spec_from_file_location("codex_cleanup", SCRIPT)
CLEANUP = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CLEANUP)


class CleanupSafetyTests(unittest.TestCase):
    def test_stale_only_and_preserves_live_data_and_two_backups(self):
        now = datetime(2026, 11, 3, tzinfo=timezone.utc)
        with tempfile.TemporaryDirectory(dir=SCRIPT.parent.parent / ".git") as temp:
            home = Path(temp) / ".codex"
            home.mkdir()
            for name in ("config.toml", "config_official.toml", "config_cmp.toml"):
                (home / name).write_text("model = 'fixture'\n", encoding="utf-8")
            old = (now - timedelta(days=63)).timestamp()

            def create(relative, payload="test", mtime=old):
                file = home / relative
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text(payload, encoding="utf-8")
                os.utime(file, (mtime, mtime))
                return file

            temp_copy = create(".tmp/plugins/package/file.txt")
            staging = create(".tmp/bundled-marketplaces/openai-bundled.staging-old/plugin.txt")
            current = create(
                ".tmp/bundled-marketplaces/openai-bundled/plugin.txt",
                mtime=now.timestamp(),
            )
            model_old = create("models_deepseek.json")
            fresh_catalog = create("models_cache.json", mtime=now.timestamp())
            stale_state = create("..codex-global-state.json.tmp-legacy")
            auth = create("auth.json", mtime=now.timestamp())
            session = create("sessions/rollout.zst", mtime=old)
            plugin = create("plugins/installed/main.js", mtime=old)
            retired = create("backup-switch/retired-2026/config_deepseek.toml", mtime=old)
            backup_old = create("backup-switch/config.toml.20260801.bak")
            backup_middle = create("backup-switch/config.toml.20260902.bak", mtime=old + 86400)
            backup_new = create("backup-switch/config.toml.20260903.bak", mtime=old + 172800)
            sandbox_log = create(".sandbox/sandbox.old.log")

            rows = CLEANUP.collect(home, now)
            items = {path.relative_to(home).as_posix() for _, path, _ in rows}
            self.assertIn(".tmp/plugins", items)
            self.assertIn(".tmp/bundled-marketplaces/openai-bundled.staging-old", items)
            self.assertIn("models_deepseek.json", items)
            self.assertIn("..codex-global-state.json.tmp-legacy", items)
            self.assertIn("backup-switch/retired-2026", items)
            self.assertIn("backup-switch/config.toml.20260801.bak", items)
            self.assertIn(".sandbox/sandbox.old.log", items)
            for kept in (
                current, fresh_catalog, auth, session, plugin, backup_middle,
                backup_new, home / "config.toml",
            ):
                self.assertTrue(kept.exists())
                self.assertNotIn(kept.relative_to(home).as_posix(), items)
            with self.assertRaises(ValueError):
                CLEANUP.execute(home, apply=True, now=now)


if __name__ == "__main__":
    unittest.main()
