// The DocSaathi pulse: a living background that shows what Alexa is doing.
// - Behind the page: the doctor network (clinics are nodes; when Alexa searches, messages fly between
//   them, like UHI calls), medical crosses floating up, and an ECG heartbeat line along the bottom.
// - On the Echo Show's idle screen: a DNA helix hologram under the clock.
// Everything beats with one heart: calm when idle, faster and violet while Alexa thinks, red in an
// emergency, a green burst when a booking is done. Plain canvas 2D, no libraries. With "reduce
// motion" switched on in the system, it draws one still picture.

export type Mood = 'idle' | 'listening' | 'thinking' | 'speaking';
type Rgb = [number, number, number];

const TEAL: Rgb = [63, 198, 189];
const CYAN: Rgb = [90, 216, 255];
const VIOLET: Rgb = [150, 130, 255];
const RED: Rgb = [255, 84, 104];
const GREEN: Rgb = [92, 230, 140];

// bpm: the heartbeat; pulses: messages per second on the network; spin: how fast the helix turns.
const MOODS: Record<Mood, { bpm: number; pulses: number; spin: number; tint: Rgb }> = {
  idle: { bpm: 64, pulses: 0.7, spin: 0.35, tint: TEAL },
  listening: { bpm: 74, pulses: 1.4, spin: 0.55, tint: CYAN },
  thinking: { bpm: 90, pulses: 7, spin: 1.4, tint: VIOLET },
  speaking: { bpm: 76, pulses: 1.8, spin: 0.6, tint: TEAL },
};

let mood: Mood = 'idle';
let alert: { kind: 'booked' | 'emergency'; until: number } | null = null;
const tint: Rgb = [...TEAL];
let beat = 0; // 1 right after each heartbeat, then fades
let still = false;

export function setMood(next: Mood): void {
  mood = next;
}

/** A booking is done (green burst) or emergency words were heard (red alert). */
export function flash(kind: 'booked' | 'emergency'): void {
  alert = { kind, until: performance.now() + (kind === 'emergency' ? 9000 : 2600) };
  if (kind === 'booked') burst = 1;
  if (still) drawAll(0);
}

