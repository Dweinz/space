import Phaser from 'phaser';
import { SpaceScene } from '@/scenes/space-scene';

new Phaser.Game({
  // Canvas: the game only draws vector shapes, so WebGL buys nothing and fails on some GPUs.
  type: Phaser.CANVAS,
  parent: 'game',
  backgroundColor: '#070b14',
  antialias: true,
  scale: { mode: Phaser.Scale.RESIZE, width: '100%', height: '100%' },
  fps: { target: 60 },
  scene: [SpaceScene],
});
