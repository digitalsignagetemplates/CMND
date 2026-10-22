@echo off
title D-Line beheer
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto nonode

echo D-Line beheer wordt gestart...
set DLINE_OPEN=1
node server.js %*
echo.
echo ------------------------------------------------------------
echo De tool is gestopt. Lees de melding hierboven.
echo ------------------------------------------------------------
pause
exit /b 1

:nonode
echo Node.js is niet gevonden op deze pc.
echo Installeer Node.js LTS via https://nodejs.org of met:
echo     winget install OpenJS.NodeJS.LTS
echo Sluit daarna dit venster en start start.cmd opnieuw.
pause
exit /b 1
