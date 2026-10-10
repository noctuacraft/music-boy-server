@echo off
echo.
echo  ============================================
echo  ^|  Music Boy(TM) Backend Server           ^|
echo  ^|  Ctrl+C to stop                        ^|
echo  ============================================
echo.

:: Find local IP address
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /i "IPv4"') do (
    set IP=%%a
    goto :found
)
:found
set IP=%IP: =%
echo  Your PC IP: %IP%
echo  Use this IP in the app (SERVER_IP constant in index.tsx)
echo.
echo  Starting server...
echo.

cd /d "%~dp0"
node index.js

pause
