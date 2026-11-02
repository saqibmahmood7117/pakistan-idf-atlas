@echo off
setlocal
cd /d "%~dp0"
title Build Pakistan IDF Atlas Standalone EXE
set "WHEELHOUSE=%CD%\wheels"

dir /b "%WHEELHOUSE%\selenium-*.whl" >nul 2>nul
if errorlevel 1 goto :missing_wheels
dir /b "%WHEELHOUSE%\pyinstaller-*.whl" >nul 2>nul
if errorlevel 1 goto :missing_wheels
dir /b "%WHEELHOUSE%\pefile-*.whl" >nul 2>nul
if errorlevel 1 goto :missing_wheels
dir /b "%WHEELHOUSE%\pywin32_ctypes-*.whl" >nul 2>nul
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
  echo Python was not found. Install Python 3.11-3.14 or use Anaconda first.
  pause
  exit /b 1
)

"%PY_EXE%" %PY_ARGS% -c "import struct,sys; raise SystemExit(0 if sys.version_info[:2] in ((3, 11), (3, 12), (3, 13), (3, 14)) and struct.calcsize('P') * 8 == 64 else 1)"
if errorlevel 1 goto :unsupported_python

if not exist ".build-venv\Scripts\python.exe" "%PY_EXE%" %PY_ARGS% -m venv .build-venv
echo Installing the included offline build packages...
".build-venv\Scripts\python.exe" -m pip install --disable-pip-version-check --no-index --find-links="%WHEELHOUSE%" --upgrade -r requirements-build.txt
if errorlevel 1 goto :failed

".build-venv\Scripts\python.exe" -c "from selenium.webdriver.chrome.webdriver import WebDriver; from selenium.webdriver.common.selenium_manager import SeleniumManager; import cffi, openpyxl, pefile, pycparser, win32ctypes"
if errorlevel 1 goto :failed

".build-venv\Scripts\python.exe" -m PyInstaller --noconfirm --clean Pakistan_IDF_Atlas_Automator.spec
if errorlevel 1 goto :failed

set "SMOKE_TEST=%TEMP%\Pakistan_IDF_Atlas_packaging_test.json"
if exist "%SMOKE_TEST%" del /q "%SMOKE_TEST%"
"%CD%\dist\Pakistan_IDF_Atlas_Automator.exe" --packaging-self-test "%SMOKE_TEST%"
if errorlevel 1 goto :failed
if not exist "%SMOKE_TEST%" goto :failed
".build-venv\Scripts\python.exe" -c "import json,sys; p=json.load(open(sys.argv[1], encoding='utf-8')); assert p.get('status') == 'ok' and p.get('selenium_manager_exists')" "%SMOKE_TEST%"
if errorlevel 1 goto :failed

echo.
echo Build complete:
echo %CD%\dist\Pakistan_IDF_Atlas_Automator.exe
echo Selenium packaging self-test: passed
start "" "%CD%\dist"
pause
exit /b 0

:missing_wheels
echo.
echo The included offline build files are missing.
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
echo The Windows executable could not be built. Review the error above.
pause
exit /b 1
