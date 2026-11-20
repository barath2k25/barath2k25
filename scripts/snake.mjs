#!/usr/bin/env node
// Egg Snake — renders the GitHub contribution calendar as white eggs and a
// green snake that eats every egg, growing one segment per egg.
//
// Usage: node scripts/snake.mjs <github-user> <out-dir>
// Uses GITHUB_TOKEN (GraphQL) when set, otherwise the public contributions page.
//
// Route: the snake sweeps the grid column by column, left to right. Columns
// holding eggs are walked end to end (down, then up the next one, ...);
// empty columns are crossed along the top or bottom row. Every move enters a
// cell the snake has never visited, so it can never run into its own body no
// matter how long it grows. validate() re-checks this frame by frame.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const ROWS = 7;
const CELL = 12; // cell size (px)
const PITCH = 16; // cell + gap
const PAD = 16; // outer padding
const START_LEN = 3; // snake length before eating anything
const STEP = 0.1; // seconds per move
const PAUSE = 16; // steps between the snake leaving and the loop restarting

const THEMES = {
  dark: {
    empty: "#161b22",
    eggs: [null, "#c9d1d9", "#dde3e9", "#eef1f4", "#ffffff"],
    eggStroke: "none",
    head: "#39d353",
    tail: "#196c2e",
    eye: "#0d1117",
  },
  light: {
    empty: "#ebedf0",
    eggs: [null, "#eef1f4", "#f6f8fa", "#fbfcfd", "#ffffff"],
    eggStroke: "#8c959f",
    head: "#2da44e",
    tail: "#116329",
    eye: "#ffffff",
  },
};

// Egg outline centred on (0,0): 10 wide, 12.5 tall, narrower at the top.
const EGG =
  "M0-6.4C3.2-6.4 5-1.6 5 1.6 5 4.4 2.8 6.1 0 6.1-2.8 6.1-5 4.4-5 1.6-5-1.6-3.2-6.4 0-6.4Z";

// ---------------------------------------------------------------- data

const LEVELS = { NONE: 0, FIRST_QUARTILE: 1, SECOND_QUARTILE: 2, THIRD_QUARTILE: 3, FOURTH_QUARTILE: 4 };

async function fromGraphQL(user, token) {
  const query = `query($login:String!){user(login:$login){contributionsCollection{contributionCalendar{weeks{contributionDays{weekday contributionLevel}}}}}}`;
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `bearer ${token}`, "Content-Type": "application/json", "User-Agent": "egg-snake" },
    body: JSON.stringify({ query, variables: { login: user } }),
  });
  const json = await res.json();
  const weeks = json?.data?.user?.contributionsCollection?.contributionCalendar?.weeks;
  if (!res.ok || !weeks) throw new Error(`GraphQL failed (${res.status}): ${JSON.stringify(json.errors ?? json)}`);
  return weeks.flatMap((w, col) =>
    w.contributionDays.map((d) => ({ col, row: d.weekday, level: LEVELS[d.contributionLevel] ?? 0 }))
  );
}

async function fromHTML(user) {
  const res = await fetch(`https://github.com/users/${encodeURIComponent(user)}/contributions`, {
    headers: { "User-Agent": "egg-snake" },
  });
  if (!res.ok) throw new Error(`contributions page failed (${res.status})`);
  const html = await res.text();
  const cells = [];
  for (const [tag] of html.matchAll(/<td\b[^>]*ContributionCalendar-day[^>]*>/g)) {
    const id = tag.match(/id="contribution-day-component-(\d+)-(\d+)"/);
    const level = tag.match(/data-level="(\d)"/);
    if (id && level) cells.push({ row: +id[1], col: +id[2], level: +level[1] });
  }
  if (!cells.length) throw new Error("no contribution cells found in the contributions page");
  return cells;
}

async function loadCells(user) {
  const token = process.env.GITHUB_TOKEN;
  if (token) {
    try {
      return await fromGraphQL(user, token);
    } catch (err) {
      console.warn(`${err.message}\nFalling back to the public contributions page.`);
    }
  }
  return fromHTML(user);
}

// ---------------------------------------------------------------- route

