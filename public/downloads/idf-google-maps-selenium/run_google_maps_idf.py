"""Google Maps outlet picker for the Pakistan IDF Atlas.

The tool records one user click on the visible Google Maps canvas, converts the
screen position to WGS84 coordinates, then fills the Atlas MGHydro controls and
starts the watershed calculation. It uses Selenium Manager, so a separate
ChromeDriver download is normally unnecessary.
"""

from __future__ import annotations

import argparse
import math
import re
import sys
import time
from pathlib import Path

from selenium import webdriver
from selenium.common.exceptions import TimeoutException, WebDriverException
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait


DEFAULT_DASHBOARD = "https://pakistan-idf-atlas.stony-coin-8485.chatgpt.site"
DEFAULT_LATITUDE = 34.64737
DEFAULT_LONGITUDE = 72.03598
DEFAULT_ZOOM = 12.0
PAKISTAN_EXTENT = (23.3, 37.2, 60.7, 77.3)
VIEW_PATTERN = re.compile(
    r"@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(\d+(?:\.\d+)?)(?:z|a)"
)


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Select an outlet in Google Maps and run MGHydro in the Pakistan IDF Atlas."
    )
    parser.add_argument("--dashboard", default=DEFAULT_DASHBOARD)
    parser.add_argument("--latitude", type=float, default=DEFAULT_LATITUDE)
    parser.add_argument("--longitude", type=float, default=DEFAULT_LONGITUDE)
    parser.add_argument("--zoom", type=float, default=DEFAULT_ZOOM)
    parser.add_argument(
        "--keep-open",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Keep Chrome open after the calculation (default: true).",
    )
    return parser.parse_args()


def parse_google_view(url: str, fallback: tuple[float, float, float]) -> tuple[float, float, float]:
    match = VIEW_PATTERN.search(url)
    if not match:
        return fallback
    return float(match.group(1)), float(match.group(2)), float(match.group(3))


def latlon_to_world(latitude: float, longitude: float, zoom: float) -> tuple[float, float]:
    scale = 256.0 * (2.0**zoom)
    clipped_latitude = max(-85.05112878, min(85.05112878, latitude))
    sin_latitude = math.sin(math.radians(clipped_latitude))
    x = (longitude + 180.0) / 360.0 * scale
    y = (
        0.5
        - math.log((1.0 + sin_latitude) / (1.0 - sin_latitude))
        / (4.0 * math.pi)
    ) * scale
    return x, y


def world_to_latlon(x: float, y: float, zoom: float) -> tuple[float, float]:
    scale = 256.0 * (2.0**zoom)
    longitude = x / scale * 360.0 - 180.0
    mercator_y = math.pi - 2.0 * math.pi * y / scale
    latitude = math.degrees(math.atan(math.sinh(mercator_y)))
    return latitude, longitude


def clicked_coordinate(
    click: dict[str, float | str], fallback: tuple[float, float, float]
) -> tuple[float, float]:
    center_latitude, center_longitude, zoom = parse_google_view(
        str(click.get("url", "")), fallback
    )
    center_x, center_y = latlon_to_world(center_latitude, center_longitude, zoom)
    canvas_center_x = float(click["left"]) + float(click["width"]) / 2.0
    canvas_center_y = float(click["top"]) + float(click["height"]) / 2.0
    selected_x = center_x + float(click["x"]) - canvas_center_x
    selected_y = center_y + float(click["y"]) - canvas_center_y
    return world_to_latlon(selected_x, selected_y, zoom)


def arm_google_click(driver: webdriver.Chrome) -> None:
    driver.execute_script(
        """
        if (window.__idfOutletHandler) {
          document.removeEventListener('click', window.__idfOutletHandler, true);
        }
        window.__idfOutletClick = null;
        window.__idfOutletHandler = function(event) {
          const canvases = Array.from(document.querySelectorAll('canvas'))
            .map((canvas) => canvas.getBoundingClientRect())
            .filter((rect) => rect.width > 300 && rect.height > 250)
            .sort((a, b) => (b.width * b.height) - (a.width * a.height));
          const rect = canvases[0] || {
            left: 0,
            top: 0,
            width: window.innerWidth,
            height: window.innerHeight
          };
          window.__idfOutletClick = {
            x: event.clientX,
            y: event.clientY,
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
            url: window.location.href
          };
          document.removeEventListener('click', window.__idfOutletHandler, true);
        };
        document.addEventListener('click', window.__idfOutletHandler, true);
        """
    )


