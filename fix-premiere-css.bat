@echo off
echo CompX Orbit Premiere - CSS Fix Installer
echo ==========================================
echo.

set "SRC=%~dp0css\premiere-edition.css"
set "BUNDLE_ID=com.compxorbit.premiere"
set "USER_DST=%APPDATA%\Adobe\CEP\extensions\%BUNDLE_ID%\css\premiere-edition.css"
set "COMMON86=%ProgramFiles(x86)%\Common Files\Adobe\CEP\extensions\%BUNDLE_ID%\css\premiere-edition.css"
set "COMMON64=%ProgramFiles%\Common Files\Adobe\CEP\extensions\%BUNDLE_ID%\css\premiere-edition.css"

echo Source: "%SRC%"
echo.

if exist "%SRC%" (
    if exist "%APPDATA%\Adobe\CEP\extensions\%BUNDLE_ID%" copy /Y "%SRC%" "%USER_DST%" >nul 2>&1
    if exist "%ProgramFiles(x86)%\Common Files\Adobe\CEP\extensions\%BUNDLE_ID%" copy /Y "%SRC%" "%COMMON86%" >nul 2>&1
    if exist "%ProgramFiles%\Common Files\Adobe\CEP\extensions\%BUNDLE_ID%" copy /Y "%SRC%" "%COMMON64%" >nul 2>&1
    echo [OK] Updated premiere-edition.css across installed locations.
) else (
    echo [ERROR] Source file not found: "%SRC%"
)

echo.
pause
