// 首页昵称在游戏重模块加载前同步；各入口共享同一个 Profile。
import { setPenaltyMode } from './PenaltyController.js';

const NAME_KEY = 'forza_lan_name';
export function syncPlayerProfile(name) {
  const value = String(name || '').trim().slice(0, 12);
  const profile = document.getElementById('profileName');
  if (profile) profile.textContent = value || '未命名车手';
  if (value) {
    try { localStorage.setItem(NAME_KEY, value); } catch (_) { /* 禁用存储时仍可驾驶 */ }
  }
  return value;
}

export function initializeRaceUI() {
  const name = document.getElementById('name');
  let saved = '';
  try { saved = localStorage.getItem(NAME_KEY) || ''; } catch (_) { /* 无本地存储 */ }
  if (name && saved) name.value = saved.slice(0, 12);
  syncPlayerProfile(saved || name?.value);
  name?.addEventListener('input', () => syncPlayerProfile(name.value));
  const inRoom = document.getElementById('nameInRoom');
  document.getElementById('btnRename')?.addEventListener('click', () => {
    if (inRoom?.value.trim()) syncPlayerProfile(inRoom.value);
  });
  window.addEventListener('storage', event => {
    if (event.key === NAME_KEY) {
      if (name) name.value = (event.newValue || '').slice(0, 12);
      syncPlayerProfile(event.newValue);
    }
  });
  const mode = document.getElementById('gameMode');
  mode?.addEventListener('change', () => setPenaltyMode(mode.value));
  setPenaltyMode(mode?.value || 'fm8');
}

initializeRaceUI();
