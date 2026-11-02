from __future__ import annotations

import json
import os
import re
import shutil
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from threading import Event
from typing import Callable, Iterable


DEFAULT_ATLAS_URL = "https://pakistan-idf-atlas.stony-coin-8485.chatgpt.site/#source"
APP_NAME = "Pakistan IDF Atlas Automator"
APP_VERSION = "2026.08.20.4.1"


@dataclass
class AutomationConfig:
    atlas_url: str = DEFAULT_ATLAS_URL
    source: str = "ERA5 daily"
    spatial_mode: str = "Point/grid-cell"
    district: str = "Peshawar"
    latitude: str = "34.0151"
    longitude: str = "71.5249"
    start_date: str = "1981-01-01"
    end_date: str = "2025-12-31"
    cmip_workbook: str = ""
    download_folder: str = ""
    timeout_minutes: int = 25
    download_excel: bool = True
    download_chart: bool = True
    headless: bool = False
    keep_browser_open: bool = False


@dataclass
class RunResult:
    run_id: str
    status: str
    source: str
    started_at_utc: str
    finished_at_utc: str
    download_folder: str
    exported_workbook: str = ""
    screenshot: str = ""
    analysis_workbook: str = ""
    summary_text: str = ""
    error: str = ""


def application_data_dir() -> Path:
    root = os.environ.get("LOCALAPPDATA") or os.environ.get("APPDATA")
    if root:
        return Path(root) / "PakistanIDFAtlas"
    return Path.home() / ".pakistan-idf-atlas"


def default_download_folder() -> Path:
    downloads = Path.home() / "Downloads"
    return downloads / "Pakistan_IDF_Atlas_Results"


def settings_path() -> Path:
    return application_data_dir() / "settings.json"


def load_settings() -> AutomationConfig:
    path = settings_path()
    if not path.exists():
        config = AutomationConfig()
        config.download_folder = str(default_download_folder())
        return config
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        allowed = AutomationConfig.__dataclass_fields__
        return AutomationConfig(**{key: value for key, value in payload.items() if key in allowed})
    except Exception:
        config = AutomationConfig()
        config.download_folder = str(default_download_folder())
        return config


def save_settings(config: AutomationConfig) -> None:
    path = settings_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(asdict(config), indent=2), encoding="utf-8")


def normalize_header(value: object) -> str:
    return re.sub(r"[^a-z0-9]+", "_", str(value or "").strip().lower()).strip("_")


def worksheet_records(sheet) -> list[dict[str, object]]:
    rows = list(sheet.iter_rows(values_only=True))
    if not rows:
        return []
    headers = [normalize_header(value) for value in rows[0]]
    result: list[dict[str, object]] = []
    for values in rows[1:]:
        record = {
            header: values[index]
            for index, header in enumerate(headers)
            if header and index < len(values)
        }
        if any(value not in (None, "") for value in record.values()):
            result.append(record)
    return result


def first_present(record: dict[str, object], names: Iterable[str], default=""):
    for name in names:
        key = normalize_header(name)
        if record.get(key) not in (None, ""):
            return record[key]
    return default


def _number(value: object) -> float | None:
    try:
        number = float(str(value).replace(",", ""))
        return number if number == number else None
    except (TypeError, ValueError):
        return None


def friendly_error_message(error: Exception) -> str:
    raw = str(error)
    browser_errors = [
        (
            "ERR_INTERNET_DISCONNECTED",
            "No internet connection was detected. Connect Windows to the internet, confirm that a normal website opens in Chrome, and then run the automation again. Live ERA5/CHIRPS retrieval and the hosted Atlas cannot operate offline.",
        ),
        (
            "ERR_NAME_NOT_RESOLVED",
            "Windows could not resolve the Atlas address. Reconnect to the internet or correct the DNS/network connection, confirm the Atlas opens in Chrome, and then run again.",
        ),
        (
            "ERR_CONNECTION_TIMED_OUT",
            "The Atlas connection timed out. Check the internet connection, VPN or firewall, confirm the Atlas opens in Chrome, and then run again.",
        ),
        (
            "ERR_CONNECTION_RESET",
            "The Atlas connection was reset. Check the internet connection, VPN or firewall, confirm the Atlas opens in Chrome, and then run again.",
        ),
    ]
    for code, message in browser_errors:
        if code in raw:
            return message
    return raw


