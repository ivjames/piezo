# Deploying piezo

Target: **https://piezo.lab980.com** — served from the lab980 droplet (conventions in
the `ivjames/lab980.com` repo's `CLAUDE.md`).

Shape: nginx proxies to a pm2-managed Node process on `127.0.0.1:8073`,
with the app dir at `/var/www/piezo`.

## One-time bring-up (on the droplet, as root)

```bash
provision-site piezo ivjames/piezo --port 8073
cd /var/www/piezo
$EDITOR .env                         # provision-site seeded PORT; add the rest
ln -sf /var/www/piezo/bin/piezo /usr/local/bin/piezo
piezo deploy                      # npm ci, build, first pm2 start, probe, save
```

`provision-site` stops before build/run on purpose — each site is deployed its
own way afterward. Here that way is `piezo deploy`: it sees that nothing
named `piezo` is registered with pm2 and runs the `pm2 start` in
`START_CMD` at the top of `bin/piezo`. That argv is set in the repo, not on
the droplet (a tracked-file edit there is wiped by the next deploy), and
`deploy` refuses a first start while it is still the `<entrypoint>`
placeholder.

Every pm2 call the CLI makes runs from a scrubbed environment: `env -i` plus
`PATH`, `HOME`, `LANG`, `PM2_HOME` and `TERM` if set, and `PORT` (`8073`).
pm2 copies the environment of the `pm2 start` call into the process and into
`~/.pm2/dump.pm2`, so anything the calling shell holds would live on there.
So the process gets `PORT` from the CLI and everything else from `.env` itself
(dotenv, or an ecosystem file that loads it) — nothing arrives from the shell
that ran `deploy`, and there is no box-level key store to copy from: `.env`
in the app dir is the only copy of any key this app uses. `pm2 save` runs only after the probe
passes and only when every registered pm2 process is `online` (the box rule),
otherwise it warns and leaves the previous dump alone.

Two details in that first line matter more than they look:

- **`--port 8073` is not optional.** Without it `provision-site` picks the
  next free port from 8060 and writes *that* into the vhost, while this repo's
  CLI, `.env` and app config all use `8073`. nginx then proxies to a port
  nothing is listening on and every request is a 502 that looks like the app is
  down while it runs perfectly on the wrong port.
- **`provision-site` seeds `.env` with `PORT=` itself** (only if there isn't one
  already, mode 600). Add the remaining keys to that file — don't `cp` over it,
  or the port goes back out of sync.

Reboot survival needs the pm2 boot hook installed **once per droplet**
(`pm2 startup systemd -u root --hp /root`, then run the line it prints; verify
`systemctl is-enabled pm2-root` → enabled). `pm2 save` alone only writes the
dump — nothing replays it at boot without the hook.

### `.env` keys

| key | what it is |
|---|---|
| `PORT` | `8073` — must match the vhost's `proxy_pass`. `provision-site` seeds this; leave it alone. |
| `HOST` | `127.0.0.1`. The default already, and it must stay loopback: nginx is the only thing that should reach the app. |
| `ANTHROPIC_API_KEY` | the key `POST /api/generate` spends. **This file is the only copy on the box.** Without it the board still plays, measures, normalises and exports the saved library — only generation is disabled — so deploying with the key absent is a valid, and safer, state. |
| `SOUNDBOARD_MODEL` | optional; defaults to `claude-opus-5`. Only set it to pin a different model deliberately. |

### Lock the vhost — do this before the first deploy

`provision-site` writes an open vhost, and an open `piezo` is a stranger
spending your Anthropic key and running model-written JavaScript in their
browser. Basic auth over the whole site, the way `photos` does it:

```bash
# once per droplet, if it isn't there already
apt-get install -y apache2-utils

htpasswd -c /etc/nginx/.htpasswd-piezo jimmy      # prompts for a password
chmod 640 /etc/nginx/.htpasswd-piezo
chown root:www-data /etc/nginx/.htpasswd-piezo
```

Then in the `:443` server block of `/etc/nginx/sites-available/piezo.lab980.com`,
inside the `location /` that proxies to `127.0.0.1:8073`:

```nginx
auth_basic           "piezo";
auth_basic_user_file /etc/nginx/.htpasswd-piezo;
```

```bash
nginx -t && systemctl reload nginx
curl -s -o /dev/null -w '%{http_code}\n' https://piezo.lab980.com/    # expect 401
curl -s -o /dev/null -w '%{http_code}\n' -u jimmy:<pass> https://piezo.lab980.com/  # expect 200
```

A `200` on that first curl means the site is open — treat it as a failed
deploy and fix it before walking away. `health-check` reads the `401` as a
warning, which is expected here and is what `install-landing piezo.lab980.com`
is for if you want a public front door (it sets `auth_basic off` inside an
exact `location = /` and leaves everything behind it locked).

### Playwright at deploy time

`piezo deploy` runs `npm ci`, which installs devDependencies — and Playwright's
postinstall downloads a Chromium (~150 MB) the droplet has no use for, on every
deploy, because `npm ci` wipes `node_modules` first. Skip it:

```bash
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 piezo deploy
```

The CLI scrubs the environment for its `pm2` calls only, so that variable does
reach `npm ci`. The test harness is not meant to run on the droplet; `npm test`
belongs on the machine you develop on.

## Deploying updates

Land changes on `main` (via a PR — see `CLAUDE.md`), then on the droplet:

```bash
piezo deploy        # sync, npm ci, build, pm2 restart, probe, save
```

`deploy` exits non-zero when nothing answers HTTP on `127.0.0.1:8073`
afterwards (any status code counts as answering — an API-only app 404s on `/`;
up to `PIEZO_PROBE_TRIES`, default 10, tries a second apart) — a dead app
is a failed deploy, not a warning to read past, and nothing is saved. The
public probe is printed alongside but does not decide the result, because it
also depends on DNS and TLS.

**How `deploy` syncs, since the conventions file sends you here for it:**
`git fetch` then `git reset --hard origin/<branch>`. A tracked file edited on
the droplet is destroyed silently on the next deploy — fix it in the repo. The
gitignored state is the exception and survives: `.env` and `data/` are meant to
be edited on the box.

## Check it

```bash
piezo status              # HEAD, pm2 state, local + public probe, cert
piezo logs                # tail pm2 logs for this app
health-check --site piezo # the droplet-wide auditor
```

## Overrides

- `PIEZO_FQDN` — default `piezo.lab980.com`
- `PIEZO_BRANCH` — default `main`
- `PIEZO_PORT` — default `8073`
- `PIEZO_PROBE_TRIES` — default `10`
