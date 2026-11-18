"""Offline regression tests for the IDE helper scripts' lexical and link/junction guards."""
import hashlib
import importlib.util
import json
import os
import re
import stat
import subprocess
import sys
import traceback
import urllib.request
import uuid
import zipfile

if os.name != "nt":
    sys.exit("scripts/test-ide-paths.py verifies Windows junction handling and only runs on Windows.")

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPTS = os.path.join(PROJECT_ROOT, "scripts")
ACQUIRE_SCRIPT = os.path.join(SCRIPTS, "acquire-ide-host.py")
PACKAGER_SCRIPT = os.path.join(SCRIPTS, "package-ide-extension.py")
FIXTURE_ROOT = os.path.join(PROJECT_ROOT, ".tmp", "module-01-portability", "b-fixtures")
PROJECT_NAME = "npn-gamma-agent"
HOST_MANIFEST = os.path.join(PROJECT_ROOT, ".deps", "ide-host", "npn-host.json")
REPARSE_KEYWORDS = ("link", "junction", "boundary")


def read_version():
    with open(ACQUIRE_SCRIPT, "r", encoding="utf-8") as stream:
        match = re.search(r"^VERSION = [\"']([^\"']+)[\"']", stream.read(), re.MULTILINE)
    if not match:
        raise SystemExit("acquire-ide-host.py has no VERSION constant.")
    return match.group(1)


VERSION = read_version()


def is_reparse(st):
    return stat.S_ISLNK(st.st_mode) or bool(st.st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT)


def remove_tree(path):
    """Remove a tree bottom-up, deleting link entries themselves and never their targets."""
    with os.scandir(path) as entries:
        collected = list(entries)
    for entry in collected:
        st = entry.stat(follow_symlinks=False)
        if is_reparse(st):
            if stat.S_ISDIR(st.st_mode):
                os.rmdir(entry.path)
            else:
                os.unlink(entry.path)
        elif stat.S_ISDIR(st.st_mode):
            remove_tree(entry.path)
        else:
            os.unlink(entry.path)
    os.rmdir(path)


class Fixture:
    """Owns one directory under .tmp/module-01-portability/b-fixtures."""

    def __init__(self, label):
        self.label = label
        self.path = os.path.join(FIXTURE_ROOT, f"{label}-{uuid.uuid4().hex}")
        os.makedirs(self.path)

    def join(self, *parts):
        return os.path.join(self.path, *parts)

    def mkdir(self, relative):
        target = self.join(*relative.split("/"))
        os.makedirs(target, exist_ok=True)
        return target

    def write(self, relative, text):
        target = self.join(*relative.split("/"))
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(text)
        return target

    def junction(self, relative, target_relative):
        link, target = self.join(*relative.split("/")), self.join(*target_relative.split("/"))
        if not os.path.normcase(target).startswith(os.path.normcase(self.path) + os.sep):
            raise AssertionError("junction targets must stay inside the fixture")
        result = subprocess.run(["cmd", "/c", "mklink", "/J", link, target], capture_output=True, text=True)
        if result.returncode != 0:
            raise AssertionError(f"mklink failed for {link}: {result.stdout}{result.stderr}")
        return link

    def write_project_manifest(self, name=PROJECT_NAME, relative=""):
        relative = (relative + "/" if relative else "") + "package.json"
        return self.write(relative, json.dumps({"name": name, "version": "0.0.0", "private": True}, indent=2))

    def extension_source(self, relative="src/extension"):
        base = self.mkdir(relative)
        manifest = {"name": "npn-ide", "publisher": "npn-gamma", "version": "0.7.0", "displayName": "NPN IDE",
                    "description": "NPN workbench", "engines": {"vscode": "^1.135.0"}, "main": "./main.js"}
        with open(os.path.join(base, "package.json"), "w", encoding="utf-8", newline="\n") as stream:
            json.dump(manifest, stream, indent=2)
        self.write(relative + "/README.md", "# NPN IDE\n\nWorkbench extension.\n")
        self.write(relative + "/main.js", "exports.activate = () => {};\n")
        self.write(relative + "/lib/util.js", "exports.value = 1;\n")
        return base

    def cleanup(self):
        path = os.path.abspath(self.path)
        root = os.path.normcase(os.path.normpath(FIXTURE_ROOT))
        normal = os.path.normcase(os.path.normpath(path))
        if not normal.startswith(root + os.sep) or not os.path.basename(normal).startswith(self.label + "-"):
            raise AssertionError(f"refusing to remove unexpected fixture: {path}")
        remove_tree(path)


