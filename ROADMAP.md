# Roadmap

What's planned for Hostdeck, roughly in the order it will be built. Plans change with feedback, so treat this as a direction, not a promise. Suggestions are welcome in [issues](https://github.com/ramiatoui/hostdeck/issues).

Guiding rules for every feature:

- **Local-first.** Nothing leaves your computer except the SSH connection itself.
- **Read before write.** Anything that changes a server (restarting a service, applying a fix) asks first and shows the exact command.
- **Few tabs.** New tools are grouped so the top level stays at five tabs: Run, Terminal, Files, Browser, Services.

## Next

### 1. Snippet library

Snippets exist today, but the list starts empty and a snippet can only fill the Run box.

- [ ] Built-in library of common commands, grouped: disk and memory, services, Docker, logs, updates, network, users.
- [ ] Edit, hide or add your own; your snippets sit next to the built-in ones.
- [ ] Two actions per snippet: **Run** (in the Run tab) and **Send to terminal** (typed into the open terminal, for interactive commands).
- [ ] Placeholders such as `journalctl -u {service} --since "{since}"`, filled in before running.
- [ ] Search snippets by name or command.

### 2. Services tab

A new top-level tab showing what is running on the server.

- [ ] systemd services with state (running, failed, stopped, disabled); failed services listed first.
- [ ] Docker containers, when Docker is installed: image, status, ports, uptime.
- [ ] Actions per row: Start, Stop, Restart, View logs. Each asks before running and shows the command.
- [ ] Sudo support: use passwordless sudo when available (default on most cloud images), otherwise ask for the sudo password once per connection and keep it in memory only.
- [ ] The same sudo support enables **saving files that need root** from the editor (for example `/etc/nginx/sites-available/*`), keeping the file's owner and permissions.

### 3. Log search across sources

Lives in the Services tab, next to the service list.

- [ ] One search box over many log sources at once: nginx access and error logs, syslog, auth.log, the systemd journal (all or per unit) and Docker container logs.
- [ ] Sources found automatically on the server; pick which ones to include.
- [ ] Time range: last 15 minutes, last hour, today, custom.
- [ ] Results grouped by source, newest first, with matches highlighted and a few lines of context.
- [ ] Plain text or regular expression; case sensitive or not.
- [ ] Later: run the same search across a whole group of servers (see multi-server commands).

### 4. Security check

A read-only report inspired by the CIS Benchmarks, without copying them and without changing anything on its own.

- [ ] About 20 high-impact checks, for example:
  - SSH: root login, password authentication, protocol and key settings
  - Firewall active (ufw, firewalld or nftables)
  - Pending security updates and automatic updates enabled
  - fail2ban or an equivalent running
  - Services listening on public interfaces
  - Users with passwordless sudo, accounts without passwords
  - World-writable files in system folders
- [ ] Each check shows pass or warning, why it matters, and the command to fix it, to copy or send to the terminal.
- [ ] Warnings for fixes that can lock you out (for example turning off password login while you connect with a password).
- [ ] If [Lynis](https://cisofy.com/lynis/) is installed on the server, offer to run it and show its hardening index and warnings.

## Later

- [ ] **Run a command on several servers**: pick servers or a whole group, run once, see each server's output and exit code side by side.
- [ ] **Automatic updates** from GitHub Releases (Windows and Linux AppImage first; macOS needs code signing).
- [ ] **Port forwarding for desktop tools**: expose a server-only port, such as PostgreSQL on 5432, on your computer for DBeaver, TablePlus or a Redis client.
- [ ] **Several terminals per server**, as tabs.
- [ ] **Reopen where you left off**: last server and tab, open terminals reconnect on request.
- [ ] **Scheduled commands**: run a snippet every few minutes or hours while the app is open, with a history of results and a notification on failure.
- [ ] Health settings: turn the header stats off or change the refresh interval.

## Quality and distribution

- [ ] Automated UI checks in CI: launch the app, click through each tab, catch layout problems before a release.
- [ ] Code signing for macOS (Developer ID, notarization) and Windows, to remove first-launch warnings.
- [ ] Translations.

## Shipped

| Version | Highlights |
| --- | --- |
| 0.3.0 | Server health in the header: disk, memory, load, uptime |
| 0.2.1 | Server group shown next to the name |
| 0.2.0 | Browser tab that loads pages through the server; file search in the folder and all subfolders |
| 0.1.2 | Scrolling fixes in Files, editor and Run; keyboard navigation in the file list |
| 0.1.1 | Linux icons at all standard sizes |
| 0.1.0 | First release: saved servers, Run, Terminal, Files with editor, host key checks, SSH config import |
