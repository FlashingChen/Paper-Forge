/** Compare the browser's origin to the external host, including behind HTTPS proxies. */
export function isSameOriginRequest(request: Request): boolean {
  if (request.headers.get("sec-fetch-site") === "cross-site") return false;
  const origin = request.headers.get("origin");
  // CLI clients do not send Origin; they still need a valid session and password.
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.origin !== origin) return false;
    // The reverse proxy must overwrite forwarded host headers from clients.
    const host = request.headers.get("x-forwarded-host")?.split(",")[0].trim()
      || request.headers.get("host") || new URL(request.url).host;
    return parsed.host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}
