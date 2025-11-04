import { useEffect, useMemo, useState, type ChangeEvent } from "react";

/**
 * Alastizen Universal Time (AUT) — Live Clock ✨
 * Sunrise→Sunset maps to 00:00→12:00 AUT; Sunset→Next Sunrise maps to 12:00→24:00 AUT.
 * Includes:
 *  • Polar/Solstice continuity via Equilux fallback using Apparent Solar Time (AST)
 *  • Higher-accuracy NOAA-style ephemeris (declination & equation of time)
 *  • Ray Windows band + cursor with within-window progress
 *  • Alice font loader
 *  • In‑app PWA registration (service worker + manifest via Blob)
 */

type Coordinates = { lat: number; lon: number };
type GeolocationStatus = "pending" | "granted" | "denied" | "unavailable";

type PolarMode = {
  mode: "polar_night" | "polar_day";
  noonUTC: number;
  EoT: number;
  declDeg: number;
};

type NormalSunWindow = {
  mode: "normal";
  sunriseUTC: number;
  sunsetUTC: number;
  noonUTC: number;
  EoT: number;
  declDeg: number;
};

type SunWindow = PolarMode | NormalSunWindow;

type AUTBase = {
  autHours: number;
  autClock: string;
  sunriseLocal: Date;
  sunsetLocal: Date;
  nextSunriseLocal: Date;
  segmentLabel: string;
  progress: number;
  segLenMin: number;
  dayLenMin: number;
  nightLenMin: number;
};

type NormalAUT = AUTBase & {
  mode: "normal";
  noonUTC: number;
};

type EquiluxAUT = AUTBase & {
  mode: "equilux";
};

type AUTResult = NormalAUT | EquiluxAUT;

// --- Math helpers ---
const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

function dayOfYear(d: Date): number {
  const start = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const diff = (Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - start.getTime()) / 86400000;
  return diff + 1; // Jan 1 → 1
}

// NOAA-style fractional year gamma and derived EoT & declination (highly precise for our purpose)
function solarParamsNOAA(n: number /* day of year */): { declDeg: number; EoT: number } {
  const gamma = (2 * Math.PI * (n - 1)) / 365.0; // fractional year at local-noon baseline
  const declRad = Math.asin(
    0.006918 - 0.399912 * Math.cos(gamma) + 0.070257 * Math.sin(gamma) -
      0.006758 * Math.cos(2 * gamma) + 0.000907 * Math.sin(2 * gamma) -
      0.002697 * Math.cos(3 * gamma) + 0.00148 * Math.sin(3 * gamma)
  );
  const EoT =
    229.18 *
    (0.000075 +
      0.001868 * Math.cos(gamma) -
      0.032077 * Math.sin(gamma) -
      0.014615 * Math.cos(2 * gamma) -
      0.040849 * Math.sin(2 * gamma)); // minutes
  return { declDeg: declRad * RAD, EoT };
}

function solarNoonUTCMinutes(longitudeDeg: number, EoT: number): number {
  return 720 - 4 * longitudeDeg - EoT; // minutes from 00:00 UTC
}

// Returns sunrise/sunset/noon plus a mode flag for polar conditions
function sunriseSunsetUTCMinutes(dateUTC: Date, latDeg: number, lonDeg: number): SunWindow {
  const n = dayOfYear(dateUTC);
  const { EoT, declDeg } = solarParamsNOAA(n);
  const noonUTC = solarNoonUTCMinutes(lonDeg, EoT);

  // Hour angle for standard upper-limb with refraction (alpha = 0.833°)
  const alpha = 0.833;
  const phi = latDeg * DEG;
  const decl = declDeg * DEG;
  const x =
    (Math.sin(-alpha * DEG) - Math.sin(phi) * Math.sin(decl)) /
    (Math.cos(phi) * Math.cos(decl));

  if (x > 1) {
    // Sun stays below horizon (polar night)
    return { mode: "polar_night", noonUTC, EoT, declDeg };
  }
  if (x < -1) {
    // Sun stays above horizon (polar day)
    return { mode: "polar_day", noonUTC, EoT, declDeg };
  }

  const h0 = Math.acos(Math.min(1, Math.max(-1, x))) * RAD; // degrees
  const sunriseUTC = noonUTC - 4 * h0;
  const sunsetUTC = noonUTC + 4 * h0;
  return { mode: "normal", sunriseUTC, sunsetUTC, noonUTC, EoT, declDeg };
}

