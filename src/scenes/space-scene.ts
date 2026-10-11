import Phaser from 'phaser';
import { GameState, type Door, type Room, type RoomKind } from '@/sim/game-state';
import { hud, ui } from '@/ui/hud';

// Tilted top-down projection: grid (x, y) plus height z -> screen. The 2:1 ratio gives the 2.5D look.
const TW = 96;
const TH = 48;
const WALL = 34;
const DIRS: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const HULL = 0x1b2236;
const DARK = 0x0a0f1c;
const ACCENT: Record<RoomKind, number> = {
  core: 0x3fd0c4,
  life: 0x7ee08a,
  lab: 0xb48cff,
  dock: 0xf5c451,
  quarters: 0x7fb2ff,
  hydro: 0x4fe0a8,
  workshop: 0xe8a04a,
  medbay: 0xf08ac8,
};

type Pt = [number, number];
const project = (x: number, y: number, z = 0): Pt => [((x - y) * TW) / 2, ((x + y) * TH) / 2 - z];
const unproject = (sx: number, sy: number): Pt => {
  const a = sx / (TW / 2);
  const b = sy / (TH / 2);
  return [(a + b) / 2, (b - a) / 2];
};

// Linear blend between two 0xRRGGBB colors.
const mix = (a: number, b: number, t: number): number => {
  let out = 0;
  for (const shift of [16, 8, 0]) {
    const ca = (a >> shift) & 255;
    const cb = (b >> shift) & 255;
    out = (out << 8) | Math.round(ca + (cb - ca) * t);
  }
  return out;
};

export class SpaceScene extends Phaser.Scene {
  private state!: GameState;
  private g!: Phaser.GameObjects.Graphics;
  private hover: Pt | null = null;
  private press: { x: number; y: number; scrollX: number; scrollY: number; moved: boolean } | null = null;
  private clock = 0;
  private pinchDist = 0;
  private lastSheet = 0;
  private fingers = new Map<number, { x: number; y: number }>();

  constructor() {
    super('space');
  }

