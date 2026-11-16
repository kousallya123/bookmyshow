import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const statusPath = path.join(__dirname, '..', 'status.json');
const statePath = path.join(__dirname, '..', 'state.json');

export function loadState() {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return { dates: {} };
  }
}

export function saveState(state) {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

export function writeStatus(payload) {
  fs.writeFileSync(statusPath, JSON.stringify(payload, null, 2));
}

export function readStatus() {
  try {
    return JSON.parse(fs.readFileSync(statusPath, 'utf8'));
  } catch {
    return {
      updatedAt: null,
      checking: false,
      dates: [],
      alert: null,
    };
  }
}

export function diffNewShows(previousShows = [], currentShows = []) {
  const prev = new Set(previousShows);
  return currentShows.filter((s) => !prev.has(s));
}
