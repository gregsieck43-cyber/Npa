"""Lexical boundary and reparse-point guards shared by the IDE helper scripts.

Windows behaviour that motivates every check in this module:

* 'Path.is_symlink()' is False for a directory junction.
* A dangling junction reports 'Path.exists() == False' even though the entry
  still redirects anything written through it, so pathlib cannot see it at all.
* 'Path.rglob' walks *through* an active junction and treats the target as part
  of the tree.

Every check therefore goes through 'os.lstat' and keeps path handling lexical
('os.path.abspath'/'normpath'/'normcase') until a chain has been proven free of
links. 'os.path.realpath' is used only as a final defence after a lexical
boundary check already passed.
"""

import json
import os
import stat

PROJECT_NAME = "npn-gamma-agent"
FILE_ATTRIBUTE_REPARSE_POINT = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)


class PathGuardError(RuntimeError):
    """A path failed a lexical boundary or link/junction check."""


def normalise(path):
    """Return the lexical, case-folded absolute form used for every comparison."""
    return os.path.normcase(os.path.normpath(os.path.abspath(os.fspath(path))))


def same_path(left, right):
    """Case-insensitive lexical equality, without resolving links."""
    return normalise(left) == normalise(right)


def is_link(st):
    """True for symlinks, junctions and any other reparse point."""
    return stat.S_ISLNK(st.st_mode) or bool(getattr(st, "st_file_attributes", 0) & FILE_ATTRIBUTE_REPARSE_POINT)


def lstat_if_exists(path):
    """'os.lstat' with a missing entry reported as None; other errors propagate."""
    try:
        return os.lstat(path)
    except FileNotFoundError:
        return None
    except NotADirectoryError as error:
        raise PathGuardError(f"Path boundary refused: a parent of {os.fspath(path)} is not a directory.") from error


def is_reparse_point(path):
    """True when *path* itself exists as a symlink or junction, dangling ones included."""
    st = lstat_if_exists(path)
    return st is not None and is_link(st)


def checked_absolute(value, label):
    """Validate one command-line path lexically and return its normalised absolute form.

    Rejected: empty values, relative paths, UNC/device paths, any '..' segment and
    volume roots. Nothing is resolved, so no link is followed by this check.
    """
    text = os.fspath(value)
    if not text or not text.strip():
        raise PathGuardError(f"Path boundary refused: {label} must not be empty.")
    if text.startswith(("\\\\", "//")):
        raise PathGuardError(f"Path boundary refused: {label} cannot be a UNC or device path: {text}")
    if not os.path.isabs(text):
        raise PathGuardError(f"Path boundary refused: {label} must be an absolute path: {text}")
    segments = [segment for segment in text.replace("/", os.sep).split(os.sep) if segment]
    if ".." in segments:
        raise PathGuardError(f"Path boundary refused: {label} must not contain '..' segments: {text}")
    absolute = os.path.normpath(os.path.abspath(text))
    drive, tail = os.path.splitdrive(absolute)
    if tail in ("", os.sep):
        raise PathGuardError(f"Path boundary refused: {label} cannot be a volume root: {text}")
    return absolute


def ensure_within(root, target, label):
    """Require *target* to sit lexically inside *root*; returns the normalised target."""
    root_key, target_key = normalise(root), normalise(target)
    if target_key == root_key:
        return target_key
    if not target_key.startswith(root_key.rstrip(os.sep) + os.sep):
        raise PathGuardError(f"Path boundary refused: {label} must stay inside {root_key}: {target_key}")
    return target_key


def _volume_ancestors(path):
    """Return the volume root and every later ancestor of *path*, lexically, without resolving links."""
    absolute = os.path.normpath(os.path.abspath(os.fspath(path)))
    drive, tail = os.path.splitdrive(absolute)
    current = drive + os.sep
    chain = [current]
    for segment in (part for part in tail.split(os.sep) if part):
        current = os.path.join(current, segment)
        chain.append(current)
    return chain


def ensure_clean_chain(root, target, label):
    """Refuse any existing symlink or junction from the volume root down to *target*.

    *root* itself can be reached through a junction (for example a checkout that a
    user relocated with one), so every existing ancestor above root is inspected as
    well: checking root -> target alone would accept writes that a link redirects.
    Only FileNotFoundError means "not created yet"; missing segments are allowed
    because callers create them and re-validate afterwards.
    """
    root_key = normalise(root)
    target_key = ensure_within(root_key, target, label)
    # The path itself is dropped here: root is appended below as the first root -> target entry.
    chain = _volume_ancestors(root_key)[:-1]
    relative = os.path.relpath(target_key, root_key)
    segments = [] if relative == os.curdir else relative.split(os.sep)
    current = root_key
    chain.append(current)
    for segment in segments:
        if not segment or segment == os.curdir:
            continue
        current = os.path.join(current, segment)
        chain.append(current)
    for candidate in chain:
        st = lstat_if_exists(candidate)
        if st is None:
            continue
        if is_link(st):
            raise PathGuardError(f"Path boundary refused: {label} crosses a link/junction at {candidate}")
    return target_key


