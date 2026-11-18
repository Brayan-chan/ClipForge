export class ApiError extends Error {
  statusCode: number;
  detectedTitle?: string;
  youtubeBlocked?: boolean;

  constructor(
    message: string,
    statusCode: number,
    extra?: { detectedTitle?: string; youtubeBlocked?: boolean }
  ) {
    super(message);
    this.statusCode = statusCode;
    this.detectedTitle = extra?.detectedTitle;
    this.youtubeBlocked = extra?.youtubeBlocked;
  }
}

export async function readJsonResponse<T = Record<string, unknown>>(res: Response): Promise<T> {
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    // Non-JSON payload (e.g., proxy 413 Request Entity Too Large or 502/504 HTML/text)
  }

  if (!res.ok) {
    const errObj =
      parsed && typeof parsed === 'object'
        ? (parsed as {
            error?: string;
            detectedTitle?: string;
            youtubeBlocked?: boolean;
          })
        : null;
    const fallback =
      res.status === 413
        ? 'Request payload too large for server proxy (413).'
        : text.trim().slice(0, 180) || `HTTP ${res.status}`;
    throw new ApiError(errObj?.error || fallback, res.status, {
      detectedTitle: errObj?.detectedTitle,
      youtubeBlocked: errObj?.youtubeBlocked,
    });
  }

  if (parsed === null || typeof parsed !== 'object') {
    throw new Error(text.trim().slice(0, 180) || 'Invalid server response');
  }

  return parsed as T;
}
