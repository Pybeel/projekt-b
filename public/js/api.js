/**
 * api.js — al kommunikation med vores egen Node-server (/api/...)
 * Efter login gemmer browseren kun et token. Selve præferencerne ligger på serveren
 * og hentes derfra, hver gang brugeren åbner appen (GET /api/me).
 */
const TOKEN_KEY = 'klaedd-token';

let token = null;
try { token = localStorage.getItem(TOKEN_KEY); } catch { /* privat vindue o.l. */ }

export function getToken() { return token; }

export function setToken(value) {
  token = value;
  try { value ? localStorage.setItem(TOKEN_KEY, value) : localStorage.removeItem(TOKEN_KEY); } catch { /* ignorér */ }
}

async function request(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;

  let res;
  try {
    res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw Object.assign(new Error('Kan ikke få forbindelse til serveren. Kører den?'), { status: 0 });
  }
  let data = {};
  try { data = await res.json(); } catch { /* tomt svar */ }
  if (!res.ok) {
    throw Object.assign(new Error(data.error || 'Noget gik galt.'), { status: res.status, field: data.field });
  }
  return data;
}

export const register = (username, password) => request('/api/register', { method: 'POST', body: { username, password } });
export const login = (username, password) => request('/api/login', { method: 'POST', body: { username, password } });
export const logout = () => request('/api/logout', { method: 'POST' });
export const me = () => request('/api/me');
export const deleteMe = () => request('/api/me', { method: 'DELETE' });
export const saveProfile = profile => request('/api/me/profile', { method: 'PUT', body: profile });

export const addLocation = place => request('/api/me/locations', { method: 'POST', body: place });
export const renameLocation = (id, label) => request('/api/me/locations/' + id, { method: 'PUT', body: { label } });
export const reorderLocations = ids => request('/api/me/locations/order', { method: 'PUT', body: { ids } });
export const deleteLocation = id => request('/api/me/locations/' + id, { method: 'DELETE' });
