import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { PRESENT_ONLY } from "./config/rays";
import { ZIP_LOOKUP_ENDPOINT, ZIP_LOOKUP_USER_AGENT } from "./config/geocode";

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

type PlaceStatus = "idle" | "loading" | "ready" | "error";
type ZipStatus = "idle" | "loading" | "success" | "error";
type TimeZoneStatus = "idle" | "loading" | "success" | "error";

type TimeZoneInfo = {
  timeZone: string;
  abbreviation?: string;
  offsetMinutes?: number;
};

const FALLBACK_PLACE_LABEL = "Charlotte, NC";
const PLACE_CACHE_PREFIX = "aut-place:";
const COORD_PRECISION = 3;
const RING_OUTER_RADIUS = 62;
const RING_INNER_RADIUS = 22;
const POINTER_RADIUS = 58;
const LABEL_RADIUS = (RING_OUTER_RADIUS + RING_INNER_RADIUS) / 2;

function roundedCoord(value: number, precision = COORD_PRECISION): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function coordsCacheKey(coords: Coordinates): string {
  const lat = roundedCoord(coords.lat);
  const lon = roundedCoord(coords.lon);
  return `${lat.toFixed(COORD_PRECISION)},${lon.toFixed(COORD_PRECISION)}`;
}

function readSession(key: string): string | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.sessionStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