def analyze_export(workbook_path: Path) -> dict[str, object]:
    from openpyxl import load_workbook

    workbook = load_workbook(workbook_path, data_only=True, read_only=True)
    summary_rows = worksheet_records(workbook["Summary"]) if "Summary" in workbook.sheetnames else []
    summary = summary_rows[0] if summary_rows else {}
    curves = worksheet_records(workbook["IDF Curves"]) if "IDF Curves" in workbook.sheetnames else []
    qa: list[dict[str, str]] = []
    selected_rows: list[dict[str, object]] = []

    for row in curves:
        duration = _number(first_present(row, ["duration_minutes"]))
        return_period = _number(first_present(row, ["return_period_years"]))
        intensity = _number(first_present(row, ["intensity_mm_per_hour"]))
        if duration == 1440 and return_period and intensity is not None:
            selected_rows.append(
                {
                    "return_period_years": int(return_period),
                    "intensity_mm_hr": intensity,
                    "lower_mm_hr": _number(first_present(row, ["uncertainty_lower_mm_per_hour"])),
                    "upper_mm_hr": _number(first_present(row, ["uncertainty_upper_mm_per_hour"])),
                    "uncertainty_type": str(first_present(row, ["uncertainty_type"], "not reported")),
                }
            )

    selected_rows.sort(key=lambda row: int(row["return_period_years"]))
    if not selected_rows:
        qa.append({"severity": "HIGH", "check": "IDF output", "finding": "No 24-hour IDF rows were found."})
    elif any(
        selected_rows[index]["intensity_mm_hr"] <= selected_rows[index - 1]["intensity_mm_hr"]
        for index in range(1, len(selected_rows))
    ):
        qa.append({"severity": "HIGH", "check": "Curve monotonicity", "finding": "24-hour intensity does not increase strictly with return period."})
    else:
        qa.append({"severity": "PASS", "check": "Curve monotonicity", "finding": "24-hour intensity increases with return period."})

    completeness = _number(first_present(summary, ["completeness_percent"]))
    if completeness is not None:
        qa.append(
            {
                "severity": "PASS" if completeness >= 90 else "HIGH",
                "check": "Temporal completeness",
                "finding": f"{completeness:.2f}% completeness; the Atlas retention threshold is 90% per year.",
            }
        )

    classification = str(first_present(summary, ["analysis_classification"], "Not reported"))
    if re.search(r"not estimable|not retrieved|blank", classification, re.I):
        qa.append({"severity": "HIGH", "check": "Analysis classification", "finding": classification})
    elif re.search(r"provisional|caveat|screen", classification, re.I):
        qa.append({"severity": "CAUTION", "check": "Analysis classification", "finding": classification})
    else:
        qa.append({"severity": "PASS", "check": "Analysis classification", "finding": classification})

    eligible_years = _number(first_present(summary, ["eligible_ams_years"]))
    if eligible_years:
        for row in selected_rows:
            period = int(row["return_period_years"])
            if period > max(100, eligible_years * 3):
                qa.append(
                    {
                        "severity": "CAUTION",
                        "check": f"{period}-year extrapolation",
                        "finding": f"Return period is far longer than the {int(eligible_years)}-year eligible record.",
                    }
                )

    source = str(first_present(summary, ["source"], "Not reported"))
    source_class = str(first_present(summary, ["source_class"], "Not reported"))
    return {
        "source": source,
        "source_class": source_class,
        "classification": classification,
        "accepted_records": first_present(summary, ["accepted_records"], "Not reported"),
        "eligible_years": first_present(summary, ["eligible_ams_years"], "Not reported"),
        "completeness_percent": first_present(summary, ["completeness_percent"], "Not reported"),
        "idf_rows": selected_rows,
        "qa": qa,
    }


