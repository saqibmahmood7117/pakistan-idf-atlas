PAKISTAN IDF ATLAS - GOOGLE MAPS SELENIUM AUTOMATION
====================================================

WHAT IT DOES
1. Opens Google Maps at the default outlet near Saidu Sharif/Swat.
2. Lets you search, zoom and pan normally.
3. Captures the river outlet you click.
4. Opens the Pakistan IDF Atlas.
5. Selects Calculate with Kirpich > MGHydro automatic.
6. Fills latitude and longitude.
7. Starts the longest-flow-path and slope calculation automatically.

FIRST-TIME REQUIREMENTS
- Windows 10 or 11
- Google Chrome
- Python 3.10 or newer
- Internet connection

SIMPLE EXECUTION
1. Extract the downloaded ZIP file.
2. Double-click START_GOOGLE_MAPS_AUTOMATION.bat.
3. On the first run, wait while Selenium is installed automatically.
4. In Google Maps, accept any notice and move to your study area.
5. Return to the black command window and press Enter.
6. Click once on the intended river outlet in Google Maps.
7. Confirm the displayed coordinates by pressing Enter.
8. The Atlas opens and starts MGHydro automatically.

IMPORTANT
- Keep the command window open while the automation runs.
- The first Atlas visit may ask you to sign in to ChatGPT. Complete it once;
  the included Selenium profile remembers that sign-in for later runs.
- Google Maps page structure can change. If a click is incorrect, answer N and
  select the outlet again.
- MGHydro snaps the selected point to its mapped river network. Always review
  the returned watershed and flow path before design use.

ADVANCED COMMAND
python run_google_maps_idf.py --latitude 34.64737 --longitude 72.03598 --zoom 12
