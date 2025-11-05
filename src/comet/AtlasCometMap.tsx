import { useEffect, useMemo, useRef, useState } from "react";

type Vec2 = { x: number; y: number };

type Planet = {
  name: string;
  a: number; // semi-major axis in AU
  e: number; // eccentricity
  periodDays: number;
  baseColor: string;
  bands?: string[];
  gradient?: { inner: string; outer: string };
  ring?: { color: string; width: number; opacity: number };
  spots?: Array<{ color: string; radius: number; offset: Vec2 }>;
};

const PLANETS: Planet[] = [
  { name: "Mercury", a: 0.387, e: 0.2056, periodDays: 87.969, baseColor: "#a8a8a8", gradient: { inner: "#f4f4f4", outer: "#7b7b7b" } },
  { name: "Venus", a: 0.723, e: 0.0068, periodDays: 224.701, baseColor: "#e0c080", gradient: { inner: "#fff2cc", outer: "#c89f60" } },
  { name: "Earth", a: 1.0, e: 0.0167, periodDays: 365.256, baseColor: "#4aa3ff", gradient: { inner: "#6fd3ff", outer: "#1359a0" }, spots: [{ color: "#4ade80", radius: 0.18, offset: { x: -0.2, y: 0.05 } }] },
  { name: "Mars", a: 1.524, e: 0.0934, periodDays: 686.98, baseColor: "#ff6a3d", gradient: { inner: "#ffb48a", outer: "#a23a27" } },
  { name: "Jupiter", a: 5.2, e: 0.0489, periodDays: 4332.589, baseColor: "#f2c078", bands: ["#f3d8ab", "#d4a46c", "#f6e5c7", "#c78f57"], spots: [{ color: "#d86b41", radius: 0.35, offset: { x: 0.25, y: 0.05 } }] },
  { name: "Saturn", a: 9.58, e: 0.0565, periodDays: 10759.22, baseColor: "#dccaa6", bands: ["#f6e7c4", "#ceb98d", "#f9eedd", "#cdaa7a"], ring: { color: "rgba(220,202,166,0.7)", width: 0.9, opacity: 0.8 } },
  { name: "Uranus", a: 19.2, e: 0.046, periodDays: 30685.4, baseColor: "#7dd3fc", gradient: { inner: "#b0f0ff", outer: "#459bbf" } },
  { name: "Neptune", a: 30.07, e: 0.009, periodDays: 60189, baseColor: "#7aa2ff", gradient: { inner: "#8ad0ff", outer: "#2843c2" } },
  { name: "Pluto", a: 39.48, e: 0.2488, periodDays: 90560, baseColor: "#cdb4ff", gradient: { inner: "#e6dcff", outer: "#9d86c6" } },
];

