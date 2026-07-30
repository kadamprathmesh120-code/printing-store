@echo off
cd /d "%~dp0"
echo Starting local server and printer agent...
start "Server" /b node server.js
start "Printer Agent" /b node local-printer.js
timeout /t 2 /nobreak >nul
start http://localhost:3000/admin.html
echo Printing Store running at http://localhost:3000
echo Admin page: http://localhost:3000/admin.html
echo.
echo Local printer agent is active.
echo Close this window to stop all services.
pause
