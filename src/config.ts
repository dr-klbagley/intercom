import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HERMES_HOME = path.join(os.homedir(), '.hermes');

export interface Config {
  port: number;
  production: boolean;
  /** Kevin's Tailscale login; PWA requests must carry it (spec §12). */
  allowedLogin: string;
  /** Dev only: accept loopback requests with no Tailscale identity. */
  devTrustLocal: boolean;
  hermesUrl: string;
  hermesKey: string;
  hermesProfile: string;
  hermesTimeoutMs: number;
  sidecarUrl: string;
  /** Jarvis's read-only gatherer scripts (spec §8). */
  scriptsDir: string;
  gatherPython: string;
  digestScript: string;
  calendarScript: string;
  webDir: string;
  voice: string;
  speed: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const production = env.NODE_ENV === 'production';
  const required = (name: string): string => {
    const v = env[name] ?? '';
    if (!v && production) throw new Error(`${name} must be set in production`);
    if (v.startsWith('REPLACE_')) throw new Error(`${name} still has its placeholder value from the plist`);
    return v;
  };
  const devTrustLocal = env.INTERCOM_DEV_TRUST_LOCAL === '1';
  if (production && devTrustLocal) throw new Error('INTERCOM_DEV_TRUST_LOCAL is not allowed in production');
  return {
    port: Number(env.PORT ?? 4177),
    production,
    allowedLogin: required('INTERCOM_ALLOWED_LOGIN'),
    devTrustLocal,
    hermesUrl: env.INTERCOM_HERMES_URL ?? 'http://127.0.0.1:8642',
    hermesKey: required('INTERCOM_HERMES_KEY'),
    hermesProfile: env.INTERCOM_HERMES_PROFILE ?? 'default',
    hermesTimeoutMs: Number(env.INTERCOM_HERMES_TIMEOUT_MS ?? 60_000),
    sidecarUrl: env.INTERCOM_SIDECAR_URL ?? 'http://127.0.0.1:4178',
    scriptsDir: env.INTERCOM_SCRIPTS_DIR ?? path.join(HERMES_HOME, 'scripts'),
    gatherPython: env.INTERCOM_GATHER_PYTHON ?? path.join(HERMES_HOME, 'hermes-agent/venv/bin/python'),
    digestScript: path.join(root, 'scripts/latest_digest.py'),
    calendarScript: path.join(root, 'scripts/calendar.sh'),
    webDir: env.INTERCOM_WEB_DIR ?? path.join(root, 'web'),
    voice: env.INTERCOM_VOICE ?? 'bm_george',
    speed: Number(env.INTERCOM_SPEED ?? 1.05),
  };
}
