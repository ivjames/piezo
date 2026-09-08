# piezo

A board for designing game sound cues by prompt: you describe a sound, Claude
writes a Web Audio program for it, the page runs it, measures it offline, and
you keep the ones that work. Cues save to `library/`, group into named
playlists in `playlists/`, and leave as a zip of WAVs or a drop-in ES module —
per playlist, or for the whole library.

Platform conventions — branch, PR, Codex review, merging is not deploying —
are in `.claude/rules/lab980-conventions.md`, which is generated from
`ivjames/lab980.com` and overwritten by every sweep. Don't edit it here. What
follows is what's true of *this* site only.

## Shape

An **app** site: nginx on `piezo.lab980.com` proxies to a pm2-managed Node
process on `127.0.0.1:8073`, checkout at `/var/www/piezo`, pm2 fork mode,
process registered as `piezo`. `DEPLOY.md` is the runbook; `bin/piezo` is the
operate CLI. No build step — `deploy` skips it, because there is no `build`
script to run.

## Generating on the droplet

`/var/www/piezo/.env` holds the `ANTHROPIC_API_KEY`, so the deployed board
generates and refines like the local one. `/api/health` reports whether a key
is loaded, and the page disables its generate and refine buttons when it isn't.

`server.mjs` reads `.env` once, at startup. A key added to that file after the
process is running is invisible to it until `piezo restart` — which is what
"I added the key and it still says there isn't one" means every time.

## Secrets

`ivjames/piezo` is **public**. The key lives in `.env` — on your machine
locally, and in `/var/www/piezo/.env` on the droplet, which is gitignored and
edited on the box by hand. Only `.env.example`, with a placeholder, is in git.
No key in any file, log line, test fixture, README example or commit message.
Check `git status` before every commit. If a key ever lands in a commit, stop
and say so — do not try to rewrite published history.

## Working on it locally

```
npm install
cp .env.example .env      # then put a key in it
npm start                 # http://127.0.0.1:8971
npm test                  # headless Chromium; measures every cue
npm run measure           # same, and writes measurements back into library/
npm run seed              # rewrite the seeded PC-speaker cues
npm run bakeoff -- --dry-run   # compare models head to head (costs money without --dry-run)
```

`npm test` must pass before you push. Nobody working on this repo can hear the
cues, so measurement is the only check there is: see the README's "Verifying"
section for what it asserts and why. `npm test` needs a Chromium that Playwright
can find; Playwright is a devDependency, which matters at deploy time (see
`DEPLOY.md`).

## Playlists

`playlists/<id>.json` is a name and a list of cue ids. The reference points
that way on purpose: a cue can be in several sets at once, and adding one to a
set writes the set's file rather than the cue's. Tracked in git like
`library/`, and subject to the same thing on the droplet — a deploy re-syncs
the checkout, so a playlist made on the hosted board arrives in the repo by PR
or not at all.

Deleting a cue prunes it from every playlist holding it (`Playlists.forget`);
that is the only dangling reference this shape can produce, so it is handled
where it happens rather than tolerated at read time.

`docs/CONTRACT.md` says nothing about playlists, correctly — they are not part
of the cue, so the contract and the system prompt in `lib/agent.mjs` do not
move when a playlist does.

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
