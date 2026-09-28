@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

set TOOLS=..\CompX-Orbit-Studio\tools
set CERTS=%TOOLS%\certs
set ZXP=%TOOLS%\ZXPSignCmd.exe

echo.
echo   Rotate the CompX Orbit signing certificate
echo   ------------------------------------------
echo.
echo   READ THIS FIRST:
echo.
echo   A new certificate means a NEW SIGNATURE. Installers can treat the
echo   extension as a different publisher, so an existing install may have
echo   to be removed before the next version will go on.
echo.
echo   Do NOT rotate in the middle of a release. Do it at a version
echo   boundary, then test upgrading OVER an existing install before you
echo   send the build to anyone.
echo.
echo   The old certificate is backed up, not deleted.
echo.
set /p GO=  Type ROTATE to continue: 
if /i not "!GO!"=="ROTATE" (
  echo.
  echo   Cancelled - nothing was changed.
  echo.
  pause
  exit /b 0
)

if not exist "%ZXP%" (
  echo.
  echo   ZXPSignCmd.exe not found at %ZXP%
  pause
  exit /b 1
)

echo.
set /p NEWPASS=  New certificate password: 
if "!NEWPASS!"=="" (
  echo   No password given - stopping.
  pause
  exit /b 1
)

for /f "tokens=2 delims==" %%d in ('wmic os get localdatetime /value 2^>nul ^| find "="') do set DT=%%d
set STAMP=!DT:~0,8!-!DT:~8,6!

if exist "%CERTS%\compx-selfsigned.p12" (
  if not exist "%CERTS%\backup" mkdir "%CERTS%\backup"
  copy /y "%CERTS%\compx-selfsigned.p12" "%CERTS%\backup\compx-selfsigned-!STAMP!.p12" >nul
  echo   Old certificate backed up to certs\backup\compx-selfsigned-!STAMP!.p12
  del /q "%CERTS%\compx-selfsigned.p12"
)

echo   Generating new certificate...
"%ZXP%" -selfSignedCert BD Dhaka "CompX Orbit" "CompX Orbit Studio" "!NEWPASS!" "%CERTS%\compx-selfsigned.p12"
set RESULT=%ERRORLEVEL%

if not "!RESULT!"=="0" (
  echo.
  echo   FAILED - restoring the old certificate.
  copy /y "%CERTS%\backup\compx-selfsigned-!STAMP!.p12" "%CERTS%\compx-selfsigned.p12" >nul
  set NEWPASS=
  pause
  exit /b !RESULT!
)

echo.
echo   ------------------------------------------
echo   New certificate written to:
echo     %CERTS%\compx-selfsigned.p12
echo.
echo   Still to do by hand:
echo     1. tools\build-zxp.js  - DEFAULT_PASSWORD on line 26 is the OLD
echo        password in plain text. Replace it with
echo        process.env.ORBIT_SIGN_PASSWORD
echo     2. Build a test ZXP and install it OVER an existing install to
echo        see whether it upgrades cleanly.
echo.
set NEWPASS=
pause
exit /b 0
