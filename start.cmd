@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is niet gevonden op deze pc.
  echo Installeer Node.js LTS via https://nodejs.org of met:
  echo     winget install OpenJS.NodeJS.LTS
  echo Sluit daarna dit venster en start start.cmd opnieuw.
  pause
  exit /b 1
)
node server.js
pause
