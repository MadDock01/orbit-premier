@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo.
echo   CompX Orbit Premiere - release build
echo   ------------------------------------
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo   Node.js was not found on PATH.
  echo   Install Node, reopen this window, and run again.
  echo.
  pause
  exit /b 1
)

for /f "tokens=2 delims='" %%v in ('findstr /c:"const version=" scripts\build-release.cjs') do set VER=%%v
echo   Version to build: !VER!
echo.

if not "!ORBIT_SIGN_PASSWORD!"=="" goto haspass
echo   The signing certificate password is not set.
echo   (What you type is visible on screen - set ORBIT_SIGN_PASSWORD
echo    beforehand if you would rather it were not.)
echo.
set /p ORBIT_SIGN_PASSWORD=  Signing certificate password:
echo.

:haspass
if "!ORBIT_SIGN_PASSWORD!"=="" (
  echo   No password given - the package cannot be signed. Stopping.
  echo.
  pause
  exit /b 1
)

echo   Running 7 test suites, compiling JSXBIN, signing...
echo.
node scripts\build-release.cjs
set RESULT=%ERRORLEVEL%

REM Do not leave the signing password sitting in this shell.
set ORBIT_SIGN_PASSWORD=

echo.
if "!RESULT!"=="0" (
  echo   ------------------------------------
  echo   Build finished.
  echo.
  echo   dist\CompX-Orbit-Premiere-v!VER!.zxp
  echo   dist\hostscript-v!VER!.jsxbin
  echo   dist\release-!VER!.json
) else (
  echo   ------------------------------------
  echo   BUILD FAILED - exit code !RESULT!
  echo.
  echo   The message above names the step that stopped it.
  echo   Copy the whole output and paste it to Claude.
)
echo.
pause
exit /b !RESULT!
