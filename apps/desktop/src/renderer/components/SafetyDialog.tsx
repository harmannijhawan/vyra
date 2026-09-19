/**
 * Safety confirmation dialog — rendered when a 'safety.confirm.request'
 * event arrives. Approve/Deny answers via vyra:safety:respond.
 */
import { useState } from 'react';
import type { SafetyConfirmRequestPayload } from '@vyra/shared';
import { respondSafety, VyraError } from '../api';

interface SafetyDialogProps {
  request: SafetyConfirmRequestPayload;
  onResolved: (requestId: string) => void;
}

export function SafetyDialog({ request, onResolved }: SafetyDialogProps): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const answer = async (approved: boolean): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await respondSafety(request.requestId, approved);
      onResolved(request.requestId);
    } catch (err) {
      setError(err instanceof VyraError ? err.message : 'Could not send your answer.');
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl border border-amber-400/30 bg-vyra-panel p-6 shadow-2xl">
        <p className="text-[11px] font-semibold uppercase tracking-widest text-amber-300">
          Confirmation needed
        </p>
        <h2 className="mt-2 text-lg font-medium text-slate-100">{request.question}</h2>
        <div className="mt-3 rounded-lg bg-black/40 p-3 text-xs text-slate-400">
          <p>
            <span className="text-slate-500">Tool:</span> {request.tool}
          </p>
          <p className="mt-1">
            <span className="text-slate-500">Risk:</span>{' '}
            <span className="text-amber-300">{request.risk}</span>
          </p>
          <details className="mt-1">
            <summary className="cursor-pointer text-slate-500 hover:text-slate-300">
              View arguments
            </summary>
            <pre className="vyra-terminal mt-1 overflow-x-auto whitespace-pre-wrap text-slate-400">
              {JSON.stringify(request.args, null, 2)}
            </pre>
          </details>
        </div>

        {error && <p className="mt-3 text-sm text-red-300">{error}</p>}

        <div className="mt-5 flex justify-end gap-3">
          <button
            type="button"
            disabled={busy}
            onClick={() => void answer(false)}
            className="rounded-lg border border-white/15 px-5 py-2 text-sm font-medium text-slate-200 transition hover:bg-white/5 disabled:opacity-50"
          >
            Deny
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void answer(true)}
            className="rounded-lg bg-amber-500 px-5 py-2 text-sm font-medium text-black transition hover:brightness-110 disabled:opacity-50"
          >
            {busy ? 'Sending…' : 'Approve'}
          </button>
        </div>
      </div>
    </div>
  );
}
