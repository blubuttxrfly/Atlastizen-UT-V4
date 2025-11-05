import { useEffect, useMemo, useRef, useState } from "react";
import { START_TIME, END_TIME, pause, play, setSpeed, setT, timeStore, useTime } from "./time";

type PlanetName = "Mercury" | "Venus" | "Earth" | "Mars" | "Jupiter" | "Saturn";

type Vec2 = { x: number; y: number };

type CometSample = { ts: number; pos: Vec2 };

type OrbitCache = {
  planetOrbits: Record<PlanetName, Vec2[]>;
  cometTrack: CometSample[];
  maxRawRadius: number;
};

const PLANET_DATA: Record<
  PlanetName,
  { color: number; size: number; radiusAU: number; periodDays: number; label: string }
> = {
  Mercury: { color: 0x777777, size: 0.9, radiusAU: 0.39, periodDays: 87.969, label: "Mercury" },
  Venus: { color: 0xc09050, size: 1.1, radiusAU: 0.72, periodDays: 224.701, label: "Venus" },
  Earth: { color: 0x4aa3ff, size: 1.2, radiusAU: 1.0, periodDays: 365.256, label: "Earth" },
  Mars: { color: 0xff5533, size: 1.0, radiusAU: 1.52, periodDays: 686.98, label: "Mars" },
  Jupiter: { color: 0xf2c078, size: 1.6, radiusAU: 5.2, periodDays: 4332.589, label: "Jupiter" },
  Saturn: { color: 0xdccaa6, size: 1.5, radiusAU: 9.58, periodDays: 10759.22, label: "Saturn" },
};

const PLANETS: PlanetName[] = ["Mercury", "Venus", "Earth", "Mars", "Jupiter", "Saturn"];

const REFERENCE_TIME = Date.UTC(2025, 0, 1);
const MAX_PLANET_RADIUS = PLANETS.reduce(
  (max, planet) => Math.max(max, PLANET_DATA[planet].radiusAU),
  0
);

const FOCUS_RADIUS = 5;
const COMPRESSION_DAMPING = 18;

const AU_KM = 149_597_870.7;

function compressRadius(r: number): number {
  if (r <= FOCUS_RADIUS) return r;
  const excess = r - FOCUS_RADIUS;
  return FOCUS_RADIUS + excess / (1 + excess / COMPRESSION_DAMPING);
}

function compressPosition(point: Vec2): Vec2 {
  const r = Math.hypot(point.x, point.y);
  if (r === 0) return { x: 0, y: 0 };
  const compressed = compressRadius(r);
  const scale = compressed / r;
  return { x: point.x * scale, y: point.y * scale };
}

function planetPositionAt(planet: PlanetName, date: Date): Vec2 {
  const { radiusAU, periodDays } = PLANET_DATA[planet];
  const periodMs = periodDays * 86400000;
  const elapsed = ((date.getTime() - REFERENCE_TIME) % periodMs + periodMs) % periodMs;
  const angle = (elapsed / periodMs) * Math.PI * 2;
  return {
    x: radiusAU * Math.cos(angle),
    y: radiusAU * Math.sin(angle),
  };
}