const col = (c: Rgb, a: number) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${Math.max(0, Math.min(1, a)).toFixed(3)})`;
const mix = (a: Rgb, b: Rgb, k: number): Rgb => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];

function targetTint(): Rgb {
  if (alert?.kind === 'emergency') return RED;
  if (alert?.kind === 'booked') return GREEN;
  return MOODS[mood].tint;
}

function bpm(): number {
  return alert?.kind === 'emergency' ? 128 : MOODS[mood].bpm;
}

// ---------------------------------------------------------------------------
// Canvas surfaces that follow their element's size (sharp on high-density screens)

interface Surface {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  w: number;
  h: number;
  dpr: number;
}

function surface(canvas: HTMLCanvasElement, maxDpr: number, onResize: (s: Surface) => void): Surface {
  const s: Surface = { canvas, ctx: canvas.getContext('2d')!, w: 0, h: 0, dpr: 1 };
  const fit = () => {
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    s.dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
    s.w = r.width;
    s.h = r.height;
    canvas.width = Math.round(r.width * s.dpr);
    canvas.height = Math.round(r.height * s.dpr);
    onResize(s);
    if (still) drawAll(0);
  };
  new ResizeObserver(fit).observe(canvas);
  fit();
  return s;
}

function begin(s: Surface): CanvasRenderingContext2D {
  const { ctx } = s;
  ctx.setTransform(s.dpr, 0, 0, s.dpr, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, s.w, s.h);
  ctx.globalCompositeOperation = 'lighter'; // overlapping light adds up: the glow
  return ctx;
}

// A soft neon glow, drawn once per colour and reused (much cheaper than shadowBlur).
const sprites = new Map<string, HTMLCanvasElement>();
function glow(c: Rgb): HTMLCanvasElement {
  const key = `${c[0] >> 3},${c[1] >> 3},${c[2] >> 3}`;
  let sprite = sprites.get(key);
  if (!sprite) {
    if (sprites.size > 200) sprites.clear();
    sprite = document.createElement('canvas');
    sprite.width = sprite.height = 64;
    const g = sprite.getContext('2d')!;
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, col(c, 0.9));
    grad.addColorStop(0.22, col(c, 0.45));
    grad.addColorStop(1, col(c, 0));
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    sprites.set(key, sprite);
  }
  return sprite;
}

const WHITE: Rgb = [255, 255, 255];

function dot(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, c: Rgb, a: number): void {
  const size = r * 8;
  ctx.globalAlpha = Math.max(0, Math.min(1, a));
  ctx.drawImage(glow(c), x - size / 2, y - size / 2, size, size);
  ctx.globalAlpha = 1;
  ctx.fillStyle = col(mix(c, WHITE, 0.55), a);
  ctx.beginPath();
  ctx.arc(x, y, r * 0.65, 0, Math.PI * 2);
  ctx.fill();
}

function cross(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, rot: number, c: Rgb, a: number): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.fillStyle = col(c, a);
  const t = size / 3;
  ctx.fillRect(-t / 2, -size / 2, t, size);
  ctx.fillRect(-size / 2, -t / 2, size, t);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// The heart: one ECG beat (P, QRS, T) over phase 0..1

function ecg(p: number): number {
  const g = (c: number, w: number, a: number) => a * Math.exp(-((p - c) ** 2) / (2 * w * w));
  return g(0.12, 0.025, 0.12) - g(0.205, 0.008, 0.18) + g(0.225, 0.009, 1) - g(0.245, 0.009, 0.3) + g(0.42, 0.045, 0.22);
}

let phase = 0;
let trace: Float32Array = new Float32Array(0); // one value every 2 px
let head = 0;
const STEP = 2;
const SWEEP = 170; // px per second

// ---------------------------------------------------------------------------
// The doctor network behind the page

interface Node {
  x: number;
  y: number;
  vx: number;
  vy: number;
  clinic: boolean;
  hub: boolean; // a hospital: bigger, with a ring on every heartbeat
}
interface Pulse {
  a: number;
  b: number;
  t: number;
  speed: number;
}
interface Floater {
  x: number;
  y: number;
  size: number;
  rot: number;
  vr: number;
  vy: number;
  a: number;
}
interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
}

let nodes: Node[] = [];
let pulses: Pulse[] = [];
let floaters: Floater[] = [];
let sparks: Spark[] = [];
let pulseDebt = 0;
let burst = 0;
const LINK = 150;

function seedNetwork(s: Surface): void {
  const count = Math.round(Math.max(26, Math.min(80, (s.w * s.h) / 21000)));
  nodes = Array.from({ length: count }, () => ({
    x: Math.random() * s.w,
    y: Math.random() * s.h,
    vx: (Math.random() - 0.5) * 12,
    vy: (Math.random() - 0.5) * 12,
    clinic: Math.random() < 0.22,
    hub: false,
  }));
  for (let i = 0; i < Math.max(2, Math.round(count / 18)); i++) Object.assign(nodes[i], { hub: true, clinic: true, vx: nodes[i].vx * 0.4, vy: nodes[i].vy * 0.4 });
  pulses = [];
  floaters = Array.from({ length: Math.round(count / 5) }, () => newFloater(s, Math.random() * s.h));
  trace = new Float32Array(Math.ceil(s.w / STEP) + 2);
  head = 0;
}

function newFloater(s: Surface, y = s.h + 20): Floater {
  return { x: Math.random() * s.w, y, size: 6 + Math.random() * 9, rot: Math.random(), vr: (Math.random() - 0.5) * 0.3, vy: 8 + Math.random() * 14, a: 0.05 + Math.random() * 0.08 };
}

function drawBackground(s: Surface, dt: number): void {
  const ctx = begin(s);
  const c = tint;
  const m = MOODS[mood];

  // Links and the messages travelling on them
  for (const n of nodes) {
    n.x += n.vx * dt;
    n.y += n.vy * dt;
    if (n.x < -20) n.x = s.w + 20;
    if (n.x > s.w + 20) n.x = -20;
    if (n.y < -20) n.y = s.h + 20;
    if (n.y > s.h + 20) n.y = -20;
  }
  ctx.lineWidth = 1;
  const near: Array<[number, number]> = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const dx = nodes[i].x - nodes[j].x;
      const dy = nodes[i].y - nodes[j].y;
      const d = Math.hypot(dx, dy);
      if (d > LINK) continue;
      near.push([i, j]);
      ctx.strokeStyle = col(c, (1 - d / LINK) * (0.14 + 0.1 * beat));
      ctx.beginPath();
      ctx.moveTo(nodes[i].x, nodes[i].y);
      ctx.lineTo(nodes[j].x, nodes[j].y);
      ctx.stroke();
    }
  }
  pulseDebt += dt * (alert?.kind === 'emergency' ? 3 : m.pulses);
  while (pulseDebt >= 1 && near.length) {
    pulseDebt -= 1;
    const [a, b] = near[Math.floor(Math.random() * near.length)];
    pulses.push(Math.random() < 0.5 ? { a, b, t: 0, speed: 0.7 + Math.random() } : { a: b, b: a, t: 0, speed: 0.7 + Math.random() });
  }
  if (!near.length) pulseDebt = 0;
  pulses = pulses.filter((p) => {
    p.t += dt * p.speed;
    const A = nodes[p.a];
    const B = nodes[p.b];
    if (p.t >= 1 || Math.hypot(A.x - B.x, A.y - B.y) > LINK * 1.3) return false;
    const x = A.x + (B.x - A.x) * p.t;
    const y = A.y + (B.y - A.y) * p.t;
    const tx = A.x + (B.x - A.x) * Math.max(0, p.t - 0.12);
    const ty = A.y + (B.y - A.y) * Math.max(0, p.t - 0.12);
    ctx.strokeStyle = col(c, 0.35);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.lineTo(x, y);
    ctx.stroke();
    ctx.lineWidth = 1;
    dot(ctx, x, y, 1.8, CYAN, 0.9);
    return true;
  });

  // Nodes: clinics are small crosses, the rest are dots
  for (const n of nodes) {
    if (n.hub) {
      const ring = 8 + (1 - beat) * 34;
      ctx.strokeStyle = col(c, beat * 0.45);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(n.x, n.y, ring, 0, Math.PI * 2);
      ctx.stroke();
      ctx.lineWidth = 1;
      dot(ctx, n.x, n.y, 3, c, 0.35 + 0.3 * beat);
      cross(ctx, n.x, n.y, 13, 0, mix(c, WHITE, 0.4), 0.55 + 0.3 * beat);
    } else if (n.clinic) cross(ctx, n.x, n.y, 9, 0, c, 0.34 + 0.25 * beat);
    else dot(ctx, n.x, n.y, 1.5, c, 0.42 + 0.25 * beat);
  }

  // Medical crosses floating up
  for (const f of floaters) {
    f.y -= f.vy * dt;
    f.rot += f.vr * dt;
    if (f.y < -30) Object.assign(f, newFloater(s));
    cross(ctx, f.x, f.y, f.size, f.rot, c, f.a);
  }

  // ECG line along the bottom, written like a hospital monitor
  const bps = bpm() / 60;
  const cols = trace.length;
  const advance = (SWEEP * dt) / STEP;
  const from = phase;
  phase += dt * bps;
  const steps = Math.max(1, Math.round(advance));
  for (let k = 1; k <= steps; k++) {
    const p = (from + ((phase - from) * k) / steps) % 1;
    head = (head + 1) % cols;
    trace[head] = ecg(p);
  }
  if (Math.floor(phase) !== Math.floor(from)) beat = 1;
  const base = s.h - Math.min(90, s.h * 0.12);
  const amp = alert?.kind === 'emergency' ? 34 : 26;
  ctx.lineWidth = 2;
  const chunks = 24;
  const per = Math.ceil(cols / chunks);
  for (let ci = 0; ci < chunks; ci++) {
    ctx.strokeStyle = col(c, (1 - ci / chunks) * 0.55);
    ctx.beginPath();
    let started = false;
    for (let k = ci * per; k <= Math.min(cols - 12, (ci + 1) * per); k++) {
      const idx = (head - k + cols) % cols;
      const x = idx * STEP;
      const y = base - trace[idx] * amp;
      if (!started || idx === cols - 1) {
        ctx.moveTo(x, y);
        started = true;
      } else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  dot(ctx, head * STEP, base - trace[head] * amp, 2.5, c, 1);

  // Emergency: a red glow pulsing at the edges with each fast beat
  if (alert?.kind === 'emergency') {
    ctx.globalCompositeOperation = 'source-over';
    const g = ctx.createRadialGradient(s.w / 2, s.h / 2, Math.min(s.w, s.h) * 0.35, s.w / 2, s.h / 2, Math.max(s.w, s.h) * 0.75);
    g.addColorStop(0, col(RED, 0));
    g.addColorStop(1, col(RED, 0.1 + 0.18 * beat));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s.w, s.h);
  }
}

// ---------------------------------------------------------------------------
// The DNA helix on the Echo Show's idle screen

let spin = 0;

function drawHero(s: Surface, dt: number, t: number): void {
  const ctx = begin(s);
  const c = tint;
  spin += dt * (alert?.kind === 'emergency' ? 2.6 : MOODS[mood].spin) * 2.2;
  const n = 60;
  const cy = s.h * 0.8;
  let R = Math.max(8, s.h * 0.075) * (1 + 0.18 * beat);
  if (mood === 'speaking') R *= 1 + 0.22 * Math.sin(t * 9) * Math.sin(t * 2.3);
  if (mood === 'listening') R *= 1.12;
  const left = s.w * 0.05;
  const span = s.w * 0.9;
  const scale = Math.max(0.6, s.w / 900);
  const scanX = mood === 'thinking' ? left + ((t * 0.45) % 1) * span : -1e9;

  // A soft hologram light behind the clock, breathing with the heartbeat
  const halo = ctx.createRadialGradient(s.w / 2, s.h * 0.42, 0, s.w / 2, s.h * 0.42, s.w * 0.38);
  halo.addColorStop(0, col(c, 0.1 + 0.07 * beat));
  halo.addColorStop(1, col(c, 0));
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, s.w, s.h);

  const pts: Array<{ x: number; y: number; z: number }> = [];
  for (let i = 0; i < n; i++) {
    const x = left + (i * span) / (n - 1);
    const a = i * 0.34 + spin;
    for (let k = 0; k < 2; k++) {
      const ang = a + k * Math.PI;
      pts.push({ x, y: cy + Math.sin(ang) * R, z: (Math.cos(ang) + 1) / 2 });
    }
    // Base pairs: the rungs of the ladder
    if (i % 3 === 0) {
      const p = pts[pts.length - 2];
      const q = pts[pts.length - 1];
      ctx.strokeStyle = col(c, 0.1 + 0.18 * Math.min(p.z, q.z));
      ctx.lineWidth = 1.2 * scale;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(q.x, q.y);
      ctx.stroke();
    }
  }
  // The two backbones of the DNA
  for (let k = 0; k < 2; k++) {
    ctx.strokeStyle = col(c, 0.22);
    ctx.lineWidth = 1.4 * scale;
    ctx.beginPath();
    for (let i = k; i < pts.length; i += 2) {
      if (i === k) ctx.moveTo(pts[i].x, pts[i].y);
      else ctx.lineTo(pts[i].x, pts[i].y);
    }
    ctx.stroke();
  }
  for (const p of pts) {
    const near = Math.max(0, 1 - Math.abs(p.x - scanX) / 40);
    const color = near > 0 ? mix(c, CYAN, near) : c;
    dot(ctx, p.x, p.y, (1 + 2.2 * p.z) * scale * (1 + near * 0.8), color, 0.2 + 0.7 * p.z + near * 0.4);
  }

  // Thinking: a scan bar moving along the helix
  if (scanX > 0) {
    const g = ctx.createLinearGradient(scanX - 30, 0, scanX + 30, 0);
    g.addColorStop(0, col(CYAN, 0));
    g.addColorStop(0.5, col(CYAN, 0.25));
    g.addColorStop(1, col(CYAN, 0));
    ctx.fillStyle = g;
    ctx.fillRect(scanX - 30, cy - R * 2.2, 60, R * 4.4);
  }

  // Listening: light rises from the helix, like sound being taken in
  if (mood === 'listening' && Math.random() < dt * 30) {
    sparks.push({ x: left + Math.random() * span, y: cy, vx: (Math.random() - 0.5) * 10, vy: -30 - Math.random() * 40, life: 1 });
  }
  // Booked: a burst of light from the middle
  if (burst > 0) {
    for (let i = 0; i < 70; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = 60 + Math.random() * 220;
      sparks.push({ x: s.w / 2, y: cy, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 40, life: 1 });
    }
    burst = 0;
  }
  sparks = sparks.filter((p) => {
    p.life -= dt * 0.9;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vy += 30 * dt;
    if (p.life <= 0) return false;
    dot(ctx, p.x, p.y, 1.6 * scale, alert?.kind === 'booked' ? GREEN : c, p.life * 0.8);
    return true;
  });

  // Faint scan lines: the hologram look
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = 'rgba(0, 0, 0, 0.16)';
  for (let y = (t * 12) % 3; y < s.h; y += 3) ctx.fillRect(0, y, s.w, 1);
}

// ---------------------------------------------------------------------------
// The loop

let bg: Surface | undefined;
let hero: Surface | undefined;
let last = 0;

function drawAll(dt: number): void {
  const now = performance.now();
  if (alert && now > alert.until) alert = null;
  const target = targetTint();
  const k = still ? 1 : Math.min(1, dt * 3);
  for (let i = 0; i < 3; i++) tint[i] += (target[i] - tint[i]) * k;
  beat = Math.max(0, beat - dt * 2.2);
  if (bg) drawBackground(bg, dt);
  // The helix only while the idle screen shows (an app screen covers it otherwise)
  if (hero && hero.canvas.offsetParent !== null) drawHero(hero, dt, now / 1000);
}

export function startFx(bgCanvas: HTMLCanvasElement, heroCanvas: HTMLCanvasElement): void {
  still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  bg = surface(bgCanvas, 1.5, seedNetwork);
  hero = surface(heroCanvas, 2, () => undefined);
  if (still) {
    // One still picture: the network, a full heartbeat on the monitor, and the helix
    for (let i = 0; i < 90; i++) drawAll(1 / 30);
    return;
  }
  const frame = (time: number) => {
    const dt = last ? Math.min(0.05, (time - last) / 1000) : 1 / 60;
    last = time;
    drawAll(dt);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
