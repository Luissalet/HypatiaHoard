/**
 * HoardChip.tsx
 *
 * Small status chip for the Dashboard header: "Hypatia · sincronizado hace X".
 * Click → sync now. Rendered (lazily) only in hoard mode.
 */

import { useEffect, useState } from 'react';
import { useStore } from '@/ui/store';
import { timeAgoEs } from '@/data/hoardSyncCore';
import { syncNow } from '@/data/hoardSync';

export function HoardChip() {
  const status = useStore((s) => s.hoardStatus);
  const [, tick] = useState(0);

  // Refresh the relative time every 30 s
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  const syncing = !!status?.syncing;
  const error = status?.error ?? null;
  const offline = status ? !status.connected : false;

  let label: string;
  if (syncing) label = 'sincronizando…';
  else if (offline) label = 'sin conexión';
  else if (error) label = 'error al sincronizar';
  else if (status?.lastSyncAt) {
    const ago = timeAgoEs(status.lastSyncAt);
    label = ago === 'ahora' ? 'sincronizado ahora' : `sincronizado ${ago}`;
  } else label = 'conectando…';

  const bad = !syncing && (offline || !!error);
  const title = error
    ? `${error}\nPulsa para reintentar.`
    : `Sincronización con Hypatia's Hoard (servidor local).${status?.rev ? ` Revisión ${status.rev}.` : ''} Pulsa para sincronizar ahora.`;

  return (
    <button
      type="button"
      onClick={() => { void syncNow(); }}
      disabled={syncing}
      title={title}
      className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium font-body border transition-all duration-150 disabled:cursor-default ${
        bad
          ? 'bg-rose-500/10 text-rose-400 border-rose-500/30 hover:bg-rose-500/20'
          : 'bg-ink-800 text-ink-300 border-ink-700 hover:text-ink-100 hover:border-ink-600'
      }`}
    >
      <span
        className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
          bad ? 'bg-rose-500' : syncing ? 'bg-amber-500 animate-pulse-soft' : 'bg-sage-500'
        }`}
      />
      <span className="font-semibold text-ink-200">Hypatia</span>
      <span className="hidden sm:inline text-ink-500">·</span>
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}

export default HoardChip;
