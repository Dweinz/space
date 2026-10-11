// Pure simulation: no Phaser or DOM. The scene and HUD read from this and call into it.

export type RoomKind = 'core' | 'life' | 'lab' | 'dock' | 'quarters';
export type BuildKind = Exclude<RoomKind, 'core'>;
export type Job = 'idle' | 'engineer' | 'salvage' | 'research' | 'trade';
export type Resource = 'metal' | 'energy' | 'food' | 'credits' | 'rp' | 'plating';
export type Cost = Partial<Record<Resource, number>>;
export type TechId = 'plating' | 'hydro' | 'scrub' | 'drones';
export type Rng = () => number;

export interface Room { id: number; x: number; y: number; kind: RoomKind; o2: number; breach: number }
export interface Door { id: number; a: number; b: number; open: boolean }
export interface Worker { id: number; name: string; roomId: number; job: Job; health: number; timer: number }
export interface Offer { label: string; pay: Cost; get: Cost; recruit?: boolean }
export interface Ship { id: number; kind: 'trader' | 'recruiter'; offer: Offer; timeLeft: number }
export interface Build { x: number; y: number; kind: BuildKind; progress: number }
export interface Result { ok: boolean; msg: string }

export const BUILD_INFO: Record<BuildKind, { label: string; cost: Cost }> = {
  life: { label: 'Life support', cost: { metal: 35, energy: 20 } },
  lab: { label: 'Laboratory', cost: { metal: 30, energy: 15 } },
  dock: { label: 'Docking bay', cost: { metal: 40, energy: 10 } },
  quarters: { label: 'Quarters', cost: { metal: 20, energy: 5 } },
};

export const ROOM_LABEL: Record<RoomKind, string> = {
  core: 'Core',
  life: 'Life support',
  lab: 'Laboratory',
  dock: 'Docking bay',
  quarters: 'Quarters',
};

export const TECHS: Record<TechId, { name: string; cost: number; desc: string }> = {
  plating: { name: 'Reinforced plating', cost: 25, desc: 'Chambers cost 25% less' },
  hydro: { name: 'Hydroponics', cost: 35, desc: '+1 food per second' },
  scrub: { name: 'Scrubber arrays', cost: 40, desc: 'Oxygen generation +50%' },
  drones: { name: 'Salvage drones', cost: 30, desc: 'Salvage yields +50%' },
};

const TRADE_OFFERS: Offer[] = [
  { label: 'sell 20 metal for 12 credits', pay: { metal: 20 }, get: { credits: 12 } },
  { label: 'buy 20 metal for 14 credits', pay: { credits: 14 }, get: { metal: 20 } },
  { label: 'trade 15 food for 10 energy', pay: { food: 15 }, get: { energy: 10 } },
];
const RECRUIT_OFFER: Offer = { label: 'recruit a crew member', pay: { food: 25, credits: 30 }, get: {}, recruit: true };
const NAMES = ['Mira', 'Joss', 'Tavi', 'Ilse', 'Rook', 'Nadia', 'Pell', 'Oskar'];
const DIRS: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];

const ROOM_MAX = 100;
const SUFFOCATE_BELOW = 10;
const O2_PER_CREW = 0.4;
const O2_GEN = 8;
const GEN_ENERGY = 0.5;
const SOLAR = 1.5;
const DIFFUSION = 1.5;
const BREACH_LEAK = 6;
const BREACH_REPAIR = 6; // engineer-seconds
const BUILD_SECONDS = 12; // engineer-seconds
const FOOD_PER_CREW = 0.04;
const HYDRO_FOOD = 1;
const RP_RATE = 0.5;
const SALVAGE_EVERY = 8;
const SHIP_STAY = 30;
const CORE_BEDS = 3;
const QUARTERS_BEDS = 2;
const MAX_LOG = 40;

const clamp = (v: number): number => Math.min(ROOM_MAX, Math.max(0, v));
const ok = (msg = ''): Result => ({ ok: true, msg });
const fail = (msg: string): Result => ({ ok: false, msg });
const scaled = (c: Cost, m: number): Cost =>
  Object.fromEntries((Object.entries(c) as [Resource, number][]).map(([k, v]) => [k, Math.ceil(v * m)])) as Cost;

