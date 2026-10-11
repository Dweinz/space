import {
  BUILD_INFO,
  ROOM_LABEL,
  TECHS,
  type BuildKind,
  type GameState,
  type Job,
  type Resource,
  type Result,
  type TechId,
} from '@/sim/game-state';

// Shared UI choice: which chamber type a click on a build slot places.
export const ui: { buildKind: BuildKind } = { buildKind: 'lab' };

const JOBS: [Job, string][] = [
  ['engineer', 'Build'],
  ['salvage', 'Salvage'],
  ['research', 'Research'],
  ['trade', 'Trade'],
  ['idle', 'Idle'],
];
const RESOURCES: [Resource, string][] = [
  ['metal', 'Metal'],
  ['energy', 'Energy'],
  ['food', 'Food'],
  ['credits', 'Credits'],
  ['rp', 'Research'],
  ['plating', 'Plating'],
];

let game: GameState | null = null;
let tickAcc = 0;
let toastTimer = 0;
const cache = new Map<string, string>();

const $ = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;

// Only touch the DOM when the markup actually changed; keeps clicks from being swallowed.
const put = (id: string, html: string): void => {
  if (cache.get(id) === html) return;
  cache.set(id, html);
  $(id).innerHTML = html;
};

function render(): void {
  if (!game) return;
  const s = game;

  put('res', RESOURCES.map(([k, label]) => `<span class="chip">${label} <b>${Math.floor(s.res[k])}</b></span>`).join(''));

  const crew = s.workers
    .map(w => {
      const room = s.room(w.roomId);
      const warn = room.o2 < 10 && w.job !== 'salvage' ? ' <span class="warn">low O₂</span>' : '';
      const buttons = JOBS.map(
        ([job, label]) =>
          `<button data-act="job" data-id="${w.id}" data-val="${job}" class="${w.job === job ? 'on' : ''}">${label}</button>`,
      ).join('');
      return `<div class="worker"><div class="row"><span>${w.name} <small>${ROOM_LABEL[room.kind]}</small>${warn}</span><span class="hp">${Math.round(w.health)}%</span></div><div class="jobs">${buttons}</div></div>`;
    })
    .join('');
  put('crew', `<div class="dim">Beds ${s.workers.length} / ${s.housing()}</div>${crew}`);

  put(
    'research',
    (Object.keys(TECHS) as TechId[])
      .map(id => {
        const t = TECHS[id];
        const action = s.techs.has(id)
          ? '<span class="good">learned</span>'
          : `<button data-act="tech" data-val="${id}">${t.cost} RP</button>`;
        return `<div class="row"><div><b>${t.name}</b><small>${t.desc}</small></div>${action}</div>`;
      })
      .join(''),
  );

  put(
    'ships',
    s.ships.length === 0
      ? '<div class="dim">No visitors. Build a docking bay to attract traffic.</div>'
      : s.ships
          .map(
            sh =>
              `<div class="row"><div><b>${sh.kind === 'trader' ? 'Trader' : 'Recruiter'}</b><small>${sh.offer.label} · leaves in ${Math.ceil(sh.timeLeft)}s</small></div><button data-act="ship" data-id="${sh.id}">Accept</button></div>`,
          )
          .join(''),
  );

  const palette = (Object.keys(BUILD_INFO) as BuildKind[])
    .map(k => {
      const cost = Object.entries(BUILD_INFO[k].cost)
        .map(([r, v]) => `${v} ${r}`)
        .join(' · ');
      return `<button data-act="kind" data-val="${k}" class="${ui.buildKind === k ? 'on' : ''}">${BUILD_INFO[k].label}<small>${cost}</small></button>`;
    })
    .join('');
  put('palette', `${palette}<span class="dim">Click a glowing slot to build.</span>`);

  const builds = s.builds
    .map(b => `<div>Building ${BUILD_INFO[b.kind].label}… ${Math.floor(b.progress * 100)}%</div>`)
    .join('');
  put('builds', builds || '<div>No construction. Engineers build queued chambers.</div>');

  put('log', s.log.slice(-6).reverse().map(l => `<div>${l}</div>`).join(''));
}

export function toast(msg: string): void {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.classList.remove('show'), 2400);
}

const notify = (r: Result): void => {
  if (!r.ok) toast(r.msg);
};

document.addEventListener('click', e => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
  if (!btn || !game) return;
  const { act, id, val } = btn.dataset;
  if (act === 'job') game.setJob(Number(id), val as Job);
  if (act === 'kind') ui.buildKind = val as BuildKind;
  if (act === 'tech') notify(game.unlockTech(val as TechId));
  if (act === 'ship') notify(game.acceptOffer(Number(id)));
  render();
});

export const hud = {
  init(s: GameState): void {
    game = s;
    render();
  },
  tick(dt: number): void {
    tickAcc += dt;
    if (tickAcc >= 0.25) {
      tickAcc = 0;
      render();
    }
  },
  render,
  toast,
};
