const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, '') ?? '';

export function apiUrl(pathname: string): string {
  if (/^https?:\/\//i.test(pathname)) return pathname;
  const normalized = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return `${API_BASE_URL}${normalized}`;
}

export function mediaUrl(url: string | null | undefined): string {
  if (!url) return '';
  if (/^https?:\/\//i.test(url)) return url;
  return apiUrl(url);
}
