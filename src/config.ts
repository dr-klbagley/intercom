import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HERMES_HOME = path.join(os.homedir(), '.hermes');

/** One value from Jarvis's ~/.hermes/.env (empty if missing). Never logged. */
function hermesEnv(name: string): string {
  try {
    const line = fs.readFileSync(path.join(HERMES_HOME, '.env'), 'utf8').split('\n').find((l) => l.startsWith(`${name}=`));
    return line ? line.slice(name.length + 1).trim().replace(/^["']|["']$/g, '') : '';
  } catch { return ''; }
}

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
  /** Model and provider for Intercom's turns; unset = Jarvis's default model. */
  hermesModel?: string;
  hermesProvider?: string;
  sidecarUrl: string;
  /** Jarvis's read-only gatherer scripts (spec §8). */
  scriptsDir: string;
  gatherPython: string;
  digestScript: string;
  calendarScript: string;
  webDir: string;
  voice: string;
  speed: number;
  vaultDir: string;
  vaultScript: string;
  dashboardUrl: string;
  slotheriumUrl: string;
  /** Jarvis's Slotherium MCP key (read from ~/.hermes/.env unless INTERCOM_SLOTHERIUM_KEY is set). */
  slotheriumKey: string;
  /** Minutes between background refreshes of mail, calendar and digests (0 = off). */
  prefetchMinutes: number;
  /** Local hours [start, end) when the prefetch runs. */
  prefetchHours: [number, number];
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
    hermesModel: env.INTERCOM_HERMES_MODEL || undefined,
    hermesProvider: env.INTERCOM_HERMES_PROVIDER || undefined,
    sidecarUrl: env.INTERCOM_SIDECAR_URL ?? 'http://127.0.0.1:4178',
    scriptsDir: env.INTERCOM_SCRIPTS_DIR ?? path.join(HERMES_HOME, 'scripts'),
    gatherPython: env.INTERCOM_GATHER_PYTHON ?? path.join(HERMES_HOME, 'hermes-agent/venv/bin/python'),
    digestScript: path.join(root, 'scripts/latest_digest.py'),
    calendarScript: path.join(root, 'scripts/calendar.sh'),
    webDir: env.INTERCOM_WEB_DIR ?? path.join(root, 'web'),
    voice: env.INTERCOM_VOICE ?? 'bm_george',
    speed: Number(env.INTERCOM_SPEED ?? 1.3),
    vaultDir: env.INTERCOM_VAULT_DIR ?? path.join(os.homedir(), 'JarvisVault'),
    vaultScript: path.join(root, 'scripts/vault_gather.py'),
    dashboardUrl: env.INTERCOM_DASHBOARD_URL ?? 'http://127.0.0.1:4180',
    slotheriumUrl: env.INTERCOM_SLOTHERIUM_URL ?? 'http://127.0.0.1:4173/mcp',
    slotheriumKey: env.INTERCOM_SLOTHERIUM_KEY ?? hermesEnv('MCP_SLOTHERIUM_API_KEY'),
    prefetchMinutes: Number(env.INTERCOM_PREFETCH_MINUTES ?? 5),
    prefetchHours: [Number(env.INTERCOM_PREFETCH_FROM ?? 6), Number(env.INTERCOM_PREFETCH_UNTIL ?? 23)],
  };
}
