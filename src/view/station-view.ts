import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { Build, Door, GameState, Job, Room, RoomKind, Worker } from '@/sim/game-state';
import { hud, ui } from '@/ui/hud';

const S = 2.2; // world units per grid cell
const WALL_H = 1.1;
const TILT = THREE.MathUtils.degToRad(60); // camera angle above the floor
const FOV = 35;
const WALK_SPEED = 2.4;
const HULL = 0x1b2236;
const WALL_COLOR = 0x3a4766;
const SLOT_COLOR = 0x3fd0c4;
const BG = 0x070b14;
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
const JOB_COLOR: Record<Job, number> = {
  engineer: 0xffb020,
  salvage: 0x7fdcff,
  research: 0xb48cff,
  trade: 0xf5c451,
  idle: 0x9fb3d9,
};

// Quaternius Sci-Fi Essentials Kit (CC0), copied into public/assets/models/glTF.
const PROP_NAMES = [
  'Prop_Barrel1',
  'Prop_Chair',
  'Prop_Chest',
  'Prop_Crate',
  'Prop_Crate_Large',
  'Prop_Desk_Medium',
  'Prop_Desk_Small',
  'Prop_HealthPack',
  'Prop_Locker',
  'Prop_Mug',
  'Prop_SatelliteDish',
  'Prop_Shelves_WideTall',
  'Prop_Syringe',
] as const;
type PropName = (typeof PROP_NAMES)[number];
type Models = Partial<Record<PropName, THREE.Object3D>>;

/** Props per chamber type: [model, size, x, z] with x, z in cell units from -0.5 to 0.5. */
const FURNISH: Record<RoomKind, [PropName, number, number, number][]> = {
  core: [['Prop_Crate', 0.5, -0.3, -0.3], ['Prop_Crate_Large', 0.6, 0.3, 0.25], ['Prop_Chest', 0.4, -0.25, 0.3]],
  life: [['Prop_Barrel1', 0.45, -0.3, -0.25], ['Prop_Barrel1', 0.45, 0.25, 0.3]],
  lab: [['Prop_Desk_Medium', 0.7, 0, -0.2], ['Prop_Chair', 0.3, 0, 0.15], ['Prop_SatelliteDish', 0.5, 0.3, 0.3]],
  dock: [['Prop_Crate_Large', 0.6, -0.25, -0.2], ['Prop_Crate', 0.45, 0.25, 0.2], ['Prop_Barrel1', 0.4, 0.25, -0.3]],
  quarters: [['Prop_Locker', 0.6, -0.3, -0.3], ['Prop_Shelves_WideTall', 0.7, 0.3, 0.2], ['Prop_Mug', 0.15, 0, 0.1]],
  hydro: [['Prop_Barrel1', 0.4, -0.3, -0.3], ['Prop_Crate', 0.4, 0.3, 0.3]],
  workshop: [['Prop_Desk_Small', 0.6, -0.2, -0.25], ['Prop_Chair', 0.3, 0.25, 0.2], ['Prop_Crate', 0.45, 0.3, -0.3]],
  medbay: [['Prop_Desk_Small', 0.6, 0, -0.25], ['Prop_HealthPack', 0.3, 0.3, 0.25], ['Prop_Syringe', 0.25, -0.3, 0.25]],
};

type Cell = [number, number];
const DIRS: Cell[] = [[1, 0], [-1, 0], [0, 1], [0, -1]];

interface RoomView { floorMat: THREE.MeshStandardMaterial }
interface DoorView { panel: THREE.Mesh; mat: THREE.MeshStandardMaterial; openness: number; alongZ: boolean }
interface BuildView {
  group: THREE.Group;
  block: THREE.Mesh;
  blockMat: THREE.MeshStandardMaterial;
  bar: THREE.Group;
  fill: THREE.Mesh;
}
interface WorkerView {
  group: THREE.Group;
  torso: THREE.Mesh;
  head: THREE.Mesh;
  pack: THREE.Mesh;
  packMat: THREE.MeshStandardMaterial;
  legs: THREE.Group[];
  pos: THREE.Vector3;
  route: { p: THREE.Vector3; room?: number }[];
  atRoom: number;
  goal: string;
  phase: number;
}

