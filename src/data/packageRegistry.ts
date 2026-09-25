/**
 * packageRegistry.ts
 *
 * Consulta el catálogo de paquetes disponibles desde GitHub Releases.
 * Cada release tiene como asset un .examcoach.zip con un manifest.json dentro.
 * Para evitar descargar cada ZIP, el manifest se incluye como JSON en el body del release.
 *
 * Formato esperado del release body (markdown):
 *   ```json
 *   { ...manifest }
 *   ```
 *
 * Si no hay manifest en el body, se descarga el ZIP y se extrae manifest.json.
 */

import type { PackageManifest, RegistryEntry, InstalledPackage } from '@/domain/models';

// ─── Config ──────────────────────────────────────────────────────────────────

const REPO_OWNER = 'Mlgpigeon';
const REPO_NAME = 'SubjectPacks'; // Repo PÚBLICO con los .enc cifrados
const API_BASE = 'https://api.github.com';
const PROXY_BASE = import.meta.env.VITE_DOWNLOAD_PROXY ?? 'https://examcoach-proxy.examcoach.workers.dev';
const CACHE_KEY = 'examcoach-registry-cache';
const CACHE_TTL = 5 * 60 * 1000; // 5 minutos

// ─── Types ───────────────────────────────────────────────────────────────────

interface GitHubRelease {
  id: number;
  tag_name: string;
  name: string;
  body: string;
  published_at: string;
  assets: GitHubAsset[];
}

interface GitHubAsset {
  id: number;
  name: string;
  browser_download_url: string;
  size: number;
}

interface CacheEntry {
  entries: RegistryEntry[];
  fetchedAt: number;
}

// ─── Fetch registry ──────────────────────────────────────────────────────────

/**
 * Obtiene la lista de paquetes disponibles desde GitHub Releases.
 * Usa cache en memoria/localStorage para evitar rate limits.
 */
export async function fetchRegistry(forceRefresh = false): Promise<RegistryEntry[]> {
  // Check cache
  if (!forceRefresh) {
    const cached = loadCache();
    if (cached) return cached;
  }

  const url = `${API_BASE}/repos/${REPO_OWNER}/${REPO_NAME}/releases`;

  const res = await fetch(url, {
    headers: { 'Accept': 'application/vnd.github.v3+json' },
  });

  if (!res.ok) {
    // Si falla (rate limit, offline, etc.), intentar devolver cache viejo
    const staleCache = loadCache(true);
    if (staleCache) return staleCache;
    throw new Error(`Error consultando GitHub: ${res.status} ${res.statusText}`);
  }

  const releases: GitHubRelease[] = await res.json();

  // Dedup por id de paquete: puede haber varias releases del mismo paquete
  // (pkg-<id>-v1.0.0, pkg-<id>-v1.1.0...). Nos quedamos con la versión más alta.
  const byId = new Map<string, RegistryEntry>();

  for (const release of releases) {
    // Solo releases que tengan un asset .examcoach.enc (cifrado) o .examcoach.zip
    const asset = release.assets.find(
      a => a.name.endsWith('.examcoach.enc') || a.name.endsWith('.examcoach.zip'),
    );
    if (!asset) continue;

    // Extraer manifest del body del release
    const manifest = parseManifestFromBody(release.body);
    if (!manifest) continue;

    const entry: RegistryEntry = {
      id: manifest.id,
      manifest,
      downloadUrl: `${PROXY_BASE}/${asset.id}`,
      size: asset.size,
      publishedAt: release.published_at,
      encrypted: asset.name.endsWith('.enc'),
    };

    const existing = byId.get(manifest.id);
    if (!existing || compareVersions(manifest.version, existing.manifest.version) > 0) {
      byId.set(manifest.id, entry);
    }
  }

  const entries = [...byId.values()];

  // Save to cache
  saveCache(entries);

  return entries;
}

/**
 * Descarga un paquete a través del Cloudflare Worker proxy.
 * El proxy descarga el asset de GitHub y lo devuelve con CORS headers.
 */
export async function downloadPackage(downloadUrl: string): Promise<Blob> {
  const res = await fetch(downloadUrl);
  if (!res.ok) {
    throw new Error(`Error descargando paquete: ${res.status}`);
  }
  return res.blob();
}

/**
 * Compara los paquetes instalados con el registry para encontrar actualizaciones.
 */
export function checkForUpdates(
  installed: InstalledPackage[],
  registry: RegistryEntry[],
): RegistryEntry[] {
  const updates: RegistryEntry[] = [];

  for (const entry of registry) {
    const inst = installed.find(p => p.id === entry.id);
    if (inst && compareVersions(entry.manifest.version, inst.version) > 0) {
      updates.push(entry);
    }
  }

  return updates;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Extrae el manifest JSON del body de un GitHub Release.
 * Busca un bloque ```json ... ``` con el manifest.
 */
function parseManifestFromBody(body: string): PackageManifest | null {
  if (!body) return null;

  // Buscar bloque de código JSON
  const jsonMatch = body.match(/```json\s*\n([\s\S]*?)\n\s*```/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[1]);
    } catch {
      return null;
    }
  }

  // Fallback: intentar parsear todo el body como JSON
  try {
    const parsed = JSON.parse(body);
    if (parsed.formatVersion && parsed.id) return parsed;
  } catch { /* not JSON */ }

  return null;
}

/**
 * Comparación semántica simple de versiones (a.b.c).
 * Devuelve > 0 si a > b, < 0 si a < b, 0 si iguales.
 */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function loadCache(ignoreExpiry = false): RegistryEntry[] | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const cache: CacheEntry = JSON.parse(raw);
    if (!ignoreExpiry && Date.now() - cache.fetchedAt > CACHE_TTL) return null;
    return cache.entries;
  } catch {
    return null;
  }
}

function saveCache(entries: RegistryEntry[]): void {
  try {
    const cache: CacheEntry = { entries, fetchedAt: Date.now() };
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch { /* quota exceeded, ignore */ }
}
