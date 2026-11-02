@echo off
setlocal
cd /d "%~dp0"

where py >nul 2>nul
if %errorlevel%==0 (
  set "PYTHON_CMD=py"
) else (
  where python >nul 2>nul
  if errorlevel 1 (
    echo Python was not found. Install Python 3.10 or newer, then run this file again.
    pause
    exit /b 1
  )
  set "PYTHON_CMD=python"
)

if not exist ".venv\Scripts\python.exe" (
  echo Creating the Selenium environment...
  %PYTHON_CMD% -m venv .venv
  if errorlevel 1 goto :failed
)

call ".venv\Scripts\activate.bat"
python -m pip install --disable-pip-version-check -r requirements.txt
if errorlevel 1 goto :failed

echo Starting Google Maps outlet automation...
python run_google_maps_idf.py
if errorlevel 1 goto :failed
exit /b 0

:failed
echo.
echo The automation could not start. Review the message above.
pause
exit /b 1