function plan(cells) {
  const minCol = Math.min(...cells.map((c) => c.col));
  cells = cells.map((c) => ({ ...c, col: c.col - minCol }));
  const W = Math.max(...cells.map((c) => c.col)) + 1;
  const key = (c, r) => `${c},${r}`;
  const eggs = new Map(cells.filter((c) => c.level > 0).map((c) => [key(c.col, c.row), c]));
  const colHasEgg = Array.from({ length: W }, (_, c) => cells.some((x) => x.col === c && x.level > 0));

  // Enter from above-left (off the grid) so the loop seam is never visible.
  const P = [[-2, -2], [-1, 0]];
  let r = 0;
  for (let c = 0; c < W; c++) {
    P.push([c, r]);
    if (colHasEgg[c]) {
      const end = r === 0 ? ROWS - 1 : 0;
      const dir = end > r ? 1 : -1;
      for (let y = r + dir; ; y += dir) {
        P.push([c, y]);
        if (y === end) break;
      }
      r = end;
    }
  }
  const N = P.length; // steps until the head leaves the grid

  const eatStep = new Map(); // egg key -> step at which the head reaches it
  P.forEach(([c, y], t) => {
    const k = key(c, y);
    if (eggs.has(k) && !eatStep.has(k)) eatStep.set(k, t);
  });

  const maxLen = START_LEN + eggs.size;
  const F = N + maxLen + PAUSE; // frames per loop: tail must be fully off-grid before the seam

  // Walk off to the right, then hop above the grid to meet P[0] off-screen.
  let x = W;
  while (P.length < F - 1) P.push([x++, r]);
  P.push([x, -2]);

  const lenAt = new Array(F);
  let len = START_LEN;
  for (let t = 0; t < F; t++) {
    if (t < N && eatStep.get(key(...P[t])) === t) len++;
    lenAt[t] = len;
  }

  // step at which segment i first exists
  const bornAt = Array.from({ length: maxLen }, (_, i) => lenAt.findIndex((l) => l > i));

  return { W, cells, eggs, eatStep, P, N, F, lenAt, bornAt, maxLen, key };
}

function validate({ W, eggs, eatStep, P, F, lenAt, maxLen, key }) {
  const onGrid = ([c, r]) => c >= 0 && c < W && r >= 0 && r < ROWS;
  for (const k of eggs.keys()) if (!eatStep.has(k)) throw new Error(`egg ${k} is never eaten`);
  for (let t = 0; t < F; t++) {
    const seen = new Set();
    for (let i = 0; i < lenAt[t]; i++) {
      if (t - i < 0) continue; // not yet entered: off-grid
      const p = P[t - i];
      if (!onGrid(p)) continue;
      const k = key(...p);
      if (seen.has(k)) throw new Error(`snake overlaps itself at step ${t}, cell ${k}`);
      seen.add(k);
    }
    if (t > 0) {
      const [a, b] = [P[t - 1], P[t]];
      const dist = Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
      if (dist !== 1 && (onGrid(a) || onGrid(b))) throw new Error(`illegal move on grid at step ${t}`);
    }
  }
  // Every segment must be off-grid at the loop seam.
  for (let i = 0; i < maxLen; i++) if (onGrid(P[F - 1 - i])) throw new Error("snake visible at loop seam");
}

// ---------------------------------------------------------------- render

const px = (c) => PAD + c * PITCH;
const pct = (s, F) => `${((Math.max(0, Math.min(F, s)) / F) * 100).toFixed(4)}%`;

function mix(a, b, t) {
  const h = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
  const [x, y] = [h(a), h(b)];
  return "#" + x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, "0")).join("");
}