const ORBIT_SAMPLES = 512;
const INITIAL_DATE = new Date(Date.UTC(2025, 5, 1));
const AU_PER_PX_AT_1X = 1 / 260; // 260 px per AU at scale = 1
const SCALE_EXP = 0.45;
const ICON_BASE = 6;
const ICON_MIN = 3;
const ICON_MAX = 36;
const FONT_BASE = 11;
const FONT_MIN = 7;
const FONT_MAX = 20;
const SCALE_MIN = 0.15;
const SCALE_MAX = 18;
const CANVAS_SIZE = 560;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function normalizeAngle(angle: number) {
  return ((angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
}

function keplerPosition(planet: Planet, timeMs: number): Vec2 {
  const periodMs = planet.periodDays * 86400000;
  if (!Number.isFinite(periodMs) || periodMs === 0) {
    return { x: planet.a, y: 0 };
  }
  const meanAnomaly = (normalizeAngle((timeMs % periodMs) / periodMs * Math.PI * 2));
  let eccentricAnomaly = meanAnomaly;
  for (let i = 0; i < 5; i += 1) {
    eccentricAnomaly = eccentricAnomaly - (eccentricAnomaly - planet.e * Math.sin(eccentricAnomaly) - meanAnomaly) / (1 - planet.e * Math.cos(eccentricAnomaly));
  }
  const cosE = Math.cos(eccentricAnomaly);
  const sinE = Math.sin(eccentricAnomaly);
  const x = planet.a * (cosE - planet.e);
  const y = planet.a * Math.sqrt(1 - planet.e * planet.e) * sinE;
  return { x, y };
}

function sampleOrbit(planet: Planet): Vec2[] {
  const orbit: Vec2[] = [];
  for (let i = 0; i <= ORBIT_SAMPLES; i += 1) {
    const angle = (i / ORBIT_SAMPLES) * Math.PI * 2;
    const M = angle;
    let E = M;
    for (let it = 0; it < 5; it += 1) {
      E = E - (E - planet.e * Math.sin(E) - M) / (1 - planet.e * Math.cos(E));
    }
    const cosE = Math.cos(E);
    const sinE = Math.sin(E);
    orbit.push({
      x: planet.a * (cosE - planet.e),
      y: planet.a * Math.sqrt(1 - planet.e * planet.e) * sinE,
    });
  }
  return orbit;
}

function HeartlightSystemMap() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const cameraRef = useRef<Vec2>({ x: 0, y: 0 });
  const scaleRef = useRef(0.6);
  const timeRef = useRef(INITIAL_DATE.getTime());
  const runningRef = useRef(true);
  const timeScaleRef = useRef(4);
  const sizeRef = useRef<{ width: number; height: number }>({ width: CANVAS_SIZE, height: CANVAS_SIZE });
  const draggingRef = useRef(false);
  const lastPointerRef = useRef<Vec2>({ x: 0, y: 0 });

  const [displayTime, setDisplayTime] = useState(INITIAL_DATE);
  const [running, setRunning] = useState(true);
  const [timeScale] = useState(4);

  const orbitCache = useMemo(() => {
    const cache = new Map<string, Vec2[]>();
    PLANETS.forEach((planet) => {
      cache.set(planet.name, sampleOrbit(planet));
    });
    return cache;
  }, []);

  useEffect(() => {
    runningRef.current = running;
  }, [running]);

  useEffect(() => {
    timeScaleRef.current = timeScale;
  }, [timeScale]);

  const worldToScreen = (point: Vec2): Vec2 => {
    const pxPerAU = scaleRef.current / AU_PER_PX_AT_1X;
    const { width, height } = sizeRef.current;
    return {
      x: (point.x - cameraRef.current.x) * pxPerAU + width / 2,
      y: height / 2 - (point.y - cameraRef.current.y) * pxPerAU,
    };
  };

  const screenToWorld = (point: Vec2): Vec2 => {
    const pxPerAU = scaleRef.current / AU_PER_PX_AT_1X;
    const { width, height } = sizeRef.current;
    return {
      x: (point.x - width / 2) / pxPerAU + cameraRef.current.x,
      y: (height / 2 - point.y) / pxPerAU + cameraRef.current.y,
    };
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let last = performance.now();
    let accumulator = 0;

    const render = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      if (runningRef.current) {
        timeRef.current += dt * timeScaleRef.current * 86400000;
      }

      accumulator += dt;
      if (accumulator > 0.2) {
        setDisplayTime(new Date(timeRef.current));
        accumulator = 0;
      }

      const dpr = window.devicePixelRatio ?? 1;
      const width = canvas.clientWidth * dpr;
      const height = canvas.clientHeight * dpr;
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      sizeRef.current = { width: width / dpr, height: height / dpr };

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.scale(dpr, dpr);

      drawScene(ctx, orbitCache, new Date(timeRef.current), worldToScreen, scaleRef.current);

      raf = requestAnimationFrame(render);
    };

    raf = requestAnimationFrame(render);
    return () => cancelAnimationFrame(raf);
  }, [orbitCache]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      const before = scaleRef.current;
      const factor = Math.exp(-event.deltaY * 0.0015);
      const after = clamp(before * factor, SCALE_MIN, SCALE_MAX);
      if (after === before) return;

      const rect = canvas.getBoundingClientRect();
      const cursor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const worldBefore = screenToWorld(cursor);
      scaleRef.current = after;
      const worldAfter = screenToWorld(cursor);
      cameraRef.current.x += worldBefore.x - worldAfter.x;
      cameraRef.current.y += worldBefore.y - worldAfter.y;
    };

    const handlePointerDown = (event: PointerEvent) => {
      draggingRef.current = true;
      const rect = canvas.getBoundingClientRect();
      lastPointerRef.current = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      canvas.setPointerCapture(event.pointerId);
    };

    const handlePointerMove = (event: PointerEvent) => {
      if (!draggingRef.current) return;
      const rect = canvas.getBoundingClientRect();
      const now = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const dx = now.x - lastPointerRef.current.x;
      const dy = now.y - lastPointerRef.current.y;
      lastPointerRef.current = now;
      const pxPerAU = scaleRef.current / AU_PER_PX_AT_1X;
      cameraRef.current.x -= dx / pxPerAU;
      cameraRef.current.y += dy / pxPerAU;
    };

    const handlePointerUp = (event: PointerEvent) => {
      draggingRef.current = false;
      try {
        canvas.releasePointerCapture(event.pointerId);
      } catch {
        /* no-op */
      }
    };

    canvas.addEventListener("wheel", handleWheel, { passive: false });
    canvas.addEventListener("pointerdown", handlePointerDown);
    canvas.addEventListener("pointermove", handlePointerMove);
    canvas.addEventListener("pointerup", handlePointerUp);
    canvas.addEventListener("pointercancel", handlePointerUp);

    return () => {
      canvas.removeEventListener("wheel", handleWheel);
      canvas.removeEventListener("pointerdown", handlePointerDown);
      canvas.removeEventListener("pointermove", handlePointerMove);
      canvas.removeEventListener("pointerup", handlePointerUp);
      canvas.removeEventListener("pointercancel", handlePointerUp);
    };
  }, []);

  const stepDays = (days: number) => {
    timeRef.current += days * 86400000;
    setDisplayTime(new Date(timeRef.current));
  };

  const handleDateChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = event.target.value;
    if (!value) return;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return;
    timeRef.current = parsed.getTime();
    setDisplayTime(parsed);
  };

  const resetView = () => {
    cameraRef.current = { x: 0, y: 0 };
    scaleRef.current = 0.6;
  };

  const formattedDate = useMemo(() => displayTime.toISOString().slice(0, 10), [displayTime]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-sky-500/40 bg-sky-500/10 p-4 text-sky-100">
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="rounded-full bg-sky-500 px-3 py-2 text-sm font-semibold text-sky-950 transition hover:bg-sky-400"
            aria-label={running ? "Pause" : "Play"}
            onClick={() => setRunning((v) => !v)}
          >
            {running ? (
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4">
                <rect x="6" y="5" width="4" height="14" rx="1" />
                <rect x="14" y="5" width="4" height="14" rx="1" />
              </svg>
            ) : (
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4">
                <polygon points="8,5 20,12 8,19" />
              </svg>
            )}
          </button>
          <button
            type="button"
            className="rounded-lg border border-sky-500/60 px-3 py-1 text-xs uppercase tracking-wide text-sky-100 transition hover:bg-sky-500/20"
            onClick={() => stepDays(-30)}
          >
            −30 days
          </button>
          <button
            type="button"
            className="rounded-lg border border-sky-500/60 px-3 py-1 text-xs uppercase tracking-wide text-sky-100 transition hover:bg-sky-500/20"
            onClick={() => stepDays(-1)}
          >
            −1 day
          </button>
          <button
            type="button"
            className="rounded-lg border border-sky-500/60 px-3 py-1 text-xs uppercase tracking-wide text-sky-100 transition hover:bg-sky-500/20"
            onClick={() => stepDays(1)}
          >
            +1 day
          </button>
          <button
            type="button"
            className="rounded-lg border border-sky-500/60 px-3 py-1 text-xs uppercase tracking-wide text-sky-100 transition hover:bg-sky-500/20"
            onClick={() => stepDays(30)}
          >
            +30 days
          </button>
        </div>
        <div className="flex items-center gap-3 text-xs uppercase tracking-wide text-sky-200/80">
          <label className="flex items-center gap-2">
            Date
            <input
              type="date"
              value={formattedDate}
              onChange={handleDateChange}
              className="rounded-md border border-sky-500/50 bg-slate-900 px-2 py-1 text-sky-100"
            />
            <button
              type="button"
              className="rounded-md border border-sky-500/50 px-2 py-1 text-xs uppercase tracking-wide text-sky-100 transition hover:bg-sky-500/20"
              onClick={() => {
                const now = new Date();
                timeRef.current = now.getTime();
                setDisplayTime(now);
              }}
            >
              Current Date
            </button>
          </label>
          <button
            type="button"
            className="rounded-lg border border-sky-500/60 px-3 py-1 text-xs uppercase tracking-wide text-sky-100 transition hover:bg-sky-500/20"
            onClick={resetView}
          >
            Reset View
          </button>
        </div>
      </div>

      <div className="relative mx-auto flex flex-col items-center gap-3 rounded-2xl border border-sky-500/30 bg-slate-900/70 p-4">
        <canvas
          ref={canvasRef}
          width={CANVAS_SIZE}
          height={CANVAS_SIZE}
          style={{ width: `${CANVAS_SIZE}px`, height: `${CANVAS_SIZE}px`, display: "block" }}
        />
      </div>

      <p className="text-xs text-slate-300">
        Heartlight System Map — a smooth, top-down heliocentric view. Drag to pan, scroll or pinch to zoom,
        and use the controls to scrub through time. Planet paths are Keplerian ellipses rendered in
        astronomical units, so you can explore orbital rhythm from Mercury to Pluto.
      </p>
    </div>
  );
}

