Hostdeck is a local-first SSH server manager for Linux, Windows and macOS.

## Changes in 0.4.0

- Lock Hostdeck with a PIN (Settings → App lock). It locks at start, after a chosen idle time and when the computer sleeps; lock it any time with the lock button or Ctrl+Shift+L. Running connections and terminals keep going while it is locked. A forgotten PIN can be removed, which also deletes all saved secrets.
- Saved browser passwords: after you sign in to a page in the Browser tab, Hostdeck offers to save the login. The key button next to the address bar fills it in, and a single saved login is filled automatically. Stored encrypted with the system keyring, per server and site.
- Browser focus mode (expand button or Ctrl+Shift+F) hides the server list, header and tabs so the page fills the window; F11 toggles full screen.
- Fixed: zoom shortcuts. Ctrl + / Ctrl - / Ctrl 0 (also on the numpad) zoom the page when it has focus, otherwise the whole app, and the app zoom is remembered.

## Changes in 0.3.0

- Server health in the header while connected: disk, memory, load and uptime, refreshed about every 30 seconds. Disk and memory turn amber at 80% and red at 90%; hover for details, click to refresh.

## Changes in 0.2.1

- The server header shows the server's group next to its name.

## Changes in 0.2.0

- New Browser tab: open web pages through the server's SSH connection. `localhost:8080` is the server's own localhost, so admin tools that are not open to the internet, like phpMyAdmin or pgAdmin, work directly. The start page lists the server's listening web ports. Separate cookies per server, self-signed certificate prompt, HTTP sign-in and downloads supported.
- File search: filter the current folder as you type (Ctrl+F), or search every folder below it on the server.

## Changes in 0.1.2

- Fixed: the file list, the file editor and long command output could not be scrolled.
- The file list works from the keyboard: arrow keys, Enter to open, Backspace for the parent folder, Home/End/Page Up/Page Down, type a letter to jump, F2 to rename, Delete to delete.

## Changes in 0.1.1

- Linux: the app icon now shows in the applications menu, dock and taskbar after installing the .deb or running the AppImage.

## Download

| System | File |
| --- | --- |
| Linux (any distribution) | `Hostdeck-*-linux-x86_64.AppImage` (Intel/AMD) or `-arm64.AppImage` |
| Ubuntu / Debian | `Hostdeck-*-linux-amd64.deb` or `-arm64.deb` |
| Windows 10 / 11 | `Hostdeck-*-win-setup.exe` (installer) or `Hostdeck-*-win-portable.exe` |
| macOS 12+ (Apple silicon and Intel) | `Hostdeck-*-mac-universal.dmg` |

These builds are not code-signed yet. Windows may show “Windows protected your PC” (choose More info, then Run anyway), and on macOS Control-click the app and choose Open the first time. See the [install guide](https://ramiatoui.com/hostdeck/docs/#install). `SHA256SUMS.txt` lists checksums for every file.

## Features

- Save servers in groups; run commands and read output, errors, exit code and duration
- Keep a connection open for more commands, or let it close after each run
- Interactive terminal for longer sessions
- Browser that loads pages through the server, for admin tools bound to localhost or a private network
- File browser over SFTP: upload (including drag and drop), download, edit with syntax highlighting, rename, permissions, delete
- Sign in with a password, a key file or pasted key, the SSH agent or Pageant, or 2FA prompts; jump hosts and legacy algorithms supported
- Host key verification, import from `~/.ssh/config`, export without secrets
- Everything stored locally, secrets encrypted with your OS keychain, no telemetry

Documentation: https://ramiatoui.com/hostdeck/docs/