function minutesLocalToUTCMinutes(d: Date): number {
  const utcMidnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return (d.getTime() - utcMidnight) / 60000; // minutes since today's UTC 00:00
}

function minutesToHHMMSS(mins: number): string {
  const total = ((mins % 1440) + 1440) % 1440;
  const h = Math.floor(total / 60);
  const m = Math.floor(total % 60);
  const s = Math.floor((total * 60) % 60);
  const pad = (x: number) => x.toString().padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function formatClock(hhFloat: number): string {
  const totalMin = (((hhFloat % 24) + 24) % 24) * 60;
  return minutesToHHMMSS(totalMin);
}

function utcMinutesToLocalDate(utcMinutes: number, baseDateUTC: Date): Date {
  const baseUTC = Date.UTC(
    baseDateUTC.getUTCFullYear(),
    baseDateUTC.getUTCMonth(),
    baseDateUTC.getUTCDate()
  );
  return new Date(baseUTC + utcMinutes * 60000);
}

// Apparent Solar Time (AST) minutes from midnight, normalized 0..1440
function apparentSolarMinutesUTC(tUTCmin: number, lonDeg: number, EoT: number): number {
  const ast = tUTCmin + 4 * lonDeg + EoT; // minutes
  return ((ast % 1440) + 1440) % 1440;
}

// Equilux fallback: split the day into two equal halves around solar noon using AST
function computeAUTEquilux(nowLocal: Date, lonDeg: number, EoT: number, noonUTC: number): EquiluxAUT {
  const tUTC = minutesLocalToUTCMinutes(nowLocal);
  const astMin = apparentSolarMinutesUTC(tUTC, lonDeg, EoT); // 0..1440
  // Day half centered on AST noon: 06:00..18:00; Night half: 18:00..30:00→wrap
  const dayStart = 360; // 06:00 AST
  const dayEnd = 1080; // 18:00 AST
  let autHours = 0;
  let segmentLabel = "";
  let progress = 0;
  let segLenMin = 0;

  if (astMin >= dayStart && astMin < dayEnd) {
    const ratio = (astMin - dayStart) / 720; // 12h day
    autHours = 12 * ratio; // 0..12
    segmentLabel = "Daylight (Lux, Equilux)";
    progress = ratio;
    segLenMin = 720;
  } else {
    // Night half: from 18:00→06:00 AST
    // Normalize via wrap
    const delta = astMin >= dayEnd ? astMin - dayEnd : astMin + (1440 - dayEnd);
    const ratio = delta / 720;
    autHours = 12 + 12 * ratio; // 12..24
    segmentLabel = "Night (Umbra, Equilux)";
    progress = ratio;
    segLenMin = 720;
  }

  // For cards: virtual sunrise/sunset based on AST half splits
  const todayUTC = new Date(
    Date.UTC(
      nowLocal.getUTCFullYear(),
      nowLocal.getUTCMonth(),
      nowLocal.getUTCDate()
    )
  );
  const sunriseVirtualUTC = noonUTC - 360; // 06:00 before noon
  const sunsetVirtualUTC = noonUTC + 360; // 18:00 after noon
  const tomorrowUTC = new Date(
    Date.UTC(
      nowLocal.getUTCFullYear(),
      nowLocal.getUTCMonth(),
      nowLocal.getUTCDate() + 1
    )
  );

  return {
    autHours,
    autClock: formatClock(autHours),
    sunriseLocal: utcMinutesToLocalDate(sunriseVirtualUTC, todayUTC),
    sunsetLocal: utcMinutesToLocalDate(sunsetVirtualUTC, todayUTC),
    nextSunriseLocal: utcMinutesToLocalDate(sunriseVirtualUTC, tomorrowUTC),
    segmentLabel,
    progress,
    segLenMin,
    dayLenMin: 720,
    nightLenMin: 720,
    mode: "equilux",
  };
}

function computeAUT(nowLocal: Date, latDeg: number, lonDeg: number): AUTResult {
  // Build UTC anchors
  const todayUTC = new Date(
    Date.UTC(
      nowLocal.getUTCFullYear(),
      nowLocal.getUTCMonth(),
      nowLocal.getUTCDate()
    )
  );
  const yesterdayUTC = new Date(
    Date.UTC(
      nowLocal.getUTCFullYear(),
      nowLocal.getUTCMonth(),
      nowLocal.getUTCDate() - 1
    )
  );
  const tomorrowUTC = new Date(
    Date.UTC(
      nowLocal.getUTCFullYear(),
      nowLocal.getUTCMonth(),
      nowLocal.getUTCDate() + 1
    )
  );

  const today = sunriseSunsetUTCMinutes(todayUTC, latDeg, lonDeg);
  const tUTC = minutesLocalToUTCMinutes(nowLocal); // 0..1440

  // Polar continuity using Equilux AST split
  if (today.mode === "polar_day" || today.mode === "polar_night") {
    return computeAUTEquilux(nowLocal, lonDeg, today.EoT, today.noonUTC);
  }

  if (today.mode !== "normal") {
    return computeAUTEquilux(nowLocal, lonDeg, today.EoT, today.noonUTC);
  }

  // Normal sunrise/sunset flow
  const { sunriseUTC: sunriseToday, sunsetUTC: sunsetToday, noonUTC } = today;
  const yesterday = sunriseSunsetUTCMinutes(yesterdayUTC, latDeg, lonDeg);
  const tomorrow = sunriseSunsetUTCMinutes(tomorrowUTC, latDeg, lonDeg);

  if (yesterday.mode !== "normal" || tomorrow.mode !== "normal") {
    return computeAUTEquilux(nowLocal, lonDeg, today.EoT, today.noonUTC);
  }

  const { sunsetUTC: sunsetYest } = yesterday;
  const { sunriseUTC: sunriseTom } = tomorrow;

  let sunriseLocal = utcMinutesToLocalDate(sunriseToday, todayUTC);
  let sunsetLocal = utcMinutesToLocalDate(sunsetToday, todayUTC);
  let nextSunriseLocal = utcMinutesToLocalDate(sunriseTom, tomorrowUTC);

  const spanAfter = (endMin: number, startMin: number): number => endMin + 1440 - startMin; // next-day minus today
  const spanBefore = (endMin: number, startMin: number): number => endMin - startMin + 1440; // today minus yesterday

  let autHours = 0;
  let segmentLabel = "";
  let progress = 0;
  let segLenMin = 0;

  if (tUTC >= sunriseToday && tUTC < sunsetToday) {
    const dayLen = sunsetToday - sunriseToday;
    const ratio = (tUTC - sunriseToday) / dayLen;
    autHours = 12 * ratio;
    segmentLabel = "Daylight (Lux)";
    segLenMin = dayLen;
    progress = ratio;
  } else if (tUTC >= sunsetToday) {
    const nightLen = spanAfter(sunriseTom, sunsetToday);
    const ratio = (tUTC - sunsetToday) / nightLen;
    autHours = 12 + 12 * ratio;
    segmentLabel = "Night (Umbra)";
    segLenMin = nightLen;
    progress = ratio;
  } else {
    // pre-sunrise: yesterday's sunset → today's sunrise (lift tUTC by +1440)
    const tCont = tUTC + 1440;
    const nightLen = spanBefore(sunriseToday, sunsetYest);
    const ratio = (tCont - (sunsetYest + 1440)) / nightLen;
    autHours = 12 + 12 * ratio;
    segmentLabel = "Night (Umbra)";
    segLenMin = nightLen;
    progress = ratio;
    sunsetLocal = utcMinutesToLocalDate(sunsetYest, yesterdayUTC);
    nextSunriseLocal = utcMinutesToLocalDate(sunriseToday, todayUTC);
  }

  const dayLenMin = Math.max(0, sunsetToday - sunriseToday);
  const nightLenMin = Math.max(0, spanAfter(sunriseTom, sunsetToday));

  return {
    autHours,
    autClock: formatClock(autHours),
    sunriseLocal,
    sunsetLocal,
    nextSunriseLocal,
    segmentLabel,
    progress,
    segLenMin,
    dayLenMin,
    nightLenMin,
    mode: "normal",
    noonUTC,
  };
}

function useGeolocation(defaultCoords: Coordinates) {
  const [coords, setCoords] = useState<Coordinates>(defaultCoords);
  const [status, setStatus] = useState<GeolocationStatus>("pending");

  useEffect(() => {
    if (!navigator.geolocation) {
      setStatus("unavailable");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos: GeolocationPosition) => {
        setCoords({ lat: pos.coords.latitude, lon: pos.coords.longitude });
        setStatus("granted");
      },
      () => {
        setStatus("denied");
      },
      { enableHighAccuracy: true, maximumAge: 60_000, timeout: 10_000 }
    );
  }, []);

  return { coords, status, setCoords };
}

