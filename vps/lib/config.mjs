// Self-hosted deployment settings. Everything comes from the environment so the
// same code can run on any server; nothing here is a secret.
export const VERSION = "0.14.0";
export const DEPLOYMENT = "0.14.0-vps.1";

export function publicOrigin(environment = process.env) {
  let url;
  try { url = new URL(environment.LINK_PUBLIC_ORIGIN); } catch {}
  if (!url || url.protocol !== "https:" || url.username || url.password || url.port ||
      (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    throw new Error("LINK_PUBLIC_ORIGIN must be a bare https:// origin");
  }
  return url.origin;
}

export function listenPort(environment = process.env) {
  const port = Number(environment.LINK_PORT ?? 8790);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("LINK_PORT must be 1024-65535");
  return port;
}
