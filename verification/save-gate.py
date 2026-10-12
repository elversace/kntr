"""Save successful verification and the exact source hashes for a stage."""
import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def save(name, reports):
    if not re.fullmatch(r'[a-z0-9_-]+', name):
        raise ValueError('Invalid gate name')
    output = ROOT / 'verification' / (name + '-gate.json')
    if output.exists():
        raise ValueError('Existing gates are immutable; choose another name')
    evidence = []
    for report in reports:
        path = ROOT / 'verification' / report
        result = json.loads(path.read_text())
        if result.get('summary', {}).get('success') is not True or result['summary'].get('failed') != 0:
            raise ValueError('A verification report has failures: ' + report)
        evidence.append({'report': report, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'result': result})
    hashes = {}
    for source in ['kntr-package', 'kntr-mobile']:
        for path in sorted((ROOT / source).rglob('*')):
            if path.is_file() and 'node_modules' not in path.parts:
                hashes[str(path.relative_to(ROOT))] = hashlib.sha256(path.read_bytes()).hexdigest()
    output.write_text(json.dumps({'gate': name, 'completed_at_utc': datetime.now(timezone.utc).isoformat(),
                                 'all_reports_passed': True, 'evidence': evidence, 'source_sha256': hashes},
                                ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'gate': str(output), 'reports': len(evidence), 'source_files': len(hashes)}))

if __name__ == '__main__':
    if len(sys.argv) < 3:
        raise SystemExit('Usage: python3 save-gate.py gate-name report.json [report.json ...]')
    save(sys.argv[1], sys.argv[2:])
