import { useEffect, useMemo, useRef, useState } from "react";
import * as Astronomy from "astronomy-engine";
type Vec2 = { x: number; y: number };

type ViewMode = "heliocentric" | "geocentric";

type BodyName =
  | "Sun"
  | "Moon"
  | "Mercury"
  | "Venus"
  | "Earth"
  | "Mars"
  | "Jupiter"
  | "Saturn"
  | "Uranus"
  | "Neptune"
  | "Pluto";

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

type OverlayOptions = {
  viewMode: ViewMode;
  showZodiac: boolean;
  showEclipticGrid: boolean;
  showMoon: boolean;
  scaleLabels: boolean;
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

const MOON: Planet = {
  name: "Moon",
  a: 0.00257,
  e: 0.0549,
  periodDays: 27.321582,
  baseColor: "#d4d4d8",
  gradient: { inner: "#f8fafc", outer: "#9ca3af" },
};

const ORBIT_SAMPLES = 512;
const INITIAL_DATE = new Date();
const AU_PER_PX_AT_1X = 1 / 260; // 260 px per AU at scale = 1
const SCALE_EXP = 0.45;
const ICON_BASE = 6;
const ICON_MIN = 3;
const ICON_MAX = 36;
const FONT_BASE = 11;
const FONT_MIN = 7;
const FONT_MAX = 20;
const SCALE_MIN = 0.03;
const SCALE_MAX = 18;
const CANVAS_SIZE = 560;
const MOON_VIS_MIN_PX = 10;
const MOON_VIS_MAX_PX = 28;
const LERP_SOFTEN_PX = 6;
const DEG2RAD = Math.PI / 180;
const ZODIAC_SIGNS = [
  { name: "Aries", symbol: "♈︎" },
  { name: "Taurus", symbol: "♉︎" },
  { name: "Gemini", symbol: "♊︎" },
  { name: "Cancer", symbol: "♋︎" },
  { name: "Leo", symbol: "♌︎" },
  { name: "Virgo", symbol: "♍︎" },
  { name: "Libra", symbol: "♎︎" },
  { name: "Scorpius", symbol: "♏︎" },
  { name: "Sagittarius", symbol: "♐︎" },
  { name: "Capricornus", symbol: "♑︎" },
  { name: "Aquarius", symbol: "♒︎" },
  { name: "Pisces", symbol: "♓︎" },
];
const ZODIAC_RING_RADIUS_AU = 44;
const BODIES: BodyName[] = ["Sun", "Moon", "Mercury", "Venus", "Earth", "Mars", "Jupiter", "Saturn", "Uranus", "Neptune", "Pluto"];
const GEO_BASE_RADIUS_AU = ZODIAC_RING_RADIUS_AU * 0.97;

type Placement = {
  body: BodyName;
  lon: number;
  lat: number;
  dist: number;
  vector: Astronomy.Vector;
  world: Vec2;
  mode: ViewMode;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function normalizeDegrees(degrees: number) {
  const mod = degrees % 360;
  return mod < 0 ? mod + 360 : mod;
}

function asTime(date: Date) {
  return Astronomy.MakeTime(date);
}

function toEcliptic(vector: Astronomy.Vector) {
  const equatorial = Astronomy.EquatorFromVector(vector);
  const ecliptic = Astronomy.Ecliptic(equatorial.vec);
  return {
    lon: normalizeDegrees(ecliptic.elon),
    lat: ecliptic.elat,
    dist: equatorial.dist,
    vector,
  };
}

function heliocentricPlacement(body: BodyName, when: Date): Placement {
  const time = asTime(when);
  const vector = Astronomy.HelioVector(body as Astronomy.Body, time);
  const { lon, lat, dist } = toEcliptic(vector);
  const rad = lon * DEG2RAD;
  const world: Vec2 = {
    x: dist * Math.cos(rad),
    y: dist * Math.sin(rad),
  };
  return { body, lon, lat, dist, vector, world, mode: "heliocentric" };
}

function geocentricWorld(lon: number, lat: number): Vec2 {
  const rad = lon * DEG2RAD;
  const latFactor = clamp(lat / 40, -1.5, 1.5);
  const radius = GEO_BASE_RADIUS_AU * (1 + latFactor * 0.12);
  return {
    x: radius * Math.cos(rad),
    y: radius * Math.sin(rad),
  };
}

function geocentricPlacement(body: BodyName, when: Date): Placement {
  if (body === "Earth") {
    const time = asTime(when);
    const vector = new Astronomy.Vector(0, 0, 0, time);
    return {
      body,
      lon: 0,
      lat: 0,
      dist: 0,
      vector,
      world: { x: 0, y: 0 },
      mode: "geocentric",
    };
  }
  const time = asTime(when);
  const vector = Astronomy.GeoVector(body as Astronomy.Body, time, true);
  const { lon, lat, dist } = toEcliptic(vector);
  const world = geocentricWorld(lon, lat);
  return { body, lon, lat, dist, vector, world, mode: "geocentric" };
}

function getPlacements(viewMode: ViewMode, when: Date): Placement[] {
  if (viewMode === "heliocentric") {
    return BODIES.map((body) => heliocentricPlacement(body, when));
  }
  return BODIES.map((body) => geocentricPlacement(body, when));
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
  const runningRef = useRef(false);
  const timeScaleRef = useRef(4);
  const sizeRef = useRef<{ width: number; height: number }>({ width: CANVAS_SIZE, height: CANVAS_SIZE });
  const draggingRef = useRef(false);
  const lastPointerRef = useRef<Vec2>({ x: 0, y: 0 });

  const [when, setWhen] = useState(INITIAL_DATE);
  const [running, setRunning] = useState(false);
  const [timeScale] = useState(4);
  const [viewMode, setViewMode] = useState<ViewMode>("heliocentric");
  const [showZodiac, setShowZodiac] = useState(true);
  const [showEclipticGrid, setShowEclipticGrid] = useState(false);
  const [showMoon, setShowMoon] = useState(true);
  const [scaleLabels, setScaleLabels] = useState(true);

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
        setWhen(new Date(timeRef.current));
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

      drawScene(
        ctx,
        orbitCache,
        new Date(timeRef.current),
        worldToScreen,
        scaleRef.current,
        { showZodiac, showEclipticGrid, showMoon, scaleLabels, viewMode }
      );

      raf = requestAnimationFrame(render);
    };

    raf = requestAnimationFrame(render);
    return () => cancelAnimationFrame(raf);
  }, [orbitCache, showZodiac, showEclipticGrid, showMoon, scaleLabels, viewMode]);

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
    setWhen(new Date(timeRef.current));
  };

  const handleDateChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = event.target.value;
    if (!value) return;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return;
    timeRef.current = parsed.getTime();
    setWhen(parsed);
  };

  const resetView = () => {
    cameraRef.current = { x: 0, y: 0 };
    scaleRef.current = 0.6;
  };

  const formattedDate = useMemo(() => when.toISOString().slice(0, 10), [when]);
  const heliocentricButtonClass = `px-3 py-1 text-xs font-semibold transition ${
    viewMode === "heliocentric" ? "bg-sky-500 text-sky-950" : "text-sky-100 hover:bg-sky-500/20"
  }`;
  const gaianButtonClass = `px-3 py-1 text-xs font-semibold transition ${
    viewMode === "geocentric" ? "bg-sky-500 text-sky-950" : "text-sky-100 hover:bg-sky-500/20"
  }`;

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
        <div className="flex flex-wrap items-center gap-3 text-xs uppercase tracking-wide text-sky-200/80">
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
                setWhen(now);
              }}
            >
              Current Date
            </button>
          </label>
          <div className="flex items-center gap-2">
            <span>Perspective</span>
            <div className="inline-flex overflow-hidden rounded-xl border border-sky-500/60">
              <button
                type="button"
                className={`${heliocentricButtonClass}`}
                aria-pressed={viewMode === "heliocentric"}
                onClick={() => setViewMode("heliocentric")}
              >
                Solar
              </button>
              <button
                type="button"
                className={`${gaianButtonClass}`}
                aria-pressed={viewMode === "geocentric"}
                onClick={() => setViewMode("geocentric")}
              >
                Gaian
              </button>
            </div>
          </div>
          <button
            type="button"
            className="rounded-lg border border-sky-500/60 px-3 py-1 text-xs uppercase tracking-wide text-sky-100 transition hover:bg-sky-500/20"
            onClick={resetView}
          >
            Reset View
          </button>
        </div>
        <div className="flex w-full flex-wrap items-center gap-3 border-t border-sky-500/20 pt-3 text-[0.65rem] uppercase tracking-wide text-sky-200/80">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-sky-500 bg-slate-900/80 text-sky-500 focus:ring-sky-400"
              checked={showZodiac}
              onChange={(event) => setShowZodiac(event.target.checked)}
            />
            Zodiac
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-sky-500 bg-slate-900/80 text-sky-500 focus:ring-sky-400"
              checked={showEclipticGrid}
              onChange={(event) => setShowEclipticGrid(event.target.checked)}
            />
            Ecliptic Grid
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-sky-500 bg-slate-900/80 text-sky-500 focus:ring-sky-400"
              checked={showMoon}
              onChange={(event) => setShowMoon(event.target.checked)}
            />
            Show Moon
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-sky-500 bg-slate-900/80 text-sky-500 focus:ring-sky-400"
              checked={scaleLabels}
              onChange={(event) => setScaleLabels(event.target.checked)}
            />
            Labels Scale
          </label>
        </div>
      </div>

      <div className="relative mx-auto flex w-full max-w-[640px] flex-col items-center gap-3 rounded-2xl border border-sky-500/30 bg-slate-900/70 p-4">
        <canvas
          ref={canvasRef}
          width={CANVAS_SIZE}
          height={CANVAS_SIZE}
          className="block aspect-square w-full max-w-[560px]"
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
  scale: number,
  overlays: OverlayOptions
) {
  const width = ctx.canvas.width / (window.devicePixelRatio ?? 1);
  const height = ctx.canvas.height / (window.devicePixelRatio ?? 1);

  ctx.save();
  ctx.fillStyle = "#030712";
  ctx.fillRect(0, 0, width, height);

  const placements = getPlacements(overlays.viewMode, time);

  if (overlays.showEclipticGrid) {
    drawEclipticGrid(ctx, worldToScreen, scale);
  }
  if (overlays.showZodiac) {
    drawZodiacRing(ctx, worldToScreen, scale);
  }

  if (overlays.viewMode === "heliocentric") {
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
  }

  drawBodies(ctx, placements, worldToScreen, scale, overlays);
  ctx.restore();
}

