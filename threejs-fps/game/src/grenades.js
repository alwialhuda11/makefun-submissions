// Frag grenades: physics (throw with velocity, gravity, bounce off colliders), fuse timer, and
// a radial explosion that damages anything (player and bots) within its radius, falling off
// with distance. The explosion also spawns a light flash.
import * as THREE from 'three';

const GRAVITY = 20;
const RESTITUTION = 0.35;
const BOUNCE_DAMP = 0.6;

export function createGrenades(scene, colliders) {
  const group = new THREE.Group();
  scene.add(group);

  const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color('#2c323a'), roughness: 0.5, metalness: 0.4 });
  const geo = new THREE.SphereGeometry(0.09, 12, 10);
  const active = [];

  function throwGrenade(origin, direction, speed) {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(origin);
    group.add(mesh);
    active.push({
      mesh,
      vel: direction.clone().multiplyScalar(speed),
      fuse: 1.6,
      alive: true,
    });
    return active.length;
  }

  function step(dt, onExplode) {
    const probe = new THREE.Box3();
    for (let i = active.length - 1; i >= 0; i -= 1) {
      const n = active[i];
      if (!n.alive) {
        group.remove(n.mesh);
        active.splice(i, 1);
        continue;
      }
      n.fuse -= dt;
      if (n.fuse <= 0) {
        n.alive = false;
        if (onExplode) onExplode(n.mesh.position.clone());
        continue;
      }
      n.vel.y -= GRAVITY * dt;
      // Move and collide.
      const next = n.mesh.position.clone().add(n.vel.clone().multiplyScalar(dt));
      // Horizontal collision.
      probe.min.set(next.x - 0.09, next.y - 0.09, next.z - 0.09);
      probe.max.set(next.x + 0.09, next.y + 0.09, next.z + 0.09);
      let hit = false;
      for (const c of colliders) {
        if (probe.intersectsBox(c)) {
          hit = true;
          break;
        }
      }
      if (hit) {
        // Simple reflect against the dominant axis.
        n.vel.x *= -RESTITUTION * BOUNCE_DAMP;
        n.vel.z *= -RESTITUTION * BOUNCE_DAMP;
        n.vel.y = Math.abs(n.vel.y) * RESTITUTION * 0.5;
        if (Math.abs(n.vel.x) < 0.5 && Math.abs(n.vel.z) < 0.5) n.vel.x = n.vel.z = 0;
      } else {
        n.mesh.position.copy(next);
      }
      // Floor.
      if (n.mesh.position.y < 0.09) {
        n.mesh.position.y = 0.09;
        n.vel.y = 0;
        n.vel.x *= BOUNCE_DAMP;
        n.vel.z *= BOUNCE_DAMP;
      }
    }
  }

  function reset() {
    for (const n of active) group.remove(n.mesh);
    active.length = 0;
  }

  return { group, throwGrenade, step, reset };
}
