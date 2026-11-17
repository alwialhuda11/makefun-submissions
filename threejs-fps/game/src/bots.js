// Enemy bots: defenders that patrol the lanes, hold guard posts, and react to what they see
// and hear. Each bot is a body (torso + head hitboxes) that moves along waypoints, turns to
// face threats, and fires hitscan shots back at the player. Vision is a cone + line-of-sight
// cast; hearing reacts to nearby gunfire within a radius.
import * as THREE from 'three';
import { TEAM } from './palette.js';

const BOT_HEALTH = 100;
const EYE = 1.55;
const WALK_SPEED = 3.9;
const TURN_SPEED = 4.5;
const FOV = 1.0; // radians ~ 57 deg half-angle for vision cone
const SIGHT_RANGE = 26;
const HEAR_RANGE = 16;
const REACT_MIN = 0.22;
const REACT_MAX = 0.7;
const FIRE_GAP = 0.11;
const AMMO = 30;
const RELOAD_TIME = 1.9;
const ACCURACY_STILL = 0.004;
const ACCURACY_MOVING = 0.03;

export function createBots(scene, shootables) {
  const group = new THREE.Group();
  scene.add(group);

  const bodyMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(TEAM.defender), roughness: 0.6, metalness: 0.05 });
  const headMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(TEAM.defender), roughness: 0.4, metalness: 0.1 });
  const visorMat = new THREE.MeshStandardMaterial({ color: new THREE.Color('#0a0d12'), roughness: 0.3, metalness: 0.4 });

  const torsoGeo = new THREE.BoxGeometry(0.52, 0.78, 0.3);
  const headGeo = new THREE.SphereGeometry(0.16, 14, 11);
  const visorGeo = new THREE.BoxGeometry(0.22, 0.06, 0.1);

  const rng = mulberry32(1337);
  const bots = [];

  function spawn(def) {
    const b = {
      position: new THREE.Vector3(def.x, 0, def.z),
      velocity: new THREE.Vector3(),
      yaw: def.yaw ?? 0,
      health: BOT_HEALTH,
      alive: true,
      ammo: AMMO,
      reloadLeft: 0,
      cooldown: 0,
      reactLeft: 0,
      alerted: false,
      mode: 'patrol', // patrol | hold | engage
      holdPoint: new THREE.Vector3(def.x, 0, def.z),
      waypoints: def.waypoints.map(([x, z]) => new THREE.Vector3(x, 0, z)),
      wpIndex: 0,
      speed: WALK_SPEED + rng() * 0.4,
      lastShot: 0,
      pinned: false,
    };
    const torso = new THREE.Mesh(torsoGeo, bodyMat);
    torso.position.y = 1.0;
    torso.userData.bot = b;
    torso.userData.part = 'torso';
    const head = new THREE.Mesh(headGeo, headMat);
    head.position.y = 1.55;
    head.userData.bot = b;
    head.userData.part = 'head';
    const visor = new THREE.Mesh(visorGeo, visorMat);
    visor.position.set(0, 1.55, 0.14);
    b.group = new THREE.Group();
    b.group.add(torso, head, visor);
    b.group.position.copy(b.position);
    b.torso = torso;
    b.head = head;
    b.hitMeshes = [torso, head];
    group.add(b.group);
    bots.push(b);
    return b;
  }

  function mulberry32(seed) {
    let a = seed;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---- Routes. Defenders hold posts near the site; a couple patrol the lanes. ----

  // Two site guards: hold at the two bombsite doors.
  spawn({
    x: 11.5, z: -2.6, yaw: Math.PI,
    waypoints: [[11.5, -2.6], [11.5, -5.5]],
  });
  spawn({
    x: 11.5, z: 2.6, yaw: -Math.PI,
    waypoints: [[11.5, 2.6], [11.5, 5.5]],
  });

  // North-lane patrol.
  spawn({
    x: -8, z: -11, yaw: 0,
    waypoints: [[-8, -11], [1, -11], [3.2, -11], [-1, -13]],
  });

  // South-lane patrol.
  spawn({
    x: -8, z: 11, yaw: 0,
    waypoints: [[-8, 11], [1, 11], [3.2, 11], [-1, 13]],
  });

  // A mid roamer that holds near the central spine.
  spawn({
    x: -3.5, z: 0, yaw: 0,
    waypoints: [[-3.5, 0], [-2, 0], [-3.5, 0]],
  });

  // Raycast against world colliders for line of sight. Reused vector/ray.
  const ray = new THREE.Raycaster();
  const origin = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);

  function hasLineOfSight(b) {
    origin.set(b.position.x, EYE, b.position.z);
    if (typeof window !== 'undefined' && window.__playerPos) {
      dir.set(window.__playerPos.x, EYE, window.__playerPos.z).sub(origin).normalize();
    } else {
      return false;
    }
    ray.set(origin, dir);
    ray.far = SIGHT_RANGE;
    const hits = ray.intersectObjects(shootables, false);
    return hits.length === 0;
  }

  function facePoint(b, px, pz, dt) {
    const dx = px - b.position.x;
    const dz = pz - b.position.z;
    const target = Math.atan2(-dx, -dz);
    let diff = target - b.yaw;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    const maxStep = TURN_SPEED * dt;
    b.yaw += Math.max(-maxStep, Math.min(maxStep, diff));
  }

  function advanceWaypoint(b, dt) {
    const target = b.waypoints[b.wpIndex];
    if (!target) return;
    const dx = target.x - b.position.x;
    const dz = target.z - b.position.z;
    const dist = Math.hypot(dx, dz);
    facePoint(b, target.x, target.z, dt);
    if (dist < 0.3) {
      b.wpIndex = (b.wpIndex + 1) % b.waypoints.length;
      return;
    }
    const s = Math.min(1, (b.speed * dt) / dist);
    b.position.x += dx * s;
    b.position.z += dz * s;
    b.velocity.set(dx * s * 60, 0, dz * s * 60);
  }

  function damage(bot, amount) {
    if (!bot.alive) return false;
    bot.health -= amount;
    if (bot.health <= 0) {
      bot.health = 0;
      bot.alive = false;
      bot.group.rotation.x = -Math.PI / 2;
      bot.group.position.y = -0.3;
      return true;
    }
    return false;
  }

  function alert(bot, sourcePos) {
    bot.alerted = true;
    bot.reactLeft = REACT_MIN + rng() * (REACT_MAX - REACT_MIN);
    bot.mode = 'engage';
    // Remember where the threat is.
    bot.lastKnown = sourcePos ? sourcePos.clone() : null;
  }

  function step(dt, playerPos, playerAlive, gunfireEvents) {
    // Update group transforms to match logical positions each frame.
    for (const b of bots) {
      if (!b.alive) continue;
      b.cooldown = Math.max(0, b.cooldown - dt);
      b.reloadLeft = Math.max(0, b.reloadLeft - dt);
      if (b.reactLeft > 0) b.reactLeft -= dt;

      // Hearing: nearby gunfire alerts bots within radius.
      if (gunfireEvents && gunfireEvents.length) {
        for (const ev of gunfireEvents) {
          const d = b.position.distanceTo(ev.pos);
          if (d < HEAR_RANGE && !b.alerted) {
            alert(b, ev.pos);
          }
        }
      }

      // Vision: if player alive and in front cone and line of sight, engage.
      const seen = playerAlive && b.hitMeshes && b.torso && !b.pinned;
      // Determine whether player is in front.
      let playerInFront = false;
      if (seen && playerPos) {
        const dx = playerPos.x - b.position.x;
        const dz = playerPos.z - b.position.z;
        const dist = Math.hypot(dx, dz);
        // Angle between bot facing and direction to player.
        const facingX = Math.sin(b.yaw) * -1;
        const facingZ = Math.cos(b.yaw) * -1;
        const dot = (dx * facingX + dz * facingZ) / (dist + 0.0001);
        playerInFront = dot > Math.cos(FOV) && dist < SIGHT_RANGE;
      }
      if (playerInFront && hasLineOfSight(b)) {
        if (!b.alerted) alert(b, playerPos);
        else if (playerPos) b.lastKnown = playerPos.clone();
      } else if (b.alerted && b.lastKnown) {
        // Move toward last known position to investigate.
        const d = b.position.distanceTo(b.lastKnown);
        if (d > 1.2) {
          b.mode = 'engage';
          advanceToPoint(b, b.lastKnown, dt);
        } else {
          b.mode = 'hold';
        }
      } else if (!b.alerted) {
        b.mode = 'patrol';
      }

      // Movement decisions.
      if (b.mode === 'patrol') {
        advanceWaypoint(b, dt);
      } else if (b.mode === 'hold') {
        // Stay still, hold the point. A little idle sway.
        if (b.holdPoint) {
          const d = b.position.distanceTo(b.holdPoint);
          if (d > 0.5) advanceToPoint(b, b.holdPoint, dt);
        }
      }

      // Firing.
      if (b.mode === 'engage' && b.reactLeft <= 0 && playerAlive && playerPos && b.ammo > 0 && b.reloadLeft === 0) {
        // Aim at the player.
        facePoint(b, playerPos.x, playerPos.z, dt);
        const dist = b.position.distanceTo(playerPos);
        if (dist < SIGHT_RANGE && b.cooldown === 0) {
          // Only fire if we roughly face the player and have LOS.
          const dx = playerPos.x - b.position.x;
          const dz = playerPos.z - b.position.z;
          const facingX = Math.sin(b.yaw) * -1;
          const facingZ = Math.cos(b.yaw) * -1;
          const dot = (dx * facingX + dz * facingZ) / Math.max(dist, 0.0001);
          if (dot > 0.94) {
            b.cooldown = FIRE_GAP;
            b.ammo -= 1;
            const moving = b.velocity.length() > 1.5;
            const acc = (moving ? ACCURACY_MOVING : ACCURACY_STILL) + Math.max(0, dist - 8) * 0.0006;
            const spread = acc * (0.6 + rng() * 0.8);
            b.lastShot = { spread, forceHead: rng() < 0.18 };
            // Report gunfire for the player's hearing (directional cues).
            if (gunfireEvents) {
              gunfireEvents.push({ pos: b.position.clone(), bot: b });
            }
            // Actually apply a shot to the player (done by caller via callback).
          }
          if (b.ammo === 0) {
            b.reloadLeft = RELOAD_TIME;
            b.ammo = AMMO;
            // Slow the engage momentarily.
            b.reactLeft = 0.6;
          }
        }
      }
    }
  }

  function advanceToPoint(b, target, dt) {
    const dx = target.x - b.position.x;
    const dz = target.z - b.position.z;
    const dist = Math.hypot(dx, dz);
    facePoint(b, target.x, target.z, dt);
    const s = Math.min(1, (b.speed * dt) / (dist + 0.0001));
    b.position.x += dx * s;
    b.position.z += dz * s;
    b.velocity.set(dx * s * 60, 0, dz * s * 60);
  }

  function resetRound() {
    for (const b of bots) {
      b.health = BOT_HEALTH;
      b.alive = true;
      b.ammo = AMMO;
      b.reloadLeft = 0;
      b.cooldown = 0;
      b.reactLeft = 0;
      b.alerted = false;
      b.mode = 'patrol';
      b.wpIndex = 0;
      b.group.rotation.set(0, 0, 0);
      b.group.position.y = 0;
      b.position.set(b.holdPoint.x, 0, b.holdPoint.z);
      b.group.position.copy(b.position);
      if (b.waypoints.length > 1) {
        b.position.set(b.waypoints[0].x, 0, b.waypoints[0].z);
        b.group.position.copy(b.position);
      }
      b.pinned = false;
    }
  }

  return {
    bots,
    group,
    spawn,
    damage,
    alert,
    step,
    resetRound,
    hasLineOfSight,
  };
}
