#!/usr/bin/env python3
"""Reject personal identifiers and personal commit emails before publishing."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys


def block(reason):
    # Do not echo matches or filenames: a publisher's job log may be public.
    print("Publication blocked: " + reason, file=sys.stderr)
    raise SystemExit(1)


def git(*args):
    return subprocess.check_output(["git", *args], stderr=subprocess.PIPE)


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--identifiers-file", type=Path)
parser.add_argument("--ref", action="append", default=[])
parser.add_argument("revisions", nargs="+")
args = parser.parse_args()
try:
    profile = args.identifiers_file or Path.home() / ".config/git/privacy/blocked-identifiers.json"
    source = profile.read_text() if args.identifiers_file or not os.environ.get("PRIVACY_BLOCKED_IDENTIFIERS") else os.environ["PRIVACY_BLOCKED_IDENTIFIERS"]
    terms = json.loads(source)
    if not isinstance(terms, list) or not terms or any(not isinstance(x, str) or len(x.strip()) < 4 for x in terms):
        raise ValueError("Invalid identifier configuration")
    terms = [x.casefold().encode() for x in terms]
    mac_path = re.compile(rb"/" + rb"Users/[^/\s<>\"'$`]+(?:/|(?=[\s<>\"'$`]|$))", re.I)

    def inspect(data, context):
        if any(term in data.lower() for term in terms):
            block("a configured personal identifier was found in " + context)
        if mac_path.search(data):
            block("a personal absolute home path was found in " + context)

    for ref in args.ref:
        inspect(ref.encode(), "a ref name")
    objects = {}
    for line in git("rev-list", "--objects", *args.revisions).splitlines():
        sha, _, path = line.partition(b" ")
        inspect(path, "a tracked filename")
        objects[sha] = None
    # Annotated tags have metadata outside the commits traversed by rev-list.
    for revision in args.revisions:
        if ".." not in revision and not revision.startswith("^"):
            sha = git("rev-parse", revision).strip()
            if git("cat-file", "-t", sha.decode()).strip() == b"tag":
                objects[sha] = None
    batch = subprocess.Popen(["git", "cat-file", "--batch"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        for sha in objects:
            batch.stdin.write(sha + b"\n")
            batch.stdin.flush()
            header = batch.stdout.readline().split()
            if len(header) != 3:
                raise ValueError("Cannot read outgoing Git object")
            kind, size = header[1], int(header[2])
            data = batch.stdout.read(size)
            if len(data) != size or batch.stdout.read(1) != b"\n":
                raise ValueError("Truncated Git object")
            if kind in (b"blob", b"commit", b"tag"):
                inspect(data, "outgoing content or metadata")
            if kind in (b"commit", b"tag"):
                emails = re.findall(rb"(?m)^(?:author|committer|tagger) .* <([^>]+)> [0-9]+ [+-][0-9]+$", data)
                if not emails or any(not re.fullmatch(rb"[^@\s]+@users\.noreply\.github\.com|noreply@github\.com", email, re.I) for email in emails):
                    block("commit or tag identities must use GitHub no-reply emails")
                if kind == b"commit":
                    inspect(git("diff-tree", "--root", "-r", "--no-commit-id", "--name-only", "-z", sha.decode()), "changed filenames")
    finally:
        batch.stdin.close()
        batch.stdout.close()
        batch.terminate()
        batch.wait()
except (OSError, ValueError, subprocess.SubprocessError):
    print("Publication blocked: the privacy check could not complete.", file=sys.stderr)
    raise SystemExit(2)
print("Privacy check passed.")
