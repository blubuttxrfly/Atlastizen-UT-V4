
import { useTime } from '../state/time';

export function TimeUI() {
  const { t, setT, playing, play, pause, speed, setSpeed } = useTime();
  const start = Date.UTC(2025, 5, 1);
  const end   = Date.UTC(2026, 2, 1);

  return (
    <div className="ui" style={{ padding:'10px', background:'rgba(0,0,0,0.55)', color:'#fff', display:'grid', gap:'8px' }}>
      <div>
        <button onClick={playing ? pause : play} style={{ padding:'6px 10px', borderRadius:8 }}>
          {playing ? 'Pause' : 'Play'}
        </button>
        <label style={{ marginLeft: 12 }}>
          Speed
          <input type="range" min={60000} max={2.16e8} step={60000}
                 value={speed}
                 onChange={e => setSpeed(parseFloat((e.target as HTMLInputElement).value))} />
        </label>
      </div>
      <input type="range" min={start} max={end} value={t} onChange={e => setT(parseFloat((e.target as HTMLInputElement).value))} />
      <div style={{ fontFamily:'monospace' }}>{new Date(t).toISOString()}</div>
      <div>
        <button onClick={() => setT(Date.UTC(2025, 9, 29))} style={{ padding:'6px 10px', borderRadius:8, marginRight:8 }}>Jump to Perihelion</button>
        <button onClick={() => setT(start)} style={{ padding:'6px 10px', borderRadius:8 }}>Jump to Start</button>
      </div>
    </div>
  );
}