function colorToCss(color: number, alpha = 1) {
  const r = (color >> 16) & 0xff;
  const g = (color >> 8) & 0xff;
  const b = color & 0xff;
  return alpha === 1
    ? `rgb(${r}, ${g}, ${b})`
    : `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

async function buildOrbitCache(): Promise<OrbitCache> {
  const sampleCount = 256;
  const planetOrbits = {} as Record<PlanetName, Vec2[]>;
  let maxRawRadius = MAX_PLANET_RADIUS;
  PLANETS.forEach((planet) => {
    const { radiusAU } = PLANET_DATA[planet];
    const orbit: Vec2[] = [];
    for (let i = 0; i <= sampleCount; i += 1) {
      const angle = (i / sampleCount) * Math.PI * 2;
      orbit.push({ x: radiusAU * Math.cos(angle), y: radiusAU * Math.sin(angle) });
    }
    planetOrbits[planet] = orbit;
  });

  const cometTrack = await loadCometEphemeris();
  cometTrack.forEach((sample) => {
    maxRawRadius = Math.max(maxRawRadius, Math.hypot(sample.pos.x, sample.pos.y));
  });

  return {
    planetOrbits,
    cometTrack,
    maxRawRadius,
  };
}

async function loadCometEphemeris(): Promise<CometSample[]> {
  const response = await fetch("comet_3I_ATLAS_2025-06_to_2026-03_12h.json");
  if (!response.ok) {
    throw new Error("Failed to load comet ephemeris");
  }
  const rows: Array<{ ts: string; x: number; y: number; z: number }> = await response.json();
  const samples = rows
    .map((row) => ({
      ts: new Date(row.ts).getTime(),
      pos: { x: row.x, y: row.y },
    }))
    .sort((a, b) => a.ts - b.ts);
  return samples;
}

function interpolateComet(samples: CometSample[], tms: number): Vec2 {
  const seg = findCometSegment(samples, tms);
  if (!seg) return { x: 0, y: 0 };
  const { a, b, u } = seg;
  return {
    x: a.pos.x + (b.pos.x - a.pos.x) * u,
    y: a.pos.y + (b.pos.y - a.pos.y) * u,
  };
}

function findCometSegment(samples: CometSample[], tms: number) {
  if (samples.length === 0) return null;
  if (samples.length === 1) return { a: samples[0], b: samples[0], u: 0 };
  if (tms <= samples[0].ts) return { a: samples[0], b: samples[1], u: 0 };
  if (tms >= samples[samples.length - 1].ts)
    return {
      a: samples[samples.length - 2],
      b: samples[samples.length - 1],
      u: 1,
    };

  let i = 0;
  let j = samples.length - 1;
  while (i + 1 < j) {
    const m = (i + j) >> 1;
    if (samples[m].ts <= tms) i = m;
    else j = m;
  }
  const a = samples[i];
  const b = samples[Math.min(i + 1, samples.length - 1)];
  const denom = b.ts - a.ts;
  const u = denom > 0 ? (tms - a.ts) / denom : 0;
  return { a, b, u: Math.min(Math.max(u, 0), 1) };
}

function computeCometSpeed(samples: CometSample[], tms: number): number {
  const seg = findCometSegment(samples, tms);
  if (!seg) return 0;
  const { a, b } = seg;
  const dt = (b.ts - a.ts) / 1000;
  if (dt <= 0) return 0;
  const dx = (b.pos.x - a.pos.x) * AU_KM;
  const dy = (b.pos.y - a.pos.y) * AU_KM;
  const distanceKm = Math.hypot(dx, dy);
  return distanceKm / dt;
}

function project(point: Vec2, width: number, height: number, scale: number) {
  const compressed = compressPosition(point);
  const cx = width / 2;
  const cy = height / 2;
  return {
    x: cx + compressed.x * scale,
    y: cy - compressed.y * scale,
  };
}

function drawFrame(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  cache: OrbitCache,
  tms: number
) {
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#020617";
  ctx.fillRect(0, 0, width, height);

  const maxRadius = Math.max(cache.maxRawRadius, 1);
  const scale =
    (Math.min(width, height) * 0.85) / (2 * compressRadius(maxRadius));

  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(148, 163, 184, 0.35)";

  PLANETS.forEach((planet) => {
    const { color } = PLANET_DATA[planet];
    const points = cache.planetOrbits[planet];
    if (!points || points.length === 0) return;
    ctx.beginPath();
    points.forEach((pt, idx) => {
      const pos = project(pt, width, height, scale);
      if (idx === 0) ctx.moveTo(pos.x, pos.y);
      else ctx.lineTo(pos.x, pos.y);
    });
    ctx.strokeStyle = colorToCss(color, 0.35);
    ctx.stroke();
  });

  if (cache.cometTrack.length > 1) {
    ctx.beginPath();
    cache.cometTrack.forEach((sample, idx) => {
      const pos = project(sample.pos, width, height, scale);
      if (idx === 0) ctx.moveTo(pos.x, pos.y);
      else ctx.lineTo(pos.x, pos.y);
    });
    ctx.strokeStyle = "rgba(94, 234, 212, 0.6)";
    ctx.stroke();
  }

  const sunRadius = 6;
  ctx.fillStyle = "#fde68a";
  ctx.beginPath();
  ctx.arc(width / 2, height / 2, sunRadius, 0, Math.PI * 2);
  ctx.fill();

  const date = new Date(tms);
  PLANETS.forEach((planet) => {
    const { color, size, label } = PLANET_DATA[planet];
    const pos = project(planetPositionAt(planet, date), width, height, scale);
    ctx.fillStyle = colorToCss(color);
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, 4 * size, 0, Math.PI * 2);
    ctx.fill();
    if (label) {
      ctx.fillStyle = "rgba(226,232,240,0.9)";
      ctx.font = "11px 'JetBrains Mono', ui-monospace, monospace";
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillText(label, pos.x + 6, pos.y + 6);
    }
  });

  if (cache.cometTrack.length > 1) {
    const cometPos = project(interpolateComet(cache.cometTrack, tms), width, height, scale);
    ctx.fillStyle = "#f8fafc";
    ctx.beginPath();
    ctx.arc(cometPos.x, cometPos.y, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(248, 250, 252, 0.35)";
    ctx.beginPath();
    ctx.arc(cometPos.x, cometPos.y, 8, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.restore();
}

function TimeControls() {
  const { t, playing, speed } = useTime();

  const formatted = useMemo(() => new Date(t).toISOString(), [t]);

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-sky-500/30 bg-sky-500/10 p-4 text-sky-100">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          className="rounded-lg bg-sky-500 px-3 py-1.5 text-sm font-semibold text-sky-950 transition hover:bg-sky-400"
          onClick={() => (playing ? pause() : play())}
        >
          {playing ? "Pause" : "Play"}
        </button>
        <label className="flex items-center gap-2 text-xs uppercase tracking-wide text-sky-200/80">
          Speed
          <input
            type="range"
            min={60000}
            max={2.16e8}
            step={60000}
            value={speed}
            onChange={(event) => setSpeed(Number(event.target.value))}
          />
        </label>
      </div>
      <input
        type="range"
        min={START_TIME}
        max={END_TIME}
        value={Math.min(Math.max(t, START_TIME), END_TIME)}
        onChange={(event) => setT(Number(event.target.value))}
      />
      <div className="font-mono text-xs text-sky-100/80">{formatted}</div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="rounded-lg border border-sky-500/50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-sky-100 transition hover:bg-sky-500/20"
          onClick={() => setT(Date.UTC(2025, 9, 29))}
        >
          Jump to Perihelion
        </button>
        <button
          type="button"
          className="rounded-lg border border-sky-500/50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-sky-100 transition hover:bg-sky-500/20"
          onClick={() => setT(START_TIME)}
        >
          Reset to Start
        </button>
      </div>
    </div>
  );
}

export function AtlasCometMap() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const cacheRef = useRef<OrbitCache | null>(null);
  const frameRef = useRef<number | null>(null);
  const lastTickRef = useRef<number>(performance.now());
  const speedRef = useRef<HTMLSpanElement | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cache = await buildOrbitCache();
        if (cancelled) return;
        cacheRef.current = cache;
        setLoading(false);
      } catch (err) {
        console.error(err);
        if (!cancelled) setError("Unable to load orbital data.");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio ?? 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
    const width = canvas.width / dpr;
    const height = canvas.height / dpr;

    let stopped = false;

    const render = () => {
      if (stopped) return;
      const now = performance.now();
      const dt = now - lastTickRef.current;
      lastTickRef.current = now;

      const { playing, speed, t } = timeStore.getState();
      if (playing) {
        const next = t + dt * speed;
        if (next > END_TIME) {
          setT(END_TIME);
          pause();
        } else if (next < START_TIME) {
          setT(START_TIME);
          pause();
        } else {
          setT(next);
        }
      }
      const currentTime = timeStore.getState().t;

      const cache = cacheRef.current;
      if (cache && width > 0 && height > 0) {
        const clampedTime = Math.min(Math.max(currentTime, START_TIME), END_TIME);
        drawFrame(ctx, width, height, cache, clampedTime);
        if (speedRef.current) {
          const speed = computeCometSpeed(cache.cometTrack, clampedTime);
          speedRef.current.textContent = `${speed.toFixed(2)}`;
        }
      }

      frameRef.current = requestAnimationFrame(render);
    };

    frameRef.current = requestAnimationFrame(render);
    return () => {
      stopped = true;
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    };
  }, []);

  return (
    <div className="flex flex-col gap-4">
      <div className="relative mx-auto flex w-full max-w-xl flex-col items-center gap-3 rounded-2xl border border-sky-500/40 bg-slate-900/80 p-4">
        <canvas
          ref={canvasRef}
          width={520 * (window.devicePixelRatio ?? 1)}
          height={520 * (window.devicePixelRatio ?? 1)}
          style={{ width: "520px", height: "520px", display: "block" }}
        />
      {loading ? (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-sky-100/80">
          Loading comet ephemeris…
        </div>
      ) : null}
      {error ? (
        <div className="absolute inset-0 flex items-center justify-center bg-slate-900/80 p-6 text-center text-sm text-red-300">
          {error}
        </div>
      ) : null}
    </div>
    <div className="text-xs text-sky-200/90">
      Comet speed: <span ref={speedRef}>0.00</span> km/s
    </div>
    <TimeControls />
      <p className="text-xs text-slate-300">
        A lightweight, top-down map of the inner solar system (Mercury–Saturn) with the 3I/ATLAS comet
        trajectory. Use the controls to scrub through time or animate the comet’s inbound path.
      </p>
    </div>
  );
}