function drawZodiacRing(
  ctx: CanvasRenderingContext2D,
  worldToScreen: (point: Vec2) => Vec2,
  scale: number
) {
  const center = worldToScreen({ x: 0, y: 0 });
  const radiusPoint = worldToScreen({ x: ZODIAC_RING_RADIUS_AU, y: 0 });
  const radiusPx = Math.hypot(radiusPoint.x - center.x, radiusPoint.y - center.y);

  ctx.save();
  ctx.strokeStyle = "rgba(56,189,248,0.28)";
  ctx.lineWidth = clamp(scale * 0.4, 0.6, 1.6);
  ctx.beginPath();
  ctx.arc(center.x, center.y, radiusPx, 0, Math.PI * 2);
  ctx.stroke();
  ctx.textAlign = "center";

  for (let i = 0; i < 12; i += 1) {
    const angle = (i / 12) * Math.PI * 2;
    const lineInner = worldToScreen({
      x: Math.cos(angle) * (ZODIAC_RING_RADIUS_AU * 0.94),
      y: Math.sin(angle) * (ZODIAC_RING_RADIUS_AU * 0.94),
    });
    const lineOuter = worldToScreen({
      x: Math.cos(angle) * (ZODIAC_RING_RADIUS_AU * 1.02),
      y: Math.sin(angle) * (ZODIAC_RING_RADIUS_AU * 1.02),
    });
    ctx.beginPath();
    ctx.moveTo(lineInner.x, lineInner.y);
    ctx.lineTo(lineOuter.x, lineOuter.y);
    ctx.stroke();

    const sign = ZODIAC_SIGNS[i];
    const midAngle = angle + Math.PI / 12;
    const symbolPx = clamp(18 * Math.pow(scale, SCALE_EXP * 0.9), 14, 34);
    const namePx = clamp(10 * Math.pow(scale, SCALE_EXP * 0.7), 8, 16);
    const labelPoint = worldToScreen({
      x: Math.cos(midAngle) * (ZODIAC_RING_RADIUS_AU * 1.07),
      y: Math.sin(midAngle) * (ZODIAC_RING_RADIUS_AU * 1.07),
    });
    const namePoint = worldToScreen({
      x: Math.cos(midAngle) * (ZODIAC_RING_RADIUS_AU * 1.14),
      y: Math.sin(midAngle) * (ZODIAC_RING_RADIUS_AU * 1.14),
    });

    ctx.font = `${symbolPx}px 'JetBrains Mono', ui-monospace, monospace`;
    ctx.textBaseline = "middle";
    ctx.fillStyle = "rgba(165,243,252,0.85)";
    ctx.fillText(sign.symbol, labelPoint.x, labelPoint.y);
    ctx.font = `${namePx}px 'JetBrains Mono', ui-monospace, monospace`;
    ctx.fillStyle = "rgba(148,212,255,0.85)";
    ctx.fillText(sign.name.toUpperCase(), namePoint.x, namePoint.y);
  }

  for (let deg = 0; deg < 360; deg += 10) {
    const rad = deg * DEG2RAD;
    const isMajor = deg % 30 === 0;
    const innerFactor = isMajor ? 0.92 : 0.97;
    const outerFactor = 1.0;
    const innerPoint = worldToScreen({
      x: Math.cos(rad) * (ZODIAC_RING_RADIUS_AU * innerFactor),
      y: Math.sin(rad) * (ZODIAC_RING_RADIUS_AU * innerFactor),
    });
    const outerPoint = worldToScreen({
      x: Math.cos(rad) * (ZODIAC_RING_RADIUS_AU * outerFactor),
      y: Math.sin(rad) * (ZODIAC_RING_RADIUS_AU * outerFactor),
    });
    ctx.beginPath();
    ctx.strokeStyle = isMajor ? "rgba(56,189,248,0.35)" : "rgba(56,189,248,0.18)";
    ctx.lineWidth = isMajor ? clamp(scale * 0.35, 0.5, 1.4) : clamp(scale * 0.25, 0.4, 1.0);
    ctx.moveTo(innerPoint.x, innerPoint.y);
    ctx.lineTo(outerPoint.x, outerPoint.y);
    ctx.stroke();
  }
  ctx.restore();
}

