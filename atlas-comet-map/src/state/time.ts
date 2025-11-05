
import { create } from 'zustand';

type TimeState = {
  t: number;                // ms since epoch
  speed: number;            // ms advanced per real ms
  playing: boolean;
  setT: (t: number) => void;
  setSpeed: (s: number) => void;
  play: () => void;
  pause: () => void;
};

export const useTime = create<TimeState>((set) => ({
  t: Date.UTC(2025, 5, 1),  // Jun 1, 2025 UTC
  speed: 3.6e6,             // 1 hr / sec
  playing: true,
  setT: (t) => set({ t }),
  setSpeed: (speed) => set({ speed }),
  play: () => set({ playing: true }),
  pause: () => set({ playing: false }),
}));