// Alice font loader + PWA (manifest + SW) registration
function useAliceAndPWA() {
  useEffect(() => {
    // Alice font
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=Alice&display=swap";
    document.head.appendChild(link);

    // Manifest via Blob
    const manifest = {
      name: "AUT — Alastizen Universal Time",
      short_name: "AUT",
      start_url: ".",
      display: "standalone",
      background_color: "#0a0a0a",
      theme_color: "#16a34a",
      icons: [],
    };
    const manifestBlob = new Blob([JSON.stringify(manifest)], {
      type: "application/json",
    });
    const manifestUrl = URL.createObjectURL(manifestBlob);
    const mlink = document.createElement("link");
    mlink.rel = "manifest";
    mlink.href = manifestUrl;
    document.head.appendChild(mlink);

    // Minimal service worker via Blob (pass-through + immediate claim)
    if ("serviceWorker" in navigator) {
      const swCode =
        "self.addEventListener('install', e => { self.skipWaiting(); });\n" +
        "self.addEventListener('activate', e => { self.clients.claim(); });\n" +
        "self.addEventListener('fetch', e => { /* passthrough */ });";
      const swBlob = new Blob([swCode], { type: "text/javascript" });
      const swUrl = URL.createObjectURL(swBlob);
      navigator.serviceWorker.register(swUrl).catch(() => {});
    }
  }, []);
}

