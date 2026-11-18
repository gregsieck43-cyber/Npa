"""Acquire a pinned official portable IDE without installers or global writes."""
import argparse
import hashlib
import importlib.util
import json
import os
import re
import shutil
import stat
import tempfile
import urllib.request
import zipfile
from pathlib import PurePosixPath

VERSION = "1.135.06055"
ASSET = f"VSCodium-win32-x64-{VERSION}.zip"
URL = f"https://github.com/VSCodium/vscodium/releases/download/{VERSION}/{ASSET}"


def _load_path_guard():
    """Load the shared guard by file path: 'python -I' drops the script directory from sys.path."""
    directory = os.path.dirname(os.path.abspath(__file__))
    spec = importlib.util.spec_from_file_location("python_path_guard", os.path.join(directory, "python_path_guard.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


path_guard = _load_path_guard()


def is_reparse_point(path):
    """True for an existing symlink or junction, including a junction whose target is missing.

    'Path.is_symlink()' is False for junctions and 'Path.exists()' is False for a
    dangling one, so only the shared 'os.lstat' check sees every redirect.
    """
    return path_guard.is_reparse_point(path)


def download(url, target):
    request = urllib.request.Request(url, headers={"User-Agent": "NPN-Gamma-IDE-build"})
    with urllib.request.urlopen(request, timeout=90) as response, open(target, "xb") as output:
        total = 0
        while block := response.read(1024 * 1024):
            output.write(block)
            total += len(block)
            if total % (32 * 1024 * 1024) == 0:
                print(f"Downloaded {total // (1024 * 1024)} MiB", flush=True)
    return total


def acquisition_tree(root, temp_root, resume_argument):
    """Return a staging directory directly under the project .tmp that contains no link."""
    if not resume_argument:
        return tempfile.mkdtemp(prefix="ide-host-acquire-", dir=temp_root)
    staging = path_guard.checked_absolute(resume_argument, "--resume")
    path_guard.ensure_within(root, staging, "--resume")
    if not path_guard.same_path(os.path.dirname(staging), temp_root):
        raise path_guard.PathGuardError("Path boundary refused: --resume must name a direct child of the project .tmp directory.")
    if not os.path.basename(staging).startswith("ide-host-acquire-"):
        raise path_guard.PathGuardError("Path boundary refused: --resume directory name must start with ide-host-acquire-.")
    path_guard.ensure_clean_chain(root, staging, "--resume staging")
    path_guard.require_directory(staging, "--resume staging")
    # A resumed tree is read, extracted into and finally deleted, so refuse every link inside it first.
    path_guard.ensure_no_links_tree(staging, "--resume staging")
    return staging


def acquire(root_argument, resume_argument):
    root = path_guard.checked_absolute(root_argument, "--root")
    path_guard.ensure_clean_chain(root, root, "project root")
    path_guard.load_project_identifier(root)

    base = os.path.join(root, ".deps", "ide-host")
    temp_root = os.path.join(root, ".tmp")
    destination = os.path.join(base, f"VSCodium-{VERSION}")
    manifest_path = os.path.join(base, "host.json")

    # Nothing below may be read or created before the boundary chain from the project root is clean.
    path_guard.ensure_clean_chain(root, base, ".deps/ide-host")
    path_guard.ensure_clean_chain(root, destination, "IDE host destination")
    path_guard.ensure_clean_chain(root, temp_root, ".tmp")

    if path_guard.lstat_if_exists(destination) is not None:
        path_guard.require_regular_file(os.path.join(destination, "VSCodium.exe"), "IDE host executable")
        saved = json.loads(path_guard.read_text(manifest_path, "IDE host manifest"))
        if not isinstance(saved, dict) or saved.get("version") != VERSION:
            raise path_guard.PathGuardError("An IDE host of a different version already exists; do not overwrite it.")
        print(json.dumps(saved, ensure_ascii=False))
        return

    os.makedirs(base, exist_ok=True)
    os.makedirs(temp_root, exist_ok=True)
    # Re-validate the directories this invocation just created.
    path_guard.ensure_clean_chain(root, base, ".deps/ide-host")
    path_guard.ensure_clean_chain(root, temp_root, ".tmp")

    staging = acquisition_tree(root, temp_root, resume_argument)
    path_guard.ensure_clean_chain(root, staging, "acquisition directory")
    path_guard.require_directory(staging, "acquisition directory")
    if not path_guard.same_path(os.path.dirname(staging), temp_root):
        raise path_guard.PathGuardError("Path boundary refused: the acquisition directory must live directly under the project .tmp.")

    download_dir = os.path.join(staging, "download")
    checksum_dir = os.path.join(staging, "checksum")
    unpacked = os.path.join(staging, "unpacked")
    for directory in (download_dir, checksum_dir, unpacked):
        path_guard.ensure_clean_chain(root, directory, "acquisition subdirectory")
        os.makedirs(directory, exist_ok=bool(resume_argument))
        path_guard.ensure_clean_chain(root, directory, "acquisition subdirectory")

    archive = os.path.join(download_dir, ASSET)
    checksum = os.path.join(checksum_dir, ASSET + ".sha256")
    print(f"Acquiring VSCodium {VERSION} into {destination}", flush=True)
    path_guard.ensure_clean_chain(root, archive, "downloaded archive")
    archive_stat = path_guard.optional_regular_file(archive, "downloaded archive")
    size = archive_stat.st_size if archive_stat is not None else download(URL, archive)
    path_guard.ensure_clean_chain(root, checksum, "downloaded checksum")
    if path_guard.optional_regular_file(checksum, "downloaded checksum") is None:
        download(URL + ".sha256", checksum)
    match = re.search(r"\b[0-9a-fA-F]{64}\b", path_guard.read_text(checksum, "downloaded checksum"))
    if not match:
        raise RuntimeError("Official checksum was not a SHA-256 record.")
    expected = match.group().lower()
    with open(archive, "rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    if digest != expected:
        raise RuntimeError("Portable host checksum mismatch; archive retained for diagnosis.")

    path_guard.ensure_clean_chain(root, unpacked, "unpacked host")
    path_guard.require_directory(unpacked, "unpacked host")
    if resume_argument:
        # extractall reuses a resumed unpacked directory, so prove it has no links first.
        path_guard.ensure_no_links_tree(unpacked, "unpacked host")
    with zipfile.ZipFile(archive) as bundle:
        for member in bundle.infolist():
            name = member.filename.replace("\\", "/")
            relative = PurePosixPath(name)
            if relative.is_absolute() or ".." in relative.parts or ":" in name or stat.S_ISLNK(member.external_attr >> 16):
                raise RuntimeError(f"Unsafe archive member: {name}")
        bundle.extractall(unpacked)

    executable = os.path.join(unpacked, "VSCodium.exe")
    package = os.path.join(unpacked, "resources", "app", "package.json")
    path_guard.require_regular_file(executable, "editor executable")
    path_guard.require_regular_file(package, "editor manifest")
    metadata = json.loads(path_guard.read_text(package, "editor manifest"))

    # The rename exposes the host tree to the rest of the project: re-prove the destination boundary.
    path_guard.ensure_clean_chain(root, base, ".deps/ide-host")
    path_guard.ensure_clean_chain(root, destination, "IDE host destination")
    path_guard.require_absent(destination, "IDE host destination")
    os.rename(unpacked, destination)

    record = {"version": VERSION, "product": "VSCodium (Code - OSS distribution)", "asset": ASSET,
              "url": URL, "bytes": size, "sha256": digest, "checksumVerified": True,
              "directory": os.path.relpath(destination, root).replace(os.sep, "/"), "editorVersion": metadata["version"]}
    path_guard.ensure_clean_chain(root, manifest_path, "IDE host manifest")
    path_guard.refuse_link(manifest_path, "IDE host manifest")
    with open(manifest_path, "w", encoding="utf-8") as stream:
        stream.write(json.dumps(record, ensure_ascii=False, indent=2) + "\n")

    # Only this invocation's inspected acquisition tree is disposable; the installed host is outside it.
    path_guard.ensure_clean_chain(root, staging, "acquisition directory")
    if not path_guard.same_path(os.path.dirname(staging), temp_root):
        raise path_guard.PathGuardError("Path boundary refused: refusing to delete an unexpected acquisition tree.")
    path_guard.ensure_no_links_tree(staging, "acquisition directory")
    shutil.rmtree(staging)
    print(json.dumps(record, ensure_ascii=False, indent=2), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--resume", help="Exact acquisition directory created by an interrupted invocation")
    args = parser.parse_args()
    try:
        acquire(args.root, args.resume)
    except path_guard.PathGuardError as error:
        raise SystemExit(f"IDE acquisition refused: {error}") from error


if __name__ == "__main__":
    main()
