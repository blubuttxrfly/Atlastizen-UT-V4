import starsRaw from "../data/stars.json?raw";

type CatalogStar = {
  ra: number;
  dec: number;
  mag: number;
  name?: string;
};

type Vec2 = { x: number; y: number };

type PrecomputedStar = {
  world: Vec2;
  mag: number;
  name?: string;
};

const DEGREES = Math.PI / 180;
const HOURS = Math.PI / 12;
const OBLIQUITY_RAD = 23.439281 * DEGREES;
const STAR_SPHERE_RADIUS_AU = 120;

const catalog: CatalogStar[] = JSON.parse(starsRaw);

function equatorialToEcliptic(raHours: number, decDeg: number) {
  const ra = raHours * HOURS;
  const dec = decDeg * DEGREES;
  const cosDec = Math.cos(dec);
  const sinDec = Math.sin(dec);

  const xEq = cosDec * Math.cos(ra);
  const yEq = cosDec * Math.sin(ra);
  const zEq = sinDec;

  const cosE = Math.cos(OBLIQUITY_RAD);
  const sinE = Math.sin(OBLIQUITY_RAD);
  const xEcl = xEq;
  const yEcl = yEq * cosE + zEq * sinE;
  const zEcl = -yEq * sinE + zEq * cosE;

  const lambda = Math.atan2(yEcl, xEcl);
  const beta = Math.asin(zEcl);
  return { lambda, beta };
}

function toWorld(lambda: number, beta: number): Vec2 {
  const radius = STAR_SPHERE_RADIUS_AU * Math.cos(beta);
  return {
    x: radius * Math.cos(lambda),
    y: radius * Math.sin(lambda),
  };
}

const PRECOMPUTED_STARS: PrecomputedStar[] = catalog.map((star) => {
  const { lambda, beta } = equatorialToEcliptic(star.ra, star.dec);
  return {
    world: toWorld(lambda, beta),
    mag: star.mag,
    name: star.name,
  };
});

const NAMED_INDEX = new Map<string, PrecomputedStar>();
PRECOMPUTED_STARS.forEach((star) => {
  if (star.name) {
    NAMED_INDEX.set(star.name, star);
  }
});

type ConstellationSegment = {
  name: string;
  segments: Array<{ a: PrecomputedStar; b: PrecomputedStar }>;
};

const CONSTELLATION_DEFINITIONS: Array<{ name: string; links: Array<[string, string]> }> = [
  {
    name: "Orion",
    links: [
      ["Betelgeuse", "Bellatrix"],
      ["Bellatrix", "Mintaka"],
      ["Mintaka", "Alnilam"],
      ["Alnilam", "Alnitak"],
      ["Alnitak", "Saiph"],
      ["Saiph", "Rigel"],
      ["Rigel", "Betelgeuse"],
    ],
  },
  {
    name: "Southern Cross",
    links: [
      ["Acrux", "Mimosa"],
      ["Mimosa", "Gacrux"],
      ["Gacrux", "Acrux"],
    ],
  },
  {
    name: "Big Dipper",
    links: [
      ["Dubhe", "Merak"],
      ["Merak", "Phecda"],
      ["Phecda", "Megrez"],
      ["Megrez", "Dubhe"],
    ],
  },
  {
    name: "Gemini",
    links: [
      ["Castor", "Pollux"],
      ["Castor", "Alnilam"],
      ["Pollux", "Betelgeuse"],
    ],
  },
];

const CONSTELLATION_SEGMENTS: ConstellationSegment[] = CONSTELLATION_DEFINITIONS.map((definition) => {
  const segments: Array<{ a: PrecomputedStar; b: PrecomputedStar }> = [];
  definition.links.forEach(([from, to]) => {
    const a = NAMED_INDEX.get(from);
    const b = NAMED_INDEX.get(to);
    if (a && b) {
      segments.push({ a, b });
    }
  });
  return { name: definition.name, segments };
});

export type { CatalogStar, PrecomputedStar };
export { PRECOMPUTED_STARS, NAMED_INDEX, CONSTELLATION_SEGMENTS };