function writeSession(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

function extractPlaceName(response: any): string | undefined {
  if (!response || typeof response !== "object") return undefined;
  const locality = typeof response.city === "string" && response.city.trim().length > 0
    ? response.city.trim()
    : typeof response.locality === "string" && response.locality.trim().length > 0
    ? response.locality.trim()
    : undefined;
  const region =
    typeof response.principalSubdivision === "string" && response.principalSubdivision.trim().length > 0
      ? response.principalSubdivision.trim()
      : undefined;
  const country =
    typeof response.countryName === "string" && response.countryName.trim().length > 0
      ? response.countryName.trim()
      : undefined;

  const parts: string[] = [];
  if (locality) parts.push(locality);
  if (region && !parts.includes(region)) parts.push(region);
  if (country && !parts.includes(country)) parts.push(country);
  return parts.length > 0 ? parts.join(", ") : undefined;
}

function polarToCartesian(radius: number, angle: number): { x: number; y: number } {
  return {
    x: radius * Math.cos(angle),
    y: radius * Math.sin(angle),
  };
}

function describeWedge(
  outerRadius: number,
  innerRadius: number,
  startAngle: number,
  endAngle: number
): string {
  const outerStart = polarToCartesian(outerRadius, startAngle);
  const outerEnd = polarToCartesian(outerRadius, endAngle);
  const innerEnd = polarToCartesian(innerRadius, endAngle);
  const innerStart = polarToCartesian(innerRadius, startAngle);
  const largeArcFlag = endAngle - startAngle <= Math.PI ? "0" : "1";
  return [
    `M ${outerStart.x.toFixed(3)} ${outerStart.y.toFixed(3)}`,
    `A ${outerRadius} ${outerRadius} 0 ${largeArcFlag} 1 ${outerEnd.x.toFixed(3)} ${outerEnd.y.toFixed(3)}`,
    `L ${innerEnd.x.toFixed(3)} ${innerEnd.y.toFixed(3)}`,
    `A ${innerRadius} ${innerRadius} 0 ${largeArcFlag} 0 ${innerStart.x.toFixed(3)} ${innerStart.y.toFixed(3)}`,
    "Z",
  ].join(" ");
}

function formatOffset(minutes: number): string {
  const sign = minutes >= 0 ? "+" : "-";
  const abs = Math.abs(Math.round(minutes));
  const hours = Math.floor(abs / 60);
  const mins = abs % 60;
  return `${sign}${hours.toString().padStart(2, "0")}:${mins.toString().padStart(2, "0")}`;
}

function splitRayLabel(name: string): string[] {
  if (name.includes("-")) {
    const parts = name.split("-");
    return parts.map((part, idx) =>
      idx < parts.length - 1 ? `${part.trim()}-` : part.trim()
    );
  }
  const tokens = name.split(" ");
  const lines: string[] = [];
  let current = "";
  const maxLen = 10;
  for (const token of tokens) {
    const candidate = current ? `${current} ${token}` : token;
    if (candidate.length > maxLen && current) {
      lines.push(current);
      current = token;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

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

function useReverseGeocode(
  coords: Coordinates,
  geoStatus: GeolocationStatus,
  fallbackLabel: string
) {
  const cacheRef = useRef<Map<string, string>>(new Map());
  const abortRef = useRef<AbortController | null>(null);
  const [placeLabel, setPlaceLabel] = useState<string>(fallbackLabel);
  const [placeStatus, setPlaceStatus] = useState<PlaceStatus>("idle");

  const lookup = useCallback(
    (force = false) => {
      if (geoStatus !== "granted") {
        abortRef.current?.abort();
        const label = geoStatus === "pending" ? fallbackLabel : `${fallbackLabel}`;
        setPlaceLabel(label);
        setPlaceStatus(geoStatus === "pending" ? "idle" : "ready");
        return;
      }

      if (!Number.isFinite(coords.lat) || !Number.isFinite(coords.lon)) {
        setPlaceLabel("Current location");
        setPlaceStatus("error");
        return;
      }

      const key = coordsCacheKey(coords);
      if (!force) {
        const cached =
          cacheRef.current.get(key) ??
          readSession(PLACE_CACHE_PREFIX + key);
        if (cached) {
          cacheRef.current.set(key, cached);
          setPlaceLabel(cached);
          setPlaceStatus("ready");
          return;
        }
      }

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setPlaceStatus("loading");

      const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${coords.lat}&longitude=${coords.lon}&localityLanguage=en`;
      fetch(url, { signal: controller.signal })
        .then((res) => {
          if (!res.ok) {
            throw new Error("reverse geocode failed");
          }
          return res.json();
        })
        .then((data) => {
          if (controller.signal.aborted) return;
          const resolved = extractPlaceName(data) ?? "Current location";
          cacheRef.current.set(key, resolved);
          writeSession(PLACE_CACHE_PREFIX + key, resolved);
          setPlaceLabel(resolved);
          setPlaceStatus("ready");
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          setPlaceLabel("Current location");
          setPlaceStatus("error");
        });
    },
    [coords, geoStatus, fallbackLabel]
  );

  useEffect(() => {
    lookup();
    return () => {
      abortRef.current?.abort();
    };
  }, [lookup]);

  const retry = useCallback(() => lookup(true), [lookup]);

  return { placeLabel, placeStatus, retry };
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
  { name: "Red", start: 0, end: 2, color: "#ef4444" },
  { name: "Orange", start: 2, end: 4, color: "#f97316" },
  { name: "Yellow", start: 4, end: 6, color: "#facc15", labelColor: "#f8fafc" },
  { name: "Green", start: 6, end: 8, color: "#22c55e" },
  { name: "Teal", start: 8, end: 10, color: "#14b8a6" },
  { name: "Blue", start: 10, end: 12, color: "#3b82f6" },
  { name: "Indigo", start: 12, end: 14, color: "#6366f1" },
  { name: "Violet", start: 14, end: 16, color: "#8b5cf6" },
  { name: "Magenta", start: 16, end: 18, color: "#d946ef" },
  { name: "Omni", start: 18, end: 20, color: "#fafafa", labelColor: "#f8fafc" },
  { name: "Crystalline-Carbon", start: 20, end: 22, color: "#a5f3fc", labelColor: "#f8fafc" },
  { name: "Infinite of ALL", start: 22, end: 24, color: "#7dd3fc", labelColor: "#f8fafc" },
];

const TOP_RAY_INDEX = (() => {
  const idx = RAY_WINDOWS.findIndex((r) => r.name === "Infinite of ALL");
  return idx === -1 ? 0 : idx;
})();

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
  const { placeLabel, placeStatus, retry } = useReverseGeocode(coords, status, FALLBACK_PLACE_LABEL);
  const [zipInput, setZipInput] = useState("");
  const [zipStatus, setZipStatus] = useState<ZipStatus>("idle");
  const [zipError, setZipError] = useState<string | null>(null);
  const zipControllerRef = useRef<AbortController | null>(null);
  const [timeZoneInfo, setTimeZoneInfo] = useState<TimeZoneInfo | null>(null);
  const [timeZoneStatus, setTimeZoneStatus] = useState<TimeZoneStatus>("idle");
  const [timeZoneError, setTimeZoneError] = useState<string | null>(null);
  const timeZoneControllerRef = useRef<AbortController | null>(null);
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    return () => {
      zipControllerRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    return () => {
      timeZoneControllerRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!Number.isFinite(coords.lat) || !Number.isFinite(coords.lon)) {
      return;
    }
    timeZoneControllerRef.current?.abort();
    const controller = new AbortController();
    timeZoneControllerRef.current = controller;
    setTimeZoneStatus("loading");
    setTimeZoneError(null);

    const url = `https://timeapi.io/api/Time/current/coordinate?latitude=${coords.lat}&longitude=${coords.lon}`;

    fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
      },
    })
      .then((res) => {
        if (!res.ok) {
          throw new Error(`Time lookup failed (${res.status})`);
        }
        return res.json();
      })
      .then((data) => {
        if (controller.signal.aborted) return;
        const zone: string | undefined =
          data?.timeZone ?? data?.timezone ?? data?.time_zone ?? data?.tz ?? undefined;
        const abbreviation: string | undefined =
          data?.timeZoneAbbreviation ?? data?.abbreviation ?? data?.dstName ?? undefined;

        let offsetMinutes: number | undefined;
        const localTime = data?.currentLocalTime ?? data?.dateTime ?? data?.localTime ?? null;
        const utcTime = data?.utcTime ?? data?.utcDateTime ?? data?.currentUtcTime ?? null;
        if (typeof localTime === "string" && typeof utcTime === "string") {
          const localMs = Date.parse(localTime);
          const utcMs = Date.parse(utcTime);
          if (Number.isFinite(localMs) && Number.isFinite(utcMs)) {
            offsetMinutes = Math.round((localMs - utcMs) / 60000);
          }
        } else if (typeof data?.timeZoneOffset === "number") {
          offsetMinutes = data.timeZoneOffset;
        } else if (typeof data?.utcOffset === "number") {
          offsetMinutes = data.utcOffset;
        }

        if (!zone) {
          throw new Error("Time zone unavailable for these coordinates.");
        }

        setTimeZoneInfo({ timeZone: zone, abbreviation, offsetMinutes });
        setTimeZoneStatus("success");
        setTimeZoneError(null);
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setTimeZoneStatus("error");
        setTimeZoneError(err instanceof Error ? err.message : "Time zone lookup failed.");
        setTimeZoneInfo(null);
      });
  }, [coords.lat, coords.lon]);

  const data = useMemo<AUTResult>(
    () => computeAUT(now, coords.lat, coords.lon),
    [now, coords]
  );
  const pct = Math.max(0, Math.min(100, Math.round(data.progress * 100)));

  const locationTimeZoneId = timeZoneInfo?.timeZone;
  const { formatShortTime, formatLongTime } = useMemo(() => {
    if (locationTimeZoneId) {
      const shortFmt = new Intl.DateTimeFormat(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: locationTimeZoneId,
      });
      const longFmt = new Intl.DateTimeFormat(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        timeZone: locationTimeZoneId,
      });
      return {
        formatShortTime: (date: Date) => shortFmt.format(date),
        formatLongTime: (date: Date) => longFmt.format(date),
      };
    }
    return {
      formatShortTime: (date: Date) =>
        date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      formatLongTime: (date: Date) =>
        date.toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }),
    };
  }, [locationTimeZoneId]);

  const locationPrimary = (() => {
    if (status === "pending") return "Requesting location…";
    if (status === "granted") {
      if (placeStatus === "loading") return "Locating your place…";
      return placeLabel;
    }
    if (status === "denied" || status === "unavailable") {
      return `${FALLBACK_PLACE_LABEL} (fallback)`;
    }
    return FALLBACK_PLACE_LABEL;
  })();

  const timeZoneLine = (() => {
    if (timeZoneStatus === "loading") return "Resolving time zone…";
    if (timeZoneStatus === "error") {
      return timeZoneError ? `Time zone unavailable (${timeZoneError})` : "Time zone unavailable.";
    }
    if (timeZoneInfo?.timeZone) {
      const abbr = timeZoneInfo.abbreviation ? ` (${timeZoneInfo.abbreviation})` : "";
      const offset =
        typeof timeZoneInfo.offsetMinutes === "number"
          ? ` UTC${formatOffset(timeZoneInfo.offsetMinutes)}`
          : "";
      return `Time zone: ${timeZoneInfo.timeZone}${abbr}${offset}`;
    }
    return "Time zone: Device time";
  })();

  const timeZoneTone =
    timeZoneStatus === "error"
      ? "text-amber-300"
      : timeZoneStatus === "loading"
      ? "text-zinc-400"
      : "text-zinc-400";

  const locationHint = (() => {
    if (status === "granted") {
      if (placeStatus === "loading") return "Fetching location name…";
      if (placeStatus === "error") return "Could not resolve a friendly place name.";
      return null;
    }
    if (status === "denied") {
      return "Permission denied — using fallback coordinates.";
    }
    if (status === "unavailable") {
      return "Geolocation unavailable — using fallback coordinates.";
    }
    return null;
  })();

  const locationHintTone =
    status === "granted" && placeStatus === "error" ? "text-amber-300" : "text-zinc-400";

  // Use a stable, wrapped AUT hour value
  const autH = ((Number(data.autHours) % 24) + 24) % 24;

  // Active Ray window + progress within that window
  const rayIndex = rayIndexForAUT(autH);
  const activeRay = RAY_WINDOWS[rayIndex];
  const rayRange = activeRay.end - activeRay.start;
  const rayProgress = Math.min(1, Math.max(0, (autH - activeRay.start) / rayRange));
  const remainingAUTHours = Math.max(0, activeRay.end - autH);
  const minutesPerAutHour = data.segmentLabel?.includes("Daylight")
    ? data.dayLenMin / 12
    : data.nightLenMin / 12;
  const remainingRealMin = Math.max(0, remainingAUTHours * minutesPerAutHour);
  const segmentAngle = (2 * Math.PI) / RAY_WINDOWS.length;
  const progressPct = Math.round(rayProgress * 100);
  const ringSizeClass = PRESENT_ONLY ? "h-[24rem] w-[24rem]" : "h-[30rem] w-[30rem]";
  const ringLayoutClass = "flex flex-col items-center justify-center gap-8";
  const rayHeaderClass = PRESENT_ONLY
    ? "flex flex-col items-center gap-2 text-center"
    : "flex flex-wrap items-end justify-between gap-3";
  const dialSegments = useMemo(() => {
    const count = RAY_WINDOWS.length;
    const offset = -Math.PI / 2;
    return RAY_WINDOWS.map((ray, index) => {
      const dialPosition = ((index - TOP_RAY_INDEX + count) % count + count) % count;
      const startAngle = offset + dialPosition * segmentAngle;
      const endAngle = startAngle + segmentAngle;
      const midAngle = startAngle + segmentAngle / 2;
      const path = describeWedge(RING_OUTER_RADIUS, RING_INNER_RADIUS, startAngle, endAngle);
      const labelPosition = polarToCartesian(LABEL_RADIUS, midAngle);
      const labelLines = splitRayLabel(ray.name);
      return {
        ray,
        index,
        dialPosition,
        startAngle,
        endAngle,
        path,
        labelX: labelPosition.x,
        labelY: labelPosition.y,
        labelLines,
      };
    });
  }, [segmentAngle]);
  const activeSegment = dialSegments[rayIndex];
  const pointerAngle = activeSegment
    ? activeSegment.startAngle + rayProgress * segmentAngle
    : -Math.PI / 2;
  const pointerCoord = polarToCartesian(POINTER_RADIUS, pointerAngle);
  const pointerInner = polarToCartesian(RING_INNER_RADIUS - 6, pointerAngle);
  const progressPath =
    activeSegment && rayProgress > 0
      ? describeWedge(
          RING_OUTER_RADIUS,
          RING_INNER_RADIUS,
          activeSegment.startAngle,
          activeSegment.startAngle + segmentAngle * Math.min(rayProgress, 1)
        )
      : null;
  const lookupZip = useCallback(async () => {
    const raw = zipInput.trim();
    if (!raw) {
      setZipError("Enter a postal or ZIP code.");
      setZipStatus("error");
      return;
    }

    let country = "us";
    let code = raw;
    const prefixMatch = raw.match(/^([A-Za-z]{2})[:\s-]+(.+)$/);
    if (prefixMatch) {
      country = prefixMatch[1].toLowerCase();
      code = prefixMatch[2];
    }

    let normalized = code.trim();
    if (country === "us") {
      normalized = normalized.replace(/[^0-9]/g, "");
      if (normalized.length >= 5) {
        normalized = normalized.slice(0, 5);
      }
      if (!/^\d{5}$/.test(normalized)) {
        setZipError("US ZIP codes must include 5 digits (you can include the +4).");
        setZipStatus("error");
        return;
      }
    } else {
      normalized = normalized.replace(/[\s-]+/g, "").toUpperCase();
      if (!/^[A-Z0-9]{3,}$/u.test(normalized)) {
        setZipError("Postal codes must be alphanumeric and at least 3 characters.");
        setZipStatus("error");
        return;
      }
    }

    zipControllerRef.current?.abort();
    const controller = new AbortController();
    zipControllerRef.current = controller;
    setZipStatus("loading");
    setZipError(null);

    try {
      const url = new URL(ZIP_LOOKUP_ENDPOINT);
      url.searchParams.set("format", "json");
      url.searchParams.set("limit", "1");
      url.searchParams.set("postalcode", normalized);
      url.searchParams.set("countrycodes", country.toLowerCase());
      url.searchParams.set("addressdetails", "1");

      const res = await fetch(url.toString(), {
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          "User-Agent": ZIP_LOOKUP_USER_AGENT,
        },
      });
      if (!res.ok) {
        throw new Error(`Lookup failed (${res.status})`);
      }
      const data = await res.json();
      const place =
        Array.isArray(data) && data.length > 0
          ? data[0]
          : data && Array.isArray(data.places) && data.places.length > 0
          ? data.places[0]
          : undefined;
      const lat = place ? parseFloat(place.lat ?? place.latitude) : NaN;
      const lon = place ? parseFloat(place.lon ?? place.longitude) : NaN;
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        throw new Error("Invalid coordinates in response");
      }
      setCoords({ lat, lon });
      setZipStatus("success");
      setZipError(null);
    } catch (err) {
      if (controller.signal.aborted) return;
      setZipStatus("error");
      setZipError(err instanceof Error ? err.message : "Could not resolve that postal code.");
    }
  }, [zipInput, setCoords]);

  const onZipSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      void lookupZip();
    },
    [lookupZip]
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
            <div className="text-xl md:text-2xl font-medium">{formatLongTime(now)}</div>
          </div>
        </header>

        {/* Location Controls */}
        <section className="flex flex-col gap-2">
          <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
            <div>
              <div className="text-sm text-zinc-400">Location</div>
              <div className="text-lg font-medium">{locationPrimary}</div>
            </div>
            <button
              className="self-start rounded-xl bg-zinc-700 px-3 py-2 shadow transition hover:bg-zinc-600 md:self-center"
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
          <div className="text-sm text-zinc-400">
            lat {coords.lat.toFixed(4)}°, lon {coords.lon.toFixed(4)}°
          </div>
          <div className={`text-xs ${timeZoneTone}`}>{timeZoneLine}</div>
          {locationHint ? (
            <div className={`flex items-center gap-2 text-xs ${locationHintTone}`}>
              <span>{locationHint}</span>
              {status === "granted" && placeStatus === "error" ? (
                <button
                  className="rounded-lg px-2 py-1 text-xs text-emerald-300 transition hover:text-emerald-200"
                  onClick={() => retry()}
                >
                  Try again
                </button>
              ) : null}
            </div>
          ) : null}
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
              <div className="text-xl font-semibold">{formatShortTime(data.sunriseLocal)}</div>
            </div>
            <div className="rounded-xl bg-zinc-900/40 border border-zinc-700 p-4">
              <div className="text-sm text-zinc-400">Solar Sunset (12:00 AUT)</div>
              <div className="text-xl font-semibold">{formatShortTime(data.sunsetLocal)}</div>
            </div>
            <div className="rounded-xl bg-zinc-900/40 border border-zinc-700 p-4">
              <div className="text-sm text-zinc-400">Next Sunrise (24:00 AUT)</div>
              <div className="text-xl font-semibold">{formatShortTime(data.nextSunriseLocal)}</div>
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

        {/* Ray Dial */}
        <section className="rounded-2xl p-6 bg-zinc-900/40 border border-zinc-700 space-y-6">
          <div className={rayHeaderClass}>
            <div>
              <div className="text-sm uppercase text-zinc-400 tracking-wide">
                Ray Wheel & Window
              </div>
              <div className="text-lg font-semibold text-zinc-100">
                Active Window: <span className="underline decoration-dotted">{activeRay.name}</span>
              </div>
            </div>
            <div className={`text-sm text-zinc-300 ${PRESENT_ONLY ? "" : "text-right"}`}>
              <div>{progressPct}% through this window</div>
              <div>
                ≈ {Math.ceil(remainingAUTHours * 60)} AUT min left • ≈ {Math.ceil(remainingRealMin)} real min
              </div>
            </div>
          </div>

          <div className={ringLayoutClass}>
            <div className="relative">
              <svg
                viewBox="-64 -64 128 128"
                className={`${ringSizeClass} text-zinc-100 drop-shadow-[0_6px_16px_rgba(15,23,42,0.45)]`}
              >
                <circle
                  cx="0"
                  cy="0"
                  r={RING_OUTER_RADIUS + 4}
                  fill="#0f172a"
                  fillOpacity="0.35"
                  stroke="#1e293b"
                  strokeWidth="0.8"
                />
                {dialSegments.map((segment) => {
                  const isActive = segment.index === rayIndex;
                  return (
                    <g key={segment.index}>
                      <path
                        d={segment.path}
                        fill={segment.ray.color}
                        fillOpacity={isActive ? 0.95 : 0.78}
                        stroke={isActive ? "#f8fafc" : "rgba(15,23,42,0.55)"}
                        strokeWidth={isActive ? 1.6 : 0.6}
                      />
                      <text
                        x={segment.labelX.toFixed(3)}
                        y={segment.labelY.toFixed(3)}
                        textAnchor="middle"
                        dominantBaseline="middle"
                        fontSize="4.6"
                        fill={segment.ray.labelColor ?? "#e2e8f0"}
                      >
                        {segment.labelLines.map((line, lineIdx) => (
                          <tspan
                            key={`${segment.index}-${lineIdx}`}
                            x={segment.labelX.toFixed(3)}
                            dy={lineIdx === 0 ? (segment.labelLines.length > 1 ? "-0.2em" : "0") : "1.1em"}
                          >
                            {line}
                          </tspan>
                        ))}
                      </text>
                    </g>
                  );
                })}
                {progressPath ? (
                  <path d={progressPath} fill="rgba(248,250,252,0.28)" stroke="none" pointerEvents="none" />
                ) : null}
                <line
                  x1={pointerInner.x.toFixed(3)}
                  y1={pointerInner.y.toFixed(3)}
                  x2={pointerCoord.x.toFixed(3)}
                  y2={pointerCoord.y.toFixed(3)}
                  stroke="#f8fafc"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                />
                <circle cx="0" cy="0" r="6" fill="#0b1120" stroke="#f1f5f9" strokeWidth="1" />
              </svg>
            </div>
          </div>

        </section>

        {/* Postal Lookup */}
        <section className="rounded-2xl p-6 bg-zinc-900/40 border border-zinc-700 space-y-4">
          <div className="text-sm uppercase text-zinc-400">Postal / ZIP Lookup</div>
          <form
            onSubmit={onZipSubmit}
            className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-start"
          >
            <input
              type="text"
              inputMode="text"
              placeholder="e.g., 28205 or CA H0H0H0"
              className="px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500 sm:w-64"
              value={zipInput}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                setZipInput(e.target.value);
                if (zipStatus !== "idle") {
                  setZipStatus("idle");
                  setZipError(null);
                }
              }}
            />
            <button
              type="submit"
              className="px-3 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 transition shadow disabled:cursor-not-allowed disabled:opacity-60"
              disabled={zipStatus === "loading"}
            >
              {zipStatus === "loading" ? "Looking up…" : "Use Postal Code"}
            </button>
          </form>
          <div className="text-xs">
            {zipStatus === "loading" ? (
              <span className="text-zinc-400">Fetching coordinates…</span>
            ) : zipStatus === "success" ? (
              <span className="text-emerald-400">Updated location from postal code.</span>
            ) : zipStatus === "error" && zipError ? (
              <span className="text-rose-400">{zipError}</span>
            ) : (
              <span className="text-zinc-500">Enter a postal/ZIP code; prefix with a country (e.g., “CA H0H0H0”).</span>
            )}
          </div>
          <p className="text-xs text-zinc-400">
            Powered by Zippopotam.us — coordinates derived from the first matching place.
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
