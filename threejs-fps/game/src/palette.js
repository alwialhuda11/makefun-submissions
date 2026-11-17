// The look plan, in one place. Six base values plus team and objective accents; the lighting
// makes every shade the game needs, so no other colour appears in the code. The same six names
// are the CSS custom properties in index.html, and the team colours are the HUD's too.
export const PALETTE = {
  canvas: '#14161a',
  surface: '#1e2228',
  hairline: '#2c323a',
  ink: '#e9e6df',
  muted: '#98a0a8',
  accent: '#f0a830',
};

// Objective and team accents. Attacker = warm, defender = cool, bomb = red.
export const TEAM = {
  attacker: '#e06c4f',
  defender: '#4f9de0',
  bomb: '#e04f4f',
  bombCasing: '#2c323a',
};

export function shade(name) {
  return PALETTE[name];
}
