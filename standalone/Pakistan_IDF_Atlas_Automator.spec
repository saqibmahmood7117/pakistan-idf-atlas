# -*- mode: python ; coding: utf-8 -*-

from PyInstaller.utils.hooks import collect_all, copy_metadata

selenium_data, selenium_binaries, selenium_hiddenimports = collect_all("selenium")
selenium_data += copy_metadata("selenium")

a = Analysis(
    ["Pakistan_IDF_Atlas_Automator.pyw"],
    pathex=["."],
    binaries=selenium_binaries,
    datas=selenium_data,
    hiddenimports=selenium_hiddenimports + [
        "selenium.webdriver.chrome.webdriver",
        "selenium.webdriver.common.selenium_manager",
        "openpyxl",
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="Pakistan_IDF_Atlas_Automator",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
