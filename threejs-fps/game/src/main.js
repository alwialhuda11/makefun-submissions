// Boot and the one loop: a fixed 60 Hz simulation feeding a render at the display's rate.
// Orchestrates the world, player, weapons, bots, grenades, the match flow, and the HUD.
// ?shot=start|play|end with &seed=N sets up a deterministic frame for a screenshot capture.
import * as THREE from 'three';
import { PALETTE } from './palette.js';
import { createWorld } from './world.js';
import { createInput } from './input.js';
import { createPlayer } from './player.js';
import { createWeaponSystem, WEAPONS } from './weapon.js';
import { createBots } from './bots.js';
import { createGrenades } from './grenades.js';
import { createMatch, PRICES } from './match.js';
import { createHud } from './hud.js';

const FIXED_STEP = 1 / 60;
const params = new URLSearchParams(window.location.search);
const shot = params.get('shot');
const seed = Number.parseInt(params.get('seed') ?? '1', 10) || 1;

function mulberry32(initial) {
  let a = initial;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = mulberry32(seed);

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.getElementById('game').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(PALETTE.canvas);
scene.fog = new THREE.Fog(new THREE.Color(PALETTE.canvas), 30, 60);
const camera = new THREE.PerspectiveCamera(74, window.innerWidth / window.innerHeight, 0.05, 140);
scene.add(camera);

const world = createWorld(scene);
const player = createPlayer(world.colliders);
const weaponSystem = createWeaponSystem(camera);
const bots = createBots(scene, world.shootables);
const grenades = createGrenades(scene, world.colliders);
const match = createMatch();
const hud = createHud();
const input = createInput(renderer.domElement, onLockChange);

const raycaster = new THREE.Raycaster();
raycaster.far = 90;
const shootables = world.shootables;
const direction = new THREE.Vector3();
let accumulated = 0;
let lastTime = performance.now();
let paused = true;
let started = false;
let cleared = false;
let frozen = false;
let roundWon = false;

// Player body ref.
const body = player.state;
// Bomb plant detection region (the plant zone on the floor).
const plantZoneBounds = new THREE.Box3().setFromObject(world.plantZone);
const PLANT_DIST = 1.6;

// Gunfire events for bot hearing.
const gunfireEvents = [];

hud.setHealth(100);
hud.setWeapon('P9');
hud.setAmmo(weaponSystem.state.mag, weaponSystem.state.reserve);
hud.setRound(0, 0);
hud.setMoney(match.match.money);
hud.setKills(0);
hud.setBomb(false);

hud.onBuy((weaponKey) => {
  const bought = match.buyWeapon(weaponKey);
  if (bought) {
    weaponSystem.buy(weaponKey);
    hud.setMoney(match.match.money);
    hud.addFeed('kill', `Bought ${WEAPONS[weaponKey].name}`);
    // Update affordability.
    for (const k of Object.keys(PRICES)) {
      hud.buyRowState(k, match.match.money >= PRICES[k]);
    }
  }
});
hud.onCont(() => {
  deploy();
}, () => {
  nextRound();
});

function startGame() {
  started = true;
  paused = false;
  cleared = false;
  hud.hideOverlay();
  input.requestLock();
  match.startRound();
  beginBuyPhase();
}

function beginBuyPhase() {
  hud.showBuy();
  // Default spawn.
  body.position.copy(world.attackerSpawns[0]);
  body.velocity.set(0, 0, 0);
  body.yaw = 0;
  body.pitch = 0;
  player.resetHealth();
  bots.resetRound();
  grenades.reset();
  weaponSystem.resetLoadout(false, false, 0);
  weaponSystem.select('pistol');
  weaponSystem.applySlot();
  // Affordability.
  for (const k of Object.keys(PRICES)) {
    hud.buyRowState(k, match.match.money >= PRICES[k]);
  }
  hud.setMoney(match.match.money);
  hud.setHealth(100);
  hud.setBomb(false);
  hud.setTimer(match.match.phaseTime, 'BUY');
}

function deploy() {
  match.match.phase = 'live';
  match.match.roundTime = 100;
  paused = false;
  frozen = false;
  hud.hideOverlay();
  if (!input.state.locked) input.requestLock();
}

function nextRound() {
  match.startRound();
  beginBuyPhase();
}

function onLockChange(locked) {
  if (shot) return;
  if (locked) {
    if (!started) {
      started = true;
    }
    hud.hideOverlay();
    paused = false;
  } else {
    // Pointer unlock pauses only if round is live and we were mid-round.
    if (match.match.phase === 'live' && !frozen) {
      paused = true;
    }
  }
}

function syncCamera() {
  camera.position.set(body.position.x, body.position.y + body.eye, body.position.z);
  camera.rotation.set(body.pitch, body.yaw, 0, 'YXZ');
}

function aimAt(point) {
  const dx = point.x - body.position.x;
  const dy = point.y - (body.position.y + body.eye);
  const dz = point.z - body.position.z;
  const length = Math.hypot(dx, dy, dz) || 1;
  body.yaw = Math.atan2(-dx, -dz);
  body.pitch = Math.asin(Math.max(-1, Math.min(1, dy / length)));
  syncCamera();
}

function fireWeapon() {
  const cfg = WEAPONS[weaponSystem.state.slot];
  if (!weaponSystem.readyToFire()) return false;
  if (!weaponSystem.takeRound()) return false;

  if (cfg.kind === 'grenade') {
    const origin = new THREE.Vector3(body.position.x, body.position.y + body.eye, body.position.z);
    camera.getWorldDirection(direction);
    const throwDir = direction.clone().normalize();
    grenades.throwGrenade(origin, throwDir, 16);
    hud.setAmmo(weaponSystem.state.grenades, 0);
    hud.setWeapon('Frag');
    weaponSystem.pullTrigger();
    return true;
  }

  camera.getWorldDirection(direction);
  const spread = weaponSystem.spread(player.groundSpeed());
  direction.x += (random() * 2 - 1) * spread;
  direction.y += (random() * 2 - 1) * spread;
  direction.z += (random() * 2 - 1) * spread;
  direction.normalize();
  scene.updateMatrixWorld(true);
  raycaster.set(camera.position, direction);
  const hits = raycaster.intersectObjects(shootables, false);
  const hit = hits[0];

  if (hit) {
    let target = hit.object;
    let damage = cfg.damage;
    let killed = false;
    let headshot = false;

    // Walk up the hit object's parents to find a bot or the player.
    if (target.userData.bot) {
      const bot = target.userData.bot;
      headshot = target.userData.part === 'head';
      const dmg = headshot ? damage * cfg.headMult : damage;
      killed = bots.damage(bot, dmg);
      if (killed) {
        const reward = cfg.damage * (headshot ? cfg.headMult : 1);
        hud.addFeed('kill', `You killed a defender${headshot ? ' (headshot)' : ''}`);
        match.onKill('defender');
        hud.setKills(match.match.kills);
        // Check if all defenders dead.
        const allDead = bots.bots.every((b) => !b.alive);
        if (allDead) {
          match.onAllDefendersDead();
          showRoundEnd();
        }
      } else {
        hud.hitMarker(false);
      }
    } else if (hit.object.userData.target && hit.object.userData.target.bot) {
      // not used.
    }
    // Player never gets hit by his own shots.
  }

  // Gunfire event (for bots' hearing).
  gunfireEvents.push({ pos: body.position.clone() });

  weaponSystem.pullTrigger();
  player.recoil(0.009 + random() * 0.004, (random() * 2 - 1) * 0.004);
  hud.setAmmo(weaponSystem.state.mag, weaponSystem.state.reserve);
  return true;
}

// Bot firing applies damage to the player.
function applyBotDamage(bot) {
  if (!bot.lastShot || !player.state.alive) return;
  const s = bot.lastShot;
  const dist = bot.position.distanceTo(body.position);
  const accuracy = Math.max(0.02, 1 - dist / 26);
  const hitChance = Math.min(0.85, accuracy);
  if (random() > hitChance) return;
  const dmg = s.forceHead ? 70 : 22; // headshot chance does more
  player.takeDamage(dmg);
  hud.setHealth(player.state.health);
  hud.damageFlash();
  if (!player.state.alive) {
    hud.addFeed('death', 'You were eliminated');
    match.onPlayerDied();
    showRoundEnd();
  }
}

function showRoundEnd() {
  if (frozen) return;
  frozen = true;
  const result = match.match.roundResult;
  if (result) {
    hud.showEnd(result, match.match.score.attacker, match.match.score.defender);
    hud.setRound(match.match.score.attacker, match.match.score.defender);
  }
}

function plantBomb() {
  if (match.match.phase !== 'live' || match.match.bombPlanted) return;
  if (body.position.distanceTo(new THREE.Vector3(13.5, 0, 0.5)) < PLANT_DIST) {
    match.onBombPlanted();
    hud.setBomb(true);
    hud.addFeed('kill', 'Bomb planted');
    gunfireEvents.length = 0;
    // Bots react to the plant (sound) — alert all defenders.
    for (const b of bots.bots) {
      if (b.alive) bots.alert(b, new THREE.Vector3(13.5, 0, 0.5));
    }
  }
}

function step(dt) {
  // Match timer.
  match.tick(dt);

  // Player sim (skip if dead).
  player.step(dt, input.state.keys);

  // Weapon sim.
  weaponSystem.step(dt);

  // Grenades.
  grenades.step(dt, (pos) => {
    // Explosion: damage anything within radius.
    const radius = WEAPONS.grenade.radius;
    const maxDmg = WEAPONS.grenade.maxDamage;
    for (const b of bots.bots) {
      if (!b.alive) continue;
      const d = b.position.distanceTo(pos);
      if (d < radius) {
        const dmg = maxDmg * (1 - d / radius);
        const killed = bots.damage(b, dmg);
        if (killed) {
          hud.addFeed('kill', 'Grenade kill');
          match.onKill('defender');
          hud.setKills(match.match.kills);
          if (bots.bots.every((bb) => !bb.alive)) {
            match.onAllDefendersDead();
            showRoundEnd();
          }
        }
      }
    }
    if (player.state.alive) {
      const d = body.position.distanceTo(pos);
      if (d < radius) {
        const dmg = maxDmg * (1 - d / radius) * 0.7;
        player.takeDamage(dmg);
        hud.setHealth(player.state.health);
        hud.damageFlash();
        if (!player.state.alive) {
          hud.addFeed('death', 'You were caught in a blast');
          match.onPlayerDied();
          showRoundEnd();
        }
      }
    }
  });

  // Bots.
  if (match.match.phase === 'live') {
    bots.step(dt, body.position, player.state.alive, gunfireEvents);
    // Apply bot shots to player.
    const shootingBot = bots.bots.find((b) => b.alive && b.lastShot && b.cooldown > 0);
    if (shootingBot) {
      applyBotDamage(shootingBot);
      shootingBot.lastShot = null;
    }
  } else {
    bots.step(dt, body.position, false, []);
  }

  // Clear gunfire events.
  gunfireEvents.length = 0;

  // Bomb timer check happening in match.
  if (match.match.bombPlanted) {
    hud.setBomb(true);
  }

  // HUD sync every frame (cheap).
  if (match.match.phase === 'buy') {
    hud.setTimer(match.match.phaseTime, 'BUY');
  } else if (match.match.phase === 'live') {
    hud.setTimer(match.match.bombPlanted ? match.match.bombTimer : match.match.roundTime, 'LIVE');
  } else {
    const result = match.match.roundResult;
    if (result) hud.setRound(match.match.score.attacker, match.match.score.defender);
  }
  hud.setMoney(match.match.money);
}

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - lastTime) / 1000, 0.1);
  lastTime = now;
  if (!frozen && !paused) {
    const look = input.takeLook();
    if (player.state.alive) {
      player.look(look.x, look.y);
      if (input.state.firing && weaponSystem.readyToFire() && match.match.phase === 'live') {
        fireWeapon();
      }
      if (input.state.keys.has('KeyR')) weaponSystem.reload();

      // Weapon switching.
      if (input.state.keys.has('Digit1')) weaponSystem.select('pistol');
      if (input.state.keys.has('Digit2')) weaponSystem.select('smg');
      if (input.state.keys.has('Digit3')) weaponSystem.select('rifle');
      if (input.state.keys.has('Digit4')) weaponSystem.select('grenade');

      // Bomb plant (E).
      if (input.state.keys.has('KeyE')) plantBomb();
    }
    accumulated += dt;
    let steps = 0;
    while (accumulated >= FIXED_STEP && steps < 5) {
      step(FIXED_STEP);
      accumulated -= FIXED_STEP;
      steps += 1;
    }
    if (accumulated > FIXED_STEP * 5) accumulated = 0;
    syncCamera();
  }
  renderer.render(scene, camera);
}

