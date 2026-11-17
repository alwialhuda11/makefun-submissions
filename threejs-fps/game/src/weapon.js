// The weapon system: a registry of three guns plus a frag grenade, with recoil, bloom that
// grows while firing and while moving, reloads, and view models. State lives here; the game
// owns the ray and applies the damage.
import * as THREE from 'three';
import { PALETTE } from './palette.js';

// Registry. spread_still is base angular error (radians); spread_move scales with speed;
// bloom grows per shot and decays. Damage: head multiplier applied by the game.
export const WEAPONS = {
  pistol: {
    name: 'P9',
    kind: 'gun',
    mag: 12,
    reserve: 60,
    fireGap: 0.15,
    reloadTime: 1.4,
    auto: false,
    damage: 28,
    headMult: 3,
    spreadStill: 0.0035,
    spreadMove: 0.012,
    spreadBloom: 0.002,
    bloomMax: 0.02,
    view: { w: 0.07, h: 0.09, len: 0.32 },
  },
  rifle: {
    name: 'RK-74',
    kind: 'gun',
    mag: 30,
    reserve: 90,
    fireGap: 0.1,
    reloadTime: 2.0,
    auto: true,
    damage: 34,
    headMult: 3.2,
    spreadStill: 0.003,
    spreadMove: 0.02,
    spreadBloom: 0.0035,
    bloomMax: 0.028,
    view: { w: 0.09, h: 0.1, len: 0.46 },
  },
  smg: {
    name: 'MP-7',
    kind: 'gun',
    mag: 32,
    reserve: 100,
    fireGap: 0.07,
    reloadTime: 1.9,
    auto: true,
    damage: 20,
    headMult: 3,
    spreadStill: 0.004,
    spreadMove: 0.026,
    spreadBloom: 0.004,
    bloomMax: 0.034,
    view: { w: 0.08, h: 0.09, len: 0.4 },
  },
  grenade: {
    name: 'Frag',
    kind: 'grenade',
    count: 1,
    fuse: 1.6,
    radius: 5.5,
    maxDamage: 95,
  },
};

const MOVE_REFERENCE = 5.2;

