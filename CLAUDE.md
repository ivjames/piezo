# piezo

A board for designing game sound cues by prompt: you describe a sound, Claude
writes a Web Audio program for it, the page runs it, measures it offline, and
you keep the ones that work. Cues save to `library/` and export as a drop-in
ES module for a game.

Platform conventions — branch, PR, Codex review, merging is not deploying —
are in `.claude/rules/lab980-conventions.md`, which is generated from
`ivjames/lab980.com` and overwritten by every sweep. Don't edit it here. What
follows is what's true of *this* site only.

## Shape

An **app** site: nginx on `piezo.lab980.com` proxies to a pm2-managed Node
process on `127.0.0.1:8062`, checkout at `/var/www/piezo`, pm2 fork mode,
process registered as `piezo`. `DEPLOY.md` is the runbook; `bin/piezo` is the
operate CLI. No build step — `deploy` skips it, because there is no `build`
script to run.

## This site must not be open to the public

Two reasons, both structural rather than cautious:

- The server holds an `ANTHROPIC_API_KEY` and `POST /api/generate` spends it.
  An unauthenticated vhost is an open funnel into your Anthropic bill.
- The board's whole job is to execute model-written JavaScript in the visitor's
  browser. That is a fine trade for the person driving the tool and a bad one
  for a stranger who arrived from a search result.

So the vhost carries HTTP basic auth over the whole site, the way `photos`
does. `DEPLOY.md` has the exact steps; a deploy that leaves `piezo.lab980.com`
answering 200 without a credential is a broken deploy, not a working one.
`server.mjs` also binds `127.0.0.1` and refuses cross-origin API calls, but
neither of those is the boundary — nginx is.

## Secrets

`ivjames/piezo` is **public**. The key lives in `/var/www/piezo/.env` on the
droplet, which is gitignored and edited on the box by hand; only
`.env.example`, with a placeholder, is in git. No key in any file, log line,
test fixture, README example or commit message. Check `git status` before every
commit. If a key ever lands in a commit, stop and say so — do not try to
rewrite published history.

## Working on it locally

```
npm install
cp .env.example .env      # then put a key in it
npm start                 # http://127.0.0.1:8971
npm test                  # headless Chromium; measures every cue
npm run measure           # same, and writes measurements back into library/
npm run seed              # rewrite the seeded PC-speaker cues
```

`npm test` must pass before you push. Nobody working on this repo can hear the
cues, so measurement is the only check there is: see the README's "Verifying"
section for what it asserts and why. `npm test` needs a Chromium that Playwright
can find; Playwright is a devDependency, which matters at deploy time (see
`DEPLOY.md`).

## The cue contract

`docs/CONTRACT.md` defines what a cue is — the body of
`(ctx, t0, out, p) => endTime` — and the same text is most of the system prompt
in `lib/agent.mjs`. They must not drift: change both, or neither.

## One local rule that isn't in the platform file

**Don't wait on a review that isn't coming.** Codex reviews within about four
minutes of a PR opening, or it isn't going to. Five minutes with nothing on the
PR means merge. Polling past that is waiting for nothing. The same holds for
anything you're watching on Jimmy's behalf: when the thing hasn't arrived in the
window it arrives in, act and say so — never come back forty minutes later with
"still nothing".