def append_analysis_log(result: RunResult, analysis: dict[str, object], output_path: Path) -> None:
    from openpyxl import Workbook, load_workbook
    from openpyxl.styles import Alignment, Font, PatternFill

    if output_path.exists():
        workbook = load_workbook(output_path)
    else:
        workbook = Workbook()
        workbook.remove(workbook.active)

    def ensure_sheet(name: str, headers: list[str]):
        sheet = workbook[name] if name in workbook.sheetnames else workbook.create_sheet(name)
        if sheet.max_row == 1 and all(cell.value is None for cell in sheet[1]):
            for column, header in enumerate(headers, start=1):
                sheet.cell(1, column, header)
        elif sheet.cell(1, 1).value is None:
            for column, header in enumerate(headers, start=1):
                sheet.cell(1, column, header)
        for cell in sheet[1]:
            cell.font = Font(bold=True, color="FFFFFF")
            cell.fill = PatternFill("solid", fgColor="0F766E")
            cell.alignment = Alignment(wrap_text=True)
        sheet.freeze_panes = "A2"
        return sheet

    runs = ensure_sheet(
        "Automation Runs",
        ["Run ID", "Status", "Started UTC", "Finished UTC", "Requested source", "Returned source", "Source class", "Classification", "Accepted records", "Eligible years", "Completeness %", "Export workbook", "Screenshot", "Error"],
    )
    runs.append(
        [
            result.run_id,
            result.status,
            result.started_at_utc,
            result.finished_at_utc,
            result.source,
            analysis.get("source", ""),
            analysis.get("source_class", ""),
            analysis.get("classification", ""),
            analysis.get("accepted_records", ""),
            analysis.get("eligible_years", ""),
            analysis.get("completeness_percent", ""),
            result.exported_workbook,
            result.screenshot,
            result.error,
        ]
    )

    idf = ensure_sheet(
        "IDF Summary",
        ["Run ID", "Return period (years)", "24-hour intensity (mm/hr)", "Lower", "Upper", "Uncertainty type"],
    )
    for row in analysis.get("idf_rows", []):
        idf.append(
            [
                result.run_id,
                row.get("return_period_years"),
                row.get("intensity_mm_hr"),
                row.get("lower_mm_hr"),
                row.get("upper_mm_hr"),
                row.get("uncertainty_type"),
            ]
        )

    qa = ensure_sheet("QA Findings", ["Run ID", "Severity", "Check", "Finding"])
    for finding in analysis.get("qa", []):
        qa.append([result.run_id, finding.get("severity"), finding.get("check"), finding.get("finding")])

    for sheet in workbook.worksheets:
        for column in sheet.columns:
            width = min(55, max(12, max(len(str(cell.value or "")) for cell in column) + 2))
            sheet.column_dimensions[column[0].column_letter].width = width
    output_path.parent.mkdir(parents=True, exist_ok=True)
    workbook.save(output_path)


def write_text_summary(result: RunResult, analysis: dict[str, object], output_path: Path) -> None:
    lines = [
        "PAKISTAN IDF ATLAS AUTOMATION SUMMARY",
        f"Run: {result.run_id}",
        f"Status: {result.status}",
        f"Source: {analysis.get('source', result.source)}",
        f"Classification: {analysis.get('classification', 'Not reported')}",
        f"Accepted records: {analysis.get('accepted_records', 'Not reported')}",
        f"Eligible years: {analysis.get('eligible_years', 'Not reported')}",
        "",
        "24-HOUR IDF",
    ]
    for row in analysis.get("idf_rows", []):
        lines.append(
            f"{row['return_period_years']}-year: {row['intensity_mm_hr']:.3f} mm/hr "
            f"({row.get('lower_mm_hr')} to {row.get('upper_mm_hr')}; {row.get('uncertainty_type')})"
        )
    lines.extend(["", "AUTOMATED QA"])
    for finding in analysis.get("qa", []):
        lines.append(f"[{finding['severity']}] {finding['check']}: {finding['finding']}")
    if result.error:
        lines.extend(["", f"ERROR: {result.error}"])
    output_path.write_text("\n".join(lines), encoding="utf-8")


