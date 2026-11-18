@echo off
cd /d "%~dp0"
set "TEMP=%~dp0.tmp"
set "TMP=%TEMP%"
if not exist "%TEMP%" mkdir "%TEMP%"
"%~dp0.deps\runtime\node.exe" "%~dp0build\src\ide\start.js" --product-root "%~dp0." %*
