import { SolProvider } from "./solProvider";

export const SolRuntime = {
  now(lat: number, lon: number, date = new Date()) {
    return SolProvider.now(lat, lon, date);
  },
};
