"""Auditable, opt-in cleanup of obsolete Codex caches and switcher backups.

The default mode is a dry run. --apply only operates on the current user's
.codex directory and deletes explicitly allowlisted, stale artifacts.
Never touches authentication, conversations, databases, installed plugins,
the active model cache, or the current two-mode switcher.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import os
from pathlib import Path
import shutil
import sys

OLDER_THAN_DAYS = 30
GLOBAL_TEMP_DAYS = 7


def contained(root: Path, candidate: Path) -> bool:
    try:
        return (
            candidate.resolve().is_relative_to(root.resolve())
            and not candidate.is_symlink()
            and not getattr(candidate, "is_junction", lambda: False)()
        )
    except OSError:
        return False


def tree_info(path: Path) -> tuple[int, float] | None:
    if path.is_symlink() or getattr(path, "is_junction", lambda: False)():
        return None
    if path.is_file():
        st = path.stat()
        return st.st_size, st.st_mtime
    if not path.is_dir():
        return None
    size = 0
    latest = 0.0
    for location, folders, filenames in os.walk(path, followlinks=False):
        for name in folders:
            folder = Path(location) / name
            if folder.is_symlink() or getattr(folder, "is_junction", lambda: False)():
                return None
        for name in filenames:
            file = Path(location) / name
            if file.is_symlink() or getattr(file, "is_junction", lambda: False)():
                return None
            try:
                info = file.stat()
                size += info.st_size
                latest = max(latest, info.st_mtime)
            except OSError:
                return None
    if latest == 0:
        latest = path.stat().st_mtime
    return size, latest


def collect(home: Path, now: datetime) -> list[tuple[str, Path, int]]:
    if not home.is_dir() or not (home / "config.toml").is_file():
        raise ValueError("Expected an existing Codex configuration directory")
    if not (home / "config_official.toml").is_file() or not (home / "config_cmp.toml").is_file():
        raise ValueError("Two-mode switcher must be installed before cleanup")
    timestamp = now.timestamp()
    old = timestamp - OLDER_THAN_DAYS * 86400
    stale = timestamp - GLOBAL_TEMP_DAYS * 86400
    entries: list[tuple[str, Path, int]] = []
    seen: set[Path] = set()

    def candidate(category: str, path: Path, cutoff: float | None) -> None:
        if path in seen or not contained(home, path):
            return
        data = tree_info(path)
        if data is None or (cutoff is not None and data[1] >= cutoff):
            return
        seen.add(path)
        entries.append((category, path, data[0]))

    # .tmp/plugins is an old downloaded copy, not .codex/plugins.
    candidate("old-plugin-checkout", home / ".tmp" / "plugins", old)
    for path in (home / ".tmp").glob("plugins-clone-*"):
        candidate("old-plugin-clone", path, old)
    for path in (home / ".tmp" / "bundled-marketplaces").glob("*.staging-*"):
        candidate("old-plugin-staging", path, old)

    for glob in ("..codex-global-state.json.tmp-*", "..codex-global-state.json.bak.tmp-*"):
        for path in home.glob(glob):
            candidate("abandoned-state-temp", path, stale)
    for path in (home / ".sandbox").glob("sandbox.*.log"):
        candidate("old-sandbox-log", path, old)
    for name in ("models.json", "models_deepseek.json", "models_opencode.json"):
        candidate("obsolete-model-catalog", home / name, old)
    for path in home.glob("models_opencode.json.*.bak"):
        candidate("obsolete-model-backup", path, old)

    for path in (home / "backup-switch").glob("retired-*"):
        candidate("retired-switcher", path, None)
    for path in home.glob("config_*.cmd.bak-*"):
        candidate("retired-switcher-backup", path, old)
    for path in home.glob("config_*.toml.bak-*"):
        candidate("retired-template-backup", path, old)
    candidate("old-switcher-backup", home / "switch_config.ps1.bak", old)

    # Keep two latest complete Codex config backups for disaster recovery.
    snapshots = {
        *home.glob("config.toml.bak*"),
        *home.glob("config.toml.*.bak"),
        *(home / "backup-switch").glob("config.toml.*.bak"),
    }
    ordered = sorted(
        (p for p in snapshots if p.is_file() and contained(home, p)),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    for path in ordered[2:]:
        candidate("redundant-config-backup", path, old)
    return sorted(entries, key=lambda row: (row[0], str(row[1]).casefold()))


def execute(home: Path, *, apply: bool, now: datetime | None = None) -> tuple[int, int]:
    now = now or datetime.now(timezone.utc)
    home = home.resolve()
    if apply and home != (Path.home() / ".codex").resolve():
        raise ValueError("--apply is restricted to the current user's own .codex directory")
    candidates = collect(home, now)
    total = sum(size for _, _, size in candidates)
    print("MODE", "APPLY" if apply else "DRY_RUN")
    print("TARGET", home)
    for category, path, size in candidates:
        print("CANDIDATE", category, round(size / 1048576, 2), "MiB", path.relative_to(home))
    print("CANDIDATE_COUNT", len(candidates))
    print("POTENTIAL_MIB", round(total / 1048576, 2))
    if apply:
        for category, path, size in candidates:
            if not contained(home, path):
                raise RuntimeError("Cleanup target escaped .codex: " + str(path))
            if path.is_dir():
                shutil.rmtree(path)
            else:
                path.unlink()
        print("DELETED_COUNT", len(candidates))
        print("FREED_MIB", round(total / 1048576, 2))
    return len(candidates), total


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--codex-home", type=Path, default=Path.home() / ".codex")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    execute(args.codex_home, apply=args.apply)
    return 0


if __name__ == "__main__":
    sys.exit(main())
