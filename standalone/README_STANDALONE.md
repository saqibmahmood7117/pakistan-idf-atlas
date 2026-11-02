# Pakistan IDF Atlas Automator — Windows

Fixed build: **2026.08.20.4.1**. This revision repairs the missing
`selenium.webdriver.chrome.webdriver` component and explicitly includes all
Windows-only dependencies discovered in the package metadata: `pefile`,
`pywin32-ctypes`, `cffi`, and `pycparser`. The app can be installed or built
without contacting PyPI.

This desktop controller automates the Pakistan IDF Atlas with Selenium. It can:

- retrieve ERA5 daily or hourly precipitation;
- retrieve CHIRPS daily precipitation;
- use a point/grid cell or a verified district polygon;
- import a bias-corrected CMIP6 results workbook;
- wait for long provider jobs;
- download the Atlas Excel results and chart;
- save a diagnostic screenshot;
- check 24-hour curve monotonicity, completeness, analysis status, and rare-event extrapolation;
- maintain `Pakistan_IDF_Atlas_Automation_Log.xlsx` across runs.

## Simplest way to run

1. Extract the ZIP to a normal folder.
2. Ensure Google Chrome and 64-bit Python 3.11-3.14 or a matching Anaconda installation are installed.
3. Double-click `RUN_PAKISTAN_IDF_ATLAS.bat`.
4. On the first run, leave **Headless after first login** unchecked.
5. If Chrome requests sign-in, sign in to ChatGPT/Sites once. The app uses a dedicated Chrome profile and remembers the session.
6. Select ERA5, CHIRPS, or a corrected CMIP6 workbook and click **Run automated IDF analysis**.

The first launch creates a private `.venv` beside the app and installs Selenium and OpenPyXL from the included `wheels` folder. It does not need PyPI. If an older or incomplete environment already exists, the launcher detects and repairs it automatically. Selenium Manager resolves the matching browser driver when internet access is available; you do not need to download ChromeDriver manually.

## Build a single EXE

Double-click `BUILD_WINDOWS_EXE.bat`. When it finishes, the executable is:

```text
dist\Pakistan_IDF_Atlas_Automator.exe
```

The builder now performs a packaging self-test before reporting success. It checks the exact Chrome WebDriver module and the bundled Selenium Manager executable. The EXE includes Python and the application dependencies. Google Chrome and an internet connection are still required because the Atlas and climate providers are online services.

If you built the earlier EXE, delete that old EXE, extract this fixed package to a new folder, and run `BUILD_WINDOWS_EXE.bat` again. Do not reuse the old `.build-venv` folder. The build dependencies, including the Windows-only `pefile`, `pywin32-ctypes`, `cffi`, and `pycparser` packages, are installed from the included `wheels` folder, so a temporary PyPI/DNS outage will not stop the EXE build.

## Internet requirement for climate retrieval

The installer and EXE builder can now run without PyPI. The analysis itself is
not offline: the hosted Atlas plus ERA5, CHIRPS and CMIP6 providers require an
active internet connection. If Chrome reports `ERR_INTERNET_DISCONNECTED`,
reconnect Windows, confirm the Atlas URL opens normally in Chrome, and rerun.

## Important analysis limits

- Daily ERA5 and CHIRPS directly support the 24-hour IDF result. Shorter durations require hourly observations or validated duration ratios.
- District precipitation is spatially averaged and may smooth local storm peaks. Use point/grid-cell mode for a specific project site.
- Imported CMIP6 result workbooks remain 24-hour-only unless observed duration ratios are supplied.
- P10–P90 CMIP6 model spread is not a 95% confidence interval.
- The 250- and 500-year values are strong extrapolations and require gauge, regional, and independent engineering review.

Official automation references:

- Selenium Manager: https://www.selenium.dev/documentation/selenium_manager/
- Selenium WebDriver: https://www.selenium.dev/documentation/webdriver/
- PyInstaller: https://pyinstaller.org/en/stable/usage.html
