// Browser probes share one platform-aware launcher; assertions stay in probes.
import { existsSync, mkdtempSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
export function launchBrowser(port, prefix) {
  const candidates = [process.env.BROWSER_PATH, '/usr/bin/chromium', '/usr/bin/google-chrome',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe'];
  const browser = candidates.find(p => p && existsSync(p));
  if (!browser) throw new Error('Install Chromium/Edge or set BROWSER_PATH');
  const linux = process.platform === 'linux';
  return spawn(browser, ['--headless=new', '--no-first-run', '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    ...(linux ? ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader', '--use-gl=angle',
      `--use-angle=${process.env.BROWSER_ANGLE || 'swiftshader'}`, '--window-size=640,480', '--force-device-scale-factor=0.5']
      : ['--ignore-gpu-blocklist', '--use-angle=d3d11', '--window-size=1280,720']),
    `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), prefix))}`, 'about:blank'],
    { stdio:'ignore', env: { ...process.env, XDG_CONFIG_HOME:path.join(tmpdir(),'forzalan-chrome-config'),
      XDG_CACHE_HOME:path.join(tmpdir(),'forzalan-chrome-cache') } });
}
