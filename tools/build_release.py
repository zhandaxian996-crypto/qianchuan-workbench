"""Build a portable, empty-account ZIP using only this project's reviewed files."""
from pathlib import Path, PurePosixPath
from datetime import datetime, timezone
import hashlib
import json
import re
import posixpath
from urllib.parse import unquote
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def safe_file(relative):
    parts = PurePosixPath(relative).parts
    if not parts or '\\' in relative or ':' in relative or relative.startswith('/') or any(p in ('..', '.') for p in parts):
        raise ValueError('Invalid release path')
    current = ROOT
    for part in parts:
        current = current / part
        if current.is_symlink() or (hasattr(current, 'is_junction') and current.is_junction()):
            raise ValueError('Linked release input')
    if not current.is_file() or not current.resolve().is_relative_to(ROOT):
        raise ValueError('Release input is missing or outside the project')
    return current


def privacy_check(relative, data):
    if re.search(r'(^|/)(private-runtime|node_modules|work|\.git|account-profiles|cache|logs|storage)(/|$)', relative, re.I):
        raise ValueError('Private directory in release list')
    if re.search(r'(^|/)(config\.json|\.env[^/]*)$|\.(cookie|db|sqlite|sqlite3|jsonl|log)$', relative, re.I):
        raise ValueError('Private runtime file in release list')
    text = data.decode('utf-8-sig')
    findings = [
        ('private_identity', r'shengli|shanboshi|胜利饭店|膳博士|千澄|22519|hanako工作区'),
        ('credential', r'\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]+|\bsk-[A-Za-z0-9_-]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'),
        ('credential_assignment', r'\b(?:cookie|token|password|secret|sessionid|sessionid_ss|sid_guard|passport_csrf_token|access_token|refresh_token|api_key|authorization)["\']?\s*[:=]\s*["\']?(?:Bearer\s+)?[A-Za-z0-9_+/=-]{20,}'),
    ]
    for category, pattern in findings:
        # 已核验的通用行政区树含东营市旧英文名 Shengli；仅豁免这份原样文件的身份词检测。
        if category == 'private_identity' and relative == 'references/data/district-tree.json' and hashlib.sha256(data).hexdigest() == 'e54215638f5d538decdeafe4b8720067e6656bef3f04c19a7e7e6c2b055f4812':
            continue
        if re.search(pattern, text, re.I):
            raise ValueError(f'Release privacy check: {relative} ({category})')


def main():
    spec = json.loads(safe_file('release/files.json').read_text(encoding='utf-8-sig'))
    names = spec['files']
    templates = set(spec['template_files'])
    if not names or len(set(names)) != len(names) or not templates.issubset(set(names)):
        raise ValueError('Invalid release inventory')
    data = {}
    for relative in names:
        source = 'release/templates/' + relative if relative in templates else relative
        content = safe_file(source).read_bytes()
        privacy_check(relative, content)
        data[relative] = content
    # 模板最终放在包根目录，引用必须按交付后的路径核验。
    for relative, content in data.items():
        if not relative.endswith('.md'):
            continue
        prose = re.sub(r'```[\s\S]*?```', '', content.decode('utf-8-sig'))
        for match in re.finditer(r'!?\[[^\]\n]*\]\(<?([^\)\n]*?)>?\)', prose):
            link = unquote(match.group(1).strip().strip('<>').split('#')[0])
            if not link or re.match(r'^(https?:|mailto:)', link):
                continue
            resolved = posixpath.normpath(posixpath.join(posixpath.dirname(relative), link))
            if resolved not in data:
                raise ValueError(f'Missing release link: {relative} -> {resolved}')
    config = json.loads(data['server-app/config.example.json'].decode('utf-8-sig'))
    if any(config.get(key) for key in ('qianchuan_accounts', 'accounts', 'yuntu_accounts')):
        raise ValueError('Release example contains an account')
    data['DELIVERY_ACCEPTANCE.md'] = (
        '# 通用包边界\n\n'
        '本包在当前主项目内按显式文件清单独立构建，不读取旧项目、Cookie 或 private-runtime。'
        '构建检查路径、常见私密特征、空账户示例、ZIP CRC 和所有文件摘要。'
        '程序只读基线曾在本机完成接入及部分 MCP 回读；这不代表本次生成包已经在其他客户机安装，'
        '也不代表自动投放或最新平台规则已验收。每次改动后仍须执行与改动相称的功能验证。\n'
    ).encode('utf-8')
    inventory = sorted([*data, 'PACKAGE_CONTENTS.txt', 'DELIVERY_MANIFEST.json'])
    data['PACKAGE_CONTENTS.txt'] = ('\n'.join(inventory) + '\n').encode('utf-8')
    digests = {key: hashlib.sha256(value).hexdigest() for key, value in data.items()}
    manifest = {'schema_version': 2, 'files': digests, 'manifest_excludes_self': True, 'accounts': 'empty', 'public_release': False}
    data['DELIVERY_MANIFEST.json'] = (json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
    output_root = ROOT / 'work/releases'
    output_root.mkdir(parents=True, exist_ok=True)
    name = 'qianchuan-clean-' + datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S-%f')
    output = output_root / (name + '.zip')
    with zipfile.ZipFile(output, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for relative, content in sorted(data.items()):
            archive.writestr(name + '/' + relative, content)
    with zipfile.ZipFile(output) as archive:
        if archive.testzip() is not None:
            raise ValueError('ZIP CRC failed')
        for relative, expected in digests.items():
            if hashlib.sha256(archive.read(name + '/' + relative)).hexdigest() != expected:
                raise ValueError('ZIP content hash failed')
    report = {'ok': True, 'file': output.relative_to(ROOT).as_posix(), 'files': len(data), 'sha256': hashlib.sha256(output.read_bytes()).hexdigest(), 'private_data_included': False}
    (ROOT / 'release/latest.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False))


if __name__ == '__main__':
    main()
