"""Organize obsolete files scattered directly in ~/.codex.

Default is a dry run. --apply archives old configuration/model artifacts under
backup-switch/root-archive-YYYYMMDD and deletes only abandoned app-state
temporary files older than seven days. It does not touch subdirectory caches,
sessions, plugins, credentials in use, current model catalogs, or live locks.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
from pathlib import Path
import re
import sys

TEMP_DAYS = 7
ARCHIVE_DAYS = 7

_ALTERNATES = {
    "config1.toml", "config.toml.kiki", "auth.json.kiki",
    "models.json", "models_deepseek.json", "models_opencode.json",
    "switch_config.ps1.bak",
}
_BACKUP_PATTERNS = [
    re.compile(r"config\.toml\.bak(?:[-.].+)?$", re.IGNORECASE),
    re.compile(r"config\.toml\.[^/\\]+\.bak$", re.IGNORECASE),
    re.compile(r"config_[^/\\]+\.(?:cmd|toml)\.bak-.+$", re.IGNORECASE),
    re.compile(r"models_opencode\.json\.[^/\\]+\.bak$", re.IGNORECASE),
    re.compile(r"hooks\.json\.bak-.+$", re.IGNORECASE),
    re.compile(r"AGENTS\.md(?:\.?\d{6})$", re.IGNORECASE),
]
_TEMP_PREFIXES = (
    "..codex-global-state.json.tmp-",
    "..codex-global-state.json.bak.tmp-",
)


def _within(root: Path, candidate: Path) -> bool:
    try:
        return (
            candidate.resolve().parent == root.resolve()
            and not candidate.is_symlink()
            and not getattr(candidate, "is_junction", lambda: False)()
        )
    except OSError:
        return False


def classify(name: str) -> str | None:
    if name.startswith(_TEMP_PREFIXES):
        return "discard-stale-temp"
    if name in _ALTERNATES or any(p.fullmatch(name) for p in _BACKUP_PATTERNS):
        return "archive-old-file"
    return None


def find_candidates(home: Path, *, now: datetime) -> list[tuple[str, Path]]:
    if not home.is_dir():
        raise ValueError("Codex configuration home does not exist")
    if not (home / "config.toml").is_file():
        raise ValueError("Active config.toml is missing")
    results = []
    for path in sorted(home.iterdir(), key=lambda x: x.name.casefold()):
        if not path.is_file() or not _within(home, path):
            continue
        kind = classify(path.name)
        if kind is None:
            continue
        age_days = (now.timestamp() - path.stat().st_mtime) / 86400
        if age_days < (TEMP_DAYS if kind == "discard-stale-temp" else ARCHIVE_DAYS):
            continue
        results.append((kind, path))
    return results


def tidy_root(home: Path, *, apply: bool, now: datetime | None = None) -> tuple[int, int]:
    now = now or datetime.now(timezone.utc)
    home = home.resolve()
    if apply and home != (Path.home() / ".codex").resolve():
        raise ValueError("Write access is limited to the current user's .codex")
    items = find_candidates(home, now=now)
    discard = sum(kind == "discard-stale-temp" for kind, _ in items)
    archive = len(items) - discard
    print("MODE", "APPLY" if apply else "DRY_RUN")
    print("CODEX_HOME", home)
    print("TOP_LEVEL_FILE_COUNT_BEFORE", sum(f.is_file() for f in home.iterdir()))
    for kind, file in items:
        print("FILE", kind, file.name)
    print("ARCHIVE_COUNT", archive)
    print("STALE_TEMP_COUNT", discard)
    if not apply:
        return archive, discard

    backup_root = home / "backup-switch"
    folder = backup_root / ("root-archive-" + now.strftime("%Y%m%d"))
    if archive:
        if backup_root.is_symlink() or getattr(backup_root, "is_junction", lambda: False)():
            raise ValueError("Backup directory must not be a link or junction")
        if backup_root.exists() and backup_root.resolve().parent != home:
            raise ValueError("Backup directory must remain directly inside .codex")
        if folder.exists() and not folder.is_dir():
            raise ValueError("Archive path is not a directory")
        folder.mkdir(parents=True, exist_ok=True)
        if folder.is_symlink() or not folder.resolve().is_relative_to(home):
            raise ValueError("Archive destination escapes Codex home")
    for kind, file in items:
        if not _within(home, file):
            raise ValueError("Source changed during cleanup")
        if kind == "discard-stale-temp":
            file.unlink()
        else:
            destination = folder / file.name
            if destination.exists():
                raise FileExistsError("Not overwriting an existing archive: " + destination.name)
            file.rename(destination)
    print("TOP_LEVEL_FILE_COUNT_AFTER", sum(f.is_file() for f in home.iterdir()))
    print("ARCHIVE_FOLDER", folder if archive else "none")
    print("MOVED_TO_ARCHIVE", archive)
    print("DISCARDED_STALE_TEMP", discard)
    return archive, discard


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--codex-home", type=Path, default=Path.home() / ".codex")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    tidy_root(args.codex_home, apply=args.apply)
    return 0


if __name__ == "__main__":
    sys.exit(main())
