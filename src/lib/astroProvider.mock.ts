import type { AstroProvider, AstroNow } from "./astroProvider";

const staticNow: AstroNow = {
  decDeg: 0,
  illum: 0.5,
  altDeg: 0,
  azDeg: 0,
  phaseName: "Mock Phase",
  phaseAngleDeg: 0,
  rise: undefined,
  set: undefined,
  transit: undefined,
  transitAltDeg: 0,
  tonight: [],
};

export const MockAstronomy: AstroProvider = {
  now() {
    return staticNow;
  },
};
