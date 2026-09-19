# Contributing

Bug reports are the most useful thing you can send, especially ones with real file names in
them: almost every wrong match comes down to a name nobody anticipated.

## Getting it running

```bash
npm run setup       # installs server and client dependencies
npm run dev:server  # http://127.0.0.1:4100
npm run dev:client  # http://localhost:5180
npm start           # the desktop app instead
```

Node 24 or newer. Shelf uses the built-in `node:sqlite`, so there is no native module to
build and nothing to compile.

## Before a pull request

```bash
npm --prefix server test
npm run build:client
```

Tests run against throwaway folders and a throwaway database; they never touch a real
library. If you change how files are identified, add a case to `server/test/parse.test.mjs`
with the name that broke — those tests are a record of real-world names, and they are the
reason the organizer can be trusted with someone's library.

## What Shelf is

One job, done carefully: the films and series on your own disk.

- **No account, no server, no telemetry.** The API listens on localhost only.
- **Files are never touched without a preview and a confirmation**, and every batch of moves
  can be undone.
- **It works offline.** TMDB adds artwork and episode names; everything else — scanning,
  organizing, tracking, statistics — works with the network unplugged.
- **It stays small.** Posters are cached at the size they are displayed, nothing more.

Ideas that need a cloud account, a subscription, or that would move files without asking are
not a good fit, however well built.

## Style

Match the file you are editing. Comments explain *why* something is the way it is, not what
the line does; the code already says what it does.