class Runner:
    def __init__(self):
        self.cases = 0
        self.passed = 0
        self.assertions = 0
        self.failures = []

    def check(self, condition, message):
        self.assertions += 1
        if not condition:
            raise AssertionError(message)

    def case(self, name, function):
        self.cases += 1
        label = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:40] or "case"
        fixture = Fixture(label)
        body_error = None
        try:
            function(self, fixture)
        except BaseException:
            body_error = traceback.format_exc()
        cleanup_error = None
        try:
            fixture.cleanup()
        except BaseException:
            cleanup_error = traceback.format_exc()
        if body_error or cleanup_error:
            detail = "\n".join(part for part in (body_error, cleanup_error and "cleanup failed:\n" + cleanup_error) if part)
            self.failures.append((name, detail))
            print(f"FAIL {name}")
        else:
            self.passed += 1
            print(f"ok   {name}")


def run_python(script, arguments, cwd=PROJECT_ROOT, timeout=90):
    return subprocess.run(
        [sys.executable, "-I", "-B", script, *arguments],
        cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace",
        timeout=timeout, env={**os.environ, "PYTHONIOENCODING": "utf-8"},
    )


def expect_rejection(runner, result, label, words=REPARSE_KEYWORDS):
    runner.check(result.returncode != 0, f"{label}: expected a non-zero exit, got {result.returncode}")
    text = f"{result.stdout}\n{result.stderr}".lower()
    runner.check(any(word in text for word in words),
                 f"{label}: expected a link/junction or boundary message; got: {text[-600:]}")
    return text


def package_attempt(source, output):
    return run_python(PACKAGER_SCRIPT, ["--source", source, "--output", output])


# --- shared guard ----------------------------------------------------------

