
import { useEffect, useRef } from 'react';
import { createRenderer } from './scene/engine';
import { makeOrbitRing, makePlanetMesh, updatePlanetMesh } from './scene/orbits';
import { loadCometEphem, makeCometPolyline, makeCometMarker, interpolateComet } from './scene/comet';
import { TimeUI } from './scene/ui';

export default function App() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    const { scene, tick } = createRenderer(ref.current);

    // Orbit rings (inner to Saturn for performance)
    const planets: { name: string; color: number; size: number }[] = [
      { name: 'Mercury', color: 0x777777, size: 0.025 },
      { name: 'Venus',   color: 0xc09050, size: 0.040 },
      { name: 'Earth',   color: 0x4aa3ff, size: 0.045 },
      { name: 'Mars',    color: 0xff5533, size: 0.035 },
      { name: 'Jupiter', color: 0xf2c078, size: 0.090 },
      { name: 'Saturn',  color: 0xdccaa6, size: 0.080 },
    ];

    planets.forEach(p => scene.add(makeOrbitRing(p.name as any, p.color)));

    // Planet meshes
    const planetMeshes = planets.map(p => {
      const mesh = makePlanetMesh(p.size, p.color);
      (mesh as any).planetName = p.name;
      scene.add(mesh);
      return mesh;
    });

    // Comet
    let cometSamples: any[] = [];
    let cometMarker: THREE.Object3D | null = null;

    loadCometEphem().then(samples => {
      cometSamples = samples;
      scene.add(makeCometPolyline(samples, 0xffffff));
      cometMarker = makeCometMarker();
      scene.add(cometMarker);
    });

    tick((tms) => {
      const date = new Date(tms);

      // move planets
      planetMeshes.forEach(mesh => updatePlanetMesh(mesh, (mesh as any).planetName as any, date));

      // move comet
      if (cometMarker && cometSamples.length > 1) {
        const pos = interpolateComet(cometSamples, tms);
        cometMarker.position.copy(pos);
      }
    });
  }, []);

  return (
    <div style={{ height: '100%', width: '100%', display:'grid', gridTemplateRows:'1fr auto' }}>
      <div ref={ref} />
      <TimeUI />
    </div>
  );
}
