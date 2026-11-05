<p align="center"><img src="assets/banner.png" alt="Stackmoor – Docker Compose stacks without thinking about volume paths" width="100%"></p>

# Stackmoor

A self-hosted web panel for Docker Compose stacks – in the spirit of Dockge, but you never have to think about volume paths. Every stack keeps its data in its own folder, backups include database dumps, and every app can get a local domain with a real HTTPS certificate.

**[Website](https://stackmoor.dev)** · **[Documentation](https://docs.stackmoor.dev)** · **[Releases](https://github.com/gadziunet/stackmoor/releases)** · [Polski](README.pl.md)

> **Status:** v0.6 – stacks, automatic volumes, local domains, backups and restoring a whole server from a backup work and are used on real servers. Still young software – keep your own backups too.

## Install

On a clean Debian, Ubuntu or Raspberry Pi OS machine (x86_64 or arm64):

```bash
curl -fsSL https://raw.githubusercontent.com/gadziunet/stackmoor/main/install.sh | sudo bash
```

The script installs Docker if it's missing, starts Stackmoor and prints its address, e.g. `http://192.168.1.50:5001`. On first visit you create the administrator account.

Run the same command again to update. Optional settings: `curl ... | sudo PORT=8080 STACKS_DIR=/srv/stacks bash`.

> Stackmoor has access to the Docker socket, which means full control over the machine. Keep it on your local network or behind a VPN.

## Features

- list of stacks with live status
- create a stack by pasting a `compose.yaml` (+ optional `.env`)
- editor with validation through `docker compose config` – a broken file is never saved
- Start, Restart, Update (pull + up), Stop, Shut down – with live output
- live logs, containers with ports, operation history
- deleting a stack moves its folder to `.trash/` – nothing is lost by accident
- automatic stack updates on chosen days (off by default): backup first, back to the previous images if the new ones don't start
- restart the server from the panel or on a schedule; stacks that were running start again – also those without `restart:`
- notifications by e-mail, Telegram, ntfy, Pushover or webhook – e.g. when a backup fails, a stack stops or the VPN goes down
- English and Polish interface

## Automatic volumes

You don't type host paths. Each stack lives in `/opt/stacks/<name>/` and its data in `/opt/stacks/<name>/data/`:

| In your compose | After saving |
|---|---|
| `- /config` | `- ./data/app-config:/config` |
| `- /some/host/path:/config` | `- ./data/app-config:/config` |
| `- db_data:/var/lib/mysql` | `- ./data/db_data:/var/lib/mysql` |
| nothing, but the image has `VOLUME /data` | `- ./data/app-data:/data` added on start |

Left untouched: system paths (`docker.sock`, `/dev`, `/etc/localtime`…), host paths on the allow-list in Settings (default `/mnt`, `/media` – e.g. media drives, not backed up), paths with `${VARIABLES}`, relative paths inside the stack and `external` volumes.

After saving, the panel shows exactly what it changed. Folders are created before start with owner `PUID:PGID` (default 1000:1000) so they don't end up owned by root. If an app mounts a single **file** (e.g. `nginx.conf`), the panel won't start the stack without it, because Docker would create an empty folder in its place.

Automatic volumes can be turned off per stack.

## Local domains

Give every stack an address like `cloud.home.example.com` with a real HTTPS certificate – no ports to remember, and the server does not have to be reachable from the internet.

1. **Right after installing** (or later in the **Domains** tab): enter your domain, pick your DNS provider (Cloudflare, Bunny, OVHcloud, Hetzner, DigitalOcean, Porkbun, Namecheap, GoDaddy, IONOS, netcup, Gandi, AWS Route 53, deSEC, DuckDNS) and paste its API key. Keys are stored encrypted.
2. The DNS records `home.example.com` and `*.home.example.com` → the server's local IP are **added automatically** for Cloudflare, Bunny, Hetzner, DigitalOcean, Porkbun, deSEC and DuckDNS (with other providers, add them by hand). The server's IP is detected automatically and the records are updated when it changes. Before saving, Stackmoor checks the API key and warns if the domain already points to another server.
3. **Stack → Domain:** choose a subdomain, the service and its port inside the container.
4. **Other servers (+ Proxy):** give a device or server outside Stackmoor – Proxmox, a router, a NAS – an address too: enter its IP and port (http or https, with an option to accept its own self-signed certificate). The dashboard shows whether it responds.

Stackmoor runs Caddy in its own container (`stackmoor-caddy`) with one wildcard certificate for all apps. Caddy is updated together with the panel – each release ships its own Caddy image. The DNS provider can be changed any time in Settings. On Unraid, ports 80/443 are used by its web UI – choose other ports under *Advanced*.

**The panel's own address.** Set *Address of this panel* (e.g. `stackmoor`) and the panel is also available at `https://stackmoor.home.example.com`. Once you open it there, you can turn on *Allow opening the panel only through this address* – access by IP address is then blocked and the panel only opens at its domain. If the domain ever stops working, unlock it with:

```bash
docker exec stackmoor node src/cli.js unlock
```

## Backups

**Backups** tab → **Backup settings:** choose the storage (Backblaze B2, Amazon S3, Cloudflare R2, Hetzner, Wasabi or any S3-compatible), paste the keys, set an encryption password, the days and time, and how many backups to keep.

- **One encrypted repository** ([restic](https://restic.net)) in your bucket holds all stacks and the panel's own settings. Files that did not change are not uploaded again.
- **Databases are dumped first** (PostgreSQL, MySQL/MariaDB, MongoDB; Redis is saved), while the apps keep running. The dump is backed up instead of the database's raw files. A service can set the type itself with the label `stackmoor.backup.dump: postgres|mysql|mongo|redis|none`.
- **Before every update** the stack is backed up; if the backup fails, the update does not run.
- **Checksums:** restic stores every piece of data under its SHA-256 checksum. Every run checks the repository, once a week 10% of the data is read back and compared, and *Verify everything* checks all of it.
- **Retention:** daily, weekly and monthly backups to keep; older ones are removed automatically.
- **Restore** from the stack's *Backups* tab: the current folder goes to the trash, the files come back, databases are loaded from their dumps and the stack starts. Restoring under a different name makes a copy. Backups are listed per run, and *Restore all stacks* brings back every stack of a run.
- **New server:** on a fresh install choose *Restore a server from a backup*, enter the bucket and the encryption password, pick a backup – the panel's settings, your account, domains and all stacks with their databases come back.

> Keep the encryption password safe. Without it nobody can restore the backups.

## Connect through VPN

Send chosen apps through your **WireGuard** tunnel – like a second internet connection only for them. Typical use: a web SSH client (e.g. Termix) on your home server reaching VPSes whose firewall only allows the tunnel's fixed address.

1. **Network → VPN:** add a tunnel – paste your `.conf` file.
2. **Stack → VPN:** choose the tunnel and the services that should use it.

What goes through the tunnel follows `AllowedIPs` in your file. **Kill switch is always on:** if the tunnel is down, those apps have no internet at all and the panel shows a warning. Details: [docs.stackmoor.dev/guides/vpn](https://docs.stackmoor.dev/guides/vpn/).

## Roadmap

- [x] Stacks, editor, automatic volumes, logs
- [x] Local domains through Caddy – wildcard certificate via your DNS provider's API (14 providers) or an internal CA
- [x] Cloudron-style backups – per stack, automatically before updates, database dumps, schedule, retention, encryption; restic to S3 / Backblaze B2; restore and clone
- [x] Setup wizard: fresh install or restore a whole server from a backup
- [x] Updates: check for new Stackmoor versions and new stack images (on/off in Settings), show what is new; the panel itself updates only after confirmation
- [x] Setup wizard: start with the IP address or set up the domain right away; the DNS record is added through the provider's API and the domain is checked first
- [x] Connect through VPN (WireGuard) for chosen services – e.g. reach your servers from a fixed address; kill switch always on
- [x] New look: top menu, dashboard, status bar, light and dark theme
- [x] Proxy: addresses in your domain for other servers (Proxmox, routers, NAS), with a health check
- [x] Automatic stack updates (off by default) with a backup first and rollback when the new version doesn't start; server restart from the panel and on a schedule; automatic system patches (Debian/Ubuntu)
- [x] Notifications (e-mail, Telegram, ntfy, Pushover, webhooks): failed backups, a stack that stopped, VPN or proxy down, automatic updates, restarts
- [ ] Pangolin – public addresses next to the local domain
- [ ] Unraid Community Apps template

## Development

```bash
npm install
STACKS_DIR=$HOME/stacks npm run dev   # http://localhost:5001
npm test
```

Requires Node 20+ and `docker` with the `compose` plugin. Or with Docker: `docker compose up -d --build` (set `STACKS_DIR` in `.env`).

| Variable | Default | Description |
|---|---|---|
| `PORT` | `5001` | panel port |
| `STACKS_DIR` | `/opt/stacks` | stacks folder (must be mounted at the same path in the container) |
| `DATA_DIR` | `./data` (`/app/data` in the image) | panel database (SQLite) |

```
src/
  server.js    – Express, API, sessions
  db.js        – SQLite (better-sqlite3, WAL), migrations, settings
  auth.js      – passwords (scrypt), sessions, login rate limit
  stacks.js    – stack operations, running docker compose
  compose.js   – automatic volumes (YAML rewrite that keeps comments)
  i18n.js      – server messages (en, pl)
public/        – UI (plain JS, no build step), i18n.js for UI texts
install.sh     – installer / updater
```

Translations: add a language block to `src/i18n.js` and `public/i18n.js` – tests check that every language has all keys.

## How it's made

Stackmoor is written with the help of AI – [Claude](https://claude.ai) by Anthropic. I design the features, review the changes and test every release myself on real servers (Debian and Unraid) before publishing it. The code is covered by automated tests that run on every push.

If you find a bug, please [open an issue](https://github.com/gadziunet/stackmoor/issues).

## License

[AGPL-3.0](LICENSE) © Gadziunet. You may use, modify and share Stackmoor freely; if you distribute a modified version or offer it as a network service, you must publish your changes under the same license.
