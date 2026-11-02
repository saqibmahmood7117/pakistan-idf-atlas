@echo off
setlocal
cd /d "%~dp0"
title Pakistan IDF Atlas Automator
set "WHEELHOUSE=%CD%\wheels"

dir /b "%WHEELHOUSE%\selenium-*.whl" >nul 2>nul
if errorlevel 1 goto :missing_wheels
dir /b "%WHEELHOUSE%\openpyxl-*.whl" >nul 2>nul
if errorlevel 1 goto :missing_wheels
dir /b "%WHEELHOUSE%\cffi-*.whl" >nul 2>nul
if errorlevel 1 goto :missing_wheels
dir /b "%WHEELHOUSE%\pycparser-*.whl" >nul 2>nul
if errorlevel 1 goto :missing_wheels

set "PY_EXE="
set "PY_ARGS="
where py >nul 2>nul
if not errorlevel 1 set "PY_EXE=py"& set "PY_ARGS=-3"
if not defined PY_EXE where python >nul 2>nul
if not defined PY_EXE if not errorlevel 1 set "PY_EXE=python"
if not defined PY_EXE if exist "%USERPROFILE%\anaconda3\python.exe" set "PY_EXE=%USERPROFILE%\anaconda3\python.exe"
if not defined PY_EXE if exist "%USERPROFILE%\miniconda3\python.exe" set "PY_EXE=%USERPROFILE%\miniconda3\python.exe"
if not defined PY_EXE (
  echo Python was not found. Install Python 3.11-3.14 or use Anaconda, then run this file again.
  pause
  exit /b 1
)

"%PY_EXE%" %PY_ARGS% -c "import struct,sys; raise SystemExit(0 if sys.version_info[:2] in ((3, 11), (3, 12), (3, 13), (3, 14)) and struct.calcsize('P') * 8 == 64 else 1)"
if errorlevel 1 goto :unsupported_python

set "ENV_READY="
if exist ".venv\Scripts\python.exe" (
  ".venv\Scripts\python.exe" -c "from selenium.webdriver.chrome.webdriver import WebDriver; from selenium.webdriver.common.selenium_manager import SeleniumManager; import cffi, openpyxl, pycparser" >nul 2>nul
  if not errorlevel 1 set "ENV_READY=1"
)

if not defined ENV_READY (
  echo Creating the local application environment...
  if not exist ".venv\Scripts\python.exe" (
    "%PY_EXE%" %PY_ARGS% -m venv .venv
    if errorlevel 1 goto :failed
  )
  echo Installing the included offline packages...
  ".venv\Scripts\python.exe" -m pip install --disable-pip-version-check --no-index --find-links="%WHEELHOUSE%" --upgrade --force-reinstall -r requirements.txt
  if errorlevel 1 goto :failed
  ".venv\Scripts\python.exe" -c "from selenium.webdriver.chrome.webdriver import WebDriver; from selenium.webdriver.common.selenium_manager import SeleniumManager; import cffi, openpyxl, pycparser"
  if errorlevel 1 goto :failed
)

start "" ".venv\Scripts\pythonw.exe" "Pakistan_IDF_Atlas_Automator.pyw"
exit /b 0

:missing_wheels
echo.
echo The included offline installer files are missing.
echo Extract the complete ZIP to a normal folder and run this file again.
pause
exit /b 1

:unsupported_python
echo.
echo This package requires 64-bit Python 3.11, 3.12, 3.13 or 3.14.
echo Install a supported version and run this file again.
pause
exit /b 1

:failed
echo.
echo Installation did not finish. Extract the complete ZIP to a new folder and try again.
pause
exit /b 1
