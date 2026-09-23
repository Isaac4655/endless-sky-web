#!/usr/bin/env python3
"""Generate resources/manifest.json for the Endless Sky web loader.

A static web server cannot list a directory, so index.html needs an explicit list of
every file it should stream. Run this after each build (or whenever the assets change):

    python make-manifest.py                # uses ./resources
    python make-manifest.py path/to/resources

Layout expected:

    resources/
        data/...       ->  streamed into /data    in the game filesystem
        shaders/...    ->  streamed into /shaders in the game filesystem
        images/...     ->  streamed into /images  in the game filesystem
        sounds/...     ->  streamed into /sounds  in the game filesystem

Output (resources/manifest.json):

    { "data": [["human/ships.txt", 1234], ...], "shaders": [...], "images": [...], "sounds": [...] }

Paths use forward slashes and are relative to resources/<category>/.
"""

import json
import os
import sys

CATEGORIES = ("data", "shaders", "images", "sounds")

# GitHub Pages and most CDNs will serve these, but they are never wanted in the game.
SKIP_NAMES = {".DS_Store", "Thumbs.db", "desktop.ini", ".gitkeep", ".gitattributes"}


def main() -> int:
    root = sys.argv[1] if len(sys.argv) > 1 else "resources"
    if not os.path.isdir(root):
        print(f"error: '{root}' is not a directory", file=sys.stderr)
        return 1

    manifest = {}
    grand_total = 0
    problems = 0
    underscore_paths = []

    for category in CATEGORIES:
        base = os.path.join(root, category)
        entries = []
        total = 0
        if not os.path.isdir(base):
            print(f"warning: {base} does not exist; '{category}' will be empty", file=sys.stderr)
            manifest[category] = entries
            continue

        for dirpath, dirnames, filenames in os.walk(base):
            # Skip hidden directories (.git and friends), but keep '_'-prefixed ones.
            dirnames[:] = sorted(d for d in dirnames if not d.startswith("."))
            for filename in sorted(filenames):
                if filename in SKIP_NAMES or filename.startswith("."):
                    continue
                full = os.path.join(dirpath, filename)
                rel = os.path.relpath(full, base).replace(os.sep, "/")

                # Characters that make a URL or a virtual-FS path ambiguous. The loader
                # percent-encodes every segment, so most names work, but flag the risky ones.
                if "\\" in rel or "\x00" in rel:
                    print(f"warning: skipping unusable name: {rel!r}", file=sys.stderr)
                    problems += 1
                    continue

                if any(part.startswith("_") for part in rel.split("/")):
                    underscore_paths.append(f"{category}/{rel}")

                size = os.path.getsize(full)
                entries.append([rel, size])
                total += size

        manifest[category] = entries
        grand_total += total
        print(f"{category:8s} {len(entries):6d} files  {total / 1048576:9.1f} MB")

    # GitHub Pages runs Jekyll by default, which silently drops any file or folder whose
    # name starts with '_' unless a .nojekyll file exists at the site root.
    if underscore_paths:
        abs_root = os.path.abspath(root)
        candidates = [abs_root, os.path.dirname(abs_root), os.path.dirname(os.path.dirname(abs_root))]
        if not any(os.path.exists(os.path.join(c, ".nojekyll")) for c in candidates):
            print(f"\nWARNING: {len(underscore_paths)} file(s) are under '_'-prefixed names, e.g. "
                  f"{underscore_paths[0]}", file=sys.stderr)
            print("         GitHub Pages will NOT serve these unless the site root contains an empty "
                  "file named .nojekyll", file=sys.stderr)
            problems += 1

    out_path = os.path.join(root, "manifest.json")
    with open(out_path, "w", encoding="utf-8", newline="\n") as handle:
        json.dump(manifest, handle, separators=(",", ":"))
    print(f"{'total':8s} {sum(len(v) for v in manifest.values()):6d} files  {grand_total / 1048576:9.1f} MB")
    print(f"wrote {out_path} ({os.path.getsize(out_path) / 1024:.1f} KB)")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())