/** Loads the kit props. Anything that fails to load is replaced by a plain box. */
export async function loadModels(): Promise<Models> {
  const loader = new GLTFLoader();
  const models: Models = {};
  await Promise.all(
    PROP_NAMES.map(async name => {
      try {
        const gltf = await loader.loadAsync(`${import.meta.env.BASE_URL}assets/models/glTF/${name}.gltf`);
        models[name] = gltf.scene;
      } catch {
        // missing model: makeProp falls back to a box
      }
    }),
  );
  return models;
}

const cellCentre = (x: number, y: number): [number, number] => [(x + 0.5) * S, (y + 0.5) * S];
/** Midpoint of the wall between two neighbouring cells. */
const boundary = (ax: number, ay: number, bx: number, by: number): [number, number] => [
  ((ax + bx + 1) / 2) * S,
  ((ay + by + 1) / 2) * S,
];
const edgeKey = (ax: number, ay: number, bx: number, by: number): string => {
  const a = `${ax},${ay}`;
  const b = `${bx},${by}`;
  return a < b ? `${a}|${b}` : `${b}|${a}`;
};
const mix = (a: number, b: number, t: number): number => new THREE.Color(a).lerp(new THREE.Color(b), t).getHex();

/** Floor texture: a fine panel grid, so rooms read as built structures rather than flat slabs. */
function panelTexture(base: string, line: string, repeat: number): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const g = c.getContext('2d') as CanvasRenderingContext2D;
  g.fillStyle = base;
  g.fillRect(0, 0, 256, 256);
  g.strokeStyle = line;
  g.lineWidth = 4;
  g.strokeRect(0, 0, 256, 256);
  g.beginPath();
  g.moveTo(128, 0);
  g.lineTo(128, 256);
  g.moveTo(0, 128);
  g.lineTo(256, 128);
  g.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  return tex;
}

function shadowify<T extends THREE.Object3D>(obj: T): T {
  obj.traverse(c => {
    if (c instanceof THREE.Mesh) {
      c.castShadow = true;
      c.receiveShadow = true;
    }
  });
  return obj;
}

function makeProp(models: Models, name: PropName, size: number): THREE.Object3D {
  const wrap = new THREE.Group();
  const src = models[name];
  if (!src) {
    const box = new THREE.Mesh(
      new THREE.BoxGeometry(size, size * 0.6, size),
      new THREE.MeshStandardMaterial({ color: 0x5b6b8a }),
    );
    box.position.y = size * 0.3;
    wrap.add(box);
    return shadowify(wrap);
  }
  const obj = src.clone(true);
  const box = new THREE.Box3().setFromObject(obj);
  const extent = Math.max(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z) || 1;
  obj.scale.setScalar(size / extent);
  obj.position.y -= new THREE.Box3().setFromObject(obj).min.y; // stand on the floor
  wrap.add(obj);
  return shadowify(wrap);
}

function makeShip(kind: 'trader' | 'recruiter'): THREE.Group {
  const g = new THREE.Group();
  const hullMat = new THREE.MeshStandardMaterial({ color: 0xc8d2e6, metalness: 0.4, roughness: 0.4 });
  const hull = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.45, 0.6), hullMat);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.7, 8), hullMat);
  nose.rotation.z = -Math.PI / 2;
  nose.position.x = 1.15;
  const glow = kind === 'trader' ? 0xf5c451 : 0x7fdcff;
  const stripe = new THREE.Mesh(
    new THREE.BoxGeometry(1.0, 0.1, 0.62),
    new THREE.MeshStandardMaterial({ color: glow, emissive: glow, emissiveIntensity: 0.6 }),
  );
  stripe.position.y = 0.2;
  g.add(hull, nose, stripe);
  return shadowify(g);
}

