// Kevin is the only user. Requests reach Intercom through `tailscale serve`, which connects from loopback
// and adds the caller's Tailscale identity (spec §12). Same rule as Rivendell and Mind Stone.
import type { RequestHandler } from 'express';

export function isLoopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

export function requireKevin(opts: { allowedLogin: string; devTrustLocal: boolean }): RequestHandler {
  return (req, res, next) => {
    if (!isLoopback(req.socket.remoteAddress)) return void res.status(401).json({ error: 'no_identity' });
    const login = req.header('Tailscale-User-Login');
    if (login && opts.allowedLogin && login.toLowerCase() === opts.allowedLogin.toLowerCase()) return next();
    if (!login && opts.devTrustLocal) return next();
    res.status(403).json({ error: 'not_kevin' });
  };
}
