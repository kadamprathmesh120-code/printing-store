@echo off
echo Starting local server and printer agent...
start /b node server.js
start /b node local-printer.js
echo Printing Store running at http://localhost:3000
echo Admin page: http://localhost:3000/admin.html
echo.
echo Local printer agent is polling Render for accepted orders.
echo Close this window to stop both.
pause
