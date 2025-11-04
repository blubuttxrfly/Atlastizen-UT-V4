import { computeLunaNow } from "./lunaLUT";
import { MockAstronomy } from "./astroProvider.mock";
import { AstronomyProvider } from "./astroProvider.astronomy";

const USING_MOCK = import.meta.env.VITE_USE_MOCK_ASTRONOMY === "1";

export const LunaRuntime = {
  now(lat: number, lon: number, date = new Date()) {
    const provider = USING_MOCK ? MockAstronomy : AstronomyProvider;
    return computeLunaNow(provider, lat, lon, date);
  },
};
