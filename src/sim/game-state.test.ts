import { describe, expect, it } from 'vitest';
import { GameState } from './game-state';

const calm = () => 0.99; // rolls that trigger no random events
const run = (s: GameState, seconds: number) => {
  for (let i = 0; i < seconds; i++) s.step(1);
};

describe('GameState', () => {
  it('keeps oxygen out of a chamber whose door is sealed', () => {
    const s = new GameState(calm);
    expect(s.requestBuild(1, 0, 'quarters').ok).toBe(true);
    run(s, 12); // build finishes on this tick, door is created open
    expect(s.rooms).toHaveLength(2);
    const quarters = s.rooms[1];

    s.toggleDoor(s.doors[0].id);
    run(s, 20);
    expect(quarters.o2).toBe(0);

    s.toggleDoor(s.doors[0].id);
    run(s, 10);
    expect(quarters.o2).toBeGreaterThan(5);
  });

  it('lets a chamber attach to one still under construction', () => {
    const s = new GameState(calm);
    expect(s.requestBuild(1, 0, 'quarters').ok).toBe(true);
    expect(s.requestBuild(2, 0, 'lab').ok).toBe(true); // next to the queued quarters
    run(s, 30);
    expect(s.rooms).toHaveLength(3);
    expect(s.doors).toHaveLength(2); // core-quarters and quarters-lab
  });

  it('charges for chambers and only builds next to the station', () => {
    const s = new GameState(calm);
    expect(s.requestBuild(5, 5, 'lab').ok).toBe(false);
    const before = s.res.metal;
    expect(s.requestBuild(0, 1, 'lab').ok).toBe(true);
    expect(s.res.metal).toBe(before - 30);
  });

  it('locks advanced chambers behind research and tech prerequisites', () => {
    const s = new GameState(calm);
    expect(s.requestBuild(1, 0, 'hydro').ok).toBe(false); // needs Hydroponics research
    expect(s.unlockTech('medicine').ok).toBe(false); // needs Hydroponics first
    s.res.rp = 500;
    expect(s.unlockTech('hydro').ok).toBe(true);
    expect(s.unlockTech('medicine').ok).toBe(true);
    expect(s.requestBuild(1, 0, 'hydro').ok).toBe(true);
  });

  it('reports the metal income from salvage crew', () => {
    const s = new GameState(calm);
    expect(s.metalPerSecond()).toBeCloseTo(0.45); // one salvage crew at the start
    s.setJob(s.workers[0].id, 'salvage');
    expect(s.metalPerSecond()).toBeCloseTo(0.9);
  });

  it('names the missing resource when a build is short', () => {
    const s = new GameState(calm);
    s.res.metal = 90;
    s.res.energy = 5;
    const res = s.requestBuild(0, 1, 'dock');
    expect(res.ok).toBe(false);
    expect(res.msg).toContain('5 more energy');
  });

  it('tells the player what blocks a job', () => {
    const s = new GameState(calm);
    const cy = s.workers[2];
    s.setJob(cy.id, 'research');
    expect(s.jobNote(cy)).toContain('Laboratory');
    s.setJob(cy.id, 'trade');
    expect(s.jobNote(cy)).toContain('Docking bay');
  });

  it('lets an engineer seal a hull breach', () => {
    const s = new GameState(calm);
    s.rooms[0].breach = 6;
    run(s, 6);
    expect(s.rooms[0].breach).toBe(0);
  });
});
