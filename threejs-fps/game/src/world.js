// The map: an original indoor industrial layout, built from boxes. "The Depository".
// Two long lanes (north/south), a mid through the middle, a closed bombsite on the east,
// a raised catwalk over mid, and cover crates in the lanes. Every box is a collider for the
// player and the bots and a surface a bullet stops on. Plain geometry only, no models,
// no textures, no network.
import * as THREE from 'three';
import { PALETTE, TEAM } from './palette.js';

// World half-extents.
const HX = 19;
const HZ = 15;

export function createWorld(scene) {
  const group = new THREE.Group();
  scene.add(group);

  const materials = {};
  for (const name of Object.keys(PALETTE)) {
    materials[name] = new THREE.MeshStandardMaterial({
      color: new THREE.Color(PALETTE[name]),
      roughness: name === 'accent' || name === 'ink' ? 0.55 : 0.92,
      metalness: 0.03,
    });
  }
  const bombMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(TEAM.bomb), roughness: 0.4, metalness: 0.2 });

  const colliders = [];
  const shootables = [];
  const geometryCache = {};

  function geo(w, h, d) {
    const key = `${w}|${h}|${d}`;
    if (!geometryCache[key]) geometryCache[key] = new THREE.BoxGeometry(w, h, d);
    return geometryCache[key];
  }

  function box(width, height, depth, x, y, z, material, opts = {}) {
    const mesh = new THREE.Mesh(geo(width, height, depth), materials[material] ?? bombMat);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    const bb = new THREE.Box3().setFromObject(mesh);
    // Pad the collider slightly inward so the player slides along faces cleanly.
    if (!opts.noCollide) {
      colliders.push(bb);
    }
    if (!opts.noShoot) shootables.push(mesh);
    return mesh;
  }

  // ---- Floor and perimeter walls (the depot shell). ----
  box(HX * 2, 0.4, HZ * 2, 0, -0.2, 0, 'canvas');
  box(0.4, 5.2, HZ * 2, -HX, 2.6, 0, 'surface');
  box(0.4, 5.2, HZ * 2, HX, 2.6, 0, 'surface');
  box(HX * 2, 5.2, 0.4, 0, 2.6, -HZ, 'surface');
  box(HX * 2, 5.2, 0.4, 0, 2.6, HZ, 'surface');

  // ---- Central spine wall splitting the depot into lanes, with three doorways. ----
  // The spine runs east-west at z=0; doors let you cross from north lane to south lane.
  box(6, 3.4, 0.4, -7, 1.7, 0, 'surface');          // west segment (between doors)
  box(6, 3.4, 0.4, 7, 1.7, 0, 'surface');             // east segment

  // ---- Bombsite: an enclosed room on the east end, two doorways. ----
  // North wall of the site (partial, doorway on the north side).
  box(4, 3.4, 0.4, 13, 1.7, -5, 'surface');
  box(4, 3.4, 0.4, 13, 1.7, 5, 'surface');
  // East wall of the site (back wall).
  box(0.4, 3.4, 10, 15, 1.7, 0, 'surface');
  // South wall, doorway on the south side.
  box(0.4, 3.4, 5, 11, 1.7, -7.5, 'surface');
  box(0.4, 3.4, 5, 11, 1.7, 7.5, 'surface');
  // A central pillar inside the site for cover.
  box(1.0, 2.6, 1.0, 13.5, 1.3, 0, 'hairline');

  // The plant zone on the floor of the site (visual marker, not a collider).
  const plantZone = new THREE.Mesh(
    new THREE.PlaneGeometry(2.4, 2.4),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(TEAM.bomb), transparent: true, opacity: 0.28, depthWrite: false })
  );
  plantZone.rotation.x = -Math.PI / 2;
  plantZone.position.set(13.5, 0.02, 0.5);
  group.add(plantZone);

  // ---- Cover crates in the lanes. ----
  // North lane.
  box(2.2, 1.1, 1.4, -11, 0.55, -7, 'hairline');
  box(1.4, 1.1, 2.2, -8.5, 0.55, -11, 'hairline');
  box(2.0, 0.9, 1.2, 3.5, 0.45, -10, 'hairline');
  box(1.2, 1.3, 1.2, 4.8, 0.65, -7.5, 'hairline');
  // South lane.
  box(2.2, 1.1, 1.4, -11, 0.55, 7, 'hairline');
  box(1.4, 1.1, 2.2, -8.5, 0.55, 11, 'hairline');
  box(2.0, 0.9, 1.2, 3.5, 0.45, 10, 'hairline');
  box(1.2, 1.3, 1.2, 4.8, 0.65, 7.5, 'hairline');

  // ---- Mid cover (a few tall pillars + low crates). ----
  box(1.0, 3.0, 1.0, -3.5, 1.5, -4, 'hairline');
  box(1.0, 3.0, 1.0, -3.5, 1.5, 4, 'hairline');
  box(2.4, 0.8, 1.0, 0, 0.4, -3, 'hairline');
  box(2.4, 0.8, 1.0, 0, 0.4, 3, 'hairline');

  // ---- Raised catwalk over mid (north side), a small platform you can jump onto. ----
  // A low ledge + a raised walkway running along the north lane.
  box(1.0, 0.6, 3.0, -5, 0.3, -8.5, 'hairline');
  box(8, 0.5, 2.0, 2, 2.6, -13.5, 'surface', { noCollide: false }); // catwalk floor
  // Catwalk legs.
  box(0.5, 2.6, 0.5, -2, 1.3, -13.5, 'hairline');
  box(0.5, 2.6, 0.5, 6, 1.3, -13.5, 'hairline');
  // Low railing on the catwalk.
  box(8, 0.5, 0.2, 2, 3.0, -12.4, 'hairline');

  // ---- Extra cover / pillars near attacker and defender spawns. ----
  box(1.0, 2.4, 1.0, -16, 1.2, -5, 'hairline');
  box(1.0, 2.4, 1.0, -16, 1.2, 5, 'hairline');

  // ---- Lighting. ----
  const sky = new THREE.HemisphereLight(new THREE.Color(PALETTE.surface), new THREE.Color(PALETTE.canvas), 1.15);
  scene.add(sky);

  const key = new THREE.DirectionalLight(new THREE.Color(PALETTE.ink), 2.4);
  key.position.set(10, 16, 8);
  key.target.position.set(0, 0, 0);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = -20;
  key.shadow.camera.right = 20;
  key.shadow.camera.top = 18;
  key.shadow.camera.bottom = -18;
  key.shadow.camera.far = 50;
  key.shadow.bias = -0.0006;
  scene.add(key, key.target);

  const fill = new THREE.DirectionalLight(new THREE.Color(PALETTE.muted), 0.6);
  fill.position.set(-10, 10, 12);
  scene.add(fill);

  // A warm accent light over the bombsite.
  const siteLight = new THREE.PointLight(new THREE.Color(TEAM.bomb), 1.2, 14);
  siteLight.position.set(13.5, 4.2, 0.5);
  scene.add(siteLight);

  // Spawn definitions (position vectors), used by the round manager.
  const attackerSpawns = [
    new THREE.Vector3(-16.5, 0, 0.5),
    new THREE.Vector3(-16.5, 0, -1.5),
    new THREE.Vector3(-16.5, 0, 1.5),
  ];
  const defenderSpawns = [
    new THREE.Vector3(11.5, 0, -2.5),
    new THREE.Vector3(11.5, 0, 2.5),
    new THREE.Vector3(15.5, 0, 8.5),
  ];

  return { colliders, shootables, group, plantZone, attackerSpawns, defenderSpawns };
}
