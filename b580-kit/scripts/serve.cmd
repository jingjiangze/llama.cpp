@echo off
REM 生产：q4_0 KV + 128K ctx + MTP2 + kv-pager
REM   实测（r3 头，128K ctx，60K 深度）：pp 272 / tg 29.5，接受率 87%
REM   q4 把显存悬崖消除：64K/96K/112K/128K 四档性能相同（29.3-29.6），160K 掉到 21.9
REM   :8080 llama-server 本体；:8081 kv-pager（推荐客户端指这里）
cd /d "C:\DDDD\Agent Work\_tmp\b580-mtp-2026-11-01"
set PORT=8080
set PG_PORT=8081
set CTX=131072
set KV=q4_0
set ALIAS=bonsai-27b
set MTP=1
set SPEC_NMAX=2
set SPEC_DEPTH=8192
set MODEL=./Ternary-Bonsai-2-27B-PTQ1_0-MTP-r3-Q4_0.gguf
set BUDGET_TOKENS=120000
set POOL=./kv-pool
set AUTO_CONTINUE=1
set SELFCHECK_MIN_TG=25
"C:\Program Files\Git\bin\bash.exe" -lc "bash serve-prod.sh" >> serve.out 2>&1
