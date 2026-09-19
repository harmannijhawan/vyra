/**
 * THE VYRA orb. Its animation is driven SOLELY by the `state` prop
 * (a real VoiceState from main-process events) via orbClassForState().
 */
import { VoiceState } from '@vyra/shared';
import { orbClassForState } from '../lib/orbState';

interface OrbProps {
  state: VoiceState;
  size?: number;
}

const SPEAKING_BARS = 24;

export function Orb({ state, size = 220 }: OrbProps): JSX.Element {
  const cls = orbClassForState(state);
  return (
    <div
      className={`orb ${cls}`}
      style={{ width: size, height: size }}
      role="img"
      aria-label={`VYRA orb — ${state}`}
      data-voice-state={state}
    >
      <div className="orb__core" />
      <div className="orb__ring" />
      <div className="orb__sheen" />
      <div className="orb__scan" />
      <div className="orb__tint" />
      <div className="orb__ripple" />
      {state === VoiceState.SPEAKING && (
        <div className="orb__bars" aria-hidden="true">
          {Array.from({ length: SPEAKING_BARS }).map((_, i) => (
            <span key={i} style={{ animationDelay: `${(i % 8) * 0.11}s` }} />
          ))}
        </div>
      )}
    </div>
  );
}