// Ray windows: 12 windows across 24 AUT hours (2h each)
const RAY_WINDOWS = [
  { name: "Red", start: 0, end: 2, tint: "bg-red-500" },
  { name: "Orange", start: 2, end: 4, tint: "bg-orange-500" },
  { name: "Yellow", start: 4, end: 6, tint: "bg-yellow-400" },
  { name: "Green", start: 6, end: 8, tint: "bg-green-500" },
  { name: "Teal", start: 8, end: 10, tint: "bg-teal-500" },
  { name: "Blue", start: 10, end: 12, tint: "bg-blue-500" },
  { name: "Indigo", start: 12, end: 14, tint: "bg-indigo-500" },
  { name: "Violet", start: 14, end: 16, tint: "bg-violet-500" },
  { name: "Magenta", start: 16, end: 18, tint: "bg-fuchsia-500" },
  { name: "Omni", start: 18, end: 20, tint: "bg-zinc-50 text-zinc-900" },
  { name: "Elemental", start: 20, end: 22, tint: "bg-emerald-600" },
  { name: "Infinite of ALL", start: 22, end: 24, tint: "bg-sky-300 text-zinc-900" },
];

// Helper: robust ray-index selection with modulo wrap & FP tolerance
function rayIndexForAUT(hours: number): number {
  const eps = 1e-9;
  const hRaw = Number.isFinite(hours) ? Number(hours) : 0;
  // Wrap  …,-1→23 , 24→0 . At exactly 24h we treat as 0h of the new cycle.
  const h = ((hRaw % 24) + 24) % 24;
  for (let i = 0; i < RAY_WINDOWS.length; i++) {
    const r = RAY_WINDOWS[i];
    const start = r.start - eps;
    const end = r.end - eps; // make upper bound a hair inside to avoid double-hit at boundaries
    if (h >= start && h < end) return i;
  }
  return 0; // fallback
}

