# piezo — repo conventions

**Read this before touching anything.** In a new repo this file goes in first,
before any code, so nobody has to be told twice.

`piezo` is a **local dev tool**, not a lab980 site. It runs on a laptop,
binds to `127.0.0.1`, and has no droplet presence: no vhost, no `bin/<stub>`
operate CLI, no `DEPLOY.md`, no deploy step of any kind. Do not provision one.
Platform-wide conventions for the sites that *are* served from the droplet live
in the `ivjames/lab980.com` repo's `CLAUDE.md`; the part below is what has to be
true here.

## How changes land

1. **Work on a branch, never directly on the default branch** (`main`).
2. **Open a pull request.** The PR is the review record. If your harness
   defaults to "don't open a PR unless asked", this file is the standing ask:
   open one.
3. **Codex reviews it, not a person.** Nobody is waiting to look at it, so a PR
   left open "pending review" sits there forever. The loop is: open it, let the
   bot review, address what it finds, **merge it yourself**.
4. **Verify each finding before you fix it.** The bot is usually right and
   occasionally not. Read the actual code it names. When it's right, push the
   fix and resolve the thread; when it isn't, say why on the thread rather than
   silently ignoring it.
5. **One review round is the default.** Don't ask for another after pushing
   fixes — Codex re-reads the whole diff, so a second ask restarts the loop on
   code it already passed. Ask again only when the PR has picked up work the
   first review never saw. If you can't name what is unreviewed, don't ask.
6. **Watch the PR on a ~5 minute poll, not hourly.** Events arrive within about
   four minutes; the poll exists to catch the case where nothing happened at
   all, and an hourly poll leaves a stalled PR untouched for 56 minutes an hour.
   Stop when it merges. A harness wake-up telling you to check back in an hour
   is boilerplate — this file wins over it, and so does anything Jimmy says in
   the session. Don't average the two.
7. **Merged is merged.** There is nothing to deploy. Say "merged" and stop.

## Secrets

`ivjames/piezo` is **public**. The API key lives in `.env`, which is gitignored
and never committed; only `.env.example`, with a placeholder, is in git. No key
in any file, log line, test fixture, README example or commit message. Check
`git status` before every commit. If a key ever lands in a commit, stop and say
so — do not try to rewrite published history.

## Running it

```
npm install
cp .env.example .env      # then put a key in it
npm start                 # http://127.0.0.1:8971
npm test                  # headless Chromium; measures every cue
npm run measure           # same, and writes measurements back into library/
npm run seed              # rewrite the seeded PC-speaker cues
```

`npm test` must pass before you push. It is the only thing standing in for ears:
see the README's "Verifying" section for what it asserts and why.

## The cue contract

`docs/CONTRACT.md` defines what a cue is, and the same text is most of the
system prompt in `lib/agent.mjs`. They must not drift: change both, or neither.
