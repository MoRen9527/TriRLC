# -*- coding: utf-8 -*-
"""件④ channel.cmd env pin（LG-064 §八裁决② 方案 §三.4，2026-10-06 FSD）。
TRILC_DATA_DIR 字面路径化（治 %LOCALAPPDATA% 未展开→cwd 漂移假 store，
D:/Code/ai/TriMetaverse/%LOCALAPPDATA%/trilc-channel 化石实证）+pin USERPROFILE。
纪律：bytes 全程保 CRLF；temp 写+os.replace 原子覆盖；改前 bak-<ts>-<pid> 备份；
值面不过手（只断言键行，禁打印全文/token 行）。幂等：已 pin 则零改动退出。
"""
import shutil, os, datetime, sys

P = r'C:\Users\jedih\AppData\Local\trimlc-daemon-channel.cmd'
LITERAL_DATA_DIR = b'set TRILC_DATA_DIR=C:\\Users\\jedih\\AppData\\Local\\trilc-channel'
USERPROFILE_PIN = b'set USERPROFILE=C:\\Users\\jedih'

raw = open(P, 'rb').read()
assert raw.count(b'\r\n') == raw.count(b'\n'), 'CRLF mix broken: mixed line endings'
n0 = raw.count(b'\n')

if LITERAL_DATA_DIR in raw and USERPROFILE_PIN in raw:
    print('IDEMPOTENT: already pinned, zero change')
    sys.exit(0)

out = []
pin_added = False
for ln in raw.split(b'\r\n'):
    if ln.startswith(b'set TRILC_DATA_DIR='):
        assert b'%LOCALAPPDATA%' in ln, 'unexpected TRILC_DATA_DIR form: ' + ln.decode('ascii', 'replace')
        out.append(LITERAL_DATA_DIR)
    else:
        out.append(ln)
    if ln.startswith(b'set TRILC_CWD=') and not pin_added:
        out.append(USERPROFILE_PIN)
        pin_added = True
assert pin_added, 'TRILC_CWD anchor line not found'

new = b'\r\n'.join(out)
assert new.count(b'\r\n') == new.count(b'\n'), 'post-write CRLF mix'
n1 = new.count(b'\n')
assert n1 == n0 + 1, f'line count drift: {n0} -> {n1} (expect +1 pin line)'

ts = datetime.datetime.now().strftime('%Y%m%dT%H%M%S')
bak = f'{P}.bak-{ts}-{os.getpid()}'
shutil.copy2(P, bak)

tmp = P + '.tmp'
with open(tmp, 'wb') as f:
    f.write(new)
os.replace(tmp, P)

raw2 = open(P, 'rb').read()
assert raw2 == new, 'post-write re-read mismatch'
print('OK bak =', os.path.basename(bak))
print('lines', n0, '->', n1)
print('CR-uniform:', raw2.count(b'\r\n') == raw2.count(b'\n'))
for l in raw2.split(b'\r\n'):
    if b'TRILC_DATA_DIR' in l or b'USERPROFILE' in l:
        print('KEYLINE:', l.decode('ascii', 'replace'))
