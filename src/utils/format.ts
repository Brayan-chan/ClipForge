export function formatTimecode(seconds: number, showDecimals = false): string {
  const s = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const mins = Math.floor(s / 60);
  const secs = Math.floor(s % 60);
  const tenths = Math.floor((s - Math.floor(s)) * 10);
  const base = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  return showDecimals ? `${base}.${tenths}` : base;
}

export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let idx = 0;
  let val = bytes;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx++;
  }
  return `${val.toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
}

export function formatShortDate(iso: string, lang: 'en' | 'es' = 'en'): string {
  try {
    return new Date(iso).toLocaleDateString(lang === 'es' ? 'es-ES' : 'en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return iso;
  }
}
