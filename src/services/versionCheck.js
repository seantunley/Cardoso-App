import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { version: APP_VERSION } = require('../../package.json');

export function normalizeVersion(version) {
  return String(version || '')
    .trim()
    .replace(/^v/i, '')
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0);
}

export function isVersionNewer(latestVersion, currentVersion) {
  const latest = normalizeVersion(latestVersion);
  const current = normalizeVersion(currentVersion);
  const maxLength = Math.max(latest.length, current.length);

  for (let i = 0; i < maxLength; i += 1) {
    const latestPart = latest[i] || 0;
    const currentPart = current[i] || 0;
    if (latestPart > currentPart) return true;
    if (latestPart < currentPart) return false;
  }

  return false;
}

const VERSION_CHECK_CACHE_MS = 1000 * 60 * 30;
let versionStatusCache = {
  data: {
    currentVersion: APP_VERSION,
    latestVersion: APP_VERSION,
    updateAvailable: false,
    source: 'local',
    checkedAt: null,
  },
  fetchedAt: 0,
};

export async function getVersionStatus() {
  const now = Date.now();
  if (now - versionStatusCache.fetchedAt < VERSION_CHECK_CACHE_MS) {
    return versionStatusCache.data;
  }

  const fallback = {
    currentVersion: APP_VERSION,
    latestVersion: versionStatusCache.data.latestVersion || APP_VERSION,
    updateAvailable: isVersionNewer(versionStatusCache.data.latestVersion || APP_VERSION, APP_VERSION),
    source: 'cache',
    checkedAt: new Date(now).toISOString(),
  };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const response = await fetch('https://api.github.com/repos/seantunley/Cardoso-App/releases/latest', {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'cardoso-app-version-check',
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`GitHub version check failed with status ${response.status}`);
    }

    const release = await response.json();
    const latestVersion = String(release.tag_name || release.name || APP_VERSION).replace(/^v/i, '') || APP_VERSION;
    const data = {
      currentVersion: APP_VERSION,
      latestVersion,
      updateAvailable: isVersionNewer(latestVersion, APP_VERSION),
      source: 'github-release',
      checkedAt: new Date(now).toISOString(),
    };

    versionStatusCache = {
      data,
      fetchedAt: now,
    };

    return data;
  } catch (error) {
    console.warn('Version check failed:', error.message);
    versionStatusCache = {
      data: fallback,
      fetchedAt: now,
    };
    return fallback;
  }
}