  create(): void {
    this.state = new GameState();
    hud.init(this.state);
    this.g = this.add.graphics();

    this.fitView();
    this.scale.on(Phaser.Scale.Events.RESIZE, this.fitView, this);

    const canvas = this.game.canvas;
    window.addEventListener('pointerdown', e => {
      if (e.target === canvas) this.fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    });
    window.addEventListener('pointermove', e => {
      if (this.fingers.has(e.pointerId)) this.fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    });
    const release = (e: PointerEvent): void => {
      this.fingers.delete(e.pointerId);
    };
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    const cam = this.cameras.main;

    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      this.press = { x: p.x, y: p.y, scrollX: cam.scrollX, scrollY: cam.scrollY, moved: false };
    });
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      this.hover = this.cellAt(p);
      if (!p.isDown || !this.press) return;
      const dx = p.x - this.press.x;
      const dy = p.y - this.press.y;
      if (Math.hypot(dx, dy) > 6) this.press.moved = true;
      if (this.press.moved) {
        cam.scrollX = this.press.scrollX - dx / cam.zoom;
        cam.scrollY = this.press.scrollY - dy / cam.zoom;
      }
    });
    this.input.on('pointerup', (p: Phaser.Input.Pointer) => {
      if (this.press && !this.press.moved) this.click(p);
      this.press = null;
    });
    this.input.on('wheel', (_p: unknown, _over: unknown, _dx: number, dy: number) => {
      cam.setZoom(Phaser.Math.Clamp(cam.zoom * (dy > 0 ? 0.9 : 1.1), 0.6, 2.4));
    });
  }

  update(_time: number, delta: number): void {
    const dt = Math.min(delta, 100) / 1000;
    this.clock += dt;
    this.pinch();
    const sheet = this.openSheetPx();
    if (sheet !== this.lastSheet) {
      this.lastSheet = sheet;
      this.fitView();
    }
    this.state.step(dt);
    this.draw();
    hud.tick(dt);
  }

  /** How many screen pixels an open phone menu covers at the bottom (0 when none is open). */
  private openSheetPx(): number {
    const panel = document.querySelector<HTMLElement>('.panel.open');
    return panel ? Math.round(window.innerHeight - panel.getBoundingClientRect().top) : 0;
  }

  /**
   * Fit the whole station into the area not covered by an open menu, and centre it there.
   * Runs on load, on resize, and whenever a menu opens or closes.
   */
  private fitView(): void {
    const { width, height } = this.scale;
    const sheet = this.openSheetPx();
    const cam = this.cameras.main;
    const zoom = Math.min(width / 700, (height - sheet) / 600);
    cam.setZoom(Phaser.Math.Clamp(zoom, 0.7, 1.3));
    // Move the camera down by half the covered area so the station lands in the visible part.
    cam.centerOn(0, 24 + sheet / (2 * cam.zoom));
  }

  /**
   * Two fingers on the canvas: scale the zoom by how far apart they move.
   * Pointers are tracked here, not via Phaser's list, because a release that lands on the
   * HUD overlay can leave a pointer stuck "down" and turn every tap into a pinch.
   */
  private pinch(): void {
    const pts = [...this.fingers.values()];
    if (pts.length < 2) {
      this.pinchDist = 0;
      return;
    }
    const [a, b] = pts;
    const dist = Phaser.Math.Distance.Between(a.x, a.y, b.x, b.y);
    const cam = this.cameras.main;
    if (this.pinchDist > 0) cam.setZoom(Phaser.Math.Clamp(cam.zoom * (dist / this.pinchDist), 0.6, 2.4));
    this.pinchDist = dist;
    if (this.press) this.press.moved = true; // a pinch is never a tap
  }

  private cellAt(p: Phaser.Input.Pointer): Pt {
    const [gx, gy] = unproject(p.worldX, p.worldY);
    return [Math.floor(gx), Math.floor(gy)];
  }

  private click(p: Phaser.Input.Pointer): void {
    hud.closeSheets(); // tapping the station gets the menu out of the way
    for (const d of this.state.doors) {
      const e = this.doorEdge(d);
      const [sx, sy] = project(e.mx, e.my, WALL / 2);
      if (Math.hypot(sx - p.worldX, sy - p.worldY) < 24) {
        this.state.toggleDoor(d.id);
        hud.render();
        return;
      }
    }
    const [x, y] = this.cellAt(p);
    const res = this.state.requestBuild(x, y, ui.buildKind);
    if (!res.ok) hud.toast(res.msg); // say why, so a missed tap or a shortage is never silent
    hud.render();
  }

  private doorEdge(d: Door): { mx: number; my: number; alongY: boolean } {
    const a = this.state.room(d.a);
    const b = this.state.room(d.b);
    return { mx: (a.x + b.x + 1) / 2, my: (a.y + b.y + 1) / 2, alongY: a.x !== b.x };
  }

  private top(x: number, y: number, z: number): Pt[] {
    return [project(x, y, z), project(x + 1, y, z), project(x + 1, y + 1, z), project(x, y + 1, z)];
  }

  private poly(pts: Pt[], fill: number, alpha: number, line?: number, lineAlpha = 1): void {
    const g = this.g;
    g.beginPath();
    g.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
    g.closePath();
    g.fillStyle(fill, alpha);
    g.fillPath();
    if (line !== undefined) {
      g.lineStyle(1.25, line, lineAlpha);
      g.strokePath();
    }
  }

  private draw(): void {
    const g = this.g;
    g.clear();
    const s = this.state;

    // Build slots: empty cells touching the station, glowing in the chosen chamber color.
    const slots = new Map<string, Pt>();
    for (const r of s.rooms) {
      for (const [dx, dy] of DIRS) {
        const x = r.x + dx;
        const y = r.y + dy;
        if (s.canBuild(x, y)) slots.set(`${x},${y}`, [x, y]);
      }
    }
    // Neutral slots: red is reserved for closed doors and breaches.
    const slotColor = 0x9fb3d9;
    for (const [x, y] of slots.values()) {
      const hot = this.hover !== null && this.hover[0] === x && this.hover[1] === y;
      this.poly(this.top(x, y, 0), slotColor, hot ? 0.25 : 0.06, slotColor, hot ? 1 : 0.4);
    }

    // Queued chambers: an outline of the finished chamber, a pulsing block rising as the
    // engineers progress, and a progress bar above it.
    for (const b of s.builds) {
      const accent = ACCENT[b.kind];
      const pulse = 0.75 + 0.25 * Math.sin(this.clock * 6);
      const x = b.x;
      const y = b.y;
      const h = 12 + (WALL - 12) * b.progress;
      this.poly(this.top(x, y, WALL), accent, 0, accent, 0.9); // finished height
      this.poly(
        [project(x + 1, y, 0), project(x + 1, y + 1, 0), project(x + 1, y + 1, h), project(x + 1, y, h)],
        mix(DARK, accent, 0.35),
        0.8 * pulse,
      );
      this.poly(
        [project(x, y + 1, 0), project(x + 1, y + 1, 0), project(x + 1, y + 1, h), project(x, y + 1, h)],
        mix(DARK, accent, 0.2),
        0.8 * pulse,
      );
      this.poly(this.top(x, y, h), accent, 0.85 * pulse, accent, 1);
      const [cx, cy] = project(x + 0.5, y + 0.5, WALL + 16);
      g.fillStyle(0x2a3550, 0.95);
      g.fillRect(cx - 36, cy - 5, 72, 10);
      g.fillStyle(accent, 1);
      g.fillRect(cx - 36, cy - 5, 72 * b.progress, 10);
    }

    // Back-to-front so nearer chambers overlap farther ones.
    const rooms = [...s.rooms].sort((a, b) => a.x + a.y - (b.x + b.y));
    for (const r of rooms) this.drawRoom(r);
    for (const d of s.doors) this.drawDoor(d);
  }

  private drawRoom(r: Room): void {
    const accent = ACCENT[r.kind];
    const x = r.x;
    const y = r.y;
    const lit = mix(HULL, accent, 0.15 + 0.6 * (r.o2 / 100));
    const pulse = (Math.sin(this.clock * 9) + 1) / 2;
    const top = r.breach > 0 ? mix(lit, 0xff4d4d, 0.35 + 0.5 * pulse) : lit;

    this.poly(
      [project(x + 1, y, 0), project(x + 1, y + 1, 0), project(x + 1, y + 1, WALL), project(x + 1, y, WALL)],
      mix(DARK, accent, 0.35),
      1,
    );
    this.poly(
      [project(x, y + 1, 0), project(x + 1, y + 1, 0), project(x + 1, y + 1, WALL), project(x, y + 1, WALL)],
      mix(DARK, accent, 0.2),
      1,
    );
    this.poly(this.top(x, y, WALL), top, 1, accent, 0.8);

    const [cx, cy] = project(x + 0.5, y + 0.5, WALL);
    this.g.fillStyle(accent, 0.9);
    this.g.fillCircle(cx, cy, 4);
  }

  private drawDoor(d: Door): void {
    const e = this.doorEdge(d);
    const h = WALL * 0.8;
    const [ax, ay, bx, by] = e.alongY
      ? [e.mx, e.my - 0.3, e.mx, e.my + 0.3]
      : [e.mx - 0.3, e.my, e.mx + 0.3, e.my];
    const color = d.open ? 0x6ee7a0 : 0xff6b6b;
    this.poly(
      [project(ax, ay, 2), project(bx, by, 2), project(bx, by, h), project(ax, ay, h)],
      color,
      d.open ? 0.35 : 0.95,
      color,
    );
  }
}