export default function AUTClock() {
  useAliceAndPWA();

  // Charlotte NoDa fallback
  const fallback = useMemo<Coordinates>(() => ({ lat: 35.25, lon: -80.8 }), []);
  const { coords, status, setCoords } = useGeolocation(fallback);
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const data = useMemo<AUTResult>(
    () => computeAUT(now, coords.lat, coords.lon),
    [now, coords]
  );
  const pct = Math.max(0, Math.min(100, Math.round(data.progress * 100)));

  const fmt = (d: Date) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const fmtLong = (d: Date) =>
    d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  // Use a stable, wrapped AUT hour value
  const autH = ((Number(data.autHours) % 24) + 24) % 24;

  // Cursor position for Ray band (0..100%) across full 24 AUT hours
  const cursorPct = (autH / 24) * 100;

  // Active Ray window + progress within that window
  const rayIndex = rayIndexForAUT(autH);
  const activeRay = RAY_WINDOWS[rayIndex];
  const rayRange = activeRay.end - activeRay.start;
  const rayProgress = Math.min(1, Math.max(0, (autH - activeRay.start) / rayRange));
  const rayCursorPctWithin = rayProgress * 100; // within active window
  const remainingAUTHours = Math.max(0, activeRay.end - autH);
  const minutesPerAutHour = data.segmentLabel?.includes("Daylight")
    ? data.dayLenMin / 12
    : data.nightLenMin / 12;
  const remainingRealMin = Math.max(0, remainingAUTHours * minutesPerAutHour);

  // Tick marks every window (2 AUT hours)
  const ticks = useMemo<Array<{ left: number }>>(
    () => Array.from({ length: 13 }, (_, i) => ({ left: (i * 100) / 12 })),
    []
  );

  return (
    <div
      className="min-h-screen w-full bg-zinc-900 text-zinc-100 flex items-center justify-center p-6"
      style={{ fontFamily: "'Alice', ui-sans-serif" }}
    >
      <div className="w-full max-w-4xl rounded-2xl shadow-xl bg-zinc-800 p-6 md:p-8 space-y-6">
        <header className="flex flex-col md:flex-row md:items-end md:justify-between gap-4">
          <div>
            <h1 className="text-2xl md:text-3xl font-semibold tracking-tight">
              Alastizen Universal Time
            </h1>
            <p className="text-zinc-300">
              Sunrise → 00:00 AUT • Sunset → 12:00 AUT • Next Sunrise → 24:00 AUT
            </p>
          </div>
          <div className="text-right">
            <div className="text-sm uppercase text-zinc-400">Local Now</div>
            <div className="text-xl md:text-2xl font-medium">{fmtLong(now)}</div>
          </div>
        </header>

        {/* Location Controls */}
        <section className="grid md:grid-cols-3 gap-4">
          <div className="md:col-span-2">
            <div className="text-sm text-zinc-400">Location</div>
            <div className="text-lg font-medium">
              {status === "granted" ? (
                <span>Using your current position</span>
              ) : status === "denied" ? (
                <span>Charlotte, NC (fallback)</span>
              ) : status === "pending" ? (
                <span>Requesting location…</span>
              ) : (
                <span>Charlotte, NC (fallback)</span>
              )}
            </div>
            <div className="text-zinc-400 text-sm">
              lat {coords.lat.toFixed(4)}°, lon {coords.lon.toFixed(4)}°
            </div>
          </div>
          <div className="flex items-end">
            <button
              className="px-3 py-2 rounded-xl bg-zinc-700 hover:bg-zinc-600 transition shadow"
              onClick={() => {
                if (navigator.geolocation) {
                  navigator.geolocation.getCurrentPosition(
                    (pos: GeolocationPosition) =>
                      setCoords({
                        lat: pos.coords.latitude,
                        lon: pos.coords.longitude,
                      }),
                    () => setCoords(fallback),
                    { enableHighAccuracy: true, maximumAge: 60_000, timeout: 10_000 }
                  );
                }
              }}
            >
              Recenter
            </button>
          </div>
        </section>

        {/* AUT Display */}
        <section className="rounded-2xl p-6 bg-gradient-to-br from-indigo-800/40 via-cyan-700/30 to-emerald-700/20 border border-zinc-700 shadow-inner">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
            <div>
              <div className="text-sm uppercase tracking-wide text-zinc-300">
                AUT (Alastizen Universal Time)
              </div>
              <div className="text-5xl md:text-6xl font-bold tabular-nums">
                {data.autClock}
              </div>
            </div>
            <div className="text-right">
              <div className="text-sm text-zinc-300">Segment</div>
              <div className="text-lg font-medium">{data.segmentLabel}</div>
              <div className="text-xs text-zinc-400">Mode: {data.mode}</div>
              <div className="text-sm text-zinc-400">{pct}% through this segment</div>
            </div>
          </div>

          <div className="mt-6">
            <div className="w-full h-3 bg-zinc-700 rounded-full overflow-hidden">
              <div
                className="h-3 bg-zinc-100/90"
                style={{ width: `${pct}%` }}
                aria-label="Progress within current segment"
              />
            </div>
          </div>

          <div className="grid md:grid-cols-3 gap-4 mt-6">
            <div className="rounded-xl bg-zinc-900/40 border border-zinc-700 p-4">
              <div className="text-sm text-zinc-400">Sunrise (00:00 AUT)</div>
              <div className="text-xl font-semibold">{fmt(data.sunriseLocal)}</div>
            </div>
            <div className="rounded-xl bg-zinc-900/40 border border-zinc-700 p-4">
              <div className="text-sm text-zinc-400">Solar Sunset (12:00 AUT)</div>
              <div className="text-xl font-semibold">{fmt(data.sunsetLocal)}</div>
            </div>
            <div className="rounded-xl bg-zinc-900/40 border border-zinc-700 p-4">
              <div className="text-sm text-zinc-400">Next Sunrise (24:00 AUT)</div>
              <div className="text-xl font-semibold">{fmt(data.nextSunriseLocal)}</div>
            </div>
          </div>

          <div className="grid md:grid-cols-2 gap-4 mt-4 text-sm text-zinc-300">
            <div className="rounded-xl bg-zinc-900/30 border border-zinc-700 p-4">
              <div>Day length: {Math.round(data.dayLenMin)} min</div>
            </div>
            <div className="rounded-xl bg-zinc-900/30 border border-zinc-700 p-4">
              <div>Night length: {Math.round(data.nightLenMin)} min</div>
            </div>
          </div>
        </section>

        {/* Ray Windows Band — enhanced visualization */}
        <section className="rounded-2xl p-6 bg-zinc-900/40 border border-zinc-700 space-y-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <div className="text-sm uppercase text-zinc-400">
                Ray Windows (2 AUT hours each)
              </div>
              <div className="text-lg font-semibold">
                Now in: <span className="underline decoration-dotted">{activeRay.name}</span>
              </div>
            </div>
            <div className="text-right text-sm text-zinc-300">
              <div>{Math.round(rayProgress * 100)}% through this window</div>
              <div>
                ≈ {Math.ceil(remainingAUTHours * 60)} AUT min left • ≈ {Math.ceil(remainingRealMin)} real min
              </div>
            </div>
          </div>

          <div className="relative w-full h-14 rounded-xl overflow-hidden border border-zinc-700 bg-zinc-800/40">
            {/* colored bands */}
            <div className="absolute inset-0 grid grid-cols-12">
              {RAY_WINDOWS.map((r, i) => {
                const isActive = i === rayIndex;
                return (
                  <div
                    key={i}
                    className={`relative flex items-center justify-center text-[11px] md:text-xs ${r.tint} bg-opacity-90 transition-transform ${
                      isActive ? "ring-2 ring-zinc-100 scale-[1.01] z-10" : ""
                    }`}
                    title={`${r.name} • ${r.start.toString().padStart(2, "0")}:00–${r.end
                      .toString()
                      .padStart(2, "0")}:00 AUT`}
                  >
                    <span className="px-1 text-center drop-shadow-[0_1px_1px_rgba(0,0,0,0.35)]">{r.name}</span>
                    {/* progress fill within the active window */}
                    {isActive && (
                      <div
                        className="absolute left-0 top-0 bottom-0 bg-zinc-100/20"
                        style={{ width: `${rayCursorPctWithin}%` }}
                        aria-hidden
                      />
                    )}
                  </div>
                );
              })}
            </div>

            {/* tick marks at every 2 AUT hours */}
            {ticks.map((t, i) => (
              <div
                key={i}
                className="absolute top-0 bottom-0 w-px bg-zinc-900/60"
                style={{ left: `${t.left}%` }}
              />
            ))}

            {/* global cursor */}
            <div
              className="absolute top-0 bottom-0 w-0.5 bg-zinc-100 shadow-[0_0_6px_rgba(255,255,255,0.9)]"
              style={{ left: `${cursorPct}%` }}
              aria-label="AUT cursor"
            />

            {/* cursor jewel */}
            <div
              className="absolute -top-1.5 h-3 w-3 rounded-full bg-zinc-100 shadow-[0_0_8px_rgba(255,255,255,0.85)]"
              style={{ left: `calc(${cursorPct}% - 6px)` }}
            />
          </div>

          <div className="flex items-center justify-between text-xs text-zinc-400">
            <div>
              Window span: {activeRay.start.toString().padStart(2, "0")}:00 → {activeRay.end
                .toString()
                .padStart(2, "0")}
              :00 AUT
            </div>
            <div>Cursor: {data.autClock}</div>
          </div>
        </section>

        {/* Manual Lat/Lon Input */}
        <section className="rounded-2xl p-6 bg-zinc-900/40 border border-zinc-700 space-y-3">
          <div className="text-sm uppercase text-zinc-400">Manual Coordinates</div>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col">
              <label className="text-xs text-zinc-400">Latitude (°)</label>
              <input
                type="number"
                step="0.0001"
                className="mt-1 px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500"
                value={coords.lat}
                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                  setCoords((c: Coordinates) => ({ ...c, lat: parseFloat(e.target.value) }))
                }
              />
            </div>
            <div className="flex flex-col">
              <label className="text-xs text-zinc-400">Longitude (°, East + / West −)</label>
              <input
                type="number"
                step="0.0001"
                className="mt-1 px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500"
                value={coords.lon}
                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                  setCoords((c: Coordinates) => ({ ...c, lon: parseFloat(e.target.value) }))
                }
              />
            </div>
          </div>
          <p className="text-xs text-zinc-400">
            Tip: Positive longitude = East, Negative = West. Charlotte’s NoDa ≈ lat 35.25°, lon −80.80°.
          </p>
        </section>

        <footer className="text-center text-xs text-zinc-500 mt-2">
          ✨ Atlas Island | AUT Live Clock | Ray‑aligned circadian time ✨
        </footer>
      </div>
    </div>
  );
}

