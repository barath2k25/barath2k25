#!/usr/bin/env node
// Egg Snake — renders the GitHub contribution calendar as eggs (white, or gold
// on the busiest days) and a green snake that hunts them down, growing one
// segment for every GROW_EVERY eggs.
//
// Usage: node scripts/snake.mjs <github-user> <out-dir>
// Uses GITHUB_TOKEN (GraphQL) when set, otherwise the public contributions page.
// Each run rebuilds the grid from the live calendar, so new contribution days
// become new eggs.
//
// Route: the snake chases the nearest egg in any direction. Before committing
// to an egg it simulates the trip and checks it can still reach its own tail
// afterwards (so it never traps itself); if not, it follows its tail until a
// safe egg opens up. Should that ever fail to finish, it falls back to a
// column-by-column sweep that never revisits a cell and so cannot collide.
// validate() re-checks the final route frame by frame either way.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const ROWS = 7;
const CELL = 12; // cell size (px)
const PITCH = 16; // cell + gap
const PAD = 16; // outer padding
const START_LEN = 3; // snake length before eating anything
const GROW_EVERY = 2; // eggs eaten per extra segment
const STEP = 0.1; // seconds per move
const PAUSE = 16; // steps between the snake leaving and the loop restarting
const GOLD_LEVEL = 4; // GitHub's darkest green = gold egg

const GOLD = ["#fff6cc", "#ffc83d", "#c98a00"];
const THEMES = {
  dark: {
    empty: "#161b22",
    eggs: [null, "#c9d1d9", "#dde3e9", "#eef1f4", GOLD],
    eggStroke: [null, "none", "none", "none", "none"],
    head: "#39d353",
    tail: "#196c2e",
    eye: "#0d1117",
  },
  light: {
    empty: "#ebedf0",
    eggs: [null, "#eef1f4", "#f6f8fa", "#fbfcfd", GOLD],
    eggStroke: [null, "#8c959f", "#8c959f", "#8c959f", "#b07800"],
    head: "#2da44e",
    tail: "#116329",
    eye: "#ffffff",
  },
};

// Egg outline centred on (0,0): 10 wide, 12.5 tall, narrower at the top.
const EGG =
  "M0-6.4C3.2-6.4 5-1.6 5 1.6 5 4.4 2.8 6.1 0 6.1-2.8 6.1-5 4.4-5 1.6-5-1.6-3.2-6.4 0-6.4Z";

const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];
const key = (c, r) => `${c},${r}`;

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
      const cells = await fromGraphQL(user, token);
      console.log("source: GraphQL");
      return cells;
    } catch (err) {
      console.warn(`${err.message}\nFalling back to the public contributions page.`);
    }
  }
  console.log("source: contributions page");
  return fromHTML(user);
}

// ---------------------------------------------------------------- routes
// A route is the list of head positions P. The body at step t is the last
// len(t) head positions, so the tail stays put on the step the snake grows.
// Every route starts at P[0] = (-2,-2), P[1] = (-1,0) (off-grid, top-left)
// and ends with the head stepping off the right edge.

