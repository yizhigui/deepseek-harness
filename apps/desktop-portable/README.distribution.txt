DeepSeek Harness Desktop — Windows x64
=====================================

This package contains its own runtime. You do NOT need Node.js, npm, pnpm, Git, Python,
PowerShell 7, WSL, or a source checkout to install and use it.


INSTALL (recommended)
---------------------

1. Run:  DeepSeek-Harness-Setup-0.1.5-rc.2.exe
2. Follow the installer, then start "DeepSeek Harness" from the desktop shortcut or the
   Start menu.
3. On first launch, enter your own DeepSeek API key in the model setup screen.

PORTABLE (optional)
-------------------

DeepSeek-Harness-0.1.5-rc.2-portable.exe runs without installing anything. It extracts its
application files before launching, so its first start takes noticeably longer than the
installed edition.


YOUR DATA IS YOURS
------------------

No API key, credential, setting, or session is included in this package. On first launch the
application shows a setup screen and asks for your API key.

Harness user data (credentials, sessions, settings) is stored under:

    %USERPROFILE%\.dsh

Uninstalling the application does not delete that directory, so your configuration and
sessions survive an uninstall.


WINDOWS SECURITY NOTICE (please read)
-------------------------------------

This is an UNSIGNED build. It has no publisher signature, so Windows may warn you:

  * "Windows protected your PC"
  * "Unknown Publisher"
  * A blue SmartScreen dialog

These warnings mean Windows does not recognize the publisher. They do NOT mean the file is
damaged or unsafe by themselves.

If you trust where you received this file, you can continue:

    Click "More info", then click "Run anyway".

Please do NOT disable Windows Defender or any other security protection in order to run it.

You can also verify the download is intact. Compare the SHA-256 hash of the file you received
with the matching line in SHA256SUMS.txt:

    PowerShell:
      Get-FileHash .\DeepSeek-Harness-Setup-0.1.5-rc.2.exe -Algorithm SHA256

The two hashes must match exactly. If they do not, do not run the file and obtain a fresh copy
from the same source.


UNINSTALL
---------

Open Windows Settings, choose Apps, choose Installed apps, find "DeepSeek Harness", and
choose Uninstall. Your data under %USERPROFILE%\.dsh is kept, as described above.
