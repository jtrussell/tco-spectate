// ==UserScript==
// @name         KeyForge Mobile Spectator
// @namespace    keyteki-experiments
// @version      0.1.0
// @description  A spectator view for The Crucible Online built for a phone: the battlelines get the screen, everything else lives in drawers you swipe in.
// @author       jtrussell
// @match        https://thecrucible.online/*
// @match        https://*.thecrucible.online/*
// @match        http://localhost:4000/*
// @match        http://127.0.0.1:4000/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/*
 * Watching a game on a phone.
 *
 * The real gameboard is laid out for a desktop and shrinks everything to fit a
 * phone, which is how you end up unable to read any of it. This does the
 * opposite: it decides the two battlelines are the only things that need to be
 * on screen, gives them the whole viewport, and puts everything else -- log,
 * piles, game info -- behind drawers you swipe in from the edges.
 *
 * Design rules it follows:
 *
 *   - Each battleline scrolls horizontally on its own. The status strips never
 *     move, so the numbers you are tracking stay put while you scan a row.
 *   - Drawers open only from an edge swipe. A swipe that starts on a card is a
 *     scroll, always; otherwise the two gestures fight and neither works.
 *   - Cards are drawn from the half-size art the site already generates (~18KB
 *     against ~267KB for a full card), with the state a spectator cares about
 *     overlaid. Tap for the full card.
 *
 * It reads the game out of the page's redux store, exactly as the ASCII
 * spectator does, and never writes anything.
 */

