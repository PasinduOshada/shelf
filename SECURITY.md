# Security

Shelf runs entirely on your own machine. Its API listens on `127.0.0.1` only, refuses
requests that arrive with another site's `Origin`, and the window it renders has no access to
Node. Your library never leaves the computer; TMDB and OpenSubtitles see only the title being
looked up, and only if you have added a key.

## Reporting something

If you find a way to reach Shelf's API from a web page, escape the renderer, or make the
organizer move a file that was not approved, please report it privately: use
**[GitHub's private vulnerability reporting](https://github.com/PasinduOshada/shelf/security/advisories/new)**
rather than a public issue.

Include what you did and what happened. A proof of concept helps but is not required.

Shelf is one person's side project given away for free, so there is no bounty, and a fix may
take a few days. Credit in the release notes if you would like it.

## What is stored, and where

| What | Where |
|---|---|
| Library index, watch history, settings | `%APPDATA%\Shelf\shelf.db` |
| Cached artwork | `%APPDATA%\Shelf\cache\images\` |
| Posters you uploaded | `%APPDATA%\Shelf\uploads\` |

API keys and sign-in tokens are encrypted with Windows' own DPAPI, tied to your user account,
so a copy of the database on its own does not give them up.
