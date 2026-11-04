/**
 * weather.js — vejrdata, stedsøgning og geolokalisering
 *  - Open-Meteo (gratis, ingen API-nøgle): vejret nu, time for time og 7 dage frem
 *  - Open-Meteo Geocoding: søg efter by
 *  - Browserens navigator.geolocation: "Brug min lokation"
 */

// WMO-vejrkoder -> dansk beskrivelse + ikon (dag / nat)
const WMO = {
  0: ['Klart vejr', 'sun', 'moon'], 1: ['Overvejende klart', 'sun', 'moon'], 2: ['Delvist skyet', 'partly', 'cloud'],
  3: ['Overskyet', 'cloud'], 45: ['Tåge', 'fog'], 48: ['Rimtåge', 'fog'],
  51: ['Let støvregn', 'drizzle'], 53: ['Støvregn', 'drizzle'], 55: ['Kraftig støvregn', 'rain'],
  56: ['Frysende støvregn', 'rain'], 57: ['Frysende støvregn', 'rain'],
  61: ['Let regn', 'rain'], 63: ['Regn', 'rain'], 65: ['Kraftig regn', 'rain'],
  66: ['Isslag', 'rain'], 67: ['Kraftigt isslag', 'rain'],
  71: ['Let sne', 'snow'], 73: ['Sne', 'snow'], 75: ['Kraftig sne', 'snow'], 77: ['Snekorn', 'snow'],
  80: ['Regnbyger', 'rain'], 81: ['Regnbyger', 'rain'], 82: ['Voldsomme byger', 'rain'],
  85: ['Snebyger', 'snow'], 86: ['Kraftige snebyger', 'snow'],
  95: ['Torden', 'thunder'], 96: ['Torden med hagl', 'thunder'], 99: ['Torden med hagl', 'thunder']
};

export const RAIN_CODES = new Set([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99]);
export const SNOW_CODES = new Set([71, 73, 75, 77, 85, 86]);

export const describe = code => (WMO[code] || ['Ukendt vejr'])[0];
export function weatherIcon(code, isDay = true) {
  const w = WMO[code] || ['', 'cloud'];
  return (!isDay && w[2]) || w[1];
}

export async function fetchWeather(lat, lon) {
  const p = new URLSearchParams({
    latitude: lat, longitude: lon, timezone: 'auto', forecast_days: 7, wind_speed_unit: 'ms',
    current: 'temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,is_day',
    hourly: 'temperature_2m,apparent_temperature,precipitation_probability,precipitation,weather_code,wind_speed_10m,uv_index,is_day',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max'
  });
  const res = await fetch('https://api.open-meteo.com/v1/forecast?' + p);
  if (!res.ok) throw new Error('Vejrtjenesten svarede ikke.');
  return res.json();
}

export async function searchPlaces(query) {
  const p = new URLSearchParams({ name: query, count: 8, language: 'da', format: 'json' });
  const res = await fetch('https://geocoding-api.open-meteo.com/v1/search?' + p);
  if (!res.ok) return [];
  const data = await res.json();
  return (data.results || []).map(r => ({
    name: r.name, region: r.admin1 || '', country: r.country || '', lat: r.latitude, lon: r.longitude
  }));
}

// Finder bynavnet for en position (bruges efter "Brug min lokation")
export async function reverseGeocode(lat, lon) {
  try {
    const p = new URLSearchParams({ latitude: lat, longitude: lon, localityLanguage: 'da' });
    const res = await fetch('https://api.bigdatacloud.net/data/reverse-geocode-client?' + p);
    const d = await res.json();
    return { name: d.city || d.locality || 'Din position', region: d.principalSubdivision || '', country: d.countryName || '' };
  } catch {
    return { name: 'Din position', region: '', country: '' };
  }
}

// Promise-udgave af navigator.geolocation (browseren spørger selv om tilladelse)
export function getPosition() {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) return reject(new Error('Din browser understøtter ikke lokation.'));
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      err => reject(new Error(err.code === 1
        ? 'Du har ikke givet adgang til din lokation. Søg i stedet efter en by.'
        : 'Din lokation kunne ikke findes. Søg i stedet efter en by.')),
      { timeout: 10000, maximumAge: 10 * 60 * 1000 }
    );
  });
}

/* ---------- Hjælpere til at læse udsigten ---------- */

// Index i hourly-listen for den aktuelle time
export function nowIndex(w) {
  const prefix = w.current.time.slice(0, 13);
  const i = w.hourly.time.findIndex(t => t.startsWith(prefix));
  return i < 0 ? 0 : i;
}

export const hourOf = (w, i) => Number(w.hourly.time[i].slice(11, 13));

// Timerne tøjrådet gælder for: resten af dagen til kl. 20 (om aftenen de næste 8 timer)
export function adviceWindow(w) {
  const ni = nowIndex(w);
  const hr = hourOf(w, ni);
  const span = hr < 18 ? 20 - hr : 8;
  const idx = [];
  for (let i = ni; i <= ni + span && i < w.hourly.time.length; i++) idx.push(i);
  return idx;
}

// Dagtimer (kl. 8–20) for en dato — bruges til "Næste dage"
export function dayWindow(w, date) {
  return w.hourly.time
    .map((t, i) => i)
    .filter(i => w.hourly.time[i].startsWith(date) && hourOf(w, i) >= 8 && hourOf(w, i) <= 20);
}

// Opsummerer en række timer til de forhold, tøjmotoren skal bruge
export function conditions(w, idx) {
  const h = w.hourly;
  const app = idx.map(i => h.apparent_temperature[i]);
  const air = idx.map(i => h.temperature_2m[i]);
  const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
  const codes = idx.map(i => h.weather_code[i]);
  const freq = {};
  codes.forEach(c => { freq[c] = (freq[c] || 0) + 1; });
  const code = Number(Object.entries(freq).sort((a, b) => b[1] - a[1])[0][0]);
  return {
    // Vægtet mod det kolde: man skal også være klædt på til dagens køligste del
    apparent: (Math.min(...app) + mean(app)) / 2,
    air: mean(air),
    precipProb: Math.max(...idx.map(i => h.precipitation_probability[i] ?? 0)),
    precip: Math.max(...idx.map(i => h.precipitation[i] ?? 0)),
    wind: Math.max(...idx.map(i => h.wind_speed_10m[i])),
    uv: Math.max(...idx.map(i => h.uv_index[i] ?? 0)),
    code, codes,
    dark: idx.some(i => h.is_day[i] === 0)
  };
}
