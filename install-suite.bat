@echo off
setlocal enabledelayedexpansion
title CompX Orbit Premiere Pro - Extension Installer
echo ===================================================================
echo CompX Orbit Studio - Premiere Pro Extension Deployer
echo ===================================================================
echo.

:: Get current folder dynamically without trailing backslash
set "SRC=%~dp0"
if "%SRC:~-1%"=="\" set "SRC=%SRC:~0,-1%"

:: Target directories
set "BUNDLE_ID=com.compxorbit.premiere"
set "USER_EXT=%APPDATA%\Adobe\CEP\extensions\%BUNDLE_ID%"
set "COMMON64=%ProgramFiles%\Common Files\Adobe\CEP\extensions\%BUNDLE_ID%"
set "COMMON86=%ProgramFiles(x86)%\Common Files\Adobe\CEP\extensions\%BUNDLE_ID%"
set "LEGACY_COMMON64=%ProgramFiles%\Common Files\Adobe\CEP\extensions\CompX-Orbit-Premiere"
set "LEGACY_COMMON86=%ProgramFiles(x86)%\Common Files\Adobe\CEP\extensions\CompX-Orbit-Premiere"

:: Remove legacy folders if present
if exist "%LEGACY_COMMON64%" rmdir /S /Q "%LEGACY_COMMON64%" >nul 2>&1
if exist "%LEGACY_COMMON86%" rmdir /S /Q "%LEGACY_COMMON86%" >nul 2>&1

echo Source Directory: "%SRC%"
echo.

:: 1. Enable PlayerDebugMode in Windows Registry for unsigned extension loading
echo [*] Enabling CEP PlayerDebugMode in Registry...
for %%v in (11 12 13 14 15 16 17) do (
    reg add "HKCU\Software\Adobe\CSXS.%%v" /v PlayerDebugMode /t REG_SZ /d 1 /f >nul 2>&1
)
echo     [OK] PlayerDebugMode enabled for CSXS 11-17 (Premiere 2022-2026+)

:: 2. Deploy to User AppData (Always succeeds without Administrator privileges)
echo.
echo [1/3] Copying to User Extensions (No Admin required):
echo       "%USER_EXT%"
if not exist "%USER_EXT%" mkdir "%USER_EXT%" >nul 2>&1
xcopy /E /Y /I /R /H /Q "%SRC%\*" "%USER_EXT%\" >nul
if exist "%USER_EXT%\index.html" (
    echo     [OK] Successfully deployed to User AppData.
) else (
    echo     [WARNING] Could not write to User AppData directory.
)

:: 3. Deploy to Common Files 64-bit (System Wide)
echo.
echo [2/3] Copying to Common Files 64-bit (System Wide):
echo       "%COMMON64%"
if not exist "%COMMON64%" mkdir "%COMMON64%" >nul 2>&1
xcopy /E /Y /I /R /H /Q "%SRC%\*" "%COMMON64%\" >nul 2>&1
if exist "%COMMON64%\index.html" (
    echo     [OK] Successfully deployed to Common Files 64-bit.
) else (
    echo     [INFO] Skipped or requires Administrator rights.
)

:: 4. Deploy to Common Files x86 (Legacy / Compatibility)
echo.
echo [3/3] Copying to Common Files x86:
echo       "%COMMON86%"
if not exist "%COMMON86%" mkdir "%COMMON86%" >nul 2>&1
xcopy /E /Y /I /R /H /Q "%SRC%\*" "%COMMON86%\" >nul 2>&1
if exist "%COMMON86%\index.html" (
    echo     [OK] Successfully deployed to Common Files x86.
) else (
    echo     [INFO] Skipped or requires Administrator rights.
)

echo.
echo ===================================================================
echo [SUCCESS] CompX Orbit Premiere is ready!
echo Restart Adobe Premiere Pro and open Window -^> Extensions -^> CompX Orbit Studio
echo ===================================================================
echo.
pause
