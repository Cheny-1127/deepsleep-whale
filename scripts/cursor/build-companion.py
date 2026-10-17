"""使用标准库打包本地跳转扩展，不访问扩展市场。"""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import json

root = Path(__file__).resolve().parents[2]
metadata = json.loads((root / 'cursor-companion/package.json').read_text())
output = root / 'out/whale-companion.vsix'
output.parent.mkdir(exist_ok=True)
manifest = f'''<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
<Metadata><Identity Language="en-US" Id="{metadata['name']}" Version="{metadata['version']}" Publisher="{metadata['publisher']}"/>
<DisplayName>鲸鱼娘 Cursor 对话跳转</DisplayName><Description xml:space="preserve">打开对应的本地 Cursor 对话</Description>
<Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="^1.96.0"/><Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="ui"/></Properties></Metadata>
<Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation><Dependencies/>
<Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/></Assets></PackageManifest>'''
with ZipFile(output, 'w', ZIP_DEFLATED) as archive:
    archive.writestr('extension.vsixmanifest', manifest)
    archive.writestr('[Content_Types].xml', '''<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="json" ContentType="application/json"/><Default Extension="cjs" ContentType="application/javascript"/><Default Extension="vsixmanifest" ContentType="text/xml"/></Types>''')
    for name in ['package.json', 'extension.cjs', 'protocol.cjs']:
        archive.write(root / 'cursor-companion' / name, 'extension/' + name)
print(output)
