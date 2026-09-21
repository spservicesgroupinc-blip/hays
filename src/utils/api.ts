/**
 * Safe API request helper to prevent JSON parsing crashes (e.g. Safari's
 * "The string did not match the expected pattern" SyntaxError) when
 * serverless edge routes or Vercel proxies return HTML or non-JSON errors.
 */

export interface ApiResponse<T = any> {
  ok: boolean;
  status: number;
  data: T;
  error?: string;
}

export async function safeFetchJson<T = any>(
  url: string,
  options?: RequestInit
): Promise<ApiResponse<T>> {
  try {
    const res = await fetch(url, options);
    const rawText = await res.text();

    let parsedData: any = null;

    if (rawText && rawText.trim().length > 0) {
      try {
        parsedData = JSON.parse(rawText);
      } catch {
        parsedData = null;
      }
    }

    if (parsedData !== null) {
      const errorMsg = !res.ok 
        ? (parsedData.error || `Request failed (HTTP ${res.status})`) 
        : (parsedData.success === false ? parsedData.error : undefined);

      return {
        ok: res.ok && parsedData.success !== false,
        status: res.status,
        data: parsedData,
        error: errorMsg
      };
    }

    // Response was not valid JSON (e.g. HTML 404, 502 proxy, or cold-start)
    let friendlyMessage = 'Unable to reach the authentication service. Please verify connection and retry.';
    if (res.status === 404) {
      friendlyMessage = 'API endpoint not reached (HTTP 404). Please ensure server is running.';
    } else if (res.status === 502 || res.status === 504) {
      friendlyMessage = 'Server gateway is temporarily warming up (HTTP 502/504). Please try again.';
    } else if (res.status >= 500) {
      friendlyMessage = `Server encountered an issue (HTTP ${res.status}).`;
    }

    return {
      ok: false,
      status: res.status,
      data: { success: false, error: friendlyMessage } as any,
      error: friendlyMessage
    };
  } catch (err: any) {
    return {
      ok: false,
      status: 0,
      data: { success: false, error: err.message || 'Network connection failed.' } as any,
      error: err.message || 'Network connection failed. Please check your internet connection.'
    };
  }
}