class Snake {
  constructor(W, eggKeys) {
    this.W = W;
    this.P = [[-2, -2], [-1, 0]];
    this.len = START_LEN;
    this.eaten = 0;
    this.left = new Set(eggKeys);
  }
  clone() {
    const s = Object.create(Snake.prototype);
    s.W = this.W;
    s.P = this.P.slice(-(this.len + 1));
    s.len = this.len;
    s.eaten = this.eaten;
    s.left = new Set(this.left);
    return s;
  }
  get head() {
    return this.P[this.P.length - 1];
  }
  onGrid([c, r]) {
    return c >= 0 && c < this.W && r >= 0 && r < ROWS;
  }
  // does stepping onto n make the snake longer? (then its tail stays put)
  grows(n) {
    return this.left.has(key(...n)) && (this.eaten + 1) % GROW_EVERY === 0;
  }
  // grid cells the body occupies after the next move (tail leaves unless growing)
  blocked(growing) {
    const body = this.P.slice(-this.len);
    const stays = growing || this.P.length < this.len ? body : body.slice(1);
    return new Set(stays.filter((p) => this.onGrid(p)).map((p) => key(...p)));
  }
  tail() {
    return this.P.length >= this.len ? this.P[this.P.length - this.len] : null;
  }
  legal(n, allowExit = false) {
    const inside = this.onGrid(n) || (allowExit && n[0] === this.W && n[1] >= 0 && n[1] < ROWS);
    return inside && !this.blocked(this.grows(n)).has(key(...n));
  }
  move(n) {
    this.P.push(n);
    if (this.grows(n)) this.len++;
    if (this.left.delete(key(...n))) this.eaten++;
  }
  // BFS from the head; body cells (except the tail) are walls.
  bfs(isTarget, allowExit = false) {
    const walls = this.blocked(false);
    const start = this.head;
    const prev = new Map([[key(...start), null]]);
    const queue = [start];
    while (queue.length) {
      const cur = queue.shift();
      for (const [dc, dr] of DIRS) {
        const n = [cur[0] + dc, cur[1] + dr];
        const k = key(...n);
        if (prev.has(k)) continue;
        const exitCell = allowExit && n[0] === this.W && n[1] >= 0 && n[1] < ROWS;
        if (!this.onGrid(n) && !exitCell) continue;
        if (walls.has(k)) continue;
        prev.set(k, cur);
        if (isTarget(n)) {
          const path = [];
          for (let p = n; p !== start; p = prev.get(key(...p))) path.unshift(p);
          return path;
        }
        if (!exitCell) queue.push(n);
      }
    }
    return null;
  }
  // can the head still find its way to its own tail?
  safe() {
    const t = this.tail();
    if (!t || !this.onGrid(t)) return true; // still entering: wide open
    return this.bfs((n) => n[0] === t[0] && n[1] === t[1]) !== null;
  }
  // walk a path; false if any step is illegal
  follow(path, allowExit = false) {
    for (const n of path) {
      if (!this.legal(n, allowExit)) return false;
      this.move(n);
    }
    return true;
  }
  // one step that keeps the tail reachable, preferring the longest way round
  stall(allowExit = false) {
    const options = DIRS.map(([dc, dr]) => [this.head[0] + dc, this.head[1] + dr])
      .filter((n) => this.legal(n, allowExit))
      .map((n) => {
        const sim = this.clone();
        sim.move(n);
        const t = sim.tail();
        const toTail = t && sim.onGrid(t) ? sim.bfs((m) => m[0] === t[0] && m[1] === t[1]) : [];
        return { n, ok: toTail !== null, d: toTail ? toTail.length : -1 };
      })
      .sort((a, b) => b.ok - a.ok || b.d - a.d);
    if (!options.length) return false;
    this.move(options[0].n);
    return true;
  }
}

function huntRoute(W, eggKeys) {
  const s = new Snake(W, eggKeys);
  s.move([0, 0]);
  let budget = Math.round(W * ROWS * 2.5); // give up on hunting if it would drag the loop out
  while (s.left.size) {
    if (--budget < 0) return null;
    const path = s.bfs((n) => s.left.has(key(...n)));
    if (path) {
      const sim = s.clone();
      if (sim.follow(path) && sim.safe()) {
        s.follow(path);
        continue;
      }
    }
    if (!s.stall()) return null;
  }
  while (s.head[0] !== W) {
    if (--budget < 0) return null;
    const path = s.bfs((n) => n[0] === W, true);
    if (path && s.legal(path[0], true)) s.move(path[0]);
    else if (!s.stall(true)) return null;
  }
  return s.P;
}

// Fallback: sweep columns left to right, never revisiting a cell.
function sweepRoute(W, colHasEgg) {
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
  P.push([W, r]);
  return P;
}

