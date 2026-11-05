#!/usr/bin/env python3
"""Fetch the public pinned Hermes runtime; never open an existing Hermes profile.

No credential values are accepted on the command line. This downloads only public
code, optionally creates a new private worker credential, and never installs globally.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import tarfile
import tempfile
import urllib.request

COMMIT = 'bf0203a794a07aac3ff764972ab9087baa4e4f4e'
ARCHIVE_SHA256 = '0dc2cca54657d162845a77f634e107c61c3fb0bd6c8505212aa2e200591b7cc9'
ARCHIVE_URL = 'https://codeload.github.com/NousResearch/hermes-agent/tar.gz/' + COMMIT
PACKAGES = {'agent', 'tools', 'hermes_cli', 'gateway', 'pm', 'providers',
            'hermes_platform', 'cron', 'plugins', 'locales'}


def fetch_source(destination):
    destination = Path(destination)
    if not destination.is_absolute() or '..' in destination.parts:
        raise ValueError('source destination must be absolute')
    for path in (destination, *destination.parents):
        if path.is_symlink():
            raise ValueError('source destination cannot contain symlinks')
    if destination.exists():
        raise ValueError('source destination already exists; use a new exact path')
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='public-hermes-', dir=destination.parent) as staging:
        archive = Path(staging) / 'source.tar.gz'
        digest = hashlib.sha256()
        size = 0
        with urllib.request.urlopen(ARCHIVE_URL, timeout=30) as response, archive.open('wb') as output:
            while chunk := response.read(1024 * 1024):
                size += len(chunk)
                if size > 128 * 1024 * 1024:
                    raise ValueError('public archive exceeds download bound')
                digest.update(chunk)
                output.write(chunk)
        if digest.hexdigest() != ARCHIVE_SHA256:
            raise ValueError('pinned public archive checksum mismatch')
        tree = Path(staging) / 'tree'
        tree.mkdir(mode=0o755)
        with tarfile.open(archive, 'r:gz') as bundle:
            for member in bundle:
                pieces = Path(member.name).parts[1:]
                if not pieces or any(piece in ('.', '..') for piece in pieces):
                    continue
                selected = (pieces[0] in PACKAGES or (len(pieces) == 1 and
                            (pieces[0].endswith(('.py', '.toml', '.json', '.yaml', '.md'))
                             or pieces[0] == 'LICENSE')))
                # Explicitly omit links, special files, repository metadata,
                # large web/desktop assets, tests and optional tool environments.
                if not selected or not member.isfile():
                    continue
                target = tree.joinpath(*pieces)
                target.parent.mkdir(parents=True, exist_ok=True)
                with bundle.extractfile(member) as stream:
                    target.write_bytes(stream.read())
                target.chmod(0o644)
        if not (tree / 'run_agent.py').is_file() or (tree / '.env').exists():
            raise ValueError('public archive runtime incomplete')
        receipt = {'commit': COMMIT, 'release': '0.22.5', 'archiveSha256': ARCHIVE_SHA256,
                   'runAgentSha256': hashlib.sha256((tree / 'run_agent.py').read_bytes()).hexdigest()}
        (tree / '.quiet-ledger-public-source.json').write_text(json.dumps(receipt) + '\n')
        tree.rename(destination)
    return receipt


def create_state(destination):
    destination = Path(destination)
    source = next((p for p in Path(__file__).resolve().parents if (p / 'package.json').is_file()), Path(__file__).resolve().parent)
    boundaries = [source, *(p for p in source.parents if (p / '.git').exists())]
    private_root = os.environ.get('QUIET_LEDGER_PRIVATE_WORKSPACE_ROOT')
    if private_root:
        if not Path(private_root).is_absolute():
            raise ValueError('private workspace root must be absolute')
        boundaries.append(Path(private_root).resolve())
    if not destination.is_absolute() or '..' in destination.parts or any(destination.is_relative_to(p) for p in boundaries):
        raise ValueError('private state must be absolute and outside source/workspace')
    for path in (destination, *destination.parents):
        if path.is_symlink():
            raise ValueError('private state cannot contain symlinks')
    destination.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = destination.stat()
    if info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError('private state must be owned by the runtime uid with mode0700')
    (destination / 'turns').mkdir(mode=0o700, exist_ok=True)
    token_file = destination / 'worker-token'
    # Exclusive create preserves existing credentials and makes reruns safe.
    try:
        descriptor = os.open(token_file, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    except FileExistsError:
        info = token_file.lstat()
        if not token_file.is_file() or token_file.is_symlink() or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError('existing worker credential is unsafe') from None
    else:
        with os.fdopen(descriptor, 'w') as output:
            output.write(secrets.token_urlsafe(32) + '\n')
    return {'workerCredentialFile': str(token_file), 'stateDirectory': str(destination / 'turns')}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-root', help='new absolute public-code directory')
    parser.add_argument('--state-root', help='optional new private runtime state outside source/vault')
    args = parser.parse_args()
    if not args.source_root and not args.state_root:
        parser.error('one destination is required')
    result = {}
    if args.source_root:
        result['source'] = fetch_source(args.source_root)
    if args.state_root:
        result['state'] = create_state(args.state_root)
    print(json.dumps(result, indent=2))  # Paths/public hashes only, no credential values.


if __name__ == '__main__':
    main()