function render(p, theme) {
  const { W, cells, eggs, eatStep, P, F, bornAt, maxLen, key } = p;
  const T = (F * STEP).toFixed(2);
  const width = W * PITCH + PAD * 2 - (PITCH - CELL);
  const height = ROWS * PITCH + PAD * 2 - (PITCH - CELL);
  const css = [];

  // Head path keyframes; straight runs collapse to their end points.
  const frames = [];
  for (let k = 0; k < F; k++) {
    const prev = P[k - 1], cur = P[k], next = P[k + 1];
    const straight =
      prev && next && cur[0] - prev[0] === next[0] - cur[0] && cur[1] - prev[1] === next[1] - cur[1];
    if (!straight) frames.push(`${pct(k, F)}{transform:translate(${px(cur[0])}px,${px(cur[1])}px)}`);
  }
  frames.push(`100%{transform:translate(${px(P[0][0])}px,${px(P[0][1])}px)}`);
  css.push(`@keyframes m{${frames.join("")}}`);
  css.push(`.s{animation:m ${T}s linear infinite}`);
  css.push(`.e{animation-duration:${T}s;animation-timing-function:linear;animation-iteration-count:infinite}`);

  // Eggs vanish as the head arrives and grow back during the pause.
  const eggEls = [];
  let j = 0;
  for (const [k, c] of eggs) {
    const t = eatStep.get(k);
    css.push(
      `@keyframes e${j}{0%,${pct(t - 0.35, F)}{opacity:1;transform:scale(1)}` +
        `${pct(t + 0.05, F)},${pct(F - PAUSE / 2, F)}{opacity:0;transform:scale(0)}` +
        `100%{opacity:1;transform:scale(1)}}`
    );
    eggEls.push(
      `<g transform="translate(${px(c.col) + CELL / 2} ${px(c.row) + CELL / 2})">` +
        `<path class="e" style="animation-name:e${j}" d="${EGG}" fill="url(#g${c.level})"/></g>`
    );
    j++;
  }

  // Segments: same path as the head, i steps behind; new ones appear as eggs are eaten.
  const segEls = [];
  for (let i = maxLen - 1; i >= 0; i--) {
    const delay = (-((F - i) % F) * STEP).toFixed(2);
    let anim = `m ${T}s linear ${delay}s infinite`;
    if (bornAt[i] > 0) {
      css.push(`@keyframes v${i}{0%,${pct(bornAt[i] - 1, F)}{opacity:0}${pct(bornAt[i] - 0.95, F)},100%{opacity:1}}`);
      anim += `,v${i} ${T}s linear infinite`;
    }
    const fill = mix(theme.head, theme.tail, maxLen > 1 ? i / (maxLen - 1) : 0);
    const body =
      i === 0
        ? `<rect width="${CELL}" height="${CELL}" rx="4" fill="${theme.head}"/>` +
          `<circle cx="3.8" cy="4.6" r="1.5" fill="${theme.eye}"/><circle cx="8.2" cy="4.6" r="1.5" fill="${theme.eye}"/>`
        : `<rect x="0.5" y="0.5" width="${CELL - 1}" height="${CELL - 1}" rx="3.5" fill="${fill}"/>`;
    segEls.push(`<g class="s" style="animation:${anim}">${body}</g>`);
  }

  const gradients = theme.eggs
    .map((col, lvl) =>
      col
        ? `<radialGradient id="g${lvl}" cx="35%" cy="30%" r="80%"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="${col}"/></radialGradient>`
        : ""
    )
    .join("");

  const grid = cells
    .map((c) => `<rect x="${px(c.col)}" y="${px(c.row)}" width="${CELL}" height="${CELL}" rx="2.5"/>`)
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
<defs>${gradients}<clipPath id="clip"><rect x="${PAD - 2}" y="${PAD - 2}" width="${W * PITCH}" height="${ROWS * PITCH}"/></clipPath></defs>
<style>${css.join("")}</style>
<g fill="${theme.empty}">${grid}</g>
<g stroke="${theme.eggStroke}" stroke-width="0.8">${eggEls.join("")}</g>
<g clip-path="url(#clip)">${segEls.join("")}</g>
</svg>
`;
}

// ---------------------------------------------------------------- main

const [user, outDir = "dist"] = process.argv.slice(2);
if (!user) {
  console.error("usage: node scripts/snake.mjs <github-user> [out-dir]");
  process.exit(1);
}

const cells = await loadCells(user);
const p = plan(cells);
validate(p);
await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, "github-snake-dark.svg"), render(p, THEMES.dark));
await writeFile(join(outDir, "github-snake.svg"), render(p, THEMES.light));
console.log(
  `${p.eggs.size} eggs, snake grows ${START_LEN} -> ${p.maxLen}, loop ${(p.F * STEP).toFixed(1)}s -> ${outDir}/`
);
