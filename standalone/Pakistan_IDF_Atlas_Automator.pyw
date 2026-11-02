from __future__ import annotations

import queue
import json
import sys
import threading
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

from atlas_automation import (
    APP_NAME,
    APP_VERSION,
    AtlasAutomation,
    AutomationConfig,
    load_settings,
    open_folder,
    save_settings,
)


DISTRICTS = [
    "Peshawar", "Swat", "Charsadda", "Nowshera", "Mardan", "Buner",
    "Upper Dir", "Lower Dir", "Abbottabad", "Mansehra", "Islamabad",
    "Lahore", "Rawalpindi", "Faisalabad", "Multan", "Quetta", "Karachi East",
]
SOURCES = ["ERA5 daily", "ERA5 hourly", "CHIRPS daily", "CMIP6 corrected workbook"]


def run_packaging_self_test(output_path: str) -> int:
    """Verify that the frozen build contains Selenium, Chrome WebDriver and Manager."""
    report: dict[str, object] = {"status": "failed", "app_version": APP_VERSION}
    try:
        import selenium
        from openpyxl import Workbook
        from selenium.webdriver.chrome.options import Options
        from selenium.webdriver.chrome.webdriver import WebDriver
        from selenium.webdriver.common.by import By
        from selenium.webdriver.common.keys import Keys
        from selenium.webdriver.common.selenium_manager import SeleniumManager
        from selenium.webdriver.support.ui import Select

        manager_path = SeleniumManager._get_binary()
        report.update(
            {
                "status": "ok",
                "selenium_version": selenium.__version__,
                "selenium_manager": str(manager_path),
                "selenium_manager_exists": manager_path.is_file(),
                "imports": [
                    Workbook.__name__,
                    Options.__name__,
                    WebDriver.__name__,
                    By.__name__,
                    Keys.__name__,
                    Select.__name__,
                ],
            }
        )
    except Exception as error:
        report["error"] = f"{type(error).__name__}: {error}"

    target = Path(output_path).expanduser().resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(report, indent=2), encoding="utf-8")
    return 0 if report["status"] == "ok" else 1


