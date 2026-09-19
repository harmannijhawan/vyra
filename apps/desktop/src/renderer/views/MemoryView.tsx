/**
 * Memory view — hosts the MemoryPanel.
 */
import { MemoryPanel } from '../components/MemoryPanel';

export function MemoryView(): JSX.Element {
  return (
    <div className="flex h-full flex-col gap-4 overflow-hidden">
      <h1 className="flex-none text-xl font-light text-slate-100">Memory</h1>
      <div className="min-h-0 flex-1">
        <MemoryPanel />
      </div>
    </div>
  );
}