def load_guard_module():
    spec = importlib.util.spec_from_file_location("python_path_guard_under_test",
                                                  os.path.join(SCRIPTS, "python_path_guard.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def expect_guard_refusal(runner, guard, action, label):
    """Run *action* and require a PathGuardError that names the link or the boundary."""
    try:
        returned = action()
    except guard.PathGuardError as error:
        text = str(error).lower()
        runner.check(any(word in text for word in REPARSE_KEYWORDS),
                     f"{label}: expected a link/junction or boundary message; got {error}")
        return text
    runner.check(False, f"{label}: expected a refusal, the guard accepted {returned!r}")


def case_clean_chain_rejects_root_below_junction(runner, fixture):
    guard = load_guard_module()
    real = fixture.mkdir("relocated/real-root")
    child = fixture.mkdir("relocated/real-root/child")
    fixture.junction("bridge", "relocated")
    fixture.junction("broken-bridge", "missing-target")
    rooted = fixture.join("bridge", "real-root")
    runner.check(guard.ensure_clean_chain(real, real, "real root") == guard.normalise(real),
                 "an ordinary existing root must stay accepted")
    runner.check(guard.ensure_clean_chain(real, child, "real root child") == guard.normalise(child),
                 "an ordinary root -> target chain must stay accepted")
    expect_guard_refusal(runner, guard, lambda: guard.ensure_clean_chain(rooted, rooted, "junction root"),
                         "root below an active junction")
    expect_guard_refusal(runner, guard,
                         lambda: guard.ensure_clean_chain(rooted, os.path.join(rooted, "child"), "junction root child"),
                         "a target below a root that itself sits under a junction")
    through_broken = fixture.join("broken-bridge", "real-root")
    expect_guard_refusal(runner, guard, lambda: guard.ensure_clean_chain(through_broken, through_broken, "dangling root"),
                         "root below a dangling junction")


# --- junction semantics ----------------------------------------------------

def case_junction_semantics(runner, fixture):
    target = fixture.mkdir("real-target")
    with open(os.path.join(target, "inside.txt"), "w", encoding="utf-8") as stream:
        stream.write("target payload\n")
    active = fixture.junction("active-link", "real-target")
    dangling = fixture.junction("dangling-link", "missing-target")
    active_stat, dangling_stat = os.lstat(active), os.lstat(dangling)
    runner.check(stat.S_ISDIR(dangling_stat.st_mode) and not stat.S_ISLNK(dangling_stat.st_mode),
                 "a junction is a directory reparse point, not a symlink")
    runner.check(is_reparse(dangling_stat), "lstat sees the dangling junction")
    runner.check(not os.path.islink(dangling), "Path.is_symlink() is False for a dangling junction")
    runner.check(not os.path.exists(dangling), "Path.exists() is False for a dangling junction")
    runner.check(is_reparse(active_stat) and not os.path.islink(active), "an active junction carries a reparse point")
    with os.scandir(active) as entries:
        names = [entry.name for entry in entries]
    runner.check(names == ["inside.txt"], f"an active junction redirects reads: {names}")
    with os.scandir(fixture.path) as entries:
        listed = {entry.name: is_reparse(entry.stat(follow_symlinks=False)) for entry in entries}
    runner.check(listed.get("dangling-link") is True, "scandir sees the dangling junction without following it")
    runner.check(listed.get("real-target") is False, "a real directory is not a reparse point")


# --- packager --------------------------------------------------------------

def case_package_success(runner, fixture):
    source = fixture.extension_source()
    output = fixture.join("dist", "npn-ide.vsix")
    runner.check(not os.path.exists(os.path.dirname(output)), "the output parent must not exist before packaging")
    result = run_python(PACKAGER_SCRIPT, ["--source", source, "--output", output])
    runner.check(result.returncode == 0, f"packager exit {result.returncode}: {result.stderr.strip()}")
    payload = json.loads(result.stdout.strip().splitlines()[-1])
    runner.check(sorted(payload) == ["path", "sha256", "version"], f"stdout payload keys: {sorted(payload)}")
    runner.check(payload["version"] == "0.7.0", f"payload version: {payload['version']}")
    runner.check(os.path.normcase(payload["path"]) == os.path.normcase(output), f"payload path: {payload['path']}")
    runner.check(os.path.isfile(output), "the VSIX was not written")
    with open(output, "rb") as stream:
        digest = hashlib.sha256(stream.read()).hexdigest()
    runner.check(payload["sha256"] == digest, "stdout sha256 must match the written VSIX")
    expected = ["[Content_Types].xml", "extension.vsixmanifest", "extension/README.md",
                "extension/lib/util.js", "extension/main.js", "extension/package.json"]
    with zipfile.ZipFile(output) as bundle:
        names = bundle.namelist()
        runner.check(sorted(names) == expected, f"VSIX entries: {sorted(names)}")
        runner.check(all("\\" not in name and not name.startswith("/") for name in names),
                     f"zip entries must be lexical: {names}")
        runner.check(bundle.testzip() is None, "the VSIX archive must be readable")
        manifest = bundle.read("extension.vsixmanifest").decode("utf-8")
        content_types = bundle.read("[Content_Types].xml").decode("utf-8")
    runner.check('Id="npn-ide"' in manifest and 'Publisher="npn-gamma"' in manifest,
                 "the VSIX manifest must keep the extension identity")
    runner.check('Extension="vsixmanifest"' in content_types, "the content types must stay unchanged")


def case_package_rejects_active_source_junction(runner, fixture):
    source = fixture.extension_source()
    target = fixture.mkdir("target-active")
    fixture.junction("src/extension/linked", "target-active")
    output = fixture.join("dist", "out.vsix")
    expect_rejection(runner, package_attempt(source, output), "active junction in source")
    runner.check(os.listdir(target) == [], f"link target must stay empty: {os.listdir(target)}")
    runner.check(not os.path.exists(output), "no VSIX may be written when a link is present")


def case_package_rejects_dangling_source_junction(runner, fixture):
    source = fixture.extension_source()
    fixture.junction("src/extension/dangling", "missing-target")
    output = fixture.join("dist", "out.vsix")
    expect_rejection(runner, package_attempt(source, output), "dangling junction in source")
    runner.check(not os.path.lexists(fixture.join("missing-target")),
                 "nothing may be created through the dangling junction")
    runner.check(not os.path.exists(output), "no VSIX may be written when a dangling junction is present")


def case_package_rejects_source_junction(runner, fixture):
    fixture.extension_source("real-extension")
    fixture.mkdir("src")
    source = fixture.junction("src/junction-source", "real-extension")
    output = fixture.join("dist", "out.vsix")
    expect_rejection(runner, package_attempt(source, output), "source is a junction")
    runner.check(not os.path.exists(output), "no VSIX may be written when the source itself is a link")


def case_package_rejects_output_parent_junction(runner, fixture):
    source = fixture.extension_source()
    target = fixture.mkdir("target-out")
    fixture.junction("out-link", "target-out")
    output = fixture.join("out-link", "out.vsix")
    expect_rejection(runner, package_attempt(source, output), "output parent junction")
    runner.check(os.listdir(target) == [], f"link target must stay empty: {os.listdir(target)}")


def case_package_rejects_output_junction(runner, fixture):
    source = fixture.extension_source()
    fixture.mkdir("dist")
    fixture.junction("dist/open.vsix", "missing-out")
    output = fixture.join("dist", "open.vsix")
    expect_rejection(runner, package_attempt(source, output), "dangling junction at output")
    runner.check(not os.path.lexists(fixture.join("missing-out")),
                 "nothing may be written through the dangling output junction")


def case_package_rejects_relative_paths(runner, fixture):
    source = fixture.extension_source()
    expect_rejection(runner, package_attempt("src/extension", fixture.join("a.vsix")), "relative --source")
    expect_rejection(runner, package_attempt(source, "out.vsix"), "relative --output")


def case_package_rejects_outside_source(runner, fixture):
    outside = os.path.join(os.path.dirname(PROJECT_ROOT), "module-01-outside-" + uuid.uuid4().hex[:8])
    expect_rejection(runner, package_attempt(outside, fixture.join("out.vsix")), "source outside project")
    runner.check(not os.path.exists(outside), "the rejected outside path must not be created")


def case_package_rejects_foreign_root(runner, fixture):
    fixture.write_project_manifest("another-product")
    source = fixture.extension_source()
    result = run_python(PACKAGER_SCRIPT, ["--source", source, "--output", fixture.join("out.vsix")],
                        cwd=fixture.path)
    text = expect_rejection(runner, result, "foreign cwd manifest", words=("boundary", "npn-gamma-agent"))
    runner.check("npn-gamma-agent" in text, "the refusal must name the expected project")


def case_package_rejects_root_below_junction(runner, fixture):
    fixture.write_project_manifest(relative="relocated/project")
    fixture.extension_source("relocated/project/src/extension")
    fixture.junction("bridge", "relocated")
    root = fixture.join("bridge", "project")
    real = fixture.join("relocated", "project")
    output = os.path.join(root, "dist", "out.vsix")
    result = run_python(PACKAGER_SCRIPT,
                        ["--source", os.path.join(root, "src", "extension"), "--output", output], cwd=root)
    expect_rejection(runner, result, "package root below a junction")
    runner.check(not os.path.exists(os.path.join(real, "dist")),
                 "the output parent must not be created when the root chain is refused")
    clean = run_python(PACKAGER_SCRIPT,
                       ["--source", os.path.join(real, "src", "extension"),
                        "--output", os.path.join(real, "dist", "clean.vsix")], cwd=real)
    runner.check(clean.returncode == 0, f"the same content under a real root must still package: {clean.stderr.strip()}")
    runner.check(os.path.isfile(os.path.join(real, "dist", "clean.vsix")),
                 "the real root must still write its VSIX")


# --- acquire ---------------------------------------------------------------

def load_acquire_module():
    spec = importlib.util.spec_from_file_location("acquire_ide_host_under_test", ACQUIRE_SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run_acquire_offline(runner, arguments, label):
    """Call acquire.main() in-process with urllib.request.urlopen replaced by a hard failure."""
    module = load_acquire_module()
    attempts = []

    def blocked(*args, **kwargs):
        attempts.append(args)
        raise AssertionError(f"{label}: acquisition attempted network access: {args!r}")

    original = urllib.request.urlopen
    previous_argv = sys.argv
    urllib.request.urlopen = blocked
    sys.argv = [ACQUIRE_SCRIPT, *arguments]
    message = None
    try:
        try:
            module.main()
        except SystemExit as exit_error:
            message = str(exit_error.code)
        except BaseException as failure:
            message = f"{type(failure).__name__}: {failure}"
    finally:
        urllib.request.urlopen = original
        sys.argv = previous_argv
    runner.check(not attempts, f"{label}: network must never be touched")
    runner.check(message is not None, f"{label}: expected a refusal instead of success")
    text = (message or "").lower()
    runner.check(any(word in text for word in REPARSE_KEYWORDS),
                 f"{label}: expected a link/junction or boundary message; got {message}")
    return text


def case_acquire_rejects_root_arguments(runner, fixture):
    fixture.write_project_manifest()
    no_manifest = fixture.mkdir("empty-root")
    wrong_name = fixture.mkdir("wrong-name")
    fixture.write_project_manifest("other-product", relative="wrong-name")
    drive = os.path.splitdrive(PROJECT_ROOT)[0]
    attempts = [
        ("relative --root", "./fake-root"),
        ("UNC --root", "\\\\server\\share\\agent"),
        ("device --root", "\\\\.\\C:\\agent"),
        ("volume-root --root", drive + os.sep),
        ("missing package.json", no_manifest),
        ("wrong package.json name", wrong_name),
    ]
    for label, argument in attempts:
        result = run_python(ACQUIRE_SCRIPT, ["--root", argument], timeout=45)
        expect_rejection(runner, result, label, words=("boundary", "npn-gamma-agent"))


def case_acquire_rejects_deps_junction(runner, fixture):
    fixture.write_project_manifest()
    fixture.mkdir(".deps")
    target = fixture.mkdir("target-deps")
    fixture.junction(".deps/ide-host", "target-deps")
    run_acquire_offline(runner, ["--root", fixture.path], "junction .deps/ide-host")
    runner.check(os.listdir(target) == [], f"link target must stay empty: {os.listdir(target)}")
    runner.check(not os.path.exists(fixture.join(".tmp")),
                 "nothing may be staged when the destination chain has a link")


def case_acquire_rejects_tmp_junction(runner, fixture):
    fixture.write_project_manifest()
    target = fixture.mkdir("target-tmp")
    fixture.junction(".tmp", "target-tmp")
    run_acquire_offline(runner, ["--root", fixture.path], "junction .tmp")
    runner.check(os.listdir(target) == [], f"link target must stay empty: {os.listdir(target)}")
    runner.check(not os.path.exists(fixture.join(".deps", "ide-host")),
                 "the destination directory must not be created before .tmp is validated")


def case_acquire_rejects_root_below_junction(runner, fixture):
    fixture.write_project_manifest(relative="relocated/project")
    fixture.junction("bridge", "relocated")
    root = fixture.join("bridge", "project")
    real = fixture.join("relocated", "project")
    run_acquire_offline(runner, ["--root", root], "root below a junction")
    runner.check(os.listdir(real) == ["package.json"], f"the refused root must stay untouched: {os.listdir(real)}")
    runner.check(not os.path.exists(os.path.join(real, ".deps")), "no .deps may be created under a refused root")
    runner.check(not os.path.exists(os.path.join(real, ".tmp")), "no .tmp may be created under a refused root")


def case_acquire_rejects_resume_arguments(runner, fixture):
    fixture.write_project_manifest()
    fixture.mkdir(".tmp")
    fixture.mkdir(".tmp/resume-other")
    target = fixture.mkdir("target-staging")
    fixture.junction(".tmp/ide-host-acquire-junction", "target-staging")
    traversal = fixture.join(".tmp", "ide-host-acquire-x", "..", "ide-host-acquire-y")
    run_acquire_offline(runner, ["--root", fixture.path, "--resume", traversal], "resume with '..'")
    run_acquire_offline(runner, ["--root", fixture.path, "--resume", fixture.join(".tmp", "resume-other")],
                        "resume with a foreign name")
    run_acquire_offline(runner, ["--root", fixture.path, "--resume",
                                 fixture.join(".tmp", "ide-host-acquire-junction")], "resume staging junction")
    runner.check(os.listdir(target) == [], f"link target must stay empty: {os.listdir(target)}")


def case_acquire_reuses_verified_host(runner, fixture):
    fixture.write_project_manifest()
    host = fixture.mkdir(f".deps/ide-host/VSCodium-{VERSION}")
    with open(os.path.join(host, "VSCodium.exe"), "w", encoding="utf-8", newline="\n") as stream:
        stream.write("stub executable\n")
    record = {"version": VERSION, "product": "VSCodium (Code - OSS distribution)",
              "asset": f"VSCodium-win32-x64-{VERSION}.zip", "url": "https://example.invalid/asset.zip",
              "bytes": 1, "sha256": "0" * 64, "checksumVerified": True,
              "directory": f".deps/ide-host/VSCodium-{VERSION}", "editorVersion": "1.135.0"}
    with open(fixture.join(".deps", "ide-host", "host.json"), "w", encoding="utf-8", newline="\n") as stream:
        json.dump(record, stream, indent=2)
    result = run_python(ACQUIRE_SCRIPT, ["--root", fixture.path])
    runner.check(result.returncode == 0, f"acquire exit {result.returncode}: {result.stderr.strip()}")
    payload = json.loads(result.stdout.strip().splitlines()[-1])
    runner.check(payload["version"] == VERSION, f"manifest version: {payload['version']}")
    runner.check(payload["checksumVerified"] is True, "the existing manifest must be reported as verified")
    runner.check("Acquiring" not in result.stdout, "an existing host must not start a download")
    runner.check(not os.path.exists(fixture.join(".tmp")), "no staging directory may be created for an existing host")


# --- suite -----------------------------------------------------------------

def manifest_snapshot():
    try:
        st = os.lstat(HOST_MANIFEST)
    except FileNotFoundError:
        return None
    return (st.st_mtime_ns, st.st_size)


def main():
    print(f"python {sys.version.split()[0]} | project {PROJECT_ROOT} | VERSION {VERSION}")
    os.makedirs(FIXTURE_ROOT, exist_ok=True)
    before = manifest_snapshot()
    runner = Runner()
    runner.case("junction semantics (dangling junction invisible to pathlib)", case_junction_semantics)
    runner.case("clean chain refuses a root below a junction", case_clean_chain_rejects_root_below_junction)
    runner.case("packager accepts a clean extension", case_package_success)
    runner.case("packager rejects an active junction in source", case_package_rejects_active_source_junction)
    runner.case("packager rejects a dangling junction in source", case_package_rejects_dangling_source_junction)
    runner.case("packager rejects a source that is a junction", case_package_rejects_source_junction)
    runner.case("packager rejects an output parent junction", case_package_rejects_output_parent_junction)
    runner.case("packager rejects a dangling junction at output", case_package_rejects_output_junction)
    runner.case("packager rejects relative source and output", case_package_rejects_relative_paths)
    runner.case("packager rejects a source outside the project", case_package_rejects_outside_source)
    runner.case("packager rejects a foreign project manifest", case_package_rejects_foreign_root)
    runner.case("packager rejects a root below a junction", case_package_rejects_root_below_junction)
    runner.case("acquire rejects unsafe --root arguments", case_acquire_rejects_root_arguments)
    runner.case("acquire rejects a junction at .deps/ide-host", case_acquire_rejects_deps_junction)
    runner.case("acquire rejects a junction at .tmp", case_acquire_rejects_tmp_junction)
    runner.case("acquire rejects a root below a junction", case_acquire_rejects_root_below_junction)
    runner.case("acquire rejects unsafe --resume arguments", case_acquire_rejects_resume_arguments)
    runner.case("acquire reuses an already verified host offline", case_acquire_reuses_verified_host)
    after = manifest_snapshot()
    if before != after:
        runner.failures.append(("real .deps/ide-host/npn-host.json untouched", f"before={before} after={after}"))
        print("FAIL real .deps/ide-host/npn-host.json untouched")
    else:
        runner.assertions += 1
        print("ok   real .deps/ide-host/npn-host.json untouched" if before else "ok   real .deps/ide-host/npn-host.json absent")
    try:
        os.rmdir(FIXTURE_ROOT)
    except OSError:
        pass
    print()
    print(f"{runner.passed}/{runner.cases} cases passed, {runner.assertions} assertions")
    for name, detail in runner.failures:
        print(f"\n--- FAILED: {name} ---\n{detail}")
    return 0 if not runner.failures else 1


if __name__ == "__main__":
    sys.exit(main())