def require_directory(path, label):
    """Require an existing, real directory at *path*."""
    st = lstat_if_exists(path)
    if st is None:
        raise PathGuardError(f"Path boundary refused: {label} does not exist: {os.fspath(path)}")
    if is_link(st):
        raise PathGuardError(f"Path boundary refused: {label} is a link/junction: {os.fspath(path)}")
    if not stat.S_ISDIR(st.st_mode):
        raise PathGuardError(f"Path boundary refused: {label} must be a directory: {os.fspath(path)}")
    return st


def require_regular_file(path, label):
    """Require an existing regular file at *path*; links and junctions are refused."""
    st = lstat_if_exists(path)
    if st is None:
        raise PathGuardError(f"Path boundary refused: {label} does not exist: {os.fspath(path)}")
    if is_link(st):
        raise PathGuardError(f"Path boundary refused: {label} is a link/junction: {os.fspath(path)}")
    if not stat.S_ISREG(st.st_mode):
        raise PathGuardError(f"Path boundary refused: {label} must be a regular file: {os.fspath(path)}")
    return st


def optional_regular_file(path, label):
    """Return the lstat of an existing regular file, or None when absent; links are refused."""
    st = lstat_if_exists(path)
    if st is None:
        return None
    if is_link(st):
        raise PathGuardError(f"Path boundary refused: {label} is a link/junction: {os.fspath(path)}")
    if not stat.S_ISREG(st.st_mode):
        raise PathGuardError(f"Path boundary refused: {label} must be a regular file: {os.fspath(path)}")
    return st


def require_absent(path, label):
    """Require that nothing (not even a dangling junction) exists at *path*."""
    if lstat_if_exists(path) is not None:
        raise PathGuardError(f"Path boundary refused: {label} already exists: {os.fspath(path)}")


def refuse_link(path, label):
    """Refuse an existing link at *path*; a missing or real entry is acceptable."""
    st = lstat_if_exists(path)
    if st is not None and is_link(st):
        raise PathGuardError(f"Path boundary refused: {label} is a link/junction: {os.fspath(path)}")


def read_text(path, label):
    """Read a UTF-8 text file after proving it is a regular file."""
    require_regular_file(path, label)
    with open(path, "r", encoding="utf-8") as stream:
        return stream.read()


def load_project_identifier(root):
    """Validate the project manifest through the guarded chain and return its JSON."""
    manifest = os.path.join(os.fspath(root), "package.json")
    require_regular_file(manifest, "project package.json")
    try:
        with open(manifest, "r", encoding="utf-8") as stream:
            data = json.load(stream)
    except (OSError, ValueError) as error:
        raise PathGuardError(f"Project boundary refused: cannot read {manifest}: {error}") from error
    name = data.get("name") if isinstance(data, dict) else None
    if name != PROJECT_NAME:
        raise PathGuardError(
            f"Project boundary refused: {manifest} must declare name {PROJECT_NAME!r}, found {name!r}."
        )
    return data


def _validated_tree(path, label):
    """Return (directories, files) under *path*, rejecting links without following them."""
    require_directory(path, label)
    directories, files = [], []
    pending = [os.fspath(path)]
    while pending:
        directory = pending.pop()
        with os.scandir(directory) as entries:
            for entry in entries:
                st = entry.stat(follow_symlinks=False)
                if is_link(st):
                    raise PathGuardError(f"Path boundary refused: {label} contains a link/junction at {entry.path}")
                if stat.S_ISDIR(st.st_mode):
                    directories.append(entry.path)
                    pending.append(entry.path)
                elif stat.S_ISREG(st.st_mode):
                    files.append(entry.path)
    return directories, files


def ensure_no_links_tree(path, label):
    """Validate a tree that will be read, extracted into or deleted, without following links."""
    _validated_tree(path, label)


def files_without_links(path, label):
    """List regular files under *path* as (relative posix path, absolute path), links refused."""
    _, files = _validated_tree(path, label)
    root = os.fspath(path)
    listed = [(os.path.relpath(item, root).replace(os.sep, "/"), item) for item in files]
    return sorted(listed, key=lambda item: item[0].lower())
