@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo.
echo   Compile jsx\hostscript.jsx  -^>  jsx\hostscript.jsxbin
echo   -----------------------------------------------------
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo   Node.js was not found on PATH.
  echo.
  pause
  exit /b 1
)

node scripts\make-jsxbin.cjs
set RESULT=%ERRORLEVEL%

echo.
if not "!RESULT!"=="0" (
  echo   Copy the message above and paste it to Claude.
)
pause
exit /b !RESULT!