/**
 * Minimal debug tests (disabled by default). Toggle RUN_TESTS to true if you want console assertions.
 */
const RUN_TESTS = false;
if (typeof window !== "undefined" && RUN_TESTS) {
  // Ensure AUT is monotonic across local midnight for Charlotte coords
  const lat = 35.25;
  const lon = -80.8;
  // Build two local times around midnight (today 23:50, tomorrow 00:10)
  const now = new Date();
  const t1 = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 50, 0);
  const t2 = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 10, 0);
  const a1 = computeAUT(t1, lat, lon).autHours;
  const a2 = computeAUT(t2, lat, lon).autHours;
  console.assert(a2 >= a1, "AUT should be non-decreasing across midnight", { a1, a2 });

  // Within-window progress should be between 0..1
  const probe = computeAUT(new Date(), lat, lon);
  console.assert(
    probe.progress >= 0 && probe.progress <= 1,
    "progress must be within [0,1]",
    probe.progress
  );

  // Ray mapping sanity checks (updated for Teal insertion and Orichalcum removal)
  const idx1 = rayIndexForAUT(0.5); // Red
  const idx2 = rayIndexForAUT(19.0); // Omni now 18–20
  const idx3 = rayIndexForAUT(23.9); // Infinite of ALL
  console.assert(RAY_WINDOWS[idx1].name === "Red", "00:30 AUT should be Red");
  console.assert(RAY_WINDOWS[idx2].name.includes("Omni"), "19:00 AUT should be Omni");
  console.assert(RAY_WINDOWS[idx3].name.includes("Infinite"), "23:54 AUT should be Infinite of ALL");
}