export class GameState {
  readonly rooms: Room[] = [];
  readonly doors: Door[] = [];
  readonly techs = new Set<TechId>();
  readonly log: string[] = [];
  readonly res: Record<Resource, number> = { metal: 60, energy: 40, food: 60, credits: 30, rp: 0, plating: 0 };
  workers: Worker[] = [];
  ships: Ship[] = [];
  builds: Build[] = [];
  private nextId = 1;
  private shipTimer = 8;
  private breachTimer = 40;

  constructor(private readonly rng: Rng = Math.random) {
    this.rooms.push({ id: this.nextId++, x: 0, y: 0, kind: 'core', o2: ROOM_MAX, breach: 0 });
    const crew: [string, Job][] = [['Ada', 'engineer'], ['Bo', 'salvage'], ['Cy', 'idle']];
    for (const [name, job] of crew) {
      this.workers.push({ id: this.nextId++, name, roomId: this.rooms[0].id, job, health: 100, timer: SALVAGE_EVERY });
    }
    this.say('Station online. Three crew in the core.');
  }

  room(id: number): Room {
    const r = this.rooms.find(r => r.id === id);
    if (!r) throw new Error(`No room ${id}`);
    return r;
  }

  roomAt(x: number, y: number): Room | undefined {
    return this.rooms.find(r => r.x === x && r.y === y);
  }

  count(kind: RoomKind): number {
    return this.rooms.filter(r => r.kind === kind).length;
  }

  has(tech: TechId): boolean {
    return this.techs.has(tech);
  }

  housing(): number {
    return CORE_BEDS + QUARTERS_BEDS * this.count('quarters');
  }

  /** Average metal per second from the salvage crew working right now (the only metal source). */
  metalPerSecond(): number {
    const crew = this.workers.filter(w => w.job === 'salvage' && this.productive(w)).length;
    const mult = this.has('drones') ? 1.5 : 1;
    return (crew * 0.3 * 12 * mult) / SALVAGE_EVERY;
  }

  /** A worker only produces when they can breathe; salvage crews work outside in suits. */
  productive(w: Worker): boolean {
    return w.health > 0 && (w.job === 'salvage' || this.room(w.roomId).o2 >= SUFFOCATE_BELOW);
  }

  /** One line telling the player what this worker is doing, or what is blocking them. */
  jobNote(w: Worker): string {
    if (w.job === 'idle') return 'No task. Pick a job above to put them to work.';
    if (w.job === 'salvage') return 'Scavenging outside: finds come every few seconds.';
    if (!this.productive(w)) return 'Stalled: no oxygen here. Open a door to a life-support room.';
    if (w.job === 'engineer') {
      if (this.rooms.some(r => r.breach > 0)) return 'Sealing a hull breach.';
      if (this.builds.length > 0) return `Building ${BUILD_INFO[this.builds[0].kind].label}.`;
      return 'Nothing to build. Queue a chamber in the Build menu.';
    }
    if (w.job === 'research') {
      return this.count('lab') > 0 ? 'Making research points in the lab.' : 'Needs a Laboratory to make research points.';
    }
    return this.count('dock') > 0 ? 'Ready to close deals with visitors.' : 'Needs a Docking bay before visitors arrive.';
  }

  step(dt: number): void {
    this.oxygen(dt);
    this.life(dt);
    this.work(dt);
    this.events(dt);
  }

  canPay(cost: Cost): boolean {
    return (Object.entries(cost) as [Resource, number][]).every(([k, v]) => this.res[k] >= v);
  }

  canBuild(x: number, y: number): boolean {
    if (this.roomAt(x, y) || this.builds.some(b => b.x === x && b.y === y)) return false;
    // Attach to finished chambers or to ones still under construction; doors connect on completion.
    return DIRS.some(
      ([dx, dy]) => this.roomAt(x + dx, y + dy) !== undefined || this.builds.some(b => b.x === x + dx && b.y === y + dy),
    );
  }

  buildCost(kind: BuildKind): Cost {
    return scaled(BUILD_INFO[kind].cost, this.has('plating') ? 0.75 : 1);
  }

  requestBuild(x: number, y: number, kind: BuildKind): Result {
    if (this.roomAt(x, y)) return fail('That spot already has a chamber.');
    if (this.builds.some(b => b.x === x && b.y === y)) return fail('Already being built here.');
    if (!this.canBuild(x, y)) return fail('Tap a glowing slot next to the station.');
    const label = BUILD_INFO[kind].label;
    if (this.res.plating >= 1) {
      this.res.plating -= 1;
    } else {
      const cost = this.buildCost(kind);
      const short = (Object.entries(cost) as [Resource, number][])
        .filter(([r, v]) => this.res[r] < v)
        .map(([r, v]) => `${Math.ceil(v - this.res[r])} more ${r}`);
      if (short.length) return fail(`${label} needs ${short.join(', ')}.`);
      this.pay(cost);
    }
    this.builds.push({ x, y, kind, progress: 0 });
    this.say(`${label} queued.`);
    return ok(`${label} queued.`);
  }

