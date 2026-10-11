import { GameState } from '@/sim/game-state';
import { hud } from '@/ui/hud';
import { StationView, loadModels } from '@/view/station-view';

const state = new GameState();
hud.init(state);

const view = new StationView(document.getElementById('game') as HTMLElement, await loadModels());

let last = performance.now();
const frame = (now: number): void => {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  state.step(dt);
  view.frame(dt, state);
  hud.tick(dt);
  requestAnimationFrame(frame);
};
requestAnimationFrame(frame);
