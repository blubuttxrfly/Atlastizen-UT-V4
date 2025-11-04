import {
  Body,
  Equator,
  Horizon,
  Illumination,
  MakeTime,
  MoonPhase,
  Observer,
  SearchHourAngle,
  SearchRiseSet,
  type HorizontalCoordinates,
} from "astronomy-engine";
import type { AstroProvider, AstroNow } from "./astroProvider";

function extractRiseSet(
  body: Body,
  observer: Observer,
  start: Date,
  direction: 1 | -1
): Date | undefined {
  const result = SearchRiseSet(body, observer, direction, MakeTime(start), 2);
  return result?.date;
}

function computeTransit(
  body: Body,
  observer: Observer,
  start: Date
): { date?: Date; altitude?: number } {
  try {
    const event = SearchHourAngle(body, observer, 0, MakeTime(start), +1);
    const date = event.time?.date;
    const altitude = (event.hor as HorizontalCoordinates | undefined)?.altitude;
    return { date, altitude };
  } catch {
    return {};
  }
}

function phaseNameFromLongitude(longitudeDeg: number): string {
  const angle = ((longitudeDeg % 360) + 360) % 360;
  const wrap = (target: number) => {
    let diff = angle - target;
    diff = ((diff + 180) % 360 + 360) % 360 - 180;
    return Math.abs(diff);
  };
  const tolerance = 7; // degrees

  if (wrap(0) <= tolerance || wrap(360) <= tolerance) {
    return "New Moon";
  }
  if (wrap(90) <= tolerance) {
    return "First Quarter";
  }
  if (wrap(180) <= tolerance) {
    return "Full Moon";
  }
  if (wrap(270) <= tolerance) {
    return "Last Quarter";
  }

  if (angle > 0 && angle < 90) {
    return "Waxing Crescent";
  }
  if (angle > 90 && angle < 180) {
    return "Waxing Gibbous";
  }
  if (angle > 180 && angle < 270) {
    return "Waning Gibbous";
  }
  return "Waning Crescent";
}

export const AstronomyProvider: AstroProvider = {
  now(lat, lon, date = new Date()): AstroNow {
    const observer = new Observer(lat, lon, 0);
    const eq = Equator(Body.Moon, MakeTime(date), observer, true, true);
    const decDeg = eq.dec;
    const horizonNow = Horizon(MakeTime(date), observer, eq.ra, eq.dec, "normal");

    const illumInfo = Illumination(Body.Moon, MakeTime(date));
    const illum = illumInfo.phase_fraction;
    const phaseAngleDeg = MoonPhase(MakeTime(date));
    const phaseName = phaseNameFromLongitude(phaseAngleDeg);

    const rise = extractRiseSet(Body.Moon, observer, date, +1);
    const set = extractRiseSet(Body.Moon, observer, date, -1);
    const { date: transit, altitude: transitAltDeg } = computeTransit(Body.Moon, observer, date);

    const tonight: AstroNow["tonight"] = [];
    const start = new Date(date);
    start.setHours(18, 0, 0, 0);
    const horizonRefraction = "normal";

    for (let minutes = 0; minutes <= 720; minutes += 5) {
      const tick = new Date(start.getTime() + minutes * 60_000);
      const tickTime = MakeTime(tick);
      const eqTick = Equator(Body.Moon, tickTime, observer, true, true);
      const horiz = Horizon(tickTime, observer, eqTick.ra, eqTick.dec, horizonRefraction);
      tonight.push({ ts: tick, alt: horiz.altitude, az: horiz.azimuth });
    }

    return {
      decDeg,
      illum,
      altDeg: horizonNow.altitude,
      azDeg: horizonNow.azimuth,
      phaseName,
      phaseAngleDeg,
      rise,
      set,
      transit,
      transitAltDeg,
      tonight,
    };
  },
};