(function () {
    'use strict';

    const STORAGE_KEY = 'keyteki-mobile-spectator';

    // A swipe has to start this close to the edge to count as a drawer pull.
    const EDGE_ZONE_PX = 28;
    // ...and travel this far before it opens.
    const DRAWER_OPEN_PX = 60;

    const HOUSE_ABBREV = {
        brobnar: 'BRO',
        dis: 'DIS',
        ekwidon: 'EKW',
        geistoid: 'GEI',
        logos: 'LOG',
        mars: 'MAR',
        ouboros: 'OUB',
        redemption: 'RED',
        sanctum: 'SAN',
        saurian: 'SAU',
        shadows: 'SHA',
        skyborn: 'SKY',
        staralliance: 'STA',
        unfathomable: 'UNF',
        untamed: 'UNT'
    };

    // ---------------------------------------------------------- store lookup

    function findFiberRoot() {
        const candidates = [document.getElementById('component'), document.body].concat(
            Array.from(document.body ? document.body.children : [])
        );

        for (const element of candidates) {
            if (!element) continue;
            for (const key of Object.keys(element)) {
                if (key.startsWith('__reactContainer$') || key.startsWith('__reactFiber$')) {
                    return element[key];
                }
            }
        }
        return null;
    }

    function findStore() {
        const root = findFiberRoot();
        if (!root) return null;

        const seen = new Set();
        const stack = [root];
        let guard = 0;

        while (stack.length && guard++ < 200000) {
            const fiber = stack.pop();
            if (!fiber || seen.has(fiber)) continue;
            seen.add(fiber);

            const props = fiber.memoizedProps;
            if (
                props &&
                props.store &&
                typeof props.store.getState === 'function' &&
                typeof props.store.subscribe === 'function'
            ) {
                return props.store;
            }

            if (fiber.child) stack.push(fiber.child);
            if (fiber.sibling) stack.push(fiber.sibling);
        }
        return null;
    }

    // ------------------------------------------------------------- helpers

    const el = (tag, className, text) => {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    };

    const house = (name) => {
        if (!name) return '--';
        const key = String(name).toLowerCase().replace(/\s+/g, '');
        return HOUSE_ABBREV[key] || String(name).slice(0, 3).toUpperCase();
    };

    // Matches CardImage.jsx, including its `*` escaping.
    const cardArt = (card, full) => {
        const name = card && card.image ? String(card.image).replace(/\*/g, '_') : '';
        if (!name) return null;
        return full ? `/img/cards/${name}.png` : `/img/cards/halfSize/${name}.jpg`;
    };

    // --------------------------------------------------------- log renderer

    // Same shape as PlainTextGameChatFormatter on the server: a message is a
    // container whose entries are fragments, and a fragment tagged with
    // `argType` is a leaf that must not be iterated.
    const BANNER_TYPES = ['startofturn', 'endofturn', 'phasestart'];
    const ALERT_PREFIXED = ['success', 'info', 'danger', 'warning'];

    function formatFragment(fragment) {
        if (fragment === null || fragment === undefined) return '';
        if (typeof fragment !== 'object') return String(fragment);
        if (Array.isArray(fragment)) return fragment.map(formatFragment).join('');

        if (fragment.argType === 'card') {
            return String(fragment.label != null ? fragment.label : fragment.name || '');
        }
        if (fragment.argType === 'player') return `${fragment.name}:`;
        if (fragment.argType === 'nonAvatarPlayer') return String(fragment.name || '');
        if (fragment.argType === 'link') {
            return String(fragment.label != null ? fragment.label : fragment.link || '');
        }

        let result = '';
        for (const [key, value] of Object.entries(fragment)) {
            if (value === null || value === undefined) continue;

            if (key === 'alert' && value.type) {
                const inner = formatFragment(value.message);
                result += ALERT_PREFIXED.includes(value.type)
                    ? `${value.type.toUpperCase()} ${inner}`
                    : inner;
            } else if (
                typeof value === 'object' &&
                !Array.isArray(value) &&
                value.message &&
                !value.argType
            ) {
                result += formatFragment(value.message);
            } else {
                result += formatFragment(value);
            }
        }
        return result;
    }

    const isBanner = (message) =>
        Object.values(message || {}).some(
            (fragment) => fragment && BANNER_TYPES.includes(fragment.type)
        );

    // ------------------------------------------------------------- the view

    const state = (() => {
        try {
            const raw = window.localStorage.getItem(STORAGE_KEY);
            if (raw) return Object.assign({ open: false }, JSON.parse(raw));
        } catch {
            /* storage blocked */
        }
        return { open: false };
    })();

    const save = () => {
        try {
            window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ open: state.open }));
        } catch {
            /* ignore */
        }
    };

    // ------------------------------------------------------------------ css

    const CSS = `
    html.kfm-locked, html.kfm-locked body { overflow: hidden !important; }

    /*
     * Phones only. This view is built for a thumb and has nothing to offer a
     * desktop, where the real board is perfectly readable -- so the launcher
     * stays out of the way there rather than sitting on every page.
     *
     * 'pointer: coarse' is the touch test and the width bound keeps it off
     * desktop touchscreens; device emulation satisfies both, so the dev loop
     * still works. Add ?spectate to any URL to force it on for debugging.
     */
    #kfm-launch { display: none; }

    @media (pointer: coarse) and (max-width: 900px) {
        #kfm-launch { display: block; }
    }
    html.kfm-force-launch #kfm-launch { display: block; }

    /*
     * Sits one button-height above the corner. The ASCII spectator's launcher
     * is fixed at right/bottom 12px, and these two are very likely installed
     * together -- in the same spot they would land exactly on top of each other.
     */
    #kfm-launch {
        position: fixed; right: 12px; bottom: calc(60px + env(safe-area-inset-bottom));
        z-index: 2147483646;
        font: 700 11px/1 system-ui, -apple-system, sans-serif; letter-spacing: .1em;
        background: #14161c; color: #d9c98f; border: 1px solid #4a4638;
        padding: 11px 13px; border-radius: 8px; box-shadow: 0 2px 10px rgb(0 0 0 / .5);
    }

    #kfm-root {
        position: fixed; inset: 0; z-index: 2147483647;
        display: flex; flex-direction: column;
        background: #0b0d12; color: #e7e3d6;
        font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
        overscroll-behavior: none;
        padding: env(safe-area-inset-top) env(safe-area-inset-right)
                 env(safe-area-inset-bottom) env(safe-area-inset-left);
    }
    #kfm-root[hidden] { display: none !important; }

    /* Status strips: fixed height, never scroll, so the numbers stay put. */
    .kfm-strip {
        flex: 0 0 auto;
        display: flex; align-items: center; gap: 8px;
        padding: 7px 10px;
        background: #141821;
        border-block: 1px solid #232838;
        font-size: 12px; line-height: 1;
    }
    .kfm-strip.is-active { background: #1d2130; box-shadow: inset 3px 0 0 #d9a33a; }
    .kfm-strip__name {
        font-weight: 700; font-size: 13px;
        max-width: 28%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .kfm-strip__amber {
        font-weight: 700; color: #1a1205; background: #e0ad3c;
        padding: 3px 7px; border-radius: 999px; font-variant-numeric: tabular-nums;
    }

    /*
     * Stat changes announce themselves. Watching a game you are not playing,
     * the change is the news -- a number that has quietly become different
     * since you last looked is easy to miss entirely.
     */
    .kfm-strip__amber.is-up, .kfm-strip__keys.is-up { animation: kfm-up 620ms ease-out; }
    .kfm-strip__amber.is-down, .kfm-strip__keys.is-down { animation: kfm-down 620ms ease-out; }
    .kfm-strip__meta.is-up, .kfm-strip__meta.is-down { animation: kfm-meta 520ms ease-out; }

    @keyframes kfm-up {
        0%   { transform: scale(1); box-shadow: 0 0 0 0 rgb(255 216 122 / .9); }
        35%  { transform: scale(1.22); box-shadow: 0 0 0 7px rgb(255 216 122 / 0); }
        100% { transform: scale(1); box-shadow: 0 0 0 0 rgb(255 216 122 / 0); }
    }

    @keyframes kfm-down {
        0%   { transform: scale(1); filter: brightness(1); }
        30%  { transform: scale(.86); filter: brightness(.7); }
        100% { transform: scale(1); filter: brightness(1); }
    }

    @keyframes kfm-meta {
        0%   { color: #ffd479; }
        100% { color: inherit; }
    }
    .kfm-strip__keys {
        font-weight: 700; padding: 3px 7px; border-radius: 999px;
        background: #262b3a; font-variant-numeric: tabular-nums;
    }
    .kfm-strip__keys.is-close { background: #d9a33a; color: #1a1205; }
    .kfm-strip__meta {
        margin-inline-start: auto; opacity: .72; font-size: 11px;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }

    /* The battlefield takes everything that is left. */
    .kfm-field {
        flex: 1 1 auto; min-height: 0;
        display: flex; flex-direction: column;
    }

    /*
     * Each line scrolls horizontally on its own. 'touch-action: pan-x' tells
     * the browser this is a horizontal scroller, which keeps a sloppy diagonal
     * swipe from being stolen by vertical panning.
     */
    .kfm-line {
        flex: 1 1 50%; min-height: 0;
        display: flex; align-items: center; gap: 6px;
        padding: 8px 10px;
        overflow-x: auto; overflow-y: hidden;
        touch-action: pan-x;
        scrollbar-width: none;
        -webkit-overflow-scrolling: touch;
    }
    .kfm-line::-webkit-scrollbar { display: none; }
    .kfm-line__empty {
        margin: auto; font-size: 11px; letter-spacing: .08em;
        text-transform: uppercase; opacity: .3;
    }

    /*
     * Turn line and log ticker. Stacked in portrait, where width is the scarce
     * thing and the ticker needs the whole row to say anything useful; side by
     * side in landscape, where height is scarce instead and the battlelines
     * want every pixel back.
     */
    .kfm-centre {
        flex: 0 0 auto;
        display: flex; flex-direction: column; align-items: center; justify-content: center;
        gap: 1px; padding: 3px 10px;
        font-size: 11px; letter-spacing: .06em;
        background: linear-gradient(to right, transparent, #1a1f2b, transparent);
        /* Children ellipsize rather than push this wider. */
        min-width: 0;
    }

    .kfm-centre__turn {
        opacity: .8; white-space: nowrap;
        overflow: hidden; text-overflow: ellipsis; max-width: 100%;
    }

    .kfm-centre__ticker {
        max-width: 100%;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        font-size: 10.5px; opacity: .58;
    }

    /* A new line arrives rather than silently replacing the last one. */
    .kfm-centre__ticker.is-new { animation: kfm-tick 420ms ease-out; }

    @keyframes kfm-tick {
        from { opacity: 0; transform: translateY(4px); }
        to   { opacity: .58; transform: none; }
    }

    @media (orientation: landscape) {
        .kfm-centre {
            flex-direction: row; gap: 10px;
            height: 20px; padding-block: 0;
        }
        .kfm-centre__turn { flex: 0 0 auto; }
        .kfm-centre__ticker { flex: 1 1 auto; min-width: 0; text-align: left; }
    }

    /* Cards: half-size art with the state a spectator needs on top of it. */
    .kfm-card {
        position: relative; flex: 0 0 auto;
        width: 104px; height: 91px;
        border-radius: 8px; overflow: hidden;
        background: #1a1e28;
        box-shadow: 0 1px 4px rgb(0 0 0 / .5);
        transition: transform 160ms ease, filter 160ms ease;
    }
    .kfm-card img {
        position: absolute; inset: 0;
        width: 100%; height: 100%; object-fit: cover;
        display: block;
    }
    .kfm-card.is-exhausted { transform: rotate(4deg); filter: brightness(.62) saturate(.7); }
    .kfm-card.is-damaged { box-shadow: 0 0 0 2px #b4453a inset, 0 1px 4px rgb(0 0 0 / .5); }

    .kfm-card__house {
        position: absolute; top: 3px; left: 3px;
        font-size: 9px; font-weight: 700; letter-spacing: .06em;
        padding: 2px 4px; border-radius: 4px;
        background: rgb(0 0 0 / .66); color: #e7e3d6;
    }
    .kfm-card__amber {
        position: absolute; top: 3px; right: 3px;
        min-width: 16px; height: 16px; border-radius: 999px;
        display: grid; place-items: center;
        font-size: 10px; font-weight: 800;
        background: #e0ad3c; color: #1a1205;
    }
    .kfm-card__name {
        position: absolute; left: 0; right: 0; bottom: 15px;
        padding: 1px 4px;
        font-size: 9px; line-height: 1.2;
        background: rgb(0 0 0 / .62);
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .kfm-card__stats {
        position: absolute; left: 0; bottom: 0;
        padding: 2px 5px;
        font-size: 11px; font-weight: 800; font-variant-numeric: tabular-nums;
        background: rgb(0 0 0 / .74);
    }
    .kfm-card__flags {
        position: absolute; right: 0; bottom: 0;
        padding: 2px 5px;
        font-size: 9px; font-weight: 700; letter-spacing: .04em;
        color: #ffd479; background: rgb(0 0 0 / .74);
    }

    /* Edge handles: swipe is not discoverable, so show where the drawers are. */
    .kfm-handle {
        position: absolute; top: 50%; transform: translateY(-50%);
        z-index: 2;
        writing-mode: vertical-rl;
        font-size: 9px; font-weight: 700; letter-spacing: .14em;
        padding: 10px 3px;
        background: #1b2030; color: #9aa0b4;
        opacity: .85;
    }
    .kfm-handle--left { left: 0; border-radius: 0 6px 6px 0; }
    .kfm-handle--right { right: 0; border-radius: 6px 0 0 6px; transform: translateY(-50%) rotate(180deg); }

    .kfm-drawer {
        position: absolute; top: 0; bottom: 0;
        z-index: 4;
        width: min(86vw, 420px);
        display: flex; flex-direction: column;
        background: #11141c;
        transition: transform 220ms cubic-bezier(.2,.8,.2,1);
        will-change: transform;
    }
    .kfm-drawer.is-dragging { transition: none; }
    .kfm-drawer--left { left: 0; transform: translateX(-100%); border-right: 1px solid #262b3a; }
    .kfm-drawer--right { right: 0; transform: translateX(100%); border-left: 1px solid #262b3a; }
    .kfm-drawer.is-open { transform: translateX(0); }

    .kfm-drawer__title {
        flex: 0 0 auto; padding: 12px 14px;
        font-size: 11px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase;
        color: #9aa0b4; border-bottom: 1px solid #222736;
    }
    .kfm-drawer__body {
        flex: 1 1 auto; min-height: 0;
        overflow-y: auto; -webkit-overflow-scrolling: touch;
        overscroll-behavior: contain;
        padding: 10px 14px calc(18px + env(safe-area-inset-bottom));
        font-size: 13px; line-height: 1.45;
    }

    .kfm-log__row { padding: 3px 0; border-bottom: 1px solid #191d28; }
    .kfm-log__banner {
        margin: 10px 0 6px; padding: 5px 8px;
        border-radius: 5px; background: #222839; color: #ffd479;
        font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase;
    }

    .kfm-piles__player {
        margin: 14px 0 6px; font-weight: 700; font-size: 14px;
        padding-bottom: 4px; border-bottom: 1px solid #262b3a;
    }
    .kfm-piles__head {
        margin: 10px 0 3px;
        font-size: 10px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase;
        color: #9aa0b4;
    }
    .kfm-piles__row { padding: 2px 0; font-variant-numeric: tabular-nums; }
    .kfm-piles__empty { opacity: .35; }

    .kfm-scrim {
        position: absolute; inset: 0; z-index: 3;
        background: rgb(0 0 0 / .55);
        opacity: 0; pointer-events: none;
        transition: opacity 200ms ease;
    }
    .kfm-scrim.is-open { opacity: 1; pointer-events: auto; }

    .kfm-close {
        position: absolute; z-index: 5;
        top: calc(6px + env(safe-area-inset-top)); right: calc(8px + env(safe-area-inset-right));
        width: 30px; height: 30px; border-radius: 999px; border: 0;
        background: rgb(0 0 0 / .5); color: #e7e3d6; font-size: 19px; line-height: 1;
    }

    .kfm-zoom {
        position: absolute; inset: 0; z-index: 6;
        display: grid; place-items: center;
        background: rgb(0 0 0 / .86);
        padding: 20px;
    }
    .kfm-zoom[hidden] { display: none; }
    .kfm-zoom img { max-width: 100%; max-height: 100%; border-radius: 12px; }

    @media (prefers-reduced-motion: reduce) {
        .kfm-drawer, .kfm-scrim, .kfm-card { transition: none; }
        .kfm-centre__ticker.is-new,
        .kfm-strip__amber.is-up, .kfm-strip__amber.is-down,
        .kfm-strip__keys.is-up, .kfm-strip__keys.is-down,
        .kfm-strip__meta.is-up, .kfm-strip__meta.is-down { animation: none; }
    }
    `;

    function mount() {
        for (const id of ['kfm-root', 'kfm-launch', 'kfm-style']) {
            const existing = document.getElementById(id);
            if (existing) existing.remove();
        }

        const style = el('style');
        style.id = 'kfm-style';
        style.textContent = CSS;
        document.documentElement.appendChild(style);

        const launch = el('button', null, 'WATCH');
        launch.id = 'kfm-launch';

        const root = el('div');
        root.id = 'kfm-root';
        root.hidden = true;
        root.innerHTML = `
            <div class="kfm-strip" data-strip="top"></div>
            <div class="kfm-field">
                <div class="kfm-line" data-line="top"></div>
                <div class="kfm-centre">
                    <span class="kfm-centre__turn" data-centre></span>
                    <span class="kfm-centre__ticker" data-ticker></span>
                </div>
                <div class="kfm-line" data-line="bottom"></div>
            </div>
            <div class="kfm-strip" data-strip="bottom"></div>

            <div class="kfm-handle kfm-handle--left" data-handle="left">LOG</div>
            <div class="kfm-handle kfm-handle--right" data-handle="right">PILES</div>

            <div class="kfm-drawer kfm-drawer--left" data-drawer="left">
                <div class="kfm-drawer__title">Game log</div>
                <div class="kfm-drawer__body" data-log></div>
            </div>
            <div class="kfm-drawer kfm-drawer--right" data-drawer="right">
                <div class="kfm-drawer__title">Piles</div>
                <div class="kfm-drawer__body" data-piles></div>
            </div>
            <div class="kfm-scrim" data-scrim></div>

            <button class="kfm-close" data-close>&times;</button>
            <div class="kfm-zoom" data-zoom hidden><img alt=""></div>
        `;

        document.documentElement.appendChild(launch);
        document.documentElement.appendChild(root);

        return { root, launch };
    }

    const { root, launch } = mount();

    const q = (selector) => root.querySelector(selector);
    const strips = { top: q('[data-strip="top"]'), bottom: q('[data-strip="bottom"]') };
    const lines = { top: q('[data-line="top"]'), bottom: q('[data-line="bottom"]') };
    const centreEl = q('[data-centre]');
    const tickerEl = q('[data-ticker]');
    const logEl = q('[data-log]');
    const pilesEl = q('[data-piles]');
    const scrim = q('[data-scrim]');
    const zoom = q('[data-zoom]');
    const drawers = { left: q('[data-drawer="left"]'), right: q('[data-drawer="right"]') };

    // ------------------------------------------------------------- drawers

    let openDrawer = null;

    function setDrawer(side) {
        openDrawer = side;
        for (const [name, node] of Object.entries(drawers)) {
            node.classList.toggle('is-open', name === side);
            node.style.transform = '';
        }
        scrim.classList.toggle('is-open', !!side);

        if (side === 'left') {
            // A log you have to scroll to the bottom of is a log you will not
            // read on a phone.
            logEl.scrollTop = logEl.scrollHeight;
        }
    }

    scrim.addEventListener('click', () => setDrawer(null));
    for (const [side, node] of Object.entries(drawers)) {
        node.addEventListener('click', (event) => {
            if (event.target === node) setDrawer(side === openDrawer ? null : side);
        });
    }
    for (const handle of root.querySelectorAll('[data-handle]')) {
        handle.addEventListener('click', () => {
            const side = handle.dataset.handle;
            setDrawer(openDrawer === side ? null : side);
        });
    }

    /*
     * Edge swipes open the drawers.
     *
     * The gesture only starts if the finger goes down within EDGE_ZONE_PX of a
     * screen edge. Anywhere else -- which is all of both battlelines -- the
     * touch is left alone entirely, so horizontal scrolling of a row is never
     * competing with a drawer pull.
     */
    let gesture = null;

    root.addEventListener(
        'touchstart',
        (event) => {
            if (event.touches.length !== 1) return;

            const touch = event.touches[0];
            const width = window.innerWidth;

            if (openDrawer) {
                gesture = { side: openDrawer, startX: touch.clientX, closing: true };
                return;
            }

            if (touch.clientX <= EDGE_ZONE_PX) {
                gesture = { side: 'left', startX: touch.clientX, closing: false };
            } else if (touch.clientX >= width - EDGE_ZONE_PX) {
                gesture = { side: 'right', startX: touch.clientX, closing: false };
            }
        },
        { passive: true }
    );

    root.addEventListener(
        'touchmove',
        (event) => {
            if (!gesture || event.touches.length !== 1) return;

            const delta = event.touches[0].clientX - gesture.startX;
            const node = drawers[gesture.side];
            const towardOpen = gesture.side === 'left' ? delta : -delta;

            if (gesture.closing) {
                const towardClosed = gesture.side === 'left' ? -delta : delta;
                if (towardClosed > 0) {
                    node.style.transform = `translateX(${gesture.side === 'left' ? -towardClosed : towardClosed}px)`;
                }
                return;
            }

            if (towardOpen > 0) {
                const shown = Math.min(towardOpen, node.offsetWidth);
                const hidden = node.offsetWidth - shown;
                node.style.transform = `translateX(${gesture.side === 'left' ? -hidden : hidden}px)`;
                node.classList.add('is-dragging');
            }
        },
        { passive: true }
    );

    const endGesture = (event) => {
        if (!gesture) return;

        const node = drawers[gesture.side];
        const touch = event.changedTouches && event.changedTouches[0];
        const delta = touch ? touch.clientX - gesture.startX : 0;
        const travel = gesture.side === 'left' ? delta : -delta;

        node.classList.remove('is-dragging');

        if (gesture.closing) {
            setDrawer(travel < -DRAWER_OPEN_PX ? null : gesture.side);
        } else {
            setDrawer(travel > DRAWER_OPEN_PX ? gesture.side : null);
        }

        gesture = null;
    };

    root.addEventListener('touchend', endGesture, { passive: true });
    root.addEventListener('touchcancel', endGesture, { passive: true });

    // ---------------------------------------------------------------- zoom

    zoom.addEventListener('click', () => {
        zoom.hidden = true;
    });

    function showZoom(card) {
        const src = cardArt(card, true);
        if (!src) return;
        zoom.querySelector('img').src = src;
        zoom.hidden = false;
    }

    // ------------------------------------------------------------ open/close

    function setOpen(open) {
        state.open = open;
        root.hidden = !open;
        launch.style.display = open ? 'none' : '';
        document.documentElement.classList.toggle('kfm-locked', open);
        save();
        if (open) render(true);
        else setDrawer(null);
    }

    launch.addEventListener('click', () => setOpen(true));
    q('[data-close]').addEventListener('click', () => setOpen(false));

    // -------------------------------------------------------------- render

    let store = null;
    let lastSignature = '';
    // uuid -> tile, so a re-render updates cards in place instead of replacing
    // them, which would restart every image load and flicker the row.
    const tiles = new Map();

    function cardTile(card) {
        let tile = tiles.get(card.uuid);

        if (!tile) {
            tile = el('div', 'kfm-card');
            tile.innerHTML = `
                <img alt="" loading="lazy">
                <span class="kfm-card__house"></span>
                <span class="kfm-card__amber"></span>
                <span class="kfm-card__name"></span>
                <span class="kfm-card__stats"></span>
                <span class="kfm-card__flags"></span>
            `;
            tile.addEventListener('click', () => showZoom(tile._card));
            tiles.set(card.uuid, tile);
        }

        tile._card = card;

        const art = cardArt(card, false);
        const img = tile.querySelector('img');
        if (art && img.getAttribute('src') !== art) img.setAttribute('src', art);

        const tokens = card.tokens || {};
        const power = card.modifiedPower != null ? card.modifiedPower : card.powerPrinted;
        const damage = tokens.damage || 0;
        const armour = tokens.armor != null ? tokens.armor : card.armorPrinted || 0;
        const amber = tokens.amber || 0;

        tile.querySelector('.kfm-card__house').textContent = house(card.printedHouse);
        tile.querySelector('.kfm-card__name').textContent = card.name || '';

        const amberEl = tile.querySelector('.kfm-card__amber');
        amberEl.textContent = amber ? amber : '';
        amberEl.hidden = !amber;

        const stats = tile.querySelector('.kfm-card__stats');
        if (card.type === 'creature') {
            stats.textContent = `${Math.max(0, power - damage)}/${power}${armour ? ` ◈${armour}` : ''}`;
            stats.hidden = false;
        } else {
            stats.hidden = true;
        }

        const flags = [];
        if (tokens.stun || card.stunned) flags.push('STN');
        if (tokens.ward || card.warded) flags.push('WRD');
        if (card.taunt) flags.push('TNT');
        if (tokens.enrage || card.enraged) flags.push('RGE');
        if ((card.upgrades || []).length) flags.push(`+${card.upgrades.length}`);
        tile.querySelector('.kfm-card__flags').textContent = flags.join(' ');

        tile.classList.toggle('is-exhausted', !!card.exhausted);
        tile.classList.toggle('is-damaged', damage > 0);

        return tile;
    }

    // Reuse tiles and reorder in place; only touch the DOM where it differs.
    function syncLine(container, cards) {
        const wanted = cards.map(cardTile);

        wanted.forEach((tile, index) => {
            const current = container.children[index];
            if (current !== tile) container.insertBefore(tile, current || null);
        });

        while (container.children.length > wanted.length) {
            container.lastElementChild.remove();
        }

        if (!wanted.length) {
            container.appendChild(el('span', 'kfm-line__empty', 'no cards in play'));
        }
    }

    /*
     * Restart a CSS animation on an element that may already be mid-animation.
     * Removing the class is not enough on its own -- the browser coalesces the
     * remove and re-add into no change at all -- so a reflow is forced between
     * them.
     */
    function flash(node, className) {
        node.classList.remove(className);
        void node.offsetWidth;
        node.classList.add(className);
    }

    /*
     * A number that reacts when it changes.
     *
     * Watching a game you did not play means the interesting thing is usually
     * the *change*: amber going up, a key being forged. A number that silently
     * differs from the one you last looked at is easy to miss, so a change
     * pulses, and gains and losses pulse differently.
     */
    function setStat(node, value) {
        const next = String(value);

        if (node._value === next) {
            return;
        }

        const previous = node._value;
        node._value = next;
        node.textContent = next;

        if (previous === undefined) {
            return;
        }

        const before = parseFloat(previous);
        const after = parseFloat(next);
        const rising = Number.isFinite(before) && Number.isFinite(after) && after > before;

        flash(node, rising ? 'is-up' : 'is-down');
    }

    // Built once per strip, then updated in place. Rebuilding the markup every
    // render would throw away the previous values the animations compare with.
    function stripParts(node) {
        if (node._parts) {
            return node._parts;
        }

        const name = el('span', 'kfm-strip__name');
        const amber = el('span', 'kfm-strip__amber');
        const keys = el('span', 'kfm-strip__keys');
        const meta = el('span', 'kfm-strip__meta');

        node.append(name, amber, keys, meta);
        node._parts = { name, amber, keys, meta };
        return node._parts;
    }

    function stripFor(node, player, label) {
        const stats = player.stats || {};
        const piles = player.cardPiles || {};
        const keys = stats.keys || {};
        const forged = ['red', 'blue', 'yellow'].filter((colour) => keys[colour]).length;
        const parts = stripParts(node);

        node.classList.toggle('is-active', !!player.activePlayer);

        parts.name.textContent = player.name || label;

        setStat(parts.amber, `${stats.amber || 0}/${stats.keyCost != null ? stats.keyCost : 6}`);
        setStat(parts.keys, `${forged}/3`);

        parts.keys.classList.toggle('is-close', (stats.amber || 0) >= (stats.keyCost || 6));

        setStat(
            parts.meta,
            `${house(player.activeHouse)} · hand ${(piles.hand || []).length} · deck ${
                player.numDeckCards || 0
            } · disc ${(piles.discard || []).length}${stats.chains ? ` · chains ${stats.chains}` : ''}`
        );
    }

    function renderLog(game) {
        logEl.innerHTML = '';

        for (const entry of game.messages || []) {
            const text = formatFragment(entry.message).trim();
            if (!text) continue;
            logEl.appendChild(
                el('div', isBanner(entry.message) ? 'kfm-log__banner' : 'kfm-log__row', text)
            );
        }

        logEl.scrollTop = logEl.scrollHeight;
    }

    function renderPiles(game, order) {
        pilesEl.innerHTML = '';

        for (const player of order) {
            const piles = player.cardPiles || {};
            pilesEl.appendChild(el('div', 'kfm-piles__player', player.name));

            for (const { key, label, topFirst } of [
                { key: 'discard', label: 'Discard', topFirst: true },
                { key: 'archives', label: 'Archives', topFirst: false },
                { key: 'purged', label: 'Purged', topFirst: true }
            ]) {
                const pile = piles[key] || [];
                pilesEl.appendChild(
                    el(
                        'div',
                        'kfm-piles__head',
                        `${label} (${pile.length})${pile.length && topFirst ? ' · top first' : ''}`
                    )
                );

                if (!pile.length) {
                    pilesEl.appendChild(el('div', 'kfm-piles__empty', '--'));
                    continue;
                }

                // Order is game state; never sort it.
                pile.forEach((card, index) => {
                    pilesEl.appendChild(
                        el('div', 'kfm-piles__row', `${index + 1}. ${card.name || '(hidden)'}`)
                    );
                });
            }
        }
    }

    function orderPlayers(game, myName) {
        const players = Object.values(game.players || {});
        if (players.length < 2) return players;

        const mine = players.findIndex((player) => player.name === myName);
        if (mine === -1) return players;
        return players.filter((_, index) => index !== mine).concat([players[mine]]);
    }

    function renderUnsafe(force) {
        if (!state.open) return;

        if (!store) {
            centreEl.textContent = 'waiting for the game client';
            return;
        }

        const appState = store.getState();
        const game = appState.lobby && appState.lobby.currentGame;
        const myName =
            appState.account && appState.account.user ? appState.account.user.username : undefined;

        if (!game || !game.started) {
            centreEl.textContent = game ? 'game not started' : 'no game in progress';
            return;
        }

        const order = orderPlayers(game, myName);
        if (order.length < 2) return;

        const signature = JSON.stringify([
            game.messages ? game.messages.length : 0,
            order.map((player) => [
                player.stats,
                player.activeHouse,
                player.activePlayer,
                player.numDeckCards,
                (player.cardPiles?.hand || []).length,
                (player.cardPiles?.discard || []).map((card) => card.name || 0),
                (player.cardPiles?.archives || []).length,
                (player.cardPiles?.purged || []).length,
                (player.cardPiles?.cardsInPlay || []).map((card) => [
                    card.uuid,
                    card.name,
                    card.exhausted,
                    card.modifiedPower,
                    card.taunt,
                    card.tokens,
                    (card.upgrades || []).length
                ])
            ])
        ]);

        if (!force && signature === lastSignature) return;
        lastSignature = signature;

        const [top, bottom] = order;

        stripFor(strips.top, top, 'opponent');
        stripFor(strips.bottom, bottom, 'player');

        // Creatures nearest the centre on both sides, artifacts behind them --
        // the same reading order as a table.
        const split = (player) => {
            const inPlay = player.cardPiles?.cardsInPlay || [];
            const creatures = inPlay.filter((card) => card.type === 'creature');
            const rest = inPlay.filter((card) => card.type !== 'creature');
            return { creatures, rest };
        };

        const topSplit = split(top);
        const bottomSplit = split(bottom);

        syncLine(lines.top, [...topSplit.rest, ...topSplit.creatures]);
        syncLine(lines.bottom, [...bottomSplit.creatures, ...bottomSplit.rest]);

        const active = order.find((player) => player.activePlayer);
        centreEl.textContent = game.winner
            ? `${game.winner} wins`
            : active
              ? `${active.name} · ${active.phase || ''}`.trim()
              : '';

        /*
         * The newest log line, as a ticker.
         *
         * The drawer holds the full log, but a spectator should not have to open
         * it to notice that something just happened. Truncation is left to CSS
         * so it fits whatever width it is given rather than a guessed character
         * count -- which is the whole difficulty on a phone.
         */
        const latest = [...(game.messages || [])]
            .reverse()
            .map((entry) => formatFragment(entry.message).trim())
            .find(Boolean);

        if (latest && latest !== tickerEl._value) {
            tickerEl._value = latest;
            tickerEl.textContent = latest;
            flash(tickerEl, 'is-new');
        }

        renderLog(game);
        renderPiles(game, order);
    }

    // A bug in this overlay must stay this overlay's problem; the host page
    // runs Sentry and an uncaught error here would land in its reports.
    function render(force) {
        try {
            renderUnsafe(force);
        } catch (error) {
            console.error('[mobile-spectator] render failed', error);
        }
    }

    // ----------------------------------------------------------- bootstrap

    let attempts = 0;
    const finder = setInterval(() => {
        store = findStore();
        attempts += 1;

        if (store) {
            clearInterval(finder);

            let queued = false;
            store.subscribe(() => {
                if (queued) return;
                queued = true;
                window.requestAnimationFrame(() => {
                    queued = false;
                    render(false);
                });
            });

            render(true);
        } else if (attempts > 60) {
            clearInterval(finder);
            render(true);
        }
    }, 500);

    if (/[?&]spectate\b/.test(window.location.search)) {
        document.documentElement.classList.add('kfm-force-launch');
    }

    // The bookmarklet sets this before injecting, so an explicit request to
    // watch opens the view even where the launcher is hidden.
    if (state.open) {
        document.documentElement.classList.add('kfm-force-launch');
        setOpen(true);
    }

})();
