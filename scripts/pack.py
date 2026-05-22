#!/usr/bin/env python3
"""Creates a deployable zip of WispNodes for Pterodactyl upload."""

import os
import zipfile
from pathlib import Path

ROOT = Path(__file__).parent.parent

EXCLUDE_DIRS  = {"node_modules", "data", ".git", ".cache", ".npm", ".pm2", ".claude", "scripts"}
EXCLUDE_FILES = {".env"}
EXCLUDE_EXT   = {".zip"}

def should_include(path: Path) -> bool:
    rel = path.relative_to(ROOT)
    parts = rel.parts
    # Exclude top-level dirs in EXCLUDE_DIRS
    if parts[0] in EXCLUDE_DIRS:
        return False
    # Exclude node_modules inside any app subdirectory
    if "node_modules" in parts:
        return False
    if path.is_file():
        if path.name in EXCLUDE_FILES:
            return False
        if path.suffix in EXCLUDE_EXT:
            return False
    return True

def main():
    out = ROOT / "package.zip"
    count = 0
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
        for path in sorted(ROOT.rglob("*")):
            if not path.is_file():
                continue
            if not should_include(path):
                continue
            arcname = path.relative_to(ROOT)
            zf.write(path, arcname)
            print(f"  + {arcname}")
            count += 1
    print(f"\n{count} files -> {out.name} ({out.stat().st_size // 1024} KB)")

if __name__ == "__main__":
    main()
