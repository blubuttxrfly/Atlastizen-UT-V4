export type AstroNow = {
  decDeg: number;
  illum: number;
  altDeg: number;
  azDeg: number;
  phaseName: string;
  phaseAngleDeg: number;
  rise?: Date;
  set?: Date;
  transit?: Date;
  transitAltDeg?: number;
  tonight: Array<{ ts: Date; alt: number; az: number }>;
};

export type AstroProvider = {
  now(lat: number, lon: number, date?: Date): AstroNow;
};
