"""Package the local NPN extension as VSIX without a publishing tool or network access."""
import argparse
import hashlib
import importlib.util
import json
import os
import zipfile
from xml.sax.saxutils import escape


def _load_path_guard():
    """Load the shared guard by file path: 'python -I' drops the script directory from sys.path."""
    directory = os.path.dirname(os.path.abspath(__file__))
    spec = importlib.util.spec_from_file_location("python_path_guard", os.path.join(directory, "python_path_guard.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


path_guard = _load_path_guard()

CONTENT_TYPES = '''<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="json" ContentType="application/json"/><Default Extension="cjs" ContentType="application/javascript"/><Default Extension="js" ContentType="application/javascript"/><Default Extension="css" ContentType="text/css"/><Default Extension="png" ContentType="image/png"/><Default Extension="svg" ContentType="image/svg+xml"/><Default Extension="md" ContentType="text/markdown"/><Default Extension="vsixmanifest" ContentType="text/xml"/></Types>'''


def read_extension_metadata(source):
    """Read the extension manifest after proving it is a regular file inside the source tree."""
    metadata = json.loads(path_guard.read_text(os.path.join(source, "package.json"), "extension manifest"))
    try:
        identity = [str(metadata[key]) for key in ("name", "publisher", "version", "displayName", "description")]
        os_engine = metadata["engines"]["vscode"]
    except (KeyError, TypeError) as error:
        raise path_guard.PathGuardError(f"Extension manifest is missing a required field: {error}") from error
    if not all(identity) or not str(os_engine):
        raise path_guard.PathGuardError("Extension manifest has an empty required field.")
    return metadata


def build_vsix_manifest(metadata):
    identity = {key: escape(str(metadata[key]), {'"': '&quot;'}) for key in ("name", "publisher", "version", "displayName", "description")}
    return f'''<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
<Metadata><Identity Id="{identity['name']}" Version="{identity['version']}" Language="en-US" Publisher="{identity['publisher']}"/><DisplayName>{identity['displayName']}</DisplayName><Description xml:space="preserve">{identity['description']}</Description>
<Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="{escape(metadata['engines']['vscode'])}"/><Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace"/></Properties></Metadata>
<Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation><Dependencies/>
<Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/><Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true"/></Assets></PackageManifest>'''


def package_extension(source_argument, output_argument):
    root = path_guard.checked_absolute(os.getcwd(), "project root")
    path_guard.ensure_clean_chain(root, root, "project root")
    path_guard.load_project_identifier(root)

    source = path_guard.checked_absolute(source_argument, "--source")
    output = path_guard.checked_absolute(output_argument, "--output")
    path_guard.ensure_within(root, source, "--source")
    path_guard.ensure_within(root, output, "--output")
    if path_guard.same_path(output, root):
        raise path_guard.PathGuardError("Path boundary refused: --output cannot be the project directory.")
    if os.path.splitext(output)[1].lower() != ".vsix":
        raise path_guard.PathGuardError(f"Path boundary refused: --output must end in .vsix: {output}")

    # Every existing ancestor of source and output is validated before any mkdir or read.
    path_guard.ensure_clean_chain(root, source, "--source")
    path_guard.ensure_clean_chain(root, output, "--output")
    output_parent = os.path.dirname(output)
    try:
        os.makedirs(output_parent, exist_ok=True)
    except OSError as error:
        raise path_guard.PathGuardError(f"Path boundary refused: cannot create {output_parent}: {error}") from error
    # Re-validate the chain this invocation may have just created.
    path_guard.ensure_clean_chain(root, output_parent, "--output parent")

    metadata = read_extension_metadata(source)
    manifest = build_vsix_manifest(metadata)
    members = path_guard.files_without_links(source, "--source")

    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as bundle:
        bundle.writestr("extension.vsixmanifest", manifest)
        bundle.writestr("[Content_Types].xml", CONTENT_TYPES)
        for relative, absolute in members:
            bundle.write(absolute, "extension/" + relative)

    # Final defence only: the lexical checks above already keep the write inside the project.
    path_guard.ensure_within(os.path.realpath(root), os.path.realpath(output), "--output")

    with open(output, "rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    print(json.dumps({"path": output, "sha256": digest, "version": metadata["version"]}, ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    try:
        package_extension(args.source, args.output)
    except path_guard.PathGuardError as error:
        raise SystemExit(f"Extension packaging refused: {error}") from error


if __name__ == "__main__":
    main()
