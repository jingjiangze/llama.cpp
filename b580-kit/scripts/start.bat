@echo off
REM QWEN3.8 start: llama-server(8080) + kv-pager(8081). Launched detached.
setlocal
cd /d "C:\DDDD\work\QWEN3.8"
if not exist "logs" mkdir "logs"

echo Stopping leftovers ...
powershell -NoProfile -Command "Get-Process llama-server -ErrorAction SilentlyContinue | ForEach-Object { taskkill /F /T /PID $_.Id 2>&1 | Out-Null }" >nul 2>&1
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*kv-pager*' } | ForEach-Object { taskkill /F /T /PID $_.ProcessId 2>&1 | Out-Null }" >nul 2>&1

echo Starting QWEN3.8 ...
powershell -NoProfile -Command "Start-Process -FilePath 'C:\Program Files\Git\bin\bash.exe' -ArgumentList '-l','/c/DDDD/work/QWEN3.8/serve-prod.sh' -WindowStyle Hidden"

echo   :8080  llama-server (direct)
echo   :8081  kv-pager     (recommended)
echo Waiting for health ...

set /a n=0
:wait
ping -n 3 127.0.0.1 >nul
curl -s -m 2 http://127.0.0.1:8081/pager/usage >nul 2>&1
if not errorlevel 1 goto ready
set /a n+=1
if %n% lss 60 goto wait
echo [FAIL] not ready after 180s - see logs\server.log
exit /b 1

:ready
echo [OK] ready
echo   base URL : http://127.0.0.1:8081/v1
echo   model    : bonsai-27b    api key : none
exit /b 0
