// Directory-level autonomy management: determines whether a directory gets 'full' or 'safe' permissions.
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';

const STORE_PATH = path.resolve('.chatroom', 'autonomy-dirs.json');

function normalize(p) {
  return path.resolve(p).replace(/\\/g, '/').toLowerCase();
}

/** Read persisted directories from file */
function loadPersisted() {
  try {
    if (fs.existsSync(STORE_PATH)) {
      const data = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
      if (Array.isArray(data)) return data;
    }
  } catch (e) {
    console.error('Failed to read autonomy-dirs.json:', e.message);
  }
  return [];
}

/** Save directories to file */
function savePersisted(dirs) {
  try {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify([...dirs], null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to save autonomy-dirs.json:', e.message);
  }
}

/** Set of active full autonomy directory paths */
const customDirs = new Set(loadPersisted());

export function getFullAutonomyDirs() {
  const envDirs = (process.env.FULL_AUTONOMY_DIRS || '')
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);

  const merged = new Set([...envDirs, ...customDirs]);
  return [...merged].map((d) => path.resolve(d));
}

export function isFullAutonomy(targetDir) {
  if (!targetDir) return false;
  if (process.env.AGENT_AUTONOMY === 'full') return true;

  const targetNorm = normalize(targetDir);
  const allDirs = getFullAutonomyDirs();

  for (const d of allDirs) {
    const dNorm = normalize(d);
    if (targetNorm === dNorm || targetNorm.startsWith(`${dNorm}/`)) {
      return true;
    }
  }
  return false;
}

export function getAutonomyForDir(targetDir) {
  return isFullAutonomy(targetDir) ? 'full' : (process.env.AGENT_AUTONOMY || 'safe');
}

export function addFullAutonomyDir(targetDir) {
  const resolved = path.resolve(targetDir);
  customDirs.add(resolved);
  savePersisted(customDirs);
  return resolved;
}

export function removeFullAutonomyDir(targetDir) {
  const resolved = path.resolve(targetDir);
  let removed = false;
  for (const d of [...customDirs]) {
    if (normalize(d) === normalize(resolved)) {
      customDirs.delete(d);
      removed = true;
    }
  }
  if (removed) savePersisted(customDirs);
  return removed;
}
