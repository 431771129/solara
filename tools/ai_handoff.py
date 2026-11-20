#!/usr/bin/env python3
"""Handle model JSON as data only; never execute candidate code or emit secrets."""
import argparse
import base64
import json
import os
from pathlib import Path

MAX_PATCH = 65536


def checked_result(raw):
    if not raw or len(raw.encode()) > 120000:
        raise ValueError('missing or oversized structured model output')
    result = json.loads(raw)
    fields = {'patch_base64', 'summary', 'evidence', 'no_change_reason'}
    if not isinstance(result, dict) or set(result) != fields:
        raise ValueError('unexpected model output fields')
    for field in ['patch_base64', 'summary', 'no_change_reason']:
        if not isinstance(result[field], str):
            raise ValueError('model output must use string fields')
    if len(result['summary']) > 2000 or len(result['no_change_reason']) > 2000:
        raise ValueError('oversized summary')
    if not isinstance(result['evidence'], list) or len(result['evidence']) > 16:
        raise ValueError('invalid evidence list')
    if any(not isinstance(item, str) or len(item) > 2000 for item in result['evidence']):
        raise ValueError('invalid evidence entry')
    patch = base64.b64decode(result['patch_base64'], validate=True)
    if len(patch) > MAX_PATCH:
        raise ValueError('patch exceeds 64 KiB')
    return result, patch


def decode(output):
    result, patch = checked_result(os.environ.get('AI_RESULT', ''))
    folder = Path(output)
    folder.mkdir(parents=True, exist_ok=False)
    (folder / 'candidate.patch').write_bytes(patch)
    (folder / 'report.json').write_text(json.dumps(result, ensure_ascii=False), encoding='utf-8')
    has_patch = bool(patch.strip())
    if os.environ.get('GITHUB_OUTPUT'):
        with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='utf-8') as stream:
            stream.write('has_patch=' + ('true' if has_patch else 'false') + '\n')
    print('Decoded candidate; independent scope checks still required.' if has_patch else 'No candidate change; nothing will be published.')


def api(method, endpoint, token, body=None):
    import urllib.request
    encoded = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request('https://api.github.com/' + endpoint, data=encoded, method=method, headers={
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'solara-bounded-stability-workflow',
    })
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)
    except Exception:
        # Never include request headers, token, body or arbitrary HTTP response in logs.
        raise RuntimeError('GitHub API request failed; check repository workflow permissions') from None


def open_pr(report_path):
    repo = os.environ['GITHUB_REPOSITORY']
    token = os.environ['GH_TOKEN']
    branch = os.environ['AI_BRANCH']
    base = os.environ['BASE_BRANCH']
    base_sha = os.environ['BASE_SHA']
    report_file = Path(report_path)
    if report_file.is_symlink() or not report_file.is_file() or report_file.stat().st_size > 120000:
        raise ValueError('invalid report artifact')
    report, _ = checked_result(report_file.read_text(encoding='utf-8'))
    evidence = '\n'.join('- ' + s.replace('```', "'''") for s in report['evidence'])
    run = f"https://github.com/{repo}/actions/runs/{os.environ['GITHUB_RUN_ID']}"
    body = (
        '## One bounded stability candidate\n\n'
        + report['summary'] + '\n\n'
        + '### Model-reported reproduction (untrusted claims)\n' + evidence
        + '\n\n### Independent checks\n'
        + f'- Fresh verification job passed at `{base_sha}`.\n'
        + '- Original check scripts and existing tests could not be modified.\n'
        + '- Allowed paths, patch size and line count were independently checked.\n'
        + '- No live music, browser playback, Cloudflare, production data or auth tests ran.\n'
        + f'- [Workflow evidence]({run})\n\n'
        + '**Draft only. Human review required. No automatic merge or deployment.**\n'
    )
    pr = api('POST', f'repos/{repo}/pulls', token, {
        'title': 'fix: offline-verified frontend stability candidate',
        'head': branch, 'base': base, 'body': body, 'draft': True,
    })
    print('Draft PR created:', pr['html_url'])


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='cmd', required=True)
    sub.add_parser('decode').add_argument('--out', required=True)
    sub.add_parser('open-pr').add_argument('--report', required=True)
    args = parser.parse_args()
    if args.cmd == 'decode':
        decode(args.out)
    else:
        open_pr(args.report)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(f'Workflow stopped: {type(error).__name__}: {error}')
        raise SystemExit(2)
