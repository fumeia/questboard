#!/usr/bin/env python3
"""The game tables (ranks, achievement families with their tiers) exist twice: extension/store.js and the Android
Store.kt. Both devices pay achievements by id, so the tables must match exactly. This checks that they do."""
import ast
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
JS = open(os.path.join(ROOT, 'extension', 'store.js'), encoding='utf-8').read()
KT = open(os.path.join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'questboard', 'app', 'data', 'Store.kt'), encoding='utf-8').read()
failed = 0


def check(ok, what):
    global failed
    print(('ok   ' if ok else 'FAIL ') + what)
    failed += not ok


def strings(block):
    return re.findall(r"['\"]([^'\"]+)['\"]", block)


js_ranks = strings(re.search(r"export const RANKS = \[(.*?)\];", JS, re.S).group(1))
kt_ranks = strings(re.search(r"val RANKS = listOf\((.*?)\)\n", KT, re.S).group(1))
check(js_ranks == kt_ranks and len(js_ranks) == 40, f'ranks match ({len(js_ranks)} / {len(kt_ranks)})')

js_fams = []
for m in re.finditer(r"^\s*\['(\w+)', '(\w+)', 'qb-([\w-]+)', '([^']+)', '([^']+)', (\[\[.*?\]\])\],$", JS, re.M):
    js_fams.append((m.group(1), m.group(2), m.group(3), m.group(4), m.group(5), [tuple(t) for t in ast.literal_eval(m.group(6))]))
kt_fams = []
for m in re.finditer(r'^\s*Fam\("(\w+)", "(\w+)", "([\w-]+)", "([^"]+)", "([^"]+)", listOf\((.*?)\)\),$', KT, re.M):
    kt_fams.append((m.group(1), m.group(2), m.group(3), m.group(4), m.group(5), [tuple(map(int, p)) for p in re.findall(r"(\d+) to (\d+)", m.group(6))]))
check(len(js_fams) == 16 and len(kt_fams) == len(js_fams), f'16 families on both ({len(js_fams)} / {len(kt_fams)})')
for a, b in zip(js_fams, kt_fams):
    check(a == b, f'family {a[0]} matches')
for f in js_fams:
    check(all(f[5][i][0] > f[5][i - 1][0] for i in range(1, len(f[5]))), f'{f[0]}: every tier is harder than the one before')
check("'quests-1': 'first-quest', 'early-1': 'early'" in JS and '"quests-1" to "first-quest", "early-1" to "early"' in KT, 'old ids kept on both')
print(f'{failed} FAILED' if failed else 'all passed')
sys.exit(1 if failed else 0)
