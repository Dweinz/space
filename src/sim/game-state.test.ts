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

  it('charges for chambers and only builds next to the station', () => {
    const s = new GameState(calm);
    expect(s.requestBuild(5, 5, 'lab').ok).toBe(false);
    const before = s.res.metal;
    expect(s.requestBuild(0, 1, 'lab').ok).toBe(true);
    expect(s.res.metal).toBe(before - 30);
  });

  it('lets an engineer seal a hull breach', () => {
    const s = new GameState(calm);
    s.rooms[0].breach = 6;
    run(s, 6);
    expect(s.rooms[0].breach).toBe(0);
  });
});