function drawScene(
  ctx: CanvasRenderingContext2D,
  orbitCache: Map<string, Vec2[]>,
  time: Date,
  worldToScreen: (point: Vec2) => Vec2,
  scale: number
) {
  const width = ctx.canvas.width / (window.devicePixelRatio ?? 1);
  const height = ctx.canvas.height / (window.devicePixelRatio ?? 1);

  ctx.save();
  ctx.fillStyle = "#030712";
  ctx.fillRect(0, 0, width, height);

  orbitCache.forEach((points) => {
    if (points.length === 0) return;
    ctx.beginPath();
    points.forEach((point, idx) => {
      const screen = worldToScreen(point);
      if (idx === 0) ctx.moveTo(screen.x, screen.y);
      else ctx.lineTo(screen.x, screen.y);
    });
    ctx.strokeStyle = "rgba(148,163,184,0.35)";
    ctx.lineWidth = 1;
    ctx.stroke();
  });

  drawSun(ctx, worldToScreen, scale);
  drawPlanets(ctx, time, worldToScreen, scale);
  ctx.restore();
}

function drawSun(ctx: CanvasRenderingContext2D, worldToScreen: (point: Vec2) => Vec2, scale: number) {
  const radius = clamp(ICON_BASE * 1.8 * Math.pow(scale, SCALE_EXP), 12, 42);
  const center = worldToScreen({ x: 0, y: 0 });
  const gradient = ctx.createRadialGradient(center.x - radius * 0.3, center.y - radius * 0.3, radius * 0.1, center.x, center.y, radius);
  gradient.addColorStop(0, "#ffe7a3");
  gradient.addColorStop(1, "#f59e0b");
  ctx.beginPath();
  ctx.fillStyle = gradient;
  ctx.shadowColor = "rgba(253, 211, 107, 0.6)";
  ctx.shadowBlur = 35;
  ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;
}