function plan(cells, route) {
  const minCol = Math.min(...cells.map((c) => c.col));
  cells = cells.map((c) => ({ ...c, col: c.col - minCol }));
  const W = Math.max(...cells.map((c) => c.col)) + 1;
  const eggs = new Map(cells.filter((c) => c.level > 0).map((c) => [key(c.col, c.row), c]));

  let P;
  if (route === "hunt") P = huntRoute(W, eggs.keys());
  const used = P ? "hunt" : "sweep";
  if (!P) {
    const colHasEgg = Array.from({ length: W }, (_, c) => cells.some((x) => x.col === c && x.level > 0));
    P = sweepRoute(W, colHasEgg);
  }
  P = P.slice();
  const N = P.length; // head has left the grid at P[N-1]

  const eatStep = new Map(); // egg key -> step at which the head reaches it
  P.forEach(([c, y], t) => {
    const k = key(c, y);
    if (eggs.has(k) && !eatStep.has(k)) eatStep.set(k, t);
  });

  const maxLen = START_LEN + Math.floor(eggs.size / GROW_EVERY);
  const F = N + maxLen + PAUSE; // frames per loop: tail must be fully off-grid before the seam

  // Walk off to the right, then hop above the grid to meet P[0] off-screen.
  let [x, r] = P[N - 1];
  while (P.length < F - 1) P.push([++x, r]);
  P.push([x + 1, -2]);

  const lenAt = new Array(F);
  let eaten = 0;
  for (let t = 0; t < F; t++) {
    if (t < N && eatStep.get(key(...P[t])) === t) eaten++;
    lenAt[t] = START_LEN + Math.floor(eaten / GROW_EVERY);
  }

  // step at which segment i first exists
  const bornAt = Array.from({ length: maxLen }, (_, i) => lenAt.findIndex((l) => l > i));

  return { W, cells, eggs, eatStep, P, N, F, lenAt, bornAt, maxLen, used };
}

function validate({ W, eggs, eatStep, P, F, lenAt, maxLen }) {
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
  const { W, cells, eggs, eatStep, P, F, bornAt, maxLen } = p;
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
  css.push(`@keyframes shine{0%,100%{opacity:.25}50%{opacity:.7}}.glow{animation:shine 2.4s ease-in-out infinite}`);

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
    const gold = c.level >= GOLD_LEVEL;
    const glow = gold ? `<ellipse class="glow" rx="7.5" ry="8.5" fill="#ffc83d" filter="url(#blur)"/>` : "";
    const stroke = theme.eggStroke[c.level];
    eggEls.push(
      `<g transform="translate(${px(c.col) + CELL / 2} ${px(c.row) + CELL / 2})">` +
        `<g class="e" style="animation-name:e${j}">${glow}` +
        `<path d="${EGG}" fill="url(#g${c.level})"${stroke === "none" ? "" : ` stroke="${stroke}" stroke-width="0.8"`}/>` +
        `</g></g>`
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
    .map((col, lvl) => {
      if (!col) return "";
      const stops = Array.isArray(col)
        ? col.map((c, i) => `<stop offset="${i / (col.length - 1)}" stop-color="${c}"/>`).join("")
        : `<stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="${col}"/>`;
      return `<radialGradient id="g${lvl}" cx="35%" cy="30%" r="80%">${stops}</radialGradient>`;
    })
    .join("");

  const grid = cells
    .map((c) => `<rect x="${px(c.col)}" y="${px(c.row)}" width="${CELL}" height="${CELL}" rx="2.5"/>`)
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
<defs>${gradients}<filter id="blur" x="-1" y="-1" width="3" height="3"><feGaussianBlur stdDeviation="2.5"/></filter><clipPath id="clip"><rect x="${PAD - 2}" y="${PAD - 2}" width="${W * PITCH}" height="${ROWS * PITCH}"/></clipPath></defs>
<style>${css.join("")}</style>
<g fill="${theme.empty}">${grid}</g>
<g>${eggEls.join("")}</g>
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
let p = plan(cells, "hunt");
try {
  validate(p);
} catch (err) {
  console.warn(`hunt route rejected (${err.message}); using sweep route`);
  p = plan(cells, "sweep");
  validate(p);
}
await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, "github-snake-dark.svg"), render(p, THEMES.dark));
await writeFile(join(outDir, "github-snake.svg"), render(p, THEMES.light));
const gold = [...p.eggs.values()].filter((c) => c.level >= GOLD_LEVEL).length;
console.log(
  `${p.used} route: ${p.eggs.size} eggs (${gold} gold), snake grows ${START_LEN} -> ${p.maxLen}, ` +
    `loop ${(p.F * STEP).toFixed(1)}s -> ${outDir}/`
);