  toggleDoor(id: number): void {
    const d = this.doors.find(d => d.id === id);
    if (d) d.open = !d.open;
  }

  setJob(workerId: number, job: Job): void {
    const w = this.workers.find(w => w.id === workerId);
    if (w) w.job = job;
  }

  unlockTech(id: TechId): Result {
    const t = TECHS[id];
    if (this.techs.has(id)) return fail('Already learned.');
    if (this.res.rp < t.cost) return fail(`Needs ${t.cost} RP.`);
    this.res.rp -= t.cost;
    this.techs.add(id);
    this.say(`Learned ${t.name}.`);
    return ok();
  }

  acceptOffer(shipId: number): Result {
    const ship = this.ships.find(s => s.id === shipId);
    if (!ship) return fail('That ship has already left.');
    if (!this.workers.some(w => w.job === 'trade' && this.productive(w))) {
      return fail('Assign a crew member to Trade first.');
    }
    const { offer } = ship;
    if (!this.canPay(offer.pay)) return fail('Not enough resources for that deal.');
    if (offer.recruit && this.workers.length >= this.housing()) return fail('No free beds. Build quarters.');
    this.pay(offer.pay);
    this.gain(offer.get);
    if (offer.recruit) this.addWorker();
    this.ships = this.ships.filter(s => s !== ship);
    this.say(`Deal done: ${offer.label}.`);
    return ok();
  }

  private oxygen(dt: number): void {
    this.res.energy += SOLAR * dt;
    for (const r of this.rooms) {
      if ((r.kind === 'core' || r.kind === 'life') && this.res.energy > 0) {
        const rate = this.has('scrub') ? O2_GEN * 1.5 : O2_GEN;
        r.o2 = clamp(r.o2 + rate * dt);
        this.res.energy = Math.max(0, this.res.energy - GEN_ENERGY * dt);
      }
    }
    // Open doors let oxygen diffuse; closed doors hold it in the chamber.
    for (const d of this.doors) {
      if (!d.open) continue;
      const a = this.room(d.a);
      const b = this.room(d.b);
      const flow = (a.o2 - b.o2) * Math.min(1, DIFFUSION * dt) * 0.5;
      a.o2 -= flow;
      b.o2 += flow;
    }
  }

  private life(dt: number): void {
    for (const r of this.rooms) {
      const crew = this.crewIn(r.id);
      r.o2 = clamp(r.o2 - (crew * O2_PER_CREW + (r.breach > 0 ? BREACH_LEAK : 0)) * dt);
    }
    const hydro = this.has('hydro') ? HYDRO_FOOD : 0;
    this.res.food = Math.max(0, this.res.food + (hydro - this.workers.length * FOOD_PER_CREW) * dt);
    const starving = this.res.food <= 0;
    for (const w of this.workers) {
      if (this.room(w.roomId).o2 < SUFFOCATE_BELOW) w.health -= 2 * dt;
      else w.health = Math.min(100, w.health + 0.5 * dt);
      if (starving) w.health -= dt;
    }
    for (const w of this.workers.filter(w => w.health <= 0)) this.say(`${w.name} did not make it.`);
    this.workers = this.workers.filter(w => w.health > 0);
  }

  private work(dt: number): void {
    const engineers = this.workers.filter(w => w.job === 'engineer' && this.productive(w)).length;
    const breached = this.rooms.find(r => r.breach > 0);
    if (engineers > 0 && breached) {
      breached.breach = Math.max(0, breached.breach - engineers * dt);
      if (breached.breach === 0) this.say(`Breach sealed in ${ROOM_LABEL[breached.kind]}.`);
    } else if (engineers > 0 && this.builds.length > 0) {
      const b = this.builds[0];
      b.progress += (engineers * dt) / BUILD_SECONDS;
      if (b.progress >= 1) {
        this.builds.shift();
        this.completeBuild(b);
      }
    }

    if (this.count('lab') > 0) {
      const researchers = this.workers.filter(w => w.job === 'research' && this.productive(w)).length;
      this.res.rp += researchers * RP_RATE * dt;
    }

    const yieldMult = this.has('drones') ? 1.5 : 1;
    for (const w of this.workers) {
      if (w.job !== 'salvage' || !this.productive(w)) continue;
      w.timer -= dt;
      if (w.timer <= 0) {
        w.timer += SALVAGE_EVERY;
        this.salvage(yieldMult);
      }
    }
  }