def wait_for_google_click(driver: webdriver.Chrome, timeout_seconds: int = 600) -> dict:
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        click = driver.execute_script("return window.__idfOutletClick || null;")
        if click:
            return click
        time.sleep(0.2)
    raise TimeoutException("No Google Maps click was detected within 10 minutes.")


def select_outlet(driver: webdriver.Chrome, args: argparse.Namespace) -> tuple[float, float]:
    fallback = (args.latitude, args.longitude, args.zoom)
    maps_url = (
        f"https://www.google.com/maps/@{args.latitude:.6f},"
        f"{args.longitude:.6f},{args.zoom:g}z"
    )
    driver.get(maps_url)
    print("\n1. Google Maps is open.")
    print("2. Accept any Google notice, search, pan and zoom to your watershed.")
    input("3. When the map is ready, return here and press Enter to arm the outlet picker... ")

    while True:
        arm_google_click(driver)
        print("\nClick ONCE on the intended river outlet in Google Maps.")
        click = wait_for_google_click(driver)
        latitude, longitude = clicked_coordinate(click, fallback)
        print(f"Selected outlet: {latitude:.6f}, {longitude:.6f}")
        south, north, west, east = PAKISTAN_EXTENT
        if not (south <= latitude <= north and west <= longitude <= east):
            print("Warning: this point is outside the Pakistan map extent.")
        answer = input("Use this outlet? [Y/n]: ").strip().lower()
        if answer in {"", "y", "yes"}:
            return latitude, longitude
        print("Re-arming the Google Maps picker.")


def click_control(driver: webdriver.Chrome, element_id: str, wait: WebDriverWait) -> None:
    element = wait.until(EC.presence_of_element_located((By.ID, element_id)))
    driver.execute_script(
        "arguments[0].scrollIntoView({block: 'center', behavior: 'instant'});", element
    )
    wait.until(EC.element_to_be_clickable((By.ID, element_id)))
    driver.execute_script("arguments[0].click();", element)


def fill_input(driver: webdriver.Chrome, element_id: str, value: float, wait: WebDriverWait) -> None:
    field = wait.until(EC.element_to_be_clickable((By.ID, element_id)))
    field.send_keys(Keys.CONTROL, "a")
    field.send_keys(f"{value:.6f}")
    field.send_keys(Keys.TAB)


def run_dashboard(
    driver: webdriver.Chrome,
    dashboard_url: str,
    latitude: float,
    longitude: float,
) -> None:
    driver.get(dashboard_url)
    print("\nOpening the Pakistan IDF Atlas...")
    print("If ChatGPT asks you to sign in, complete the sign-in in Chrome once.")
    wait = WebDriverWait(driver, 600)
    click_control(driver, "tc-mode-kirpich", wait)
    click_control(driver, "flow-geometry-mghydro", wait)
    fill_input(driver, "watershed-outlet-latitude", latitude, wait)
    fill_input(driver, "watershed-outlet-longitude", longitude, wait)
    click_control(driver, "calculate-mghydro", wait)
    print("Coordinates transferred. MGHydro calculation started.")

    status = wait.until(EC.presence_of_element_located((By.ID, "watershed-geometry-status")))
    try:
        WebDriverWait(driver, 180).until(
            lambda _: any(
                phrase in status.text.lower()
                for phrase in ("automatic geometry complete", "failed", "error", "unavailable")
            )
        )
    except TimeoutException:
        print("The calculation is still running; keep the dashboard open to finish.")
    print(f"Dashboard status: {status.text}")


def main() -> int:
    args = parse_arguments()
    profile_dir = Path(__file__).resolve().parent / ".chrome-profile"
    options = webdriver.ChromeOptions()
    options.add_argument("--start-maximized")
    options.add_argument(f"--user-data-dir={profile_dir}")
    options.add_experimental_option("excludeSwitches", ["enable-automation"])

    driver: webdriver.Chrome | None = None
    try:
        driver = webdriver.Chrome(options=options)
        latitude, longitude = select_outlet(driver, args)
        run_dashboard(driver, args.dashboard, latitude, longitude)
        if args.keep_open:
            input("\nPress Enter when you want to close the automated Chrome window... ")
        return 0
    except (TimeoutException, WebDriverException) as error:
        print(f"\nAutomation stopped: {error}", file=sys.stderr)
        print("Close other automated Chrome windows, then run the tool again.", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("\nCancelled by user.")
        return 130
    finally:
        if driver is not None:
            driver.quit()


if __name__ == "__main__":
    raise SystemExit(main())