// ---- Deterministic screenshot modes (used by the build to generate shots). ----
function settle(steps) {
  for (let index = 0; index < steps; index += 1) step(FIXED_STEP);
}

function runShot(name) {
  hud.hideOverlay();
  body.pitch = 0;
  body.yaw = 0;
  body.position.copy(world.attackerSpawns[0]);
  body.velocity.set(0, 0, 0);
  player.resetHealth();
  bots.resetRound();
  grenades.reset();
  weaponSystem.select('rifle');
  weaponSystem.buy('rifle');
  weaponSystem.applySlot();

  if (name === 'play' || name === 'end') {
    // Walk toward the site a bit and show combat.
    body.position.set(-6, 0, -2);
    settle(20);
    // Aim toward a defender.
    const targetBot = bots.bots[0];
    aimAt(targetBot.head.position);
    // Fire a burst.
    for (let i = 0; i < 3; i += 1) {
      fireWeapon();
      settle(4);
    }
    if (name === 'end') {
      // Show the bomb planted + defenders down.
      match.match.bombPlanted = true;
      match.match.bombTimer = 20;
      hud.setBomb(true);
      for (const b of bots.bots) {
        bots.damage(b, 999);
      }
      aimAt(new THREE.Vector3(13.5, 1.5, 0.5));
      settle(8);
    } else {
      settle(12);
    }
  } else {
    // Start screen: overview of the depot from attacker spawn.
    body.position.set(-17, 0, 6);
    body.yaw = 0.5;
    settle(20);
    aimAt(new THREE.Vector3(13, 1.4, 1));
  }
  hud.setRound(match.match.score.attacker, match.match.score.defender);
  hud.setMoney(match.match.money);
  hud.setKills(match.match.kills);
  paintTwiceThenReady();
}

function paintTwiceThenReady() {
  let painted = 0;
  function paint() {
    requestAnimationFrame(paint);
    syncCamera();
    renderer.render(scene, camera);
    painted += 1;
    if (painted === 2) {
      window.__shotReady = true;
      frozen = true;
    }
  }
  requestAnimationFrame(paint);
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// Expose player position to bots (for LOS).
Object.defineProperty(window, '__playerPos', {
  get: () => body.position,
});

// Start.
syncCamera();
// Place in buy phase initially (but paused) so a first click begins.
beginBuyPhase();
if (shot) {
  runShot(shot);
} else {
  // Show start overlay with intro.
  hud.showBuy();
  paused = true;
  requestAnimationFrame(frame);
}