function drawEclipticGrid(
  ctx: CanvasRenderingContext2D,
  worldToScreen: (point: Vec2) => Vec2,
  scale: number
) {
  const center = worldToScreen({ x: 0, y: 0 });
  const outerRadius = ZODIAC_RING_RADIUS_AU * 1.05;
  const innerRadius = 2.5;
  ctx.save();
  ctx.strokeStyle = "rgba(125,211,252,0.18)";
  ctx.lineWidth = clamp(scale * 0.25, 0.3, 1.0);

  for (let deg = 0; deg < 360; deg += 30) {
    const rad = deg * DEG2RAD;
    const innerPoint = worldToScreen({
      x: Math.cos(rad) * innerRadius,
      y: Math.sin(rad) * innerRadius,
    });
    const outerPoint = worldToScreen({
      x: Math.cos(rad) * outerRadius,
      y: Math.sin(rad) * outerRadius,
    });
    ctx.beginPath();
    ctx.moveTo(innerPoint.x, innerPoint.y);
    ctx.lineTo(outerPoint.x, outerPoint.y);
    ctx.stroke();
  }

  const latitudes = [-30, -15, 15, 30];
  latitudes.forEach((lat) => {
    const beta = lat * DEG2RAD;
    const radiusAU = outerRadius * Math.cos(beta);
    const edge = worldToScreen({ x: radiusAU, y: 0 });
    const radiusPx = Math.hypot(edge.x - center.x, edge.y - center.y);
    ctx.beginPath();
    ctx.arc(center.x, center.y, radiusPx, 0, Math.PI * 2);
    ctx.stroke();
  });

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

function drawSunMarker(ctx: CanvasRenderingContext2D, center: Vec2, scale: number) {
  const radius = clamp(ICON_BASE * 1.3 * Math.pow(scale, SCALE_EXP * 0.85), ICON_MIN * 0.8, ICON_MAX * 0.8);
  const gradient = ctx.createRadialGradient(center.x - radius * 0.3, center.y - radius * 0.3, radius * 0.15, center.x, center.y, radius);
  gradient.addColorStop(0, "#fff7d6");
  gradient.addColorStop(1, "#f59e0b");
  ctx.save();
  ctx.beginPath();
  ctx.fillStyle = gradient;
  ctx.shadowColor = "rgba(253, 211, 107, 0.45)";
  ctx.shadowBlur = 18;
  ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.restore();
}

function drawBodies(
  ctx: CanvasRenderingContext2D,
  placements: Placement[],
  worldToScreen: (point: Vec2) => Vec2,
  scale: number,
  overlays: OverlayOptions
) {
  const radiusPx = clamp(ICON_BASE * Math.pow(scale, SCALE_EXP), ICON_MIN, ICON_MAX);
  const fontPx = overlays.scaleLabels ? clamp(FONT_BASE * Math.pow(scale, SCALE_EXP), FONT_MIN, FONT_MAX) : FONT_BASE;

  ctx.textBaseline = "middle";
  ctx.font = `${fontPx}px 'JetBrains Mono', ui-monospace, monospace`;
  ctx.fillStyle = "#e2e8f0";

  const earthPlacement = placements.find((placement) => placement.body === "Earth");
  const moonPlacement = placements.find((placement) => placement.body === "Moon");

  placements.forEach((placement) => {
    const { body } = placement;
    if (!overlays.showMoon && body === "Moon") return;
    if (overlays.viewMode === "heliocentric" && (body === "Sun" || body === "Moon")) return;

    const center = worldToScreen(placement.world);
    if (overlays.viewMode === "geocentric" && body === "Sun") {
      drawSunMarker(ctx, center, scale);
    } else {
      const planetDef = body === "Moon" ? MOON : PLANETS.find((planet) => planet.name === body);
      if (!planetDef) return;
      drawPlanetGlyph(ctx, center, radiusPx, planetDef);
    }
    ctx.fillStyle = "#e2e8f0";
    ctx.fillText(body, center.x + radiusPx + 6, center.y);
  });

  if (overlays.viewMode === "heliocentric" && overlays.showMoon && earthPlacement && moonPlacement) {
    drawHeliocentricMoonSystem(ctx, earthPlacement, moonPlacement, worldToScreen, radiusPx);
  }
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

function drawHeliocentricMoonSystem(
  ctx: CanvasRenderingContext2D,
  earthPlacement: Placement,
  moonPlacement: Placement,
  worldToScreen: (point: Vec2) => Vec2,
  planetRadius: number
) {
  const earthScreen = worldToScreen(earthPlacement.world);
  const moonScreenRaw = worldToScreen(moonPlacement.world);
  const dx = moonScreenRaw.x - earthScreen.x;
  const dy = moonScreenRaw.y - earthScreen.y;
  const screenDistance = Math.hypot(dx, dy);
  const theta = Math.atan2(moonPlacement.world.y - earthPlacement.world.y, moonPlacement.world.x - earthPlacement.world.x);
  const rTarget = clamp(screenDistance, MOON_VIS_MIN_PX, MOON_VIS_MAX_PX);
  const weight = smoothClampWeight(screenDistance, MOON_VIS_MIN_PX, MOON_VIS_MAX_PX, LERP_SOFTEN_PX);
  const rVisual = lerp(screenDistance, rTarget, weight);
  const moonScreen = {
    x: earthScreen.x + rVisual * Math.cos(theta),
    y: earthScreen.y + rVisual * Math.sin(theta),
  };

  ctx.save();
  ctx.beginPath();
  ctx.arc(earthScreen.x, earthScreen.y, rVisual, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(148,163,184,0.25)";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();

  const moonRadius = clamp(planetRadius * 0.55, ICON_MIN * 0.45, ICON_MAX * 0.45);
  drawPlanetGlyph(ctx, moonScreen, moonRadius, MOON);
  ctx.fillStyle = "#e2e8f0";
  ctx.fillText(MOON.name, moonScreen.x + moonRadius + 4, moonScreen.y);
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function smoothClampWeight(r: number, lo: number, hi: number, feather: number) {
  if (feather <= 0) return r < lo || r > hi ? 1 : 0;
  if (r < lo) {
    const t = (lo - r) / feather;
    return Math.min(1, (t * t) / (1 + t * t));
  }
  if (r > hi) {
    const t = (r - hi) / feather;
    return Math.min(1, (t * t) / (1 + t * t));
  }
  return 0;
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
