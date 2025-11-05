
import * as THREE from 'three';

export type CometSample = { ts: string; x: number; y: number; z: number }; // AU in ECL

export async function loadCometEphem(url = '/comet_3I_ATLAS_2025-06_to_2026-03_12h.json') {
  const res = await fetch(url);
  const rows: CometSample[] = await res.json();
  rows.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
  return rows;
}

export function makeCometPolyline(samples: CometSample[], color = 0xffffff) {
  const pts = samples.map(s => new THREE.Vector3(s.x, s.y, s.z));
  const geom = new THREE.BufferGeometry().setFromPoints(pts);
  const mat  = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.85 });
  return new THREE.Line(geom, mat);
}

export function makeCometMarker() {
  return new THREE.Mesh(
    new THREE.SphereGeometry(0.06, 20, 12),
    new THREE.MeshBasicMaterial({ color: 0xffffff })
  );
}

export function interpolateComet(samples: CometSample[], tms: number): THREE.Vector3 {
  const t = tms;
  let i = 0, j = samples.length - 1;
  while (i + 1 < j) {
    const m = (i + j) >> 1;
    if (new Date(samples[m].ts).getTime() <= t) i = m; else j = m;
  }
  const a = samples[i], b = samples[Math.min(i + 1, samples.length - 1)];
  const ta = new Date(a.ts).getTime(), tb = new Date(b.ts).getTime();
  const u  = tb === ta ? 0 : (t - ta) / (tb - ta);
  return new THREE.Vector3(
    a.x + (b.x - a.x) * u,
    a.y + (b.y - a.y) * u,
    a.z + (b.z - a.z) * u
  );
}
