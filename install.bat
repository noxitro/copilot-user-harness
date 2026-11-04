@echo off
rem copilot-user-harness: copy the harness parts into a target repository. Entry point for scripts\install.ps1.
rem Double-click: asks for the target path. Command line: install.bat <target> [-Workflow] [-Check] [-Remove] [-Force]
rem (comments are ASCII on purpose: chcp inside a batch file breaks parsing of multibyte lines that follow it)
chcp 65001 >nul
if not "%~1"=="" goto with_args
set "TARGET="
set /p "TARGET=Target repository path: "
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install.ps1" "%TARGET%"
goto done
:with_args
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install.ps1" %*
:done
set RC=%ERRORLEVEL%
pause
exit /b %RC%
