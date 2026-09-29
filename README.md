# tco-spectate — deployable folder

Everything here is meant to be copied into a GitHub Pages repo as a folder named
`tco-spectate`, so it ends up at:

    https://jtrussell.me/tco-spectate/                     landing page
    https://jtrussell.me/tco-spectate/mobile-spectator.js  the script

## Why a loader and not the script itself

A bookmarklet carrying the whole script inline is ~32,000 characters, and
browser sync will not carry a bookmark that large to a phone — confirmed, since
other `javascript:` bookmarklets sync fine and only this one did not. A gzipped
variant got it to ~10,000 and still did not sync.

This one is **435 characters** because it only injects a `<script src>` pointing
back here. It also stops being a snapshot: redeploy the script and every
installed bookmark picks it up, with no rebuild and no re-drag.

## Contents

| file | what it is |
| --- | --- |
| `mobile-spectator.js` | the script, copied from `../mobile-spectator/` |
| `index.html` | landing page with the bookmarklet to drag |
| `bookmarklet.txt` | the same bookmarklet as raw text |
| `sync.sh` | refresh `mobile-spectator.js` and rebuild the page |
| `make-index.js` | generates `index.html` and `bookmarklet.txt` |

`sync.sh` is the only thing to run after editing the script upstream.

## Deploying

1. Copy this folder into the Pages repo as `tco-spectate/`.
2. Push. Pages serves `.js` as `application/javascript`, which matters — see
   below.
3. The `CNAME` for `jtrussell.me` belongs at the **repo root**, not in here.

## Two things that would silently break this

**Content type.** A browser refuses to run a `<script src>` served as
`text/plain` with `X-Content-Type-Options: nosniff`. That is exactly what
GitHub's raw endpoints send, so `raw.githubusercontent.com` and
`gist.githubusercontent.com` are both unusable as script hosts. Pages serves
`.js` correctly, which is why it was chosen over a gist. jsDelivr also works but
caches branch URLs for around 12 hours, which is unhelpful while iterating.

**Content-Security-Policy.** The injected script is subject to the *page's* CSP
even though the bookmarklet itself is exempt. thecrucible.online currently sends
no CSP header at all — checked directly — so a cross-origin script injection is
allowed. If that ever changes, this route stops working and the self-contained
bookmarklet in `../mobile-spectator/` becomes the fallback.

## Testing sync before deploying

The bookmarklet is 435 characters whether or not the URL resolves, so install it
and check it reaches the phone first. Until the folder is deployed it will pop
an alert naming the URL it failed to fetch — which is itself a useful signal:
the bookmark synced and ran.

Locally the same folder is served at http://localhost:4000/tco-spectate/ (see
`docker-compose.override.yml`), so the page can be opened and the link dragged
without deploying anything.
