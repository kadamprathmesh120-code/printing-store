@echo off
title Printing Store - Starter
cd /d "%~dp0"
echo ========================================================
echo          PRINTING STORE - STARTING ALL SERVICES
echo ========================================================
echo.
echo [1/3] Starting Backend Server (server.js)...
start "Printing Store Server" /b node server.js

echo [2/3] Starting Local Printer Agent (local-printer.js)...
start "Local Printer Agent" /b node local-printer.js

echo [3/3] Opening Admin Dashboard in browser...
timeout /t 2 /nobreak >nul
start http://localhost:3000/admin.html

echo.
echo ========================================================
echo All services are running!
echo Server: http://localhost:3000
echo Admin:  http://localhost:3000/admin.html
echo.
echo Keep this window OPEN while using Printing Store.
echo To STOP all services, close this window.
echo ========================================================
pause
