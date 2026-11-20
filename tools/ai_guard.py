#!/usr/bin/env python3
"""Fail-closed exporter/applicator for small, untrusted AI patches."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import sys
import tempfile

MAX_FILES = 8
MAX_LINES = 300
MAX_PATCH = 64 * 1024
SHA40 = re.compile(r"[0-9a-fA-F]{40}\Z")
SAFE_PATH = re.compile(r"[A-Za-z0-9._/-]+\Z")

class GuardError(Exception):
    pass


def git_env(extra=None):
    env = dict(os.environ)
    for key in list(env):
        if key.startswith("GIT_CONFIG_"):
            env.pop(key, None)
    env.update({
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_OPTIONAL_LOCKS": "0",
        "GIT_FLUSH": "1",
    })
    if extra:
        env.update(extra)
    return env


def run_git(root, args, *, extra=None, input_data=None, check=True):
    opts = [
        "-c", "core.hooksPath=/dev/null",
        "-c", "core.fsmonitor=false",
        "-c", "diff.external=",
        "-c", "core.pager=cat",
    ]
    p = subprocess.run(
        ["git", "--no-pager", *opts, *args], cwd=root, env=git_env(extra),
        input=input_data, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        check=False,
    )
    if check and p.returncode:
        detail = p.stderr.decode("utf-8", "replace").strip()[-400:]
        raise GuardError(f"git {' '.join(args[:2])} failed{(': ' + detail) if detail else ''}")
    return p


def repo_info():
    root = Path(run_git(Path.cwd(), ["rev-parse", "--show-toplevel"]).stdout.decode().strip()).resolve()
    git_dir = Path(run_git(root, ["rev-parse", "--git-dir"]).stdout.decode().strip())
    if not git_dir.is_absolute():
        git_dir = (root / git_dir).resolve()
    index = Path(run_git(root, ["rev-parse", "--git-path", "index"]).stdout.decode().strip())
    objects = Path(run_git(root, ["rev-parse", "--git-path", "objects"]).stdout.decode().strip())
    if not index.is_absolute(): index = (root / index).resolve()
    if not objects.is_absolute(): objects = (root / objects).resolve()
    return root, git_dir, index, objects


def check_base(root, base):
    if not SHA40.fullmatch(base):
        raise GuardError("base must be an exact 40-hex commit SHA")
    head = run_git(root, ["rev-parse", "HEAD"]).stdout.decode().strip().lower()
    if head != base.lower():
        raise GuardError("HEAD does not equal base")
    if run_git(root, ["cat-file", "-e", f"{base}^{{commit}}"], check=False).returncode:
        raise GuardError("base is not a commit")
    return head


def temp_index_env(index, objects, alternate):
    return {
        "GIT_INDEX_FILE": str(index),
        "GIT_OBJECT_DIRECTORY": str(objects),
        "GIT_ALTERNATE_OBJECT_DIRECTORIES": str(alternate),
    }


def parse_z_names(data):
    return [x for x in data.split(b"\0") if x]


def decode_name(raw):
    try:
        name = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise GuardError("non-UTF-8 path") from exc
    if (not name or name.startswith("/") or "\\" in name or "\x00" in name
            or "//" in name or any(part in ("", ".", "..") for part in name.split("/"))
            or not SAFE_PATH.fullmatch(name)):
        raise GuardError(f"unsafe path: {name!r}")
    return name


def allowed(name):
    if name == "index.html": return True
    if name == "js/core/storage.js" or name == "js/state.js": return False
    if name.startswith("js/") and name.endswith(".js"): return True
    if name.startswith("css/") and name.endswith(".css"): return True
    if name.startswith("tests/") and name.count("/") == 1 and name.endswith(".test.mjs"): return True
    return False


def read_index_entries(root, env):
    records = parse_z_names(run_git(root, ["ls-files", "--stage", "-z"], extra=env).stdout)
    result = {}
    for rec in records:
        head, raw = rec.split(b"\t", 1)
        fields = head.split()
        if len(fields) != 3 or fields[2] != b"0":
            raise GuardError("unmerged index entry")
        name = decode_name(raw)
        result[name] = (fields[0].decode(), fields[1].decode())
    return result


def parse_name_status(data):
    fields = parse_z_names(data)
    result = []
    i = 0
    while i < len(fields):
        status = fields[i].decode("ascii", "replace")
        i += 1
        if not status:
            raise GuardError("malformed git status")
        # --no-renames means a status has one following name.
        if i >= len(fields): raise GuardError("malformed git name-status")
        result.append((status, decode_name(fields[i])))
        i += 1
    return result


def blob_id(data):
    header = f"blob {len(data)}\0".encode()
    return hashlib.sha1(header + data).hexdigest()


def worktree_blob(path):
    info = path.lstat()
    if stat.S_ISLNK(info.st_mode):
        return 120000, os.fsencode(os.readlink(path))
    if not stat.S_ISREG(info.st_mode):
        raise GuardError(f"non-regular file: {path}")
    mode = 100755 if info.st_mode & 0o111 else 100644
    if info.st_size > MAX_PATCH * 4:
        raise GuardError("file exceeds bounded inspection size")
    return mode, path.read_bytes()


def safe_out(root, raw):
    supplied = Path(raw).expanduser()
    if supplied.is_symlink(): raise GuardError("output path is a symlink")
    out = supplied
    if not out.is_absolute(): out = root / out
    out = out.resolve(strict=False)
    try:
        rel = out.relative_to(root).as_posix()
    except ValueError:
        rel = None
    if rel is not None:
        if rel == "." or rel == ".git" or rel.startswith(".git/"):
            raise GuardError("unsafe output directory")
        # Do not follow a pre-existing symlink on any output component.
        cur = root
        for part in PurePosixPath(rel).parts:
            cur /= part
            if cur.exists() and cur.is_symlink():
                raise GuardError("output path contains a symlink")
    elif out.parts and any(part == ".git" for part in out.parts):
        raise GuardError("unsafe output directory")
    if out.exists() and not out.is_dir(): raise GuardError("output is not a directory")
    return out, rel


def changed_worktree(root, env, base_entries, out_rel):
    tracked = parse_name_status(run_git(root, ["diff-files", "--name-status", "-z", "--no-renames", "--no-ext-diff", "--no-textconv"], extra=env).stdout)
    untracked = [decode_name(x) for x in parse_z_names(run_git(root, ["ls-files", "--others", "--exclude-standard", "-z"], extra=env).stdout)]
    changes = []
    for status, name in tracked:
        if out_rel and (name == out_rel or name.startswith(out_rel + "/")):
            raise GuardError("tracked output path cannot be excluded")
        if status != "M": raise GuardError(f"unsupported tracked change {status}: {name}")
        changes.append((status, name, False))
    for name in untracked:
        if out_rel and (name == out_rel or name.startswith(out_rel + "/")):
            continue
        if name in base_entries: raise GuardError(f"ambiguous untracked path: {name}")
        changes.append(("A", name, True))
    # A changed path reported twice is a malformed/conflicting worktree state.
    if len({name for _, name, _ in changes}) != len(changes): raise GuardError("duplicate changed path")
    return changes


def validate_change_names(changes, base_entries):
    for status, name, is_new in changes:
        if not allowed(name): raise GuardError(f"path is not allowlisted: {name}")
        if name.startswith("tests/") and not is_new: raise GuardError("existing tests cannot change")
        if name.startswith("tests/") and name in base_entries: raise GuardError("existing tests cannot change")
        if status != "A" and name.startswith("tests/"): raise GuardError("test must be new")


def stage_changes(root, env, changes, base_entries):
    for _, name, _ in changes:
        mode, data = worktree_blob(root / name)
        old = base_entries.get(name)
        if mode == 120000 or mode not in (100644, 100755): raise GuardError(f"symlink or special mode: {name}")
        if old and old[0] != str(mode): raise GuardError(f"executable-bit change: {name}")
        if name.startswith("tests/") and mode != 100644: raise GuardError(f"new test must be non-executable: {name}")
        if b"\0" in data: raise GuardError(f"binary content: {name}")
        sha = run_git(root, ["hash-object", "--no-filters", "-w", "--stdin"], extra=env, input_data=data).stdout.decode().strip()
        run_git(root, ["update-index", "--add", "--cacheinfo", f"{mode},{sha},{name}"], extra=env)


def parse_raw(data):
    fields = parse_z_names(data)
    result = []
    i = 0
    while i < len(fields):
        parts = fields[i].decode("ascii", "replace").split()
        i += 1
        if len(parts) != 5 or i >= len(fields): raise GuardError("malformed raw diff")
        if not re.fullmatch(r":[0-7]{6}", parts[0]) or not re.fullmatch(r"[0-7]{6}", parts[1]):
            raise GuardError("malformed raw diff modes")
        result.append((parts[0][1:], parts[1], parts[4], decode_name(fields[i])))
        i += 1
    return result


def validate_index_diff(root, env, base, base_entries):
    statuses = parse_name_status(run_git(root, ["diff", "--cached", "--name-status", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", base, "--"], extra=env).stdout)
    raw = parse_raw(run_git(root, ["diff", "--cached", "--raw", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", base, "--"], extra=env).stdout)
    nums = parse_z_names(run_git(root, ["diff", "--cached", "--numstat", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", base, "--"], extra=env).stdout)
    if len(statuses) != len(raw) or len(nums) != len(statuses): raise GuardError("inconsistent staged diff")
    total = 0
    names = set()
    for (status, name), (oldmode, newmode, rawstatus, rawname), num in zip(statuses, raw, nums):
        if name != rawname or status != rawstatus: raise GuardError("inconsistent staged path")
        if status != "A" and name.startswith("tests/"): raise GuardError("existing tests cannot change")
        if not allowed(name): raise GuardError(f"path is not allowlisted: {name}")
        if status not in ("A", "M"): raise GuardError(f"unsupported diff status {status}")
        if status == "A" and name.startswith("tests/") and name in base_entries: raise GuardError("existing tests cannot change")
        modes_ok = (status == "A" and oldmode == "000000" and newmode == "100644") or (status == "M" and oldmode == "100644" and newmode == "100644")
        if not modes_ok: raise GuardError(f"mode change or executable file: {name}")
        add, delete, _ = num.decode("utf-8", "strict").split("\t", 2)
        if add == "-" or delete == "-": raise GuardError(f"binary diff: {name}")
        total += int(add) + int(delete)
        names.add(name)
    if len(names) > MAX_FILES: raise GuardError("file cap exceeded")
    if total > MAX_LINES: raise GuardError("changed-line cap exceeded")
    if not names: return 0, set()
    if total == 0: raise GuardError("empty file change")
    return total, names


def patch_bytes(root, env, base):
    p = run_git(root, ["diff", "--cached", "--full-index", "--no-ext-diff", "--no-textconv", "--no-renames", base, "--"], extra=env).stdout
    if not p or not p.strip(): raise GuardError("empty patch")
    if len(p) > MAX_PATCH: raise GuardError("patch-size cap exceeded")
    if b"GIT binary patch" in p or b"Binary files" in p or b"\x00" in p: raise GuardError("binary patch")
    return p


def write_output(out, patch, metadata):
    out.mkdir(parents=True, exist_ok=True)
    for name in ("candidate.patch", "metadata.json"):
        target = out / name
        if target.is_symlink() or (target.exists() and not target.is_file()): raise GuardError("unsafe output file")
    (out / "candidate.patch").write_bytes(patch)
    (out / "metadata.json").write_text(json.dumps(metadata, sort_keys=True, indent=2) + "\n", encoding="utf-8")


def export_cmd(base, out_arg):
    root, _, real_index, real_objects = repo_info()
    head = check_base(root, base)
    out, out_rel = safe_out(root, out_arg)
    with tempfile.TemporaryDirectory(prefix="ai-guard-", dir=None) as td:
        temp = Path(td); idx = temp / "index"; objs = temp / "objects"; objs.mkdir()
        env = temp_index_env(idx, objs, real_objects)
        run_git(root, ["read-tree", base], extra=env)
        run_git(root, ["update-index", "--refresh"], extra=env, check=False)
        before_index = real_index.read_bytes() if real_index.exists() else None
        base_entries = read_index_entries(root, env)
        changes = changed_worktree(root, env, base_entries, out_rel)
        validate_change_names(changes, base_entries)
        if not changes:
            print("no allowed changes")
            return 3
        stage_changes(root, env, changes, base_entries)
        lines, names = validate_index_diff(root, env, base, base_entries)
        patch = patch_bytes(root, env, base)
        metadata = {"base": base.lower(), "head": head.lower(), "files": len(names), "changed_lines": lines, "patch_bytes": len(patch), "paths": sorted(names)}
        write_output(out, patch, metadata)
        if real_index.exists() and real_index.read_bytes() != before_index:
            raise GuardError("export modified the real index")
    print(f"exported {len(names)} files, {lines} changed lines, {len(patch)} patch bytes")
    return 0


def patch_paths(text):
    if "GIT binary patch" in text or "Binary files" in text or re.search(r"^(?:old|new) mode |^new file mode (?!100644$)|^deleted file mode |^(?:similarity|rename|copy) ", text, re.M):
        raise GuardError("binary, rename, delete, or mode patch rejected")
    paths = []
    for line in text.splitlines():
        if line.startswith("diff --git "):
            m = re.fullmatch(r"diff --git a/([^\s]+) b/([^\s]+)", line)
            if not m: raise GuardError("malformed diff header")
            a, b = decode_name(m.group(1).encode()), decode_name(m.group(2).encode())
            if a != b: raise GuardError("rename rejected")
            paths.append(a)
        elif line.startswith("--- ") or line.startswith("+++ "):
            token = line[4:]
            if token == "/dev/null": continue
            if token.startswith("a/") or token.startswith("b/"):
                decode_name(token[2:].encode())
            else: raise GuardError("malformed file header")
    if not paths or len(paths) != len(set(paths)): raise GuardError("empty or duplicate patch")
    return set(paths)


def apply_cmd(base, patch_arg):
    root, _, real_index, real_objects = repo_info()
    check_base(root, base)
    if run_git(root, ["status", "--porcelain=v1", "--untracked-files=all", "-z"]).stdout:
        raise GuardError("apply requires a clean checkout")
    patch_path = Path(patch_arg).expanduser()
    if patch_path.is_symlink() or not patch_path.is_file(): raise GuardError("patch is not a regular file")
    patch_path = patch_path.resolve(strict=True)
    if patch_path.stat().st_size == 0 or patch_path.stat().st_size > MAX_PATCH: raise GuardError("invalid patch size")
    patch = patch_path.read_bytes()
    try: text = patch.decode("utf-8")
    except UnicodeDecodeError as exc: raise GuardError("patch is not UTF-8 text") from exc
    expected = patch_paths(text)
    with tempfile.TemporaryDirectory(prefix="ai-guard-apply-") as td:
        idx = Path(td) / "index"
        env = {"GIT_INDEX_FILE": str(idx), "GIT_OBJECT_DIRECTORY": str(real_objects)}
        run_git(root, ["read-tree", base], extra=env)
        base_entries = read_index_entries(root, env)
        run_git(root, ["apply", "--cached", "--check", "--recount", "--whitespace=nowarn", str(patch_path)], extra=env)
        run_git(root, ["apply", "--cached", "--recount", "--whitespace=nowarn", str(patch_path)], extra=env)
        lines, actual = validate_index_diff(root, env, base, base_entries)
        if actual != expected: raise GuardError("patch paths do not match staged diff")
        mode = real_index.stat().st_mode & 0o777 if real_index.exists() else 0o644
        os.chmod(idx, mode)
        os.replace(idx, real_index)
    print(f"applied {len(actual)} files, {lines} changed lines to index")
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(prog="ai_guard.py")
    sub = parser.add_subparsers(dest="command", required=True)
    e = sub.add_parser("export"); e.add_argument("--base", required=True); e.add_argument("--out", required=True)
    a = sub.add_parser("apply"); a.add_argument("--base", required=True); a.add_argument("--patch", required=True)
    args = parser.parse_args(argv)
    try:
        return export_cmd(args.base, args.out) if args.command == "export" else apply_cmd(args.base, args.patch)
    except (GuardError, OSError, subprocess.SubprocessError, ValueError) as exc:
        print(f"ai-guard: {exc}", file=sys.stderr)
        return 2

if __name__ == "__main__":
    raise SystemExit(main())
