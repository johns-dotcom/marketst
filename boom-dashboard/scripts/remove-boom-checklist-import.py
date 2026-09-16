#!/usr/bin/env python3
"""
One-off: remove the Boom catalog checklist that importChecklistReleases()
inserted into the Market Street PRODUCTION database on the first deploy
(2026-09-16 06:24:10Z). 384 releases + 50 artists, none of them ours.

Scoped by created_at to the two-second import window, so anything added
since is untouched. Uses the app's own DELETE routes (hard deletes), so the
artist delete refuses if a release still points at it.

Usage (from boom-dashboard/server, where .env.railway.notes lives):
  python3 ../scripts/remove-boom-checklist-import.py
Add --dry-run to only count.
"""
import sys, json, os, urllib.request, concurrent.futures as cf

B = 'https://marketst-production.up.railway.app'
WINDOW = ('2026-09-16T06:24:09', '2026-09-16T06:24:13')
DRY = '--dry-run' in sys.argv

notes = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'server', '.env.railway.notes')
PW = next(l.split('=', 1)[1].strip() for l in open(notes) if l.startswith('PW_JOHN='))

def req(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(B + path, method=method, data=data,
        headers={'Authorization': 'Bearer ' + TOK, 'Content-Type': 'application/json'} if 'TOK' in globals() else {'Content-Type': 'application/json'})
    with urllib.request.urlopen(r, timeout=60) as resp:
        return json.loads(resp.read())

TOK = req('POST', '/api/auth/login', {'email': 'john@deanst.co', 'password': PW})['data']['token']

rels = req('GET', '/api/releases?in_catalog=any&archived=any')['data']
target_r = [r for r in rels if WINDOW[0] <= (r.get('created_at') or '') <= WINDOW[1]]
print(f'releases total {len(rels)} | from the import {len(target_r)} | kept {len(rels) - len(target_r)}')

def dele(path):
    try:
        return req('DELETE', path).get('success', False)
    except Exception as e:
        return f'ERR {e}'

if not DRY:
    with cf.ThreadPoolExecutor(8) as ex:
        res = list(ex.map(lambda r: dele(f"/api/releases/{r['id']}"), target_r))
    print('releases deleted:', sum(1 for x in res if x is True), '| failures:', [x for x in res if x is not True][:3])

arts = req('GET', '/api/artists')['data']
has_rel = {r['artist_id'] for r in req('GET', '/api/releases?in_catalog=any&archived=any')['data']}
target_a = [a for a in arts if WINDOW[0] <= (a.get('created_at') or '') <= WINDOW[1] and a['id'] not in has_rel]
print(f'artists total {len(arts)} | from the import with no releases left {len(target_a)}')

if not DRY:
    with cf.ThreadPoolExecutor(8) as ex:
        res = list(ex.map(lambda a: dele(f"/api/artists/{a['id']}"), target_a))
    print('artists deleted:', sum(1 for x in res if x is True), '| failures:', [x for x in res if x is not True][:3])
    print('FINAL: artists', len(req('GET', '/api/artists')['data']),
          '| releases', len(req('GET', '/api/releases?in_catalog=any&archived=any')['data']))