  private events(dt: number): void {
    this.breachTimer -= dt;
    if (this.breachTimer <= 0) {
      this.breachTimer = 30 + this.rng() * 40;
      const candidates = this.rooms.filter(r => r.breach === 0);
      if (candidates.length > 0) {
        const r = this.pick(candidates);
        r.breach = BREACH_REPAIR;
        this.say(`Micrometeorite breach in ${ROOM_LABEL[r.kind]}! Seal its doors to contain the leak.`);
      }
    }

    this.shipTimer -= dt;
    if (this.shipTimer <= 0) {
      this.shipTimer = 18 + this.rng() * 18;
      if (this.count('dock') > 0 && this.ships.length < 2 * this.count('dock')) this.spawnShip();
    }
    for (const s of this.ships) s.timeLeft -= dt;
    for (const s of this.ships.filter(s => s.timeLeft <= 0)) {
      this.say(`${s.kind === 'trader' ? 'Trader' : 'Recruiter'} ship departed.`);
    }
    this.ships = this.ships.filter(s => s.timeLeft > 0);
  }

  private salvage(mult: number): void {
    const roll = this.rng();
    if (roll < 0.3) {
      const amount = Math.round(12 * mult);
      this.res.metal += amount;
      this.say(`Meteorite salvaged: +${amount} metal.`);
    } else if (roll < 0.55) {
      const amount = Math.round(5 * mult);
      this.res.energy += amount;
      this.say(`Debris cell recovered: +${amount} energy.`);
    } else if (roll < 0.65) {
      this.res.plating += 1;
      this.say('Hull plating recovered: one free chamber token.');
    } else if (roll < 0.7) {
      if (this.workers.length < this.housing()) {
        this.addWorker();
        this.say('Survivor rescued and given a bunk.');
      } else {
        this.say('Survivor found, but there are no free beds.');
      }
    } else {
      this.say('Salvage run came back empty.');
    }
  }

  private spawnShip(): void {
    const recruiter = this.rng() < 0.5;
    const offer = recruiter ? RECRUIT_OFFER : this.pick(TRADE_OFFERS);
    this.ships.push({ id: this.nextId++, kind: recruiter ? 'recruiter' : 'trader', offer, timeLeft: SHIP_STAY });
    this.say(`${recruiter ? 'Recruiter' : 'Trader'} ship requests docking.`);
  }

  private addWorker(job: Job = 'idle'): void {
    const quarters = this.rooms.find(r => r.kind === 'quarters' && this.crewIn(r.id) < QUARTERS_BEDS);
    this.workers.push({
      id: this.nextId++,
      name: this.pick(NAMES),
      roomId: (quarters ?? this.rooms[0]).id,
      job,
      health: 100,
      timer: SALVAGE_EVERY,
    });
  }

  private completeBuild(b: Build): void {
    const room: Room = { id: this.nextId++, x: b.x, y: b.y, kind: b.kind, o2: 0, breach: 0 };
    for (const other of this.rooms) {
      if (Math.abs(other.x - b.x) + Math.abs(other.y - b.y) === 1) {
        this.doors.push({ id: this.nextId++, a: other.id, b: room.id, open: true });
      }
    }
    this.rooms.push(room);
    if (b.kind === 'quarters') {
      const core = this.rooms[0].id;
      for (const w of this.workers.filter(w => w.roomId === core).slice(0, QUARTERS_BEDS)) w.roomId = room.id;
    }
    this.say(`${ROOM_LABEL[b.kind]} finished.`);
  }

  private crewIn(roomId: number): number {
    return this.workers.filter(w => w.roomId === roomId).length;
  }

  private pay(cost: Cost): void {
    for (const [k, v] of Object.entries(cost) as [Resource, number][]) this.res[k] -= v;
  }

  private gain(amount: Cost): void {
    for (const [k, v] of Object.entries(amount) as [Resource, number][]) this.res[k] += v;
  }

  private pick<T>(xs: T[]): T {
    return xs[Math.floor(this.rng() * xs.length)];
  }

  private say(msg: string): void {
    this.log.push(msg);
    if (this.log.length > MAX_LOG) this.log.shift();
  }
}