class AtlasAutomation:
    def __init__(self, config: AutomationConfig, logger: Callable[[str], None], stop_event: Event):
        self.config = config
        self.log = logger
        self.stop_event = stop_event
        self.driver = None

    def _stopped(self) -> bool:
        if self.stop_event.is_set():
            raise RuntimeError("Automation stopped by the user.")
        return False

    def _wait(self, predicate, timeout: int, message: str):
        end = time.time() + timeout
        last_error = None
        while time.time() < end:
            self._stopped()
            try:
                value = predicate()
                if value:
                    return value
            except Exception as error:
                last_error = error
            time.sleep(0.5)
        if last_error:
            raise TimeoutError(f"{message} Last browser response: {last_error}")
        raise TimeoutError(message)

    def _click_button(self, text: str):
        from selenium.webdriver.common.by import By

        xpath = f"//button[contains(normalize-space(.), {json.dumps(text)})]"
        button = self._wait(
            lambda: next((item for item in self.driver.find_elements(By.XPATH, xpath) if item.is_displayed() and item.is_enabled()), None),
            30,
            f"Could not find the enabled “{text}” button.",
        )
        self.driver.execute_script("arguments[0].scrollIntoView({block:'center'});", button)
        self.driver.execute_script("arguments[0].click();", button)
        return button

    def _label_control(self, label_text: str, tag: str):
        from selenium.webdriver.common.by import By

        xpath = f"//label[contains(normalize-space(.), {json.dumps(label_text)})]//{tag}"
        return self._wait(
            lambda: next((item for item in self.driver.find_elements(By.XPATH, xpath) if item.is_displayed()), None),
            30,
            f"Could not find {label_text} control.",
        )

    def _set_input(self, label: str, value: str):
        from selenium.webdriver.common.keys import Keys

        element = self._label_control(label, "input")
        element.send_keys(Keys.CONTROL, "a")
        element.send_keys(value)
        element.send_keys(Keys.TAB)

    def _select_value(self, label: str, value: str):
        from selenium.webdriver.support.ui import Select

        Select(self._label_control(label, "select")).select_by_value(value)

    def _select_text(self, label: str, text: str):
        from selenium.webdriver.support.ui import Select

        Select(self._label_control(label, "select")).select_by_visible_text(text)

    def _new_download(self, before: set[Path], folder: Path, suffix: str, timeout: int = 120) -> Path:
        def locate():
            candidates = [
                path
                for path in folder.glob(f"*{suffix}")
                if path not in before and not path.name.endswith(".crdownload") and path.stat().st_size > 0
            ]
            return max(candidates, key=lambda path: path.stat().st_mtime) if candidates else None

        return self._wait(locate, timeout, f"The expected {suffix} download did not finish.")

    def _start_browser(self, download_folder: Path):
        try:
            from selenium.webdriver.chrome.options import Options
            from selenium.webdriver.chrome.webdriver import WebDriver as ChromeWebDriver
        except ModuleNotFoundError as error:
            raise RuntimeError(
                "The Selenium Chrome components are incomplete. Download the fixed "
                "2026.08.20 package, or run RUN_PAKISTAN_IDF_ATLAS.bat again so it can repair them."
            ) from error

        profile = application_data_dir() / "ChromeProfile"
        profile.mkdir(parents=True, exist_ok=True)
        options = Options()
        options.add_argument(f"--user-data-dir={profile}")
        options.add_argument("--profile-directory=Default")
        options.add_argument("--start-maximized")
        options.add_argument("--disable-notifications")
        options.add_argument("--disable-popup-blocking")
        if self.config.headless:
            options.add_argument("--headless=new")
            options.add_argument("--window-size=1600,1200")
        options.add_experimental_option(
            "prefs",
            {
                "download.default_directory": str(download_folder.resolve()),
                "download.prompt_for_download": False,
                "download.directory_upgrade": True,
                "safebrowsing.enabled": True,
            },
        )
        self.log("Starting Chrome through Selenium Manager…")
        self.driver = ChromeWebDriver(options=options)
        self.driver.set_page_load_timeout(120)

    def _wait_for_atlas(self):
        from selenium.webdriver.common.by import By

        self.driver.get(self.config.atlas_url)
        try:
            self._wait(
                lambda: any("Precipitation IDF Analysis" in item.text for item in self.driver.find_elements(By.TAG_NAME, "h1")),
                20,
                "Atlas did not open.",
            )
        except TimeoutError:
            if self.config.headless:
                raise RuntimeError("The Atlas requires sign-in. Run once with Headless mode off and sign in manually.")
            self.log("If a sign-in page is visible, sign in now. The dedicated Chrome profile will remember it.")
            self._wait(
                lambda: any("Precipitation IDF Analysis" in item.text for item in self.driver.find_elements(By.TAG_NAME, "h1")),
                300,
                "Sign-in was not completed within five minutes.",
            )
        self.log("Atlas is ready.")

    def _run_online(self):
        from selenium.webdriver.common.by import By

        self._click_button("Online source data")
        source_value = "chirps" if self.config.source.startswith("CHIRPS") else "era5"
        resolution = "hourly" if "hourly" in self.config.source.lower() else "daily"
        self._select_value("Online dataset", source_value)
        self._select_value("Temporal resolution", resolution)

        if self.config.spatial_mode.startswith("Point"):
            self._click_button("Point/grid-cell series")
            self._set_input("Latitude", self.config.latitude)
            self._set_input("Longitude", self.config.longitude)
        else:
            self._click_button("District spatial series")
            self._select_text("District", self.config.district)
            self.log(f"Waiting for the verified {self.config.district} polygon…")

        self._set_input("Start date", self.config.start_date)
        self._set_input("End date", self.config.end_date)
        self._wait(
            lambda: next(
                (
                    button
                    for button in self.driver.find_elements(By.XPATH, "//button[contains(normalize-space(.), 'Retrieve directly from source') or contains(normalize-space(.), 'Retrieve updated source data')]")
                    if button.is_displayed() and button.is_enabled()
                ),
                None,
            ),
            90,
            "The source retrieval button did not become available. Check coordinates or the district boundary.",
        )
        self._click_button("Retrieve")
        self.log(f"Retrieving {self.config.source}; long CHIRPS requests can take several minutes…")
        timeout = max(1, int(self.config.timeout_minutes)) * 60
        self._wait(
            lambda: "Retrieved source data ready" in self.driver.find_element(By.TAG_NAME, "body").text,
            timeout,
            f"{self.config.source} did not complete within {self.config.timeout_minutes} minutes.",
        )
        self.log("Provider retrieval, quality control, annual maxima and IDF fitting completed.")

    def _run_cmip_import(self):
        from selenium.webdriver.common.by import By

        workbook = Path(self.config.cmip_workbook).expanduser().resolve()
        if not workbook.exists():
            raise FileNotFoundError("Choose an existing bias-corrected CMIP6 workbook.")
        self._click_button("CMIP6 projections")
        inputs = self._wait(
            lambda: self.driver.find_elements(By.XPATH, "//input[@type='file' and @accept='.xlsx,.xls']"),
            30,
            "The corrected-results workbook input was not found.",
        )
        inputs[-1].send_keys(str(workbook))
        self.log("Validating the corrected CMIP6 workbook and rebuilding the ensemble…")
        self._wait(
            lambda: "Bias-corrected CMIP6 ensemble imported" in self.driver.find_element(By.TAG_NAME, "body").text,
            120,
            "The corrected CMIP6 workbook was not accepted. Review the validation message in Chrome.",
        )
        self.log("Corrected model curves and the multi-model ensemble are ready.")

    def run(self) -> RunResult:
        started = datetime.now(timezone.utc)
        run_id = started.strftime("%Y%m%dT%H%M%SZ")
        folder = Path(self.config.download_folder or default_download_folder()).expanduser().resolve()
        folder.mkdir(parents=True, exist_ok=True)
        run_folder = folder / f"Run_{run_id}_{normalize_header(self.config.source)}"
        run_folder.mkdir(parents=True, exist_ok=True)
        result = RunResult(
            run_id=run_id,
            status="running",
            source=self.config.source,
            started_at_utc=started.isoformat(),
            finished_at_utc="",
            download_folder=str(run_folder),
        )
        analysis: dict[str, object] = {"qa": []}
        try:
            self._start_browser(run_folder)
            self._wait_for_atlas()
            if self.config.source.startswith("CMIP6"):
                self._run_cmip_import()
            else:
                self._run_online()

            screenshot = run_folder / f"Atlas_Result_{run_id}.png"
            self.driver.save_screenshot(str(screenshot))
            result.screenshot = str(screenshot)

            if self.config.download_excel:
                before = set(run_folder.glob("*.xlsx"))
                self._click_button("Download Excel")
                exported = self._new_download(before, run_folder, ".xlsx")
                result.exported_workbook = str(exported)
                self.log(f"Downloaded analysis workbook: {exported.name}")
                analysis = analyze_export(exported)

            if self.config.download_chart:
                before_png = set(run_folder.glob("*.png"))
                self._click_button("Download image")
                try:
                    chart = self._new_download(before_png, run_folder, ".png", timeout=60)
                    self.log(f"Downloaded chart: {chart.name}")
                except TimeoutError:
                    self.log("The chart download was not detected; the full-page result screenshot was preserved.")

            result.status = "completed"
        except Exception as error:
            result.status = "failed"
            result.error = friendly_error_message(error)
            self.log(f"ERROR: {result.error}")
            if self.driver:
                try:
                    screenshot = run_folder / f"Automation_Error_{run_id}.png"
                    self.driver.save_screenshot(str(screenshot))
                    result.screenshot = str(screenshot)
                except Exception:
                    pass
        finally:
            result.finished_at_utc = datetime.now(timezone.utc).isoformat()
            log_path = folder / "Pakistan_IDF_Atlas_Automation_Log.xlsx"
            try:
                append_analysis_log(result, analysis, log_path)
                result.analysis_workbook = str(log_path)
                summary_path = run_folder / "Automation_Summary.txt"
                write_text_summary(result, analysis, summary_path)
                result.summary_text = str(summary_path)
            except Exception as error:
                self.log(f"Could not update the Excel automation log: {error}")
            if self.driver and not self.config.keep_browser_open:
                try:
                    self.driver.quit()
                except Exception:
                    pass
        return result


def open_folder(path: str) -> None:
    folder = Path(path)
    if os.name == "nt":
        os.startfile(folder)  # type: ignore[attr-defined]
    elif shutil.which("xdg-open"):
        os.system(f'xdg-open "{folder}"')
    elif shutil.which("open"):
        os.system(f'open "{folder}"')
