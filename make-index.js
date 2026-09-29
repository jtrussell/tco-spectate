/*
 * Builds index.html and bookmarklet.txt for the deployed folder.
 *
 *   node make-index.js <folder>
 *
 * The bookmarklet is a loader: a few hundred characters that inject
 * mobile-spectator.js from this same origin. That size is the entire point --
 * a bookmarklet carrying the script inline runs to 32k characters and browser
 * sync will not carry a bookmark that large to a phone. Being a link rather
 * than a snapshot, it also picks up every redeploy without being rebuilt.
 */

const fs = require('fs');
const path = require('path');

const folder = process.argv[2];

if (!folder) {
    console.error('usage: node make-index.js <folder>');
    process.exit(2);
}

// Absolute so the bookmarklet works from any page on thecrucible.online, not
// just one whose path happens to line up.
const BASE = 'https://jtrussell.me/tco-spectate';
const SCRIPT_URL = `${BASE}/mobile-spectator.js`;

const loader =
    `(function(){` +
    `try{localStorage.setItem("keyteki-mobile-spectator",JSON.stringify({open:true}))}catch(e){}` +
    `var s=document.createElement("script");` +
    `s.src=${JSON.stringify(SCRIPT_URL)}+"?t="+Date.now();` +
    `s.onerror=function(){alert("TCO spectate: could not load "+s.src)};` +
    `document.documentElement.appendChild(s);})()`;

const bookmarklet = 'javascript:' + encodeURIComponent(loader);

fs.writeFileSync(path.join(folder, 'bookmarklet.txt'), bookmarklet);

// encodeURIComponent has already escaped & " < >, so this is attribute-safe.
const page = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>TCO Spectate</title>
<style>
  body {
    font: 15px/1.6 system-ui, -apple-system, sans-serif;
    max-width: 40rem; margin: 3rem auto; padding: 0 1.25rem;
    background: #0f1116; color: #e7e3d6;
  }
  h1 { font-size: 1.35rem; margin-bottom: .2rem; }
  h2 { font-size: 1rem; margin-top: 2rem; }
  p.sub { opacity: .75; margin-top: 0; }
  a.bm {
    display: inline-block; padding: .75rem 1.15rem; border-radius: 8px;
    background: #d9a33a; color: #1a1205; font-weight: 700; text-decoration: none;
  }
  button {
    font: inherit; padding: .6rem 1rem; border-radius: 8px;
    border: 1px solid #3a4054; background: #1b2030; color: #e7e3d6;
  }
  code { background: #1b2030; padding: .1rem .3rem; border-radius: 4px; font-size: .9em; }
  li { margin: .45rem 0; }
  .note { opacity: .72; font-size: .92rem; }
</style>

<h1>TCO Spectate</h1>
<p class="sub">A phone-shaped spectator view for The Crucible Online.</p>

<p><strong>Drag this onto your bookmarks bar:</strong></p>
<p><a class="bm" href="${bookmarklet}">TCO Spectate</a></p>
<p>
  <button id="copy">Copy the URL instead</button>
  <span id="status" class="note"></span>
</p>
<p class="note">
  ${bookmarklet.length} characters. It loads the script from this site rather
  than carrying it, which is what keeps it small enough for bookmark sync and
  means it picks up updates on its own.
</p>

<h2>On the phone</h2>
<ol>
  <li>Let bookmark sync carry it across.</li>
  <li><strong>iOS Safari</strong> &mdash; add it to Favourites, then tap it while
      on the game page.</li>
  <li><strong>Android Chrome</strong> &mdash; type the bookmark name in the
      address bar and tap the suggestion. Tapping it in the bookmarks list will
      not run it.</li>
</ol>
<p class="note">
  It opens the view straight away. If nothing happens you will get an alert
  naming the URL it failed to fetch.
</p>

<h2>What it does</h2>
<ul>
  <li>Both battlelines get the whole screen, each scrolling horizontally on its own.</li>
  <li>Status strips stay fixed, so the numbers you are tracking do not move.</li>
  <li>Swipe in from the left for the game log, from the right for the piles.</li>
  <li>Tap a card for its full image.</li>
</ul>
<p class="note">It only ever reads the game; it cannot affect play.</p>

<script>
  document.getElementById('copy').onclick = async () => {
    const status = document.getElementById('status');
    try {
      await navigator.clipboard.writeText(document.querySelector('a.bm').href);
      status.textContent = 'copied';
    } catch {
      status.textContent = 'copy blocked \\u2014 drag the link instead';
    }
  };
</script>
`;

fs.writeFileSync(path.join(folder, 'index.html'), page);

console.log(`wrote index.html and bookmarklet.txt (${bookmarklet.length} chars)`);
console.log(`  script URL: ${SCRIPT_URL}`);
