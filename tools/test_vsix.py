"""Structural checks for the offline VSIX; these do not replace installation tests."""

import json
from pathlib import Path
import tempfile
import unittest
import xml.etree.ElementTree as ET
import zipfile

from build_vsix import build, PACKAGE_FILES, ROOT


class VsixTests(unittest.TestCase):
    def test_allowlisted_runtime_files_and_source_bytes(self):
        with tempfile.TemporaryDirectory() as temp:
            result = build(Path(temp) / 'quicklist.vsix')
            with zipfile.ZipFile(result) as archive:
                self.assertIsNone(archive.testzip())
                expected = {'[Content_Types].xml', 'extension.vsixmanifest'}
                expected.update(f'extension/{name}' for name in PACKAGE_FILES)
                self.assertEqual(set(archive.namelist()), expected)
                for name in PACKAGE_FILES:
                    self.assertEqual(archive.read(f'extension/{name}'), (ROOT / name).read_bytes())
                manifest = json.loads(archive.read('extension/package.json'))
                self.assertEqual(manifest['name'], 'quicklist')
                self.assertEqual(manifest['publisher'], 'xbghc')

    def test_xml_identity_assets_and_engine(self):
        with tempfile.TemporaryDirectory() as temp:
            with zipfile.ZipFile(build(Path(temp) / 'quicklist.vsix')) as archive:
                root = ET.fromstring(archive.read('extension.vsixmanifest'))
                ns = {'v': 'http://schemas.microsoft.com/developer/vsx-schema/2011'}
                identity = root.find('v:Metadata/v:Identity', ns)
                self.assertEqual(identity.attrib['Id'], 'quicklist')
                self.assertEqual(identity.attrib['Publisher'], 'xbghc')
                for asset in root.findall('v:Assets/v:Asset', ns):
                    self.assertIn(asset.attrib['Path'], archive.namelist())
                props = {item.attrib['Id']: item.attrib['Value']
                         for item in root.findall('v:Metadata/v:Properties/v:Property', ns)}
                self.assertEqual(props['Microsoft.VisualStudio.Code.Engine'], '^1.85.0')
                ET.fromstring(archive.read('[Content_Types].xml'))

    def test_output_is_reproducible(self):
        with tempfile.TemporaryDirectory() as temp:
            first = build(Path(temp) / 'first.vsix').read_bytes()
            second = build(Path(temp) / 'second.vsix').read_bytes()
            self.assertEqual(first, second)


if __name__ == '__main__':
    unittest.main()
