
import * as THREE from 'three';
import * as Astro from 'astronomy-engine';

// 1 AU = 1 scene unit
const AU = 1;

function toEcliptic(vec: Astro.Vector): THREE.Vector3 {
  const rot = Astro.Rotation_EQJ_ECL();
  const ecl = Astro.RotateVector(rot, vec);
  return new THREE.Vector3(ecl.x * AU, ecl.y * AU, ecl.z * AU);
}

function planetXYZ(planet: string, date: Date): THREE.Vector3 {
  const vec = Astro.HelioVector(planet as Astro.Body, date);
  return toEcliptic(vec);
}

// Approx sidereal periods (days)
const PERIOD: Record<string, number> = {
  Mercury: 87.969,
  Venus: 224.701,
  Earth: 365.256,
  Mars: 686.980,
  Jupiter: 4332.589,
  Saturn: 10759.22,
  Uranus: 30685.4,
  Neptune: 60189.0,
};

export function makeOrbitRing(planet: string, color = 0x3355ff) {
  const samples = 512;
  const periodDays = PERIOD[planet] ?? 365.256;
  const start = new Date(Date.UTC(2025, 0, 1));

  const points: THREE.Vector3[] = [];
  for (let i = 0; i <= samples; i++) {
    const d = new Date(start.getTime() + (i / samples) * periodDays * 86400000);
    points.push(planetXYZ(planet, d));
  }

  const geom = new THREE.BufferGeometry().setFromPoints(points);
  const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.35 });
  return new THREE.Line(geom, mat);
}

export function makePlanetMesh(radius = 0.05, color = 0x88ccff) {
  return new THREE.Mesh(
    new THREE.SphereGeometry(radius, 24, 16),
    new THREE.MeshStandardMaterial({ color, metalness: 0.1, roughness: 0.7 })
  );
}

export function updatePlanetMesh(mesh: THREE.Object3D, planet: string, date: Date) {
  const p = planetXYZ(planet, date);
  mesh.position.copy(p);
}