export function createWeaponSystem(camera) {
  // Shared materials for view models.
  const grip = new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.hairline), roughness: 0.7, metalness: 0.2 });
  const body = new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.ink), roughness: 0.5, metalness: 0.35 });
  const accent = new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.accent), roughness: 0.4, metalness: 0.2 });

  const gunGroup = new THREE.Group();
  camera.add(gunGroup);

  // Model groups per gun, so we can show/hide on swap.
  const gunModels = {};
  for (const key of ['pistol', 'rifle', 'smg']) {
    const cfg = WEAPONS[key];
    const g = new THREE.Group();
    const receiver = new THREE.Mesh(new THREE.BoxGeometry(cfg.view.w, cfg.view.h, cfg.view.len), body);
    const barrel = new THREE.Mesh(new THREE.BoxGeometry(cfg.view.w * 0.5, cfg.view.h * 0.45, cfg.view.len * 0.9), grip);
    barrel.position.set(0, 0.02, -cfg.view.len * 0.8);
    const stock = new THREE.Mesh(new THREE.BoxGeometry(cfg.view.w * 0.8, cfg.view.h * 0.8, cfg.view.len * 0.5), grip);
    stock.position.set(0, -0.02, cfg.view.len * 0.65);
    g.add(receiver, barrel, stock);
    // A small accent stripe.
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(cfg.view.w * 1.05, cfg.view.h * 0.18, cfg.view.len * 0.14), accent);
    stripe.position.set(0, cfg.view.h * 0.4, 0);
    g.add(stripe);
    g.visible = false;
    gunGroup.add(g);
    gunModels[key] = g;
  }
  gunGroup.position.set(0.24, -0.2, -0.42);

  // Grenade view: a small sphere resting in hand when selected.
  const nadeGroup = new THREE.Group();
  const nadeSphere = new THREE.Mesh(new THREE.SphereGeometry(0.09, 12, 10), body);
  nadeGroup.add(nadeSphere);
  nadeGroup.position.set(0.3, -0.24, -0.5);
  nadeGroup.visible = false;
  camera.add(nadeGroup);

  const flash = new THREE.Mesh(
    new THREE.PlaneGeometry(0.24, 0.24),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(PALETTE.accent), transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide })
  );
  flash.position.set(0.24, -0.18, -0.95);
  flash.visible = false;
  camera.add(flash);

  const flashLight = new THREE.PointLight(new THREE.Color(PALETTE.accent), 0, 5);
  flashLight.position.set(0.24, -0.16, -0.6);
  camera.add(flashLight);

  // Inventory.
  const inventory = {
    pistol: { mag: WEAPONS.pistol.mag, reserve: WEAPONS.pistol.reserve, grenades: 0 },
    rifle: { mag: WEAPONS.rifle.mag, reserve: WEAPONS.rifle.reserve, grenades: 0 },
    smg: { mag: WEAPONS.smg.mag, reserve: WEAPONS.smg.reserve, grenades: 0 },
  };

  const state = {
    slot: 'pistol',
    mag: WEAPONS.pistol.mag,
    reserve: WEAPONS.pistol.reserve,
    grenades: 0,
    cooldown: 0,
    reloadLeft: 0,
    flash: 0,
    kick: 0,
    bloom: 0,
    firing: false,
  };

  function currentCfg() {
    return WEAPONS[state.slot];
  }

  function applySlot() {
    const key = state.slot;
    if (key === 'grenade') {
      gunGroup.visible = false;
      nadeGroup.visible = true;
      state.mag = 0;
      state.reserve = 0;
      state.grenades = inventory.rifle.grenades;
      return;
    }
    gunGroup.visible = true;
    nadeGroup.visible = false;
    for (const k of Object.keys(gunModels)) gunModels[k].visible = k === key;
    state.mag = inventory[key].mag;
    state.reserve = inventory[key].reserve;
    state.grenades = inventory.rifle.grenades;
  }

  function select(slot) {
    if (slot === state.slot) return;
    if (slot !== 'grenade' && !WEAPONS[slot]) return;
    if (slot === 'grenade' && inventory.rifle.grenades <= 0) return;
    state.slot = slot;
    state.cooldown = 0;
    state.reloadLeft = 0;
    state.bloom = 0;
    applySlot();
  }

  function step(dt) {
    state.cooldown = Math.max(0, state.cooldown - dt);
    state.flash = Math.max(0, state.flash - dt);
    state.kick += (0 - state.kick) * Math.min(1, dt * 14);
    state.bloom = Math.max(0, state.bloom - dt * 0.045);
    gunGroup.position.z = -0.42 + state.kick;
    gunGroup.rotation.x = state.kick * 2.2;
    nadeGroup.rotation.y += dt * 2.4;
    flash.visible = state.flash > 0;
    flash.rotation.z = state.flash * 30;
    flashLight.intensity = state.flash > 0 ? 18 : 0;
    if (state.reloadLeft > 0) {
      state.reloadLeft = Math.max(0, state.reloadLeft - dt);
      gunGroup.rotation.x = -0.55 * Math.min(1, (currentCfg().reloadTime - state.reloadLeft) * 2);
      if (state.reloadLeft === 0) {
        const cfg = currentCfg();
        const need = cfg.mag - state.mag;
        const take = Math.min(need, state.reserve);
        state.mag += take;
        state.reserve -= take;
      }
    }
  }

  function readyToFire() {
    const cfg = currentCfg();
    if (cfg.kind === 'grenade') return state.cooldown === 0 && state.grenades > 0;
    return state.mag > 0 && state.cooldown === 0 && state.reloadLeft === 0;
  }

  function pullTrigger() {
    const cfg = currentCfg();
    state.cooldown = cfg.fireGap ?? 0.4;
    if (cfg.kind === 'grenade') {
      state.flash = 0;
      state.kick = 0.02;
      return;
    }
    state.flash = 0.06;
    state.kick = 0.055;
    state.bloom = Math.min(cfg.bloomMax, state.bloom + cfg.spreadBloom);
  }

  function takeRound() {
    const cfg = currentCfg();
    if (cfg.kind === 'grenade') {
      state.grenades -= 1;
      inventory.rifle.grenades = state.grenades;
      return true;
    }
    if (state.mag <= 0) return false;
    state.mag -= 1;
    return true;
  }

  function reload() {
    const cfg = currentCfg();
    if (cfg.kind !== 'gun') return;
    if (state.reloadLeft > 0 || state.mag === cfg.mag || state.reserve === 0) return;
    state.reloadLeft = cfg.reloadTime;
  }

  function spread(speed) {
    const cfg = currentCfg();
    return cfg.spreadStill + Math.min(1, speed / MOVE_REFERENCE) * cfg.spreadMove + state.bloom;
  }

  function addGrenades(n) {
    inventory.rifle.grenades += n;
    if (state.slot === 'grenade') state.grenades = inventory.rifle.grenades;
  }

  // Buy a weapon or grenade by key; requires spending (handled by game). Returns bool.
  function buy(key) {
    if (!WEAPONS[key]) return false;
    if (key === 'grenade') {
      addGrenades(1);
      return true;
    }
    // Refill the gun.
    const cfg = WEAPONS[key];
    inventory[key].mag = cfg.mag;
    inventory[key].reserve = cfg.reserve;
    if (state.slot === key) {
      state.mag = cfg.mag;
      state.reserve = cfg.reserve;
    }
    return true;
  }

  function resetLoadout(hasRifle, hasSmg, nades) {
    inventory.pistol.mag = WEAPONS.pistol.mag;
    inventory.pistol.reserve = WEAPONS.pistol.reserve;
    inventory.rifle.mag = WEAPONS.rifle.mag;
    inventory.rifle.reserve = WEAPONS.rifle.reserve;
    inventory.rifle.grenades = nades;
    inventory.smg.mag = WEAPONS.smg.mag;
    inventory.smg.reserve = WEAPONS.smg.reserve;
    inventory.smg.grenades = nades;
  }

  return {
    state,
    inventory,
    step,
    readyToFire,
    pullTrigger,
    takeRound,
    reload,
    spread,
    select,
    buy,
    addGrenades,
    resetLoadout,
    applySlot,
  };
}
