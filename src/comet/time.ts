import { useSyncExternalStore } from "react";

export const START_TIME = Date.UTC(2025, 5, 1);
export const END_TIME = Date.UTC(2026, 2, 1);

type TimeState = {
  t: number;
  speed: number;
  playing: boolean;
};

type Listener = () => void;

const state: TimeState = {
  t: START_TIME,
  speed: 3.6e6, // 1 hour per second
  playing: true,
};

const listeners = new Set<Listener>();

function emit() {
  listeners.forEach((listener) => listener());
}

function setState(partial: Partial<TimeState>) {
  Object.assign(state, partial);
  emit();
}

export function setT(t: number) {
  const clamped = Math.min(Math.max(t, START_TIME), END_TIME);
  setState({ t: clamped });
}

export function setSpeed(speed: number) {
  setState({ speed });
}

export function play() {
  setState({ playing: true });
}

export function pause() {
  setState({ playing: false });
}

function getSnapshot(): TimeState {
  return state;
}

function subscribe(listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useTime(): TimeState {
  return useSyncExternalStore(subscribe, getSnapshot);
}

export const timeStore = {
  getState: (): TimeState => ({ ...state }),
  setT,
  setSpeed,
  play,
  pause,
  subscribe,
};
