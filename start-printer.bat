@echo off
cd /d "%~dp0"
echo Printing Store - Local Printer Agent
echo =====================================
echo.
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | Where-Object { $_.CommandLine -like '*local-printer.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>&1
timeout /t 1 /nobreak >nul
node local-printer.js
echo.
pause
