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

const JOBS: [Job, string, string][] = [
  ['engineer', 'Build', 'Finishes queued chambers and seals hull breaches'],
  ['salvage', 'Salvage', 'Scavenges outside for metal, energy, plating and new crew'],
  ['research', 'Research', 'Makes research points (RP) in a Laboratory'],
  ['trade', 'Trade', 'Lets you accept visitor deals at a Docking bay'],
  ['idle', 'Idle', 'No task'],
];

const RESOURCES: [Resource, string, string][] = [
  ['metal', 'Metal', 'Builds chambers. Found by salvaging meteorites or bought from traders.'],
  ['energy', 'Energy', 'Builds chambers and runs oxygen generators. Solar gives a steady trickle; debris adds more.'],
  ['food', 'Food', 'Crew eat constantly; if it runs out, everyone starves. Grown by Hydroponics, or bought from traders.'],
  ['credits', 'Credits', 'Pays for trades and recruiting. Earned by selling to traders.'],
  ['rp', 'Research', 'Spent to unlock techs. Made by crew on Research in a Laboratory.'],
  ['plating', 'Plating', 'Salvaged hull plating. Each one builds a chamber for free.'],
];

const GUIDE = `
<details>
  <summary>How to grow the station</summary>
  <p><b>1.</b> Open <b>Build</b>, pick a chamber, then tap a glowing slot next to the station. Engineers finish it over time.</p>
  <p><b>2.</b> Chambers need oxygen. Open doors let it spread; close one to keep a room sealed off, for example during a breach.</p>
  <p><b>3.</b> Quarters add crew beds. Recruit visitors only when you have a free bed.</p>
  <h2>Resources</h2>
  ${RESOURCES.map(([, label, text]) => `<p><b>${label}:</b> ${text}</p>`).join('')}
  <h2>Jobs</h2>
  ${JOBS.map(([, label, text]) => `<p><b>${label}:</b> ${text}</p>`).join('')}
</details>`;

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

  put(
    'res',
    RESOURCES.map(
      ([k, label, text]) => `<span class="chip" title="${text}">${label} <b>${Math.floor(s.res[k])}</b></span>`,
    ).join(''),
  );

  const crew = s.workers
    .map(w => {
      const room = s.room(w.roomId);
      const warn = room.o2 < 10 && w.job !== 'salvage' ? ' <span class="warn">low O₂</span>' : '';
      const buttons = JOBS.map(
        ([job, label, help]) =>
          `<button data-act="job" data-id="${w.id}" data-val="${job}" title="${help}" class="${w.job === job ? 'on' : ''}">${label}</button>`,
      ).join('');
      return `<div class="worker"><div class="row"><span>${w.name} <small>${ROOM_LABEL[room.kind]}</small>${warn}</span><span class="hp">${Math.round(w.health)}%</span></div><div class="jobs">${buttons}</div><small>${s.jobNote(w)}</small></div>`;
    })
    .join('');
  put(
    'crew',
    `<div class="dim">Beds ${s.workers.length} / ${s.housing()}. Tap a job to assign it.</div>${crew}`,
  );

  put(
    'research',
    `<div class="dim">Labs make RP. Spend it here to unlock upgrades.</div>` +
      (Object.keys(TECHS) as TechId[])
        .map(id => {
          const t = TECHS[id];
          const action = s.techs.has(id)
            ? '<span class="good">learned</span>'
            : `<button data-act="tech" data-val="${id}" ${s.res.rp >= t.cost ? '' : 'class="dim"'}>${Math.floor(s.res.rp)} / ${t.cost} RP</button>`;
          return `<div class="row"><div><b>${t.name}</b><small>${t.desc}</small></div>${action}</div>`;
        })
        .join(''),
  );

  put(
    'ships',
    s.ships.length === 0
      ? '<div class="dim">Visitors arrive at a Docking bay. Accept their offers when a crew member is on Trade.</div>'
      : s.ships
          .map(
            sh =>
              `<div class="row"><div><b>${sh.kind === 'trader' ? 'Trader' : 'Recruiter'}</b><small>${sh.offer.label} · leaves in ${Math.ceil(sh.timeLeft)}s</small></div><button data-act="ship" data-id="${sh.id}">Accept</button></div>`,
          )
          .join(''),
  );

  // What is still missing for a chamber; empty when it is affordable (a plating token pays for any chamber).
  const missing = (k: BuildKind): string[] => {
    if (s.res.plating >= 1) return [];
    return (Object.entries(s.buildCost(k)) as [Resource, number][])
      .filter(([r, v]) => s.res[r] < v)
      .map(([r, v]) => `${Math.ceil(v - s.res[r])} more ${r}`);
  };
  const palette = (Object.keys(BUILD_INFO) as BuildKind[])
    .map(k => {
      const short = missing(k);
      const cost = Object.entries(s.buildCost(k))
        .map(([r, v]) => `${v} ${r}`)
        .join(' · ');
      const cls = [ui.buildKind === k ? 'on' : '', short.length ? 'blocked' : ''].join(' ');
      const line = short.length ? `need ${short.join(', ')}` : cost;
      return `<button data-act="kind" data-val="${k}" class="${cls}">${BUILD_INFO[k].label}<small>${line}</small></button>`;
    })
    .join('');
  const chamber = ui.buildKind;
  const shortMetal = Math.ceil((s.buildCost(chamber).metal ?? 0) - s.res.metal);
  const rate = s.metalPerSecond();
  const eta =
    shortMetal <= 0
      ? ''
      : rate > 0
        ? ` About ${Math.ceil(shortMetal / rate)}s of salvage to go (metal ≈ ${rate.toFixed(2)}/s).`
        : ' Assign a crew member to Salvage to earn metal.';
  const status =
    s.res.plating >= 1
      ? 'A plating token is ready: the next chamber is free.'
      : missing(chamber).length
        ? `${BUILD_INFO[chamber].label} needs ${missing(chamber).join(', ')}.${eta}`
        : 'Pick a chamber, then tap a glowing slot.';
  put('palette', `${palette}<span class="dim">${status}</span>`);

  const builds = s.builds
    .map(b => `<div>Building ${BUILD_INFO[b.kind].label}… ${Math.floor(b.progress * 100)}%</div>`)
    .join('');
  put('builds', builds || '<div>No construction. Queue one here, and an engineer will build it.</div>');

  put('guide', GUIDE);
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

// On phones the menus are bottom sheets: one open at a time, opened from the tab bar.
function closeSheets(): void {
  document.querySelectorAll('.panel.open').forEach(p => p.classList.remove('open'));
  document.querySelectorAll('[data-tab].on').forEach(b => b.classList.remove('on'));
}

function toggleSheet(id: string): void {
  const open = !$(id).classList.contains('open');
  closeSheets();
  if (!open) return;
  $(id).classList.add('open');
  document.querySelector<HTMLElement>(`[data-tab="${id}"]`)?.classList.add('on');
}

document.addEventListener('click', e => {
  const tab = (e.target as HTMLElement).closest<HTMLElement>('[data-tab]');
  if (tab) {
    toggleSheet(tab.dataset.tab ?? '');
    return;
  }
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
  closeSheets,
};
