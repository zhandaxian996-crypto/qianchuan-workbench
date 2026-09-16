#!/usr/bin/env python3
"""Check the portable skill's declared files and local evidence without network access."""
import hashlib
import json
from pathlib import Path
import re
import sys
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parents[1]

def under_root(path):
    resolved = path.resolve()
    try:
        resolved.relative_to(ROOT)
    except ValueError:
        raise ValueError("dependency escapes skill root: " + str(path)) from None
    return resolved

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def check():
    manifest = json.loads((ROOT / "package-manifest.json").read_text(encoding="utf-8"))
    declared = manifest["files"]
    errors = []
    links = 0
    for relative, expected in declared.items():
        try:
            path = under_root(ROOT / relative)
            if not path.is_file():
                errors.append("missing: " + relative)
                continue
            if sha(path) != expected:
                errors.append("hash mismatch: " + relative)
            text = path.read_text(encoding="utf-8")
            if re.search(r"(?<![A-Za-z0-9])[A-Za-z]:[\\/]", text):
                errors.append("machine-specific drive path: " + relative)
            if re.search(r"(?:authcode/\?code=|(?:access_token|api_key)=)[A-Za-z0-9_-]{12,}", text):
                errors.append("embedded credential-like URL: " + relative)
            if path.suffix == ".md":
                for match in re.finditer(r"\[[^\]]*\]\((?:<([^>]+)>|([^)]+))\)", text):
                    target = match.group(1) or match.group(2)
                    if "://" in target or target.startswith("#"):
                        continue
                    target = unquote(target.split("#", 1)[0])
                    if not target:
                        continue
                    links += 1
                    linked = under_root(path.parent / target)
                    if not linked.is_file():
                        errors.append("missing link: " + relative + " -> " + target)
                    elif linked.relative_to(ROOT).as_posix() not in declared:
                        errors.append("undeclared link: " + relative + " -> " + target)
        except (OSError, ValueError) as error:
            errors.append(str(error))
    catalog_path = ROOT / "references/来源清单.json"
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    source_ids = set()
    evidence_count = 0
    for entry in catalog["sources"]:
        source_id = entry["source_id"]
        if source_id in source_ids:
            errors.append("duplicate source: " + source_id)
        source_ids.add(source_id)
        if entry["excerpt_file"] is not None:
            excerpt = under_root(catalog_path.parent / entry["excerpt_file"])
            if not excerpt.is_file() or sha(excerpt) != entry["excerpt_sha256"]:
                errors.append("evidence mismatch: " + source_id)
            if excerpt.relative_to(ROOT).as_posix() not in declared:
                errors.append("undeclared evidence: " + source_id)
            evidence_count += 1
    for relative in declared:
        if relative.endswith(".md"):
            text = (ROOT / relative).read_text(encoding="utf-8")
            for source_id in set(re.findall(r"QC-OFFICIAL-\d{3}", text)):
                if source_id not in source_ids:
                    errors.append("unknown source " + source_id + " in " + relative)
    result = {"ok":not errors,"declared_files":len(declared),"local_links":links,"evidence_excerpts":evidence_count,"errors":errors}
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if not errors else 1

if __name__ == "__main__":
    try:
        raise SystemExit(check())
    except (OSError, ValueError, KeyError) as error:
        print(json.dumps({"ok":False,"error":str(error)}, ensure_ascii=False))
        raise SystemExit(1)