class Application(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title(APP_NAME)
        self.geometry("980x760")
        self.minsize(880, 680)
        self.configure(bg="#eef6f5")
        self.config_data = load_settings()
        self.queue: queue.Queue[tuple[str, object]] = queue.Queue()
        self.stop_event = threading.Event()
        self.worker: threading.Thread | None = None
        self.last_output = self.config_data.download_folder
        self.variables: dict[str, tk.Variable] = {}
        self.controls: dict[str, ttk.Widget] = {}
        self._style()
        self._build()
        self.after(150, self._drain_queue)

    def _style(self):
        style = ttk.Style(self)
        style.theme_use("clam")
        style.configure("TFrame", background="#eef6f5")
        style.configure("Card.TFrame", background="#ffffff", relief="solid", borderwidth=1)
        style.configure("TLabel", background="#eef6f5", foreground="#18384c", font=("Segoe UI", 10))
        style.configure("Card.TLabel", background="#ffffff", foreground="#18384c", font=("Segoe UI", 10))
        style.configure("Title.TLabel", background="#eef6f5", foreground="#173b5c", font=("Segoe UI Semibold", 22))
        style.configure("Subtitle.TLabel", background="#eef6f5", foreground="#54707d", font=("Segoe UI", 10))
        style.configure("Primary.TButton", font=("Segoe UI Semibold", 11), foreground="#ffffff", background="#0f766e", padding=(16, 10))
        style.map("Primary.TButton", background=[("active", "#0b5f59"), ("disabled", "#8aa7a3")])
        style.configure("TButton", font=("Segoe UI", 10), padding=(10, 7))

    def _var(self, name: str, value):
        variable = tk.BooleanVar(value=value) if isinstance(value, bool) else tk.StringVar(value=str(value))
        self.variables[name] = variable
        return variable

    def _field(self, parent, row: int, label: str, name: str, value: str, widget="entry", values=None, browse=None):
        ttk.Label(parent, text=label, style="Card.TLabel").grid(row=row, column=0, sticky="w", padx=12, pady=7)
        variable = self._var(name, value)
        if widget == "combo":
            control = ttk.Combobox(parent, textvariable=variable, values=values or [], state="readonly")
        else:
            control = ttk.Entry(parent, textvariable=variable)
        control.grid(row=row, column=1, sticky="ew", padx=8, pady=7)
        self.controls[name] = control
        if browse:
            ttk.Button(parent, text="Browse", command=browse).grid(row=row, column=2, padx=8, pady=7)
        return control

    def _build(self):
        outer = ttk.Frame(self, padding=20)
        outer.pack(fill="both", expand=True)
        ttk.Label(outer, text="Pakistan IDF Atlas Automator", style="Title.TLabel").pack(anchor="w")
        ttk.Label(
            outer,
            text=f"Standalone Windows controller · Selenium retrieval · automatic QA · Excel run log · build {APP_VERSION}",
            style="Subtitle.TLabel",
        ).pack(anchor="w", pady=(2, 14))

        cards = ttk.Frame(outer)
        cards.pack(fill="x")
        left = ttk.Frame(cards, style="Card.TFrame", padding=8)
        right = ttk.Frame(cards, style="Card.TFrame", padding=8)
        left.grid(row=0, column=0, sticky="nsew", padx=(0, 7))
        right.grid(row=0, column=1, sticky="nsew", padx=(7, 0))
        cards.columnconfigure(0, weight=1)
        cards.columnconfigure(1, weight=1)
        left.columnconfigure(1, weight=1)
        right.columnconfigure(1, weight=1)

        ttk.Label(left, text="Automation selection", style="Card.TLabel", font=("Segoe UI Semibold", 12)).grid(row=0, column=0, columnspan=3, sticky="w", padx=12, pady=(6, 10))
        source_control = self._field(left, 1, "Data workflow", "source", self.config_data.source, "combo", SOURCES)
        spatial_control = self._field(left, 2, "Spatial mode", "spatial_mode", self.config_data.spatial_mode, "combo", ["Point/grid-cell", "District polygon"])
        self._field(left, 3, "District", "district", self.config_data.district, "combo", DISTRICTS)
        self._field(left, 4, "Latitude", "latitude", self.config_data.latitude)
        self._field(left, 5, "Longitude", "longitude", self.config_data.longitude)
        self._field(left, 6, "Start date", "start_date", self.config_data.start_date)
        self._field(left, 7, "End date", "end_date", self.config_data.end_date)
        source_control.bind("<<ComboboxSelected>>", lambda _event: self._update_states())
        spatial_control.bind("<<ComboboxSelected>>", lambda _event: self._update_states())

        ttk.Label(right, text="Files and execution", style="Card.TLabel", font=("Segoe UI Semibold", 12)).grid(row=0, column=0, columnspan=3, sticky="w", padx=12, pady=(6, 10))
        self._field(right, 1, "Corrected CMIP6 workbook", "cmip_workbook", self.config_data.cmip_workbook, browse=self._browse_workbook)
        self._field(right, 2, "Results folder", "download_folder", self.config_data.download_folder, browse=self._browse_folder)
        self._field(right, 3, "Atlas URL", "atlas_url", self.config_data.atlas_url)
        self._field(right, 4, "Timeout (minutes)", "timeout_minutes", str(self.config_data.timeout_minutes))

        checks = ttk.Frame(right, style="Card.TFrame")
        checks.grid(row=5, column=0, columnspan=3, sticky="w", padx=8, pady=8)
        for label, name, value in [
            ("Download Excel", "download_excel", self.config_data.download_excel),
            ("Download chart", "download_chart", self.config_data.download_chart),
            ("Headless after first login", "headless", self.config_data.headless),
            ("Keep Chrome open", "keep_browser_open", self.config_data.keep_browser_open),
        ]:
            ttk.Checkbutton(checks, text=label, variable=self._var(name, value)).pack(anchor="w", pady=2)

        note = ttk.Label(
            right,
            text="First run: leave Headless off. Sign in once if requested; the dedicated Chrome profile remembers the session.",
            style="Card.TLabel",
            wraplength=390,
            foreground="#8a5b12",
        )
        note.grid(row=6, column=0, columnspan=3, sticky="w", padx=12, pady=(4, 10))

        actions = ttk.Frame(outer)
        actions.pack(fill="x", pady=14)
        self.run_button = ttk.Button(actions, text="Run automated IDF analysis", style="Primary.TButton", command=self._start)
        self.run_button.pack(side="left")
        self.stop_button = ttk.Button(actions, text="Stop", command=self._stop, state="disabled")
        self.stop_button.pack(side="left", padx=8)
        ttk.Button(actions, text="Open results folder", command=self._open_results).pack(side="right")

        log_card = ttk.Frame(outer, style="Card.TFrame", padding=10)
        log_card.pack(fill="both", expand=True)
        ttk.Label(log_card, text="Automation log", style="Card.TLabel", font=("Segoe UI Semibold", 12)).pack(anchor="w", pady=(0, 6))
        self.log_box = tk.Text(log_card, height=15, wrap="word", bg="#0f2430", fg="#d8f3ee", insertbackground="#ffffff", font=("Consolas", 9), relief="flat", padx=10, pady=10)
        self.log_box.pack(fill="both", expand=True)
        self._log("Ready. Select a workflow and click Run automated IDF analysis.")
        self._update_states()

    def _browse_workbook(self):
        path = filedialog.askopenfilename(title="Select corrected CMIP6 workbook", filetypes=[("Excel workbook", "*.xlsx *.xls")])
        if path:
            self.variables["cmip_workbook"].set(path)

    def _browse_folder(self):
        path = filedialog.askdirectory(title="Choose results folder")
        if path:
            self.variables["download_folder"].set(path)

    def _update_states(self):
        if not self.controls:
            return
        is_cmip = str(self.variables["source"].get()).startswith("CMIP6")
        point_mode = str(self.variables["spatial_mode"].get()).startswith("Point")
        for name in ("start_date", "end_date", "spatial_mode"):
            self.controls[name].configure(state="disabled" if is_cmip else ("readonly" if name == "spatial_mode" else "normal"))
        self.controls["cmip_workbook"].configure(state="normal" if is_cmip else "disabled")
        self.controls["district"].configure(state="disabled" if is_cmip or point_mode else "readonly")
        for name in ("latitude", "longitude"):
            self.controls[name].configure(state="disabled" if is_cmip or not point_mode else "normal")

    def _config(self) -> AutomationConfig:
        return AutomationConfig(
            atlas_url=str(self.variables["atlas_url"].get()).strip(),
            source=str(self.variables["source"].get()),
            spatial_mode=str(self.variables["spatial_mode"].get()),
            district=str(self.variables["district"].get()),
            latitude=str(self.variables["latitude"].get()).strip(),
            longitude=str(self.variables["longitude"].get()).strip(),
            start_date=str(self.variables["start_date"].get()).strip(),
            end_date=str(self.variables["end_date"].get()).strip(),
            cmip_workbook=str(self.variables["cmip_workbook"].get()).strip(),
            download_folder=str(self.variables["download_folder"].get()).strip(),
            timeout_minutes=max(1, int(str(self.variables["timeout_minutes"].get()))),
            download_excel=bool(self.variables["download_excel"].get()),
            download_chart=bool(self.variables["download_chart"].get()),
            headless=bool(self.variables["headless"].get()),
            keep_browser_open=bool(self.variables["keep_browser_open"].get()),
        )

    def _start(self):
        if self.worker and self.worker.is_alive():
            return
        try:
            config = self._config()
            if config.source.startswith("CMIP6") and not Path(config.cmip_workbook).exists():
                raise ValueError("Choose the corrected CMIP6 workbook first.")
            if not config.source.startswith("CMIP6") and config.spatial_mode.startswith("Point"):
                float(config.latitude)
                float(config.longitude)
            save_settings(config)
        except Exception as error:
            messagebox.showerror(APP_NAME, str(error))
            return
        self.stop_event.clear()
        self.run_button.configure(state="disabled")
        self.stop_button.configure(state="normal")
        self._log("Starting a new automation run…")
        self.worker = threading.Thread(target=self._work, args=(config,), daemon=True)
        self.worker.start()

    def _work(self, config: AutomationConfig):
        result = AtlasAutomation(config, lambda message: self.queue.put(("log", message)), self.stop_event).run()
        self.queue.put(("done", result))

    def _stop(self):
        self.stop_event.set()
        self._log("Stop requested. The current browser action will finish safely, then automation will close.")

    def _open_results(self):
        path = str(self.variables["download_folder"].get()).strip() or self.last_output
        if path:
            Path(path).mkdir(parents=True, exist_ok=True)
            open_folder(path)

    def _drain_queue(self):
        try:
            while True:
                kind, payload = self.queue.get_nowait()
                if kind == "log":
                    self._log(str(payload))
                elif kind == "done":
                    result = payload
                    self.last_output = result.download_folder
                    self.run_button.configure(state="normal")
                    self.stop_button.configure(state="disabled")
                    self._log(f"Run {result.status}. Results: {result.download_folder}")
                    if result.status == "completed":
                        messagebox.showinfo(APP_NAME, "Automation and IDF QA completed. The Excel log and result files are ready.")
                    else:
                        messagebox.showerror(APP_NAME, f"Automation stopped with an error:\n\n{result.error}\n\nA diagnostic screenshot was saved when possible.")
        except queue.Empty:
            pass
        self.after(150, self._drain_queue)

    def _log(self, message: str):
        self.log_box.insert("end", f"{message}\n")
        self.log_box.see("end")


if __name__ == "__main__":
    if "--packaging-self-test" in sys.argv:
        option_index = sys.argv.index("--packaging-self-test")
        if option_index + 1 >= len(sys.argv):
            raise SystemExit(2)
        raise SystemExit(run_packaging_self_test(sys.argv[option_index + 1]))
    Application().mainloop()
