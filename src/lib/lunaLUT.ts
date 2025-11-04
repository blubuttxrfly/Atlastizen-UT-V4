import type { AstroProvider } from "./astroProvider";

export function computeLunaNow(provider: AstroProvider, lat: number, lon: number, date?: Date) {
  return provider.now(lat, lon, date);
}