function stars(): THREE.Points {
  const pos: number[] = [];
  for (let i = 0; i < 500; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = 80 + Math.random() * 120;
    pos.push(Math.cos(a) * r, 40 + Math.random() * 80, Math.sin(a) * r);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return new THREE.Points(g, new THREE.PointsMaterial({ color: 0xffffff, size: 0.8 }));
}

export class StationView {
  private readonly renderer = new THREE.WebGLRenderer({ antialias: true });
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 500);
  private readonly raycaster = new THREE.Raycaster();
  private readonly rooms = new Map<number, RoomView>();
  private readonly doors = new Map<number, DoorView>();
  private readonly walls = new Map<string, THREE.Mesh>();
  private readonly slots = new Map<string, THREE.Mesh>();
  private readonly builds = new Map<string, BuildView>();
  private readonly workers = new Map<number, WorkerView>();
  private readonly ships = new Map<number, THREE.Group>();
  private readonly fingers = new Map<number, { x: number; y: number }>();
  private readonly pan = new THREE.Vector2();
  private readonly wallMat = new THREE.MeshStandardMaterial({ color: WALL_COLOR, roughness: 0.55, metalness: 0.35 });
  private readonly floorTex = panelTexture('#ffffff', 'rgba(0,0,0,0.35)', 1);
  private readonly blockGeo = new THREE.BoxGeometry(S * 0.96, 1, S * 0.96).translate(0, 0.5, 0);
  private press: { x: number; y: number; moved: boolean } | null = null;
  private pinchDist = 0;
  private zoom = 1;
  private lastDist = 30;
  private hover = '';
  private clock = 0;
  private state: GameState | null = null;

  constructor(
    private readonly container: HTMLElement,
    private readonly models: Models,
  ) {
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(BG);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);
    this.scene.fog = new THREE.Fog(BG, 45, 130);

    this.scene.add(new THREE.HemisphereLight(0xcfe3ff, 0x1a2236, 0.9));
    const sun = new THREE.DirectionalLight(0xfff4e6, 1.8);
    sun.position.set(8, 16, 10);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -22, right: 22, top: 22, bottom: -22, near: 1, far: 60 });
    sun.shadow.bias = -0.0008;
    this.scene.add(sun);

    const groundTex = panelTexture('#0b1020', 'rgba(120,150,200,0.12)', 60);
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(400, 400).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ map: groundTex, roughness: 1 }),
    );
    ground.position.y = -0.02;
    ground.receiveShadow = true;
    this.scene.add(ground, stars());

    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.setupInput();
  }

  /** Called once per animation frame, after the simulation has stepped. */
  frame(dt: number, state: GameState): void {
    this.state = state;
    this.clock += dt;
    this.sync(state);
    this.animate(dt, state);
    this.updateCamera(state);
    this.renderer.render(this.scene, this.camera);
  }

  private resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private sync(state: GameState): void {
    for (const r of state.rooms) if (!this.rooms.has(r.id)) this.createRoom(r);
    this.syncWalls(state);
    for (const d of state.doors) if (!this.doors.has(d.id)) this.createDoor(d, state);
    this.syncSlots(state);
    this.syncBuilds(state);
    this.syncWorkers(state);
    this.syncShips(state);
  }

  private createRoom(r: Room): void {
    const [cx, cz] = cellCentre(r.x, r.y);
    const floorMat = new THREE.MeshStandardMaterial({ color: HULL, map: this.floorTex, roughness: 0.7, metalness: 0.2 });
    const floor = new THREE.Mesh(new THREE.BoxGeometry(S * 0.96, 0.12, S * 0.96), floorMat);
    floor.position.set(cx, 0.06, cz);
    floor.receiveShadow = true;
    const trim = new THREE.LineSegments(
      new THREE.EdgesGeometry(floor.geometry),
      new THREE.LineBasicMaterial({ color: ACCENT[r.kind] }),
    );
    trim.position.copy(floor.position);
    this.scene.add(floor, trim);

    const rot = (r.id % 4) * (Math.PI / 2);
    for (const [name, size, lx, lz] of FURNISH[r.kind]) {
      const p = makeProp(this.models, name, size);
      p.position.set(cx + lx * S, 0.12, cz + lz * S);
      p.rotation.y = rot;
      this.scene.add(p);
    }
    this.rooms.set(r.id, { floorMat });
  }

  /** Walls on every edge that faces empty space; shared edges get a door instead. */
  private syncWalls(state: GameState): void {
    const want = new Map<string, [number, number, number, number]>();
    for (const r of state.rooms) {
      for (const [dx, dy] of DIRS) {
        const nx = r.x + dx;
        const ny = r.y + dy;
        if (state.roomAt(nx, ny)) continue;
        want.set(edgeKey(r.x, r.y, nx, ny), [r.x, r.y, nx, ny]);
      }
    }
    for (const [key, mesh] of this.walls) {
      if (want.has(key)) continue;
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      this.walls.delete(key);
    }
    for (const [key, [rx, ry, ex, ey]] of want) {
      if (this.walls.has(key)) continue;
      const [bx, bz] = boundary(rx, ry, ex, ey);
      const geo =
        ex !== rx
          ? new THREE.BoxGeometry(0.14, WALL_H, S * 0.96)
          : new THREE.BoxGeometry(S * 0.96, WALL_H, 0.14);
      const mesh = new THREE.Mesh(geo, this.wallMat);
      mesh.position.set(bx, WALL_H / 2, bz);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.scene.add(mesh);
      this.walls.set(key, mesh);
    }
  }

  private createDoor(d: Door, state: GameState): void {
    const a = state.room(d.a);
    const b = state.room(d.b);
    const [bx, bz] = boundary(a.x, a.y, b.x, b.y);
    const alongZ = a.x !== b.x;
    const mat = new THREE.MeshStandardMaterial({ color: 0xff6b6b, emissive: 0x330000, transparent: true, opacity: 0.95 });
    const geo = alongZ
      ? new THREE.BoxGeometry(0.12, WALL_H * 0.9, S * 0.5)
      : new THREE.BoxGeometry(S * 0.5, WALL_H * 0.9, 0.12);
    const panel = new THREE.Mesh(geo, mat);
    panel.position.set(bx, WALL_H * 0.45, bz);
    panel.userData.doorId = d.id;
    this.scene.add(panel);
    this.doors.set(d.id, { panel, mat, openness: d.open ? 1 : 0, alongZ });
  }

  /**
   * Build markers: a small ring on each free cell next to the station.
   * The invisible disc underneath is the click target, so the whole cell is tappable.
   */
  private syncSlots(state: GameState): void {
    const anchors: { x: number; y: number }[] = [...state.rooms, ...state.builds];
    const want = new Map<string, Cell>();
    for (const a of anchors) {
      for (const [dx, dy] of DIRS) {
        const x = a.x + dx;
        const y = a.y + dy;
        if (state.canBuild(x, y)) want.set(`${x},${y}`, [x, y]);
      }
    }
    for (const [key, mesh] of this.slots) {
      if (want.has(key)) continue;
      this.scene.remove(mesh);
      this.slots.delete(key);
    }
    for (const [key, [x, y]] of want) {
      if (this.slots.has(key)) continue;
      const [cx, cz] = cellCentre(x, y);
      const disc = new THREE.Mesh(
        new THREE.CircleGeometry(S * 0.45, 32).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
      );
      disc.position.set(cx, 0.03, cz);
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(S * 0.2, S * 0.27, 32).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: SLOT_COLOR, transparent: true, opacity: 0.5, depthWrite: false }),
      );
      ring.position.y = 0.01;
      disc.add(ring);
      disc.userData.cell = [x, y];
      this.scene.add(disc);
      this.slots.set(key, disc);
    }
  }

  private syncBuilds(state: GameState): void {
    const live = new Set<string>();
    for (const b of state.builds) {
      const key = `${b.x},${b.y}`;
      live.add(key);
      if (!this.builds.has(key)) this.createBuild(key, b);
    }
    for (const [key, v] of this.builds) {
      if (live.has(key)) continue;
      this.scene.remove(v.group);
      this.builds.delete(key);
    }
  }

  /** A queued chamber: a wireframe of the finished size, a block rising as it's built, and a progress bar. */
  private createBuild(key: string, b: Build): void {
    const [cx, cz] = cellCentre(b.x, b.y);
    const accent = ACCENT[b.kind];
    const group = new THREE.Group();
    const outline = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(S * 0.96, WALL_H, S * 0.96)),
      new THREE.LineBasicMaterial({ color: accent }),
    );
    outline.position.set(cx, WALL_H / 2, cz);
    const blockMat = new THREE.MeshStandardMaterial({
      color: accent,
      transparent: true,
      opacity: 0.7,
      emissive: accent,
      emissiveIntensity: 0.25,
    });
    const block = new THREE.Mesh(this.blockGeo, blockMat);
    block.position.set(cx, 0, cz);
    const bar = new THREE.Group();
    bar.position.set(cx, WALL_H + 0.9, cz);
    const back = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 0.22), new THREE.MeshBasicMaterial({ color: 0x2a3550 }));
    const fill = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 0.22), new THREE.MeshBasicMaterial({ color: accent }));
    bar.add(back, fill);
    group.add(outline, block, bar);
    this.scene.add(group);
    this.builds.set(key, { group, block, blockMat, bar, fill });
  }

  private syncWorkers(state: GameState): void {
    const live = new Set(state.workers.map(w => w.id));
    for (const w of state.workers) if (!this.workers.has(w.id)) this.createWorker(w, state);
    for (const [id, v] of this.workers) {
      if (live.has(id)) continue;
      this.scene.remove(v.group);
      this.workers.delete(id);
    }
  }

  /** A crew member: white suit, job-coloured backpack, and two legs that swing when walking. */
  private createWorker(w: Worker, state: GameState): void {
    const home = state.room(w.roomId);
    const [cx, cz] = cellCentre(home.x, home.y);
    const suit = new THREE.MeshStandardMaterial({ color: 0xdfe6f3, roughness: 0.6 });
    const packMat = new THREE.MeshStandardMaterial({ color: JOB_COLOR[w.job], emissive: JOB_COLOR[w.job], emissiveIntensity: 0.35 });
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.16, 0.2, 4, 10), suit);
    torso.position.y = 0.5;
    const pack = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.28, 0.1), packMat);
    pack.position.set(0, 0.5, -0.19);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.14, 14, 10), new THREE.MeshStandardMaterial({ color: 0xe0c3a0 }));
    head.position.y = 0.9;
    const legs: THREE.Group[] = [];
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.08, 0.32, 0);
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.32, 0.12), suit);
      leg.position.y = -0.16;
      pivot.add(leg);
      legs.push(pivot);
    }
    const group = new THREE.Group();
    group.add(torso, pack, head, ...legs);
    shadowify(group);
    group.position.set(cx, 0, cz);
    this.scene.add(group);
    this.workers.set(w.id, {
      group,
      torso,
      head,
      pack,
      packMat,
      legs,
      pos: new THREE.Vector3(cx, 0, cz),
      route: [],
      atRoom: w.roomId,
      goal: '',
      phase: Math.random() * 6,
    });
  }

  /** Workers walk through the doors to where their job is, then work, hammer, or breathe. */
  private moveWorkers(dt: number, state: GameState): void {
    for (const w of state.workers) {
      const v = this.workers.get(w.id);
      if (!v) continue;
      v.packMat.color.setHex(JOB_COLOR[w.job]);
      v.packMat.emissive.setHex(JOB_COLOR[w.job]);
      const spot = state.workSpot(w);

      let point: THREE.Vector3;
      if (spot.outside) {
        const minX = Math.min(...state.rooms.map(r => r.x));
        point = new THREE.Vector3(minX * S - 1.4, 0, S * 0.5);
      } else if (spot.cell) {
        const [x, z] = cellCentre(spot.cell[0], spot.cell[1]);
        point = new THREE.Vector3(x, 0, z);
      } else {
        const r = state.room(spot.roomId);
        const [x, z] = cellCentre(r.x, r.y);
        point = new THREE.Vector3(x, 0, z);
      }
      const key = `${spot.roomId}|${spot.cell ?? ''}|${spot.outside ? 'out' : ''}`;
      if (v.goal !== key) {
        v.goal = key;
        v.route = state.roomPath(v.atRoom, spot.roomId).slice(1).map(id => {
          const r = state.room(id);
          const [x, z] = cellCentre(r.x, r.y);
          return { p: new THREE.Vector3(x, 0, z), room: id };
        });
        v.route.push({ p: point });
      }

      if (v.route.length > 0) {
        const next = v.route[0];
        const dir = next.p.clone().sub(v.pos);
        dir.y = 0;
        const dist = dir.length();
        const step = WALK_SPEED * dt;
        if (dist <= step) {
          v.pos.copy(next.p);
          if (next.room !== undefined) v.atRoom = next.room;
          v.route.shift();
        } else {
          v.pos.addScaledVector(dir, step / dist);
        }
        if (dist > 0.001) v.group.rotation.y = Math.atan2(dir.x, dir.z);
      }
      v.group.position.set(v.pos.x, 0, v.pos.z);

      const walking = v.route.length > 0;
      const working = !walking && w.job !== 'idle' && state.productive(w);
      const t = this.clock + v.phase;
      const bob = walking
        ? Math.abs(Math.sin(t * 12)) * 0.07
        : working
          ? Math.abs(Math.sin(t * 7)) * 0.05
          : Math.sin(t * 2) * 0.015;
      v.torso.position.y = 0.5 + bob;
      v.pack.position.y = 0.5 + bob;
      v.head.position.y = 0.9 + bob;
      v.legs.forEach((leg, i) => {
        leg.rotation.x = walking ? Math.sin(t * 10 + i * Math.PI) * 0.6 : 0;
      });
    }
  }

  private syncShips(state: GameState): void {
    const live = new Set(state.ships.map(s => s.id));
    for (const [id, g] of this.ships) {
      if (live.has(id)) continue;
      this.scene.remove(g);
      this.ships.delete(id);
    }
    for (const s of state.ships) {
      if (this.ships.has(s.id)) continue;
      const g = makeShip(s.kind);
      this.scene.add(g);
      this.ships.set(s.id, g);
    }
  }

  private animate(dt: number, state: GameState): void {
    for (const d of state.doors) {
      const v = this.doors.get(d.id);
      if (!v) continue;
      v.openness += ((d.open ? 1 : 0) - v.openness) * Math.min(1, dt * 6);
      const s = Math.max(0.05, 1 - 0.85 * v.openness);
      if (v.alongZ) v.panel.scale.z = s;
      else v.panel.scale.x = s;
      v.mat.color.setHex(d.open ? 0x6ee7a0 : 0xff6b6b);
      v.mat.opacity = d.open ? 0.35 : 0.95;
    }

    for (const r of state.rooms) {
      const v = this.rooms.get(r.id);
      if (!v) continue;
      const pulse = (Math.sin(this.clock * 9) + 1) / 2;
      v.floorMat.color.setHex(mix(HULL, ACCENT[r.kind], 0.15 + 0.6 * (r.o2 / 100)));
      v.floorMat.emissive.setHex(r.breach > 0 ? mix(0x000000, 0xff3030, 0.3 + 0.5 * pulse) : 0x000000);
    }

    for (const [key, disc] of this.slots) {
      const ring = disc.children[0] as THREE.Mesh;
      const mat = ring.material as THREE.MeshBasicMaterial;
      const pulse = 0.5 + 0.3 * Math.sin(this.clock * 3 + disc.position.x);
      mat.opacity = key === this.hover ? 1 : pulse;
    }

    for (const b of state.builds) {
      const v = this.builds.get(`${b.x},${b.y}`);
      if (!v) continue;
      v.block.scale.y = Math.max(0.05, b.progress * WALL_H);
      v.blockMat.opacity = 0.55 + 0.2 * Math.sin(this.clock * 6);
      v.fill.scale.x = Math.max(0.001, b.progress);
      v.fill.position.x = -0.9 * (1 - b.progress);
      v.bar.quaternion.copy(this.camera.quaternion); // keep the bar facing the camera
    }

    this.moveWorkers(dt, state);

    const dock = state.rooms.find(r => r.kind === 'dock');
    const [dx, dz] = dock ? cellCentre(dock.x, dock.y) : [0, 0];
    state.ships.forEach((s, i) => {
      const g = this.ships.get(s.id);
      if (!g) return;
      const n = state.ships.length;
      const target = new THREE.Vector3(dx + 3.4, 1.8, dz + (i - (n - 1) / 2) * 2.6);
      if (!g.userData.placed) {
        g.position.copy(target).add(new THREE.Vector3(14, 0, 0));
        g.userData.placed = true;
      }
      g.position.lerp(target, Math.min(1, dt * 1.2));
      g.position.y = target.y + Math.sin(this.clock * 2 + s.id) * 0.12;
      g.rotation.y = Math.sin(this.clock * 0.5 + s.id) * 0.1;
    });
  }

  /** Fit the station into the visible area (above any open menu), then apply pan and zoom. */
  private updateCamera(state: GameState): void {
    const xs = state.rooms.map(r => r.x);
    const ys = state.rooms.map(r => r.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs) + 1;
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys) + 1;
    const extent = Math.max(maxX - minX, maxY - minY) * S + S;
    const centreX = ((minX + maxX) / 2) * S;
    const centreZ = ((minY + maxY) / 2) * S;

    const w = window.innerWidth;
    const h = window.innerHeight;
    const sheet = this.openSheetPx();
    const vHalf = THREE.MathUtils.degToRad(FOV / 2);
    const visible = Math.max(0.35, (h - sheet) / h);
    const halfTan = Math.min(Math.tan(vHalf) * visible, Math.tan(vHalf) * (w / h));
    const fit = ((extent / 2) * 1.9) / halfTan;
    const dist = Math.min(140, Math.max(6, fit * this.zoom));

    const tx = centreX + this.pan.x;
    const tz = centreZ + this.pan.y;
    this.camera.position.set(tx, Math.sin(TILT) * dist, tz + Math.cos(TILT) * dist);
    this.camera.lookAt(tx, 0, tz);
    this.camera.updateMatrixWorld();
    this.lastDist = dist;

    // Shift the image up by half the covered height so the station sits above the menu.
    if (sheet > 0) this.camera.setViewOffset(w, h, 0, sheet / 2, w, h);
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
  }

  /** How many screen pixels an open phone menu covers at the bottom (0 when none is open). */
  private openSheetPx(): number {
    const panel = document.querySelector<HTMLElement>('.panel.open');
    return panel ? Math.round(window.innerHeight - panel.getBoundingClientRect().top) : 0;
  }

  private pick(clientX: number, clientY: number): THREE.Intersection[] {
    const ndc = new THREE.Vector2((clientX / window.innerWidth) * 2 - 1, -(clientY / window.innerHeight) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    return this.raycaster.intersectObjects(this.scene.children, true);
  }

  private slotKeyAt(clientX: number, clientY: number): string | undefined {
    const slot = this.pick(clientX, clientY).find(h => h.object.userData.cell !== undefined);
    return slot ? (slot.object.userData.cell as Cell).join(',') : undefined;
  }

  /** Tap: toggle the nearest door, or queue the chosen chamber on the nearest glowing slot. */
  private tap(e: PointerEvent): void {
    const state = this.state;
    if (!state) return;
    hud.closeSheets();
    const hit = this.pick(e.clientX, e.clientY).find(
      h => h.object.userData.doorId !== undefined || h.object.userData.cell !== undefined,
    );
    if (!hit) return;
    if (hit.object.userData.doorId !== undefined) {
      state.toggleDoor(hit.object.userData.doorId as number);
    } else {
      const [x, y] = hit.object.userData.cell as Cell;
      const res = state.requestBuild(x, y, ui.buildKind);
      if (!res.ok) hud.toast(res.msg);
    }
    hud.render();
  }

  private setupInput(): void {
    const el = this.renderer.domElement;
    el.style.touchAction = 'none';

    el.addEventListener('pointerdown', e => {
      this.fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.press = { x: e.clientX, y: e.clientY, moved: false };
    });

    el.addEventListener('pointermove', e => {
      const f = this.fingers.get(e.pointerId);
      if (!f) {
        this.hover = this.slotKeyAt(e.clientX, e.clientY) ?? '';
        return;
      }
      f.x = e.clientX;
      f.y = e.clientY;
      if (this.fingers.size >= 2) {
        const [a, b] = [...this.fingers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (this.pinchDist > 0) this.zoom = Math.min(2.5, Math.max(0.4, this.zoom * (this.pinchDist / d)));
        this.pinchDist = d;
        if (this.press) this.press.moved = true;
        return;
      }
      if (this.press) {
        if (Math.hypot(e.clientX - this.press.x, e.clientY - this.press.y) > 6) this.press.moved = true;
        if (this.press.moved) {
          const k = this.lastDist * 0.0016;
          this.pan.x -= e.movementX * k;
          this.pan.y -= e.movementY * k;
        }
      }
    });

    const release = (e: PointerEvent): void => {
      const pressed = this.press;
      this.fingers.delete(e.pointerId);
      if (this.fingers.size < 2) this.pinchDist = 0;
      if (this.fingers.size === 0) {
        if (pressed && !pressed.moved && e.type === 'pointerup' && e.target === el) this.tap(e);
        this.press = null;
      }
    };
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);

    el.addEventListener(
      'wheel',
      e => {
        e.preventDefault();
        this.zoom = Math.min(2.5, Math.max(0.4, this.zoom * (e.deltaY > 0 ? 1.1 : 0.9)));
      },
      { passive: false },
    );
  }
}
