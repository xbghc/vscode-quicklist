#!/usr/bin/env python3
"""Create a deterministic local VSIX without installing npm tooling.

The official @vscode/vsce packager is used in CI. This fallback only handles
Quicklist's dependency-free, explicitly allowlisted runtime files.
"""

import argparse
import json
from pathlib import Path
from xml.sax.saxutils import escape, quoteattr
import zipfile

ROOT = Path(__file__).resolve().parents[1]
PACKAGE_FILES = ('package.json', 'extension.js', 'README.md', 'CHANGELOG.md', 'LICENSE')


def build(output=None):
    manifest = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))
    if manifest.get('dependencies'):
        raise ValueError('The offline packager does not bundle runtime dependencies.')
    if manifest.get('main') != './extension.js':
        raise ValueError('Update the runtime allowlist before changing the entry point.')
    target = Path(output) if output else ROOT / 'dist' / f"{manifest['name']}-{manifest['version']}.vsix"
    target.parent.mkdir(parents=True, exist_ok=True)
    assets = [
        ('Microsoft.VisualStudio.Code.Manifest', 'extension/package.json'),
        ('Microsoft.VisualStudio.Services.Content.Details', 'extension/README.md'),
        ('Microsoft.VisualStudio.Services.Content.Changelog', 'extension/CHANGELOG.md'),
        ('Microsoft.VisualStudio.Services.Content.License', 'extension/LICENSE'),
    ]
    properties = {
        'Microsoft.VisualStudio.Code.Engine': manifest['engines']['vscode'],
        'Microsoft.VisualStudio.Code.ExtensionDependencies': '',
        'Microsoft.VisualStudio.Code.ExtensionPack': '',
        'Microsoft.VisualStudio.Code.ExtensionKind': ','.join(manifest.get('extensionKind', [])),
        'Microsoft.VisualStudio.Code.LocalizedLanguages': '',
        'Microsoft.VisualStudio.Code.EnabledApiProposals': '',
        'Microsoft.VisualStudio.Code.ExecutesCode': 'true',
        'Microsoft.VisualStudio.Services.Links.Source': manifest['repository']['url'],
    }
    properties_xml = ''.join(f'<Property Id={quoteattr(key)} Value={quoteattr(value)}/>'
                             for key, value in properties.items())
    assets_xml = ''.join(f'<Asset Type={quoteattr(kind)} Path={quoteattr(name)} Addressable="true"/>'
                        for kind, name in assets)
    vsix_xml = f'''<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
<Metadata>
<Identity Language="en-US" Id={quoteattr(manifest['name'])} Version={quoteattr(manifest['version'])} Publisher={quoteattr(manifest['publisher'])}/>
<DisplayName>{escape(manifest['displayName'])}</DisplayName>
<Description xml:space="preserve">{escape(manifest['description'])}</Description>
<Tags>{escape(','.join(manifest.get('keywords', [])))}</Tags>
<Categories>{escape(','.join(manifest.get('categories', [])))}</Categories>
<GalleryFlags>Public</GalleryFlags>
<Properties>{properties_xml}</Properties>
<License>extension/LICENSE</License>
</Metadata>
<Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation>
<Dependencies/>
<Assets>{assets_xml}</Assets>
</PackageManifest>
'''
    types = {'.js': 'application/javascript', '.json': 'application/json',
             '.md': 'text/markdown', '.vsixmanifest': 'text/xml'}
    types_xml = ('<?xml version="1.0" encoding="utf-8"?>\n'
                 '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
                 ''.join(f'<Default Extension={quoteattr(ext)} ContentType={quoteattr(mime)}/>'
                         for ext, mime in sorted(types.items())) + '</Types>\n')
    payload = {'[Content_Types].xml': types_xml.encode(), 'extension.vsixmanifest': vsix_xml.encode()}
    payload.update({f'extension/{name}': (ROOT / name).read_bytes() for name in PACKAGE_FILES})
    with zipfile.ZipFile(target, 'w') as archive:
        for name, content in sorted(payload.items()):
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, content)
    return target


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, help='Output VSIX path (default: dist/).')
    args = parser.parse_args()
    output = build(args.output)
    print(f'Wrote {output} ({output.stat().st_size} bytes)')


if __name__ == '__main__':
    main()
