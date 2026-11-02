@echo off
REM QWEN3.8 stop: kill llama-server + kv-pager + launcher shell
setlocal

echo Stopping QWEN3.8 ...

powershell -NoProfile -Command "Get-Process llama-server -ErrorAction SilentlyContinue | ForEach-Object { taskkill /F /T /PID $_.Id 2>&1 | Out-Null }" >nul 2>&1
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*kv-pager*' } | ForEach-Object { taskkill /F /T /PID $_.ProcessId 2>&1 | Out-Null }" >nul 2>&1
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='bash.exe'\" | Where-Object { $_.CommandLine -like '*serve-prod*' -or $_.CommandLine -like '*start-bonsai*' } | ForEach-Object { taskkill /F /T /PID $_.ProcessId 2>&1 | Out-Null }" >nul 2>&1

ping -n 4 127.0.0.1 >nul

curl -s -m 2 http://127.0.0.1:8080/health >nul 2>&1
if errorlevel 1 (
  echo [OK] stopped
) else (
  echo [WARN] something still answers on :8080
)
exit /b 0