function drawPlanets(
  ctx: CanvasRenderingContext2D,
  time: Date,
  worldToScreen: (point: Vec2) => Vec2,
  scale: number
) {
  const radiusPx = clamp(ICON_BASE * Math.pow(scale, SCALE_EXP), ICON_MIN, ICON_MAX);
  const fontPx = clamp(FONT_BASE * Math.pow(scale, SCALE_EXP), FONT_MIN, FONT_MAX);

  ctx.textBaseline = "middle";
  ctx.font = `${fontPx}px 'JetBrains Mono', ui-monospace, monospace`;
  ctx.fillStyle = "#e2e8f0";

  PLANETS.forEach((planet) => {
    const pos = keplerPosition(planet, time.getTime());
    const screen = worldToScreen(pos);
    drawPlanetGlyph(ctx, screen, radiusPx, planet);
    ctx.fillStyle = "#e2e8f0";
    ctx.fillText(planet.name, screen.x + radiusPx + 6, screen.y);
  });
}

function drawPlanetGlyph(ctx: CanvasRenderingContext2D, center: Vec2, radius: number, planet: Planet) {
  if (planet.ring) {
    ctx.save();
    ctx.strokeStyle = planet.ring.color;
    ctx.globalAlpha = planet.ring.opacity;
    ctx.lineWidth = radius * (1 + planet.ring.width);
    ctx.beginPath();
    ctx.arc(center.x, center.y, radius * 1.8, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  if (planet.bands && planet.bands.length > 0) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
    ctx.clip();
    const bandHeight = (radius * 2) / planet.bands.length;
    planet.bands.forEach((color, index) => {
      const y = center.y - radius + index * bandHeight;
      ctx.fillStyle = color;
      ctx.fillRect(center.x - radius, y, radius * 2, bandHeight + 1);
    });
    ctx.restore();
  } else {
    const gradient = ctx.createRadialGradient(
      center.x - radius * 0.35,
      center.y - radius * 0.35,
      radius * 0.1,
      center.x,
      center.y,
      radius
    );
    gradient.addColorStop(0, planet.gradient?.inner ?? lighten(planet.baseColor, 0.2));
    gradient.addColorStop(1, planet.gradient?.outer ?? planet.baseColor);
    ctx.beginPath();
    ctx.fillStyle = gradient;
    ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
    ctx.fill();
  }

  if (planet.spots) {
    planet.spots.forEach((spot) => {
      ctx.beginPath();
      ctx.fillStyle = spot.color;
      ctx.arc(center.x + spot.offset.x * radius, center.y + spot.offset.y * radius, radius * spot.radius, 0, Math.PI * 2);
      ctx.fill();
    });
  }
}

function lighten(hex: string, factor: number) {
  const normalized = hex.startsWith("#") ? hex.substring(1) : hex;
  const num = parseInt(normalized, 16);
  const r = clamp(Math.round(((num >> 16) & 0xff) + 255 * factor), 0, 255);
  const g = clamp(Math.round(((num >> 8) & 0xff) + 255 * factor), 0, 255);
  const b = clamp(Math.round((num & 0xff) + 255 * factor), 0, 255);
  return `rgb(${r}, ${g}, ${b})`;
}

export { HeartlightSystemMap as AtlasCometMap };
