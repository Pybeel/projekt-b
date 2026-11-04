/**
 * app.js — Klädd front-end
 * --------------------------------------------------------------
 * En lille "single page app" uden frameworks. Adressen efter # bestemmer skærmen:
 *
 *   #/velkommen          01 Velkommen / lokation
 *   #/sog                02 Søg efter by       (#/sog?tilfoej=1 = gem et nyt sted)
 *   #/                   03 Forside (gæst)  /  09 Personlig forside
 *   #/opret              04 Opret profil
 *   #/login              05 Log ind
 *   #/onboarding/1–3     06–08 Onboarding
 *   #/profil             10 Profil og præferencer   (+ #/profil/alder, /kulde, /transport, /navn)
 *   #/steder             11 Gemte steder
 *
 * Hver skærm er en funktion, der returnerer HTML. Klik håndteres ét sted
 * (data-action="..."), så det er nemt at finde, hvad en knap gør.
 */
import * as api from './api.js';
import * as W from './weather.js';
import * as C from './clothing.js';
import { icon, glyph } from './icons.js';

const app = document.getElementById('app');
const nav = document.getElementById('nav');
const shell = document.querySelector('.shell');
const $ = sel => document.querySelector(sel);

const state = {
  user: null,              // hentes fra serveren (GET /api/me)
  place: null,             // det sted, forsiden viser
  weather: null, weatherKey: null, weatherAt: 0, weatherError: null,
  draft: {},               // svar under onboarding / redigering af præferencer
  query: '', results: [], searched: false,
  lastHash: null, navCount: 0, confirmDelete: false
};

/* ============================================================
   Små hjælpere
   ============================================================ */
const esc = s => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const deg = t => { const r = Math.round(t); return (r < 0 ? '−' + -r : r) + '°'; };
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignorér */ } }
};
const DAYS = ['søndag', 'mandag', 'tirsdag', 'onsdag', 'torsdag', 'fredag', 'lørdag'];
const MONTHS = ['januar', 'februar', 'marts', 'april', 'maj', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'december'];
const placeKey = p => (p ? `${(+p.lat).toFixed(3)},${(+p.lon).toFixed(3)}` : '');
const samePlace = (a, b) => a && b && (a.id || b.id ? a.id === b.id : Math.abs(a.lat - b.lat) < 0.01 && Math.abs(a.lon - b.lon) < 0.01);
const displayName = u => u.profile.displayName || cap(u.username.replace(/[\d_.-]+$/, '')) || u.username;

let toastTimer;
function toast(msg, isErr = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('err', isErr);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
}

/* ============================================================
   Router
   ============================================================ */
function parseRoute() {
  const [path, qs] = (location.hash.slice(1) || '/').split('?');
  return { path, params: new URLSearchParams(qs || '') };
}
function go(path) {
  if (location.hash === '#' + path) render();
  else location.hash = path;
}
function goBack() {
  if (state.navCount > 1) history.back();
  else go('/');
}

const STEPS = [
  { key: 'ageGroup', slug: 'alder', title: 'Hvor gammel er du?', sub: 'Så vi ikke foreslår flyverdragt til en voksen.', options: C.AGE_OPTIONS },
  { key: 'coldSensitivity', slug: 'kulde', title: 'Fryser du let?', sub: 'Vi justerer rådene med op til 3 grader.', options: C.COLD_OPTIONS },
  { key: 'transport', slug: 'transport', title: 'Hvordan kommer du rundt?', sub: 'Cyklister får råd om fartvind og regntøj.', options: C.TRANSPORT_OPTIONS }
];

const ROUTES = {
  '/': homeView,
  '/velkommen': welcomeView,
  '/sog': searchView,
  '/opret': registerView,
  '/login': loginView,
  '/onboarding/1': () => choiceView('onboarding', 0),
  '/onboarding/2': () => choiceView('onboarding', 1),
  '/onboarding/3': () => choiceView('onboarding', 2),
  '/profil': profileView,
  '/profil/alder': () => choiceView('edit', 0),
  '/profil/kulde': () => choiceView('edit', 1),
  '/profil/transport': () => choiceView('edit', 2),
  '/profil/navn': nameView,
  '/steder': placesView
};
const TABS = ['/', '/steder', '/profil'];
const NEEDS_LOGIN = ['/onboarding/1', '/onboarding/2', '/onboarding/3', '/profil/alder', '/profil/kulde', '/profil/transport', '/profil/navn'];

// Ting der skal ske, efter en skærm er tegnet
const AFTER = {
  '/sog': changed => {
    if (changed) { state.query = ''; state.results = []; state.searched = false; $('#q').value = ''; updateResults(); }
    $('#q').focus();
    $('#q').addEventListener('input', onSearchInput);
  },
  '/opret': changed => changed && $('#f-username').focus(),
  '/login': changed => changed && $('#f-username').focus(),
  '/profil/navn': changed => changed && $('#f-displayName').focus()
};

function render() {
  const { path, params } = parseRoute();
  const view = ROUTES[path];
  if (!view) return go('/');
  if (NEEDS_LOGIN.includes(path) && !state.user) return go('/login');
  if ((path === '/login' || path === '/opret') && state.user) return go('/');
  if (path === '/' && !state.place) return go('/velkommen');

  const changed = state.lastHash !== location.hash;
  state.lastHash = location.hash;
  if (changed) state.confirmDelete = false;

  app.innerHTML = view(params);

  const tabs = TABS.includes(path);
  nav.hidden = !tabs;
  shell.classList.toggle('has-tabs', tabs);
  if (tabs) nav.innerHTML = navView(path);

  if (changed) { window.scrollTo(0, 0); app.focus({ preventScroll: true }); }
  AFTER[path]?.(changed);
}

window.addEventListener('hashchange', () => { state.navCount++; render(); });

function navView(path) {
  return [['/', 'home', 'Hjem'], ['/steder', 'bookmark', 'Steder'], ['/profil', 'user', 'Profil']]
    .map(([href, ic, text]) => `<a href="#${href}" ${path === href ? 'aria-current="page"' : ''}>${icon(ic)}<span>${text}</span></a>`)
    .join('');
}

/* ============================================================
   Sted og vejr
   ============================================================ */
function setPlace(place) {
  state.place = place;
  store.set('klaedd-place', place);
}

async function loadWeather() {
  const place = state.place;
  const key = placeKey(place);
  state.weatherKey = key;
  state.weather = null;
  state.weatherError = null;
  try {
    const w = await W.fetchWeather(place.lat, place.lon);
    if (placeKey(state.place) !== key) return;     // brugeren har skiftet sted imens
    state.weather = w;
    state.weatherAt = Date.now();
  } catch (e) {
    if (placeKey(state.place) === key) state.weatherError = e.message || 'Vejret kunne ikke hentes.';
  }
  if (parseRoute().path === '/') render();
}

async function useMyLocation({ silent = false, add = false } = {}) {
  if (!silent) toast('Finder din lokation …');
  try {
    const pos = await W.getPosition();
    const info = await W.reverseGeocode(pos.lat, pos.lon);
    const place = { ...info, lat: pos.lat, lon: pos.lon, here: true };
    store.set('klaedd-geo', true);
    $('#toast').hidden = true;
    if (add) return pickPlace(place, true);
    setPlace(place);
    if (silent) { if (parseRoute().path === '/') render(); }
    else go('/');
  } catch (e) {
    if (!silent) toast(e.message, true);
  }
}

async function pickPlace(place, add) {
  if (!add) { setPlace(place); return go('/'); }
  const label = $('#placeLabel')?.value.trim() || place.name;
  try {
    const data = await api.addLocation({ ...place, label });
    state.user = data.user;
    setPlace(data.location);
    toast(`${label} er gemt`);
    goBack();
  } catch (e) {
    toast(e.message, true);
  }
}

/* ============================================================
   01 · Velkommen / lokation
   ============================================================ */
function welcomeView() {
  const art = (name, x, y, s) => `<g transform="translate(${x} ${y}) scale(${s})" stroke-width="${(1.8 / s).toFixed(2)}">${glyph(name)}</g>`;
  return `
    <div class="hero-art" aria-hidden="true">
      <svg viewBox="0 0 200 150" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
        ${art('sun', 22, 14, 2.2)}${art('cloud', 64, 18, 3.4)}${art('raincoat', 34, 76, 2.6)}${art('umbrella', 104, 82, 2.4)}${art('boots', 152, 98, 1.8)}
      </svg>
    </div>
    <div>
      <h1 class="title-xl">Hvad skal du have på i dag?</h1>
      <p class="lead" style="margin-top:10px">Vi bruger din lokation til at give tøjråd, der passer til vejret lige der, hvor du er.</p>
    </div>
    <p class="note">${icon('info')}<span>Lokationen bruges kun til vejrudsigten og gemmes ikke uden en profil.</span></p>
    <div class="actions">
      <button class="btn primary" data-action="geo">Brug min lokation</button>
      <a class="btn" href="#/sog">Søg efter by i stedet</a>
      ${state.user ? '' : '<a class="link" href="#/login">Har du en profil? Log ind</a>'}
    </div>`;
}

/* ============================================================
   02 · Søg efter by
   ============================================================ */
function searchView(params) {
  const add = params.has('tilfoej');
  return `
    <div class="searchbar">
      <button class="iconbtn" data-action="back" aria-label="Tilbage">${icon('back')}</button>
      <label class="searchfield">
        ${icon('search', 'ic ic-sm')}
        <input id="q" type="search" placeholder="Søg efter by" autocomplete="off" aria-label="Søg efter by" value="${esc(state.query)}">
        <button type="button" class="iconbtn" data-action="clear-search" aria-label="Ryd søgning">${icon('close', 'ic ic-sm')}</button>
      </label>
    </div>
    ${add ? `
      <div>
        <h1 class="title">Tilføj sted</h1>
        <label class="field" style="margin-top:12px">Hvad skal stedet hedde?
          <input id="placeLabel" maxlength="30" placeholder="fx Hjem, Campus eller Job" autocomplete="off">
          <span class="hint">Vælg derefter byen nedenfor.</span>
        </label>
      </div>` : ''}
    <ul class="list" id="results" aria-live="polite">${resultsHtml()}</ul>
    ${add ? '' : savedSection()}`;
}

function resultsHtml() {
  const rows = [`<li><button class="row" data-action="geo">${icon('pin')}<span class="grow"><b>Brug min lokation</b><small>Kræver tilladelse</small></span></button></li>`];
  state.results.forEach((r, i) => {
    rows.push(`<li><button class="row" data-action="pick" data-i="${i}">${icon('search')}<span class="grow"><b>${esc(r.name)}</b><small>${esc([r.region, r.country].filter(Boolean).join(', '))}</small></span></button></li>`);
  });
  if (state.searched && !state.results.length) {
    rows.push(`<li class="row small">Ingen steder fundet for »${esc(state.query.trim())}«</li>`);
  }
  return rows.join('');
}

function savedSection() {
  let body;
  if (!state.user) {
    body = `<div class="empty"><span>Log ind for at gemme Hjem, Campus og Job</span><a class="link" href="#/login">Log ind</a></div>`;
  } else if (!state.user.locations.length) {
    body = `<div class="empty"><span>Du har ingen gemte steder endnu</span><a class="link" href="#/sog?tilfoej=1">Tilføj sted</a></div>`;
  } else {
    body = `<ul class="list">${state.user.locations.map(l => `
      <li><button class="row" data-action="place" data-id="${l.id}">${icon('bookmark')}<span class="grow"><b>${esc(l.label)}</b><small>${esc(l.name)}</small></span></button></li>`).join('')}</ul>`;
  }
  return `<section><h2 class="overline" style="margin-bottom:10px">Gemte steder</h2>${body}</section>`;
}

let searchTimer, searchSeq = 0;
function onSearchInput(e) {
  state.query = e.target.value;
  clearTimeout(searchTimer);
  const q = state.query.trim();
  if (q.length < 2) { state.results = []; state.searched = false; return updateResults(); }
  // US2: forslag vises, mens man skriver (venter 250 ms efter sidste tast)
  searchTimer = setTimeout(async () => {
    const seq = ++searchSeq;
    const results = await W.searchPlaces(q).catch(() => []);
    if (seq !== searchSeq) return;
    state.results = results;
    state.searched = true;
    updateResults();
  }, 250);
}
function updateResults() {
  const ul = $('#results');
  if (ul) ul.innerHTML = resultsHtml();
}

/* ============================================================
   03 / 09 · Forside
   ============================================================ */
function homeView() {
  const key = placeKey(state.place);
  const stale = Date.now() - state.weatherAt > 30 * 60 * 1000;
  if (state.weatherKey !== key || (state.weather && stale)) { loadWeather(); return homeSkeleton(); }
  if (state.weatherError) return homeError();
  if (!state.weather) return homeSkeleton();

  const w = state.weather;
  const prof = state.user?.profile || null;
  const idx = W.adviceWindow(w);
  const cond = W.conditions(w, idx);
  const advice = C.advise(cond, prof);
  const change = laterChange(w, idx, advice, prof);

  return `
    ${state.user ? personalHead() : guestHead(w)}
    ${adviceCard(advice, cond, prof, w)}
    ${change ? `<p class="banner">${icon(change.icon)}<span>${esc(change.text)}</span></p>` : ''}
    ${hoursSection(w)}
    ${state.user ? '' : `
      <section class="empty" style="text-align:left;gap:8px">
        <b>Få råd, der passer til dig</b>
        <p class="small">Fryser du let? Cykler du? Opret en profil på et minut.</p>
        <a class="btn" href="#/opret" style="margin-top:6px">Opret profil</a>
      </section>`}
    ${daysSection(w, prof)}
    ${tilesSection(w, cond)}`;
}

function guestHead(w) {
  const p = state.place;
  return `
    <header class="homehead">
      <a class="placebtn" href="#/sog" aria-label="Skift sted, nu ${esc(p.label || p.name)}">${icon('pin', 'ic ic-sm')}${esc(p.label || p.name)}${icon('chevron', 'ic ic-sm')}</a>
      <span class="small">Nu · ${deg(w.current.temperature_2m)}</span>
    </header>`;
}

function personalHead() {
  const now = new Date();
  const h = now.getHours();
  const greet = h < 10 ? 'Godmorgen' : h < 12 ? 'God formiddag' : h < 18 ? 'God eftermiddag' : 'Godaften';
  const date = `${cap(DAYS[now.getDay()])} ${now.getDate()}. ${MONTHS[now.getMonth()]}`;
  const locs = state.user.locations;
  const p = state.place;
  const unsaved = !locs.some(l => samePlace(l, p));
  const chips = [
    unsaved ? `<span class="chip on" aria-current="true">${icon('pin', 'ic ic-sm')}${esc(p.name)}</span>` : '',
    ...locs.map(l => `<button class="chip" data-action="place" data-id="${l.id}" aria-pressed="${samePlace(l, p)}">${esc(l.label)}</button>`),
    `<a class="chip" href="#/sog?tilfoej=1">+ Tilføj</a>`
  ].join('');
  return `
    <header class="homehead">
      <div>
        <p class="small">${date}</p>
        <h1 class="title">${greet}, ${esc(displayName(state.user))}</h1>
      </div>
      <a class="iconbtn" href="#/sog" aria-label="Søg efter by">${icon('search')}</a>
    </header>
    <div class="chips" role="group" aria-label="Dine steder">${chips}</div>`;
}

function adviceCard(a, cond, prof, w) {
  const evening = W.hourOf(w, W.nowIndex(w)) >= 18;
  let overline;
  if (!prof) overline = evening ? 'Dit tøjråd i aften' : 'Dit tøjråd i dag';
  else {
    overline = ['Tilpasset dig',
      prof.ageGroup === 'under12' ? 'Børneprofil' : '',
      prof.coldSensitivity !== 'normal' ? C.label(C.COLD_OPTIONS, prof.coldSensitivity) : '',
      prof.transport ? C.label(C.TRANSPORT_OPTIONS, prof.transport) : ''
    ].filter(Boolean).join(' · ');
  }

  const wind = Math.round(cond.wind);
  let why;
  if (!prof) why = `Føles som ${deg(a.t)}` + (wind >= 5 ? ` pga. vind på ${wind} m/s` : '');
  else {
    const parts = [`${deg(cond.air)} luft`];
    if (wind >= 5) parts.push(`vind ${wind} m/s`);
    why = `Føles som ${deg(a.t)} ${prof.transport === 'cykel' ? 'på cyklen' : 'for dig'} (${parts.join(', ')})`;
  }

  const outfit = a.outfit.map(o => o.missing
    ? `<li class="missing"><span class="slot">${o.slotLabel}</span>Du mangler ${esc(o.missing)} – tilføj under Profil</li>`
    : `<li><span class="slot">${o.slotLabel}</span>${icon(o.item.icon, 'ic ic-sm')}${esc(o.item.label)}${o.approx ? ' <span class="small">(nærmeste i din garderobe)</span>' : ''}</li>`);
  if (a.extras.length) outfit.push(`<li><span class="slot">Husk</span>${esc(a.extras.map(e => e.label).join(', '))}</li>`);

  return `
    <section class="card advice" aria-labelledby="advice-title">
      <p class="overline">${esc(overline)}</p>
      <h2 id="advice-title">${esc(C.headline(a))}</h2>
      <p class="why">${icon('info')}<span>${esc(why)}</span></p>
      <ul class="pieces">${a.key.map(i => `<li class="piece"><span class="art">${icon(i.icon, 'ic ic-lg')}</span>${esc(i.label)}</li>`).join('')}</ul>
      <details class="outfit"><summary>Se hele påklædningen</summary><ul>${outfit.join('')}</ul></details>
    </section>`;
}

// D3: varsel om skift senere på dagen ("Regn fra kl. 16 – tag jakken med hjem")
function laterChange(w, idx, a, prof) {
  const h = w.hourly;
  const ni = idx[0];
  const later = idx.slice(1);
  const at = i => `kl. ${W.hourOf(w, i)}`;
  const wet = i => W.RAIN_CODES.has(h.weather_code[i]) || W.SNOW_CODES.has(h.weather_code[i]) || (h.precipitation_probability[i] ?? 0) >= 60;

  if (!wet(ni)) {
    const i = later.find(wet);
    if (i != null) {
      const snow = W.SNOW_CODES.has(h.weather_code[i]);
      const owned = new Set(C.ownedIds(prof || {}));
      let tail = 'tag jakken med hjem';
      if (prof?.transport === 'cykel') tail = owned.has('regnbukser') ? 'pak regnbukserne i tasken' : 'tag regntøj med';
      else if (!a.ctx.kid && owned.has('paraply')) tail = 'tag paraplyen med';
      return { icon: snow ? 'snow' : 'rain', text: `${snow ? 'Sne' : 'Regn'} fra ${at(i)} – ${tail}` };
    }
  } else {
    const i = later.find(x => !wet(x));
    if (i != null) return { icon: 'partly', text: `Tørvejr fra ${at(i)}` };
  }
  const t0 = h.temperature_2m[ni];
  const colder = later.find(x => t0 - h.temperature_2m[x] >= 5);
  if (colder != null) return { icon: 'wind', text: `Koldere fra ${at(colder)} (${deg(h.temperature_2m[colder])}) – tag et ekstra lag med` };
  return null;
}

function hoursSection(w) {
  const h = w.hourly;
  const ni = W.nowIndex(w);
  const hr = W.hourOf(w, ni);
  const today = w.current.time.slice(0, 10);
  let title, slots;
  if (hr < 16) {
    title = 'I dag';
    slots = [8, 10, 12, 14, 16, 18].map(x => h.time.indexOf(`${today}T${String(x).padStart(2, '0')}:00`)).filter(i => i >= 0);
  } else {
    title = 'De næste timer';
    slots = [0, 2, 4, 6, 8, 10].map(k => ni + k).filter(i => i < h.time.length);
  }
  const items = slots.map(i => {
    const pp = h.precipitation_probability[i] ?? 0;
    const past = i + 1 < ni;
    const now = i <= ni && ni < i + 2;
    const desc = W.describe(h.weather_code[i]);
    return `
      <li class="hour${past ? ' past' : ''}${now ? ' now' : ''}">
        <span class="time">${W.hourOf(w, i)}</span>
        ${icon(W.weatherIcon(h.weather_code[i], h.is_day[i] === 1), 'ic', esc(desc))}
        <span class="temp">${deg(h.temperature_2m[i])}</span>
        <span class="rainbar" title="${pp} % risiko for nedbør"><span style="height:${pp}%"></span></span>
        <span class="pp">${pp >= 20 ? pp + ' %' : ''}</span>
      </li>`;
  }).join('');
  return `<section aria-label="${title}"><h2 class="overline" style="margin-bottom:12px">${title}</h2><ol class="hours" style="list-style:none;margin:0;padding:0">${items}</ol></section>`;
}

function daysSection(w, prof) {
  const d = w.daily;
  const rows = d.time.slice(1).map((date, k) => {
    const i = k + 1;
    const idx = W.dayWindow(w, date);
    const top = idx.length ? C.advise(W.conditions(w, idx), prof).key[0] : null;
    const name = i === 1 ? 'I morgen' : cap(DAYS[new Date(date + 'T12:00').getDay()]);
    return `
      <li class="day">
        <span class="name">${name}</span>
        ${icon(W.weatherIcon(d.weather_code[i]), 'ic', esc(W.describe(d.weather_code[i])))}
        <span class="wear">${top ? icon(top.icon, 'ic ic-sm') + `<span>${esc(top.label)}</span>` : ''}</span>
        <span class="range"><span class="lo">${deg(d.temperature_2m_min[i])}</span> / ${deg(d.temperature_2m_max[i])}</span>
      </li>`;
  }).join('');
  return `<section><h2 class="overline" style="margin-bottom:4px">Næste dage</h2><ul class="days">${rows}</ul></section>`;
}

function tilesSection(w, cond) {
  return `
    <dl class="tiles" style="margin:0">
      <div class="tile"><dt>Luft</dt><dd>${deg(w.current.temperature_2m)}</dd></div>
      <div class="tile"><dt>Vind</dt><dd>${Math.round(w.current.wind_speed_10m)} m/s</dd></div>
      <div class="tile"><dt>Nedbør</dt><dd>${Math.round(cond.precipProb)} %</dd></div>
    </dl>`;
}

function homeSkeleton() {
  return `
    <div class="skeleton" style="height:44px"></div>
    <div class="skeleton" style="height:260px"></div>
    <div class="skeleton" style="height:120px"></div>
    <p class="small" role="status">Henter vejret …</p>`;
}

function homeError() {
  return `
    <div class="empty" role="alert" style="margin-top:40px">
      <b>Vejret kunne ikke hentes</b>
      <span class="small">${esc(state.weatherError)}</span>
      <button class="btn primary" data-action="retry" style="margin-top:10px">Prøv igen</button>
      <a class="link" href="#/sog">Søg efter en anden by</a>
    </div>`;
}

/* ============================================================
   04 · Opret profil   /   05 · Log ind
   ============================================================ */
function field({ name, label, type = 'text', placeholder = '', autocomplete = 'off', hint = '' }) {
  const describedBy = `err-${name}` + (hint ? ` hint-${name}` : '');
  return `
    <label class="field">${label}
      <input id="f-${name}" name="${name}" type="${type}" placeholder="${placeholder}" autocomplete="${autocomplete}"
             autocapitalize="off" spellcheck="false" aria-describedby="${describedBy}">
      ${hint ? `<span class="hint" id="hint-${name}">${hint}</span>` : ''}
      <span class="err" id="err-${name}" hidden></span>
    </label>`;
}

// UX: fejlen står ved feltet — ikke i en pop-up
function setErrors(form, errors) {
  form.querySelectorAll('.err').forEach(el => { el.hidden = true; el.textContent = ''; });
  form.querySelectorAll('input').forEach(el => el.removeAttribute('aria-invalid'));
  let first = null;
  for (const [name, msg] of Object.entries(errors)) {
    const err = form.querySelector('#err-' + name);
    const input = form.querySelector(`[name="${name}"]`);
    if (err) { err.textContent = msg; err.hidden = false; }
    if (input) { input.setAttribute('aria-invalid', 'true'); first ??= input; }
  }
  first?.focus();
}

function registerView() {
  return `
    <div class="topbar"><button class="iconbtn" data-action="back" aria-label="Tilbage">${icon('back')}</button></div>
    <div>
      <h1 class="title-xl">Opret profil</h1>
      <p class="lead" style="margin-top:8px">Så husker vi dine steder og giver råd, der passer til dig.</p>
    </div>
    <form class="form" data-form="register" novalidate>
      ${field({ name: 'username', label: 'Brugernavn', placeholder: 'fx emma22', autocomplete: 'username' })}
      ${field({ name: 'password', label: 'Adgangskode', type: 'password', autocomplete: 'new-password', hint: 'Mindst 8 tegn' })}
      ${field({ name: 'password2', label: 'Gentag adgangskode', type: 'password', autocomplete: 'new-password' })}
      <div class="actions">
        <button class="btn primary" type="submit">Opret profil</button>
        <a class="link" href="#/login">Har du en profil? Log ind</a>
      </div>
    </form>`;
}

function loginView() {
  return `
    <div class="topbar"><button class="iconbtn" data-action="back" aria-label="Tilbage">${icon('back')}</button></div>
    <div>
      <h1 class="title-xl">Velkommen tilbage</h1>
      <p class="lead" style="margin-top:8px">Log ind for at få dine egne råd og steder.</p>
    </div>
    <form class="form" data-form="login" novalidate>
      ${field({ name: 'username', label: 'Brugernavn', placeholder: 'emma22', autocomplete: 'username' })}
      ${field({ name: 'password', label: 'Adgangskode', type: 'password', autocomplete: 'current-password' })}
      <div class="actions">
        <button class="btn primary" type="submit">Log ind</button>
        <a class="link" href="#/opret">Ny bruger? Opret profil</a>
      </div>
    </form>`;
}

function onLoggedIn(data, isNew) {
  api.setToken(data.token);
  state.user = data.user;
  state.draft = {};
  // D7: det første gemte sted vises først på forsiden
  if (data.user.locations.length) setPlace(data.user.locations[0]);
  // D5: efter oprettelse kommer onboarding med 3 spørgsmål
  if (isNew || !data.user.profile.onboarded) go('/onboarding/1');
  else { toast(`Velkommen tilbage, ${displayName(data.user)}`); go('/'); }
}

/* ============================================================
   06–08 · Onboarding  (genbruges til at ændre præferencer fra profilen)
   ============================================================ */
function choiceView(mode, n) {
  const s = STEPS[n];
  const onboarding = mode === 'onboarding';
  const current = state.draft[s.key] ?? state.user.profile[s.key];
  return `
    <div class="topbar">
      <button class="iconbtn" data-action="${onboarding ? 'ob-back' : 'back'}" data-n="${n}" aria-label="Tilbage">${icon('back')}</button>
      ${onboarding ? `<span class="small">Trin ${n + 1} af 3</span>` : ''}
    </div>
    ${onboarding ? `<div class="progress" aria-hidden="true">${[0, 1, 2].map(i => `<span class="${i <= n ? 'on' : ''}"></span>`).join('')}</div>` : ''}
    <div>
      <h1 class="title">${s.title}</h1>
      <p class="lead" style="margin-top:6px">${s.sub}</p>
    </div>
    <fieldset class="choices">
      <legend class="sr-only">${s.title}</legend>
      ${s.options.map(o => `
        <label class="choice">
          <input type="radio" name="choice" value="${o.value}" data-key="${s.key}" ${o.value === current ? 'checked' : ''}>
          <span><b>${o.label}</b>${o.hint ? `<small>${o.hint}</small>` : ''}</span>
        </label>`).join('')}
    </fieldset>
    <div class="actions">
      ${onboarding
        ? `<button class="btn primary" data-action="ob-next" data-n="${n}">${n === 2 ? 'Færdig' : 'Næste'}</button>
           <button class="link" data-action="ob-skip" data-n="${n}">Spring over</button>`
        : `<button class="btn primary" data-action="pref-save" data-key="${s.key}">Gem</button>`}
    </div>`;
}

async function finishOnboarding() {
  try {
    const { user } = await api.saveProfile({ ...state.draft, onboarded: true });
    state.user = user;
    state.draft = {};
    toast('Dine råd er nu tilpasset dig');
    go(state.place ? '/' : '/velkommen');
  } catch (e) {
    toast(e.message, true);
  }
}

/* ============================================================
   10 · Profil og præferencer
   ============================================================ */
function profileView() {
  if (!state.user) {
    return `
      <h1 class="title-xl">Profil</h1>
      <p class="lead">Opret en profil for at få råd efter din alder, hvor let du fryser, og hvordan du kommer rundt.</p>
      <div class="actions" style="margin-top:8px">
        <a class="btn primary" href="#/opret">Opret profil</a>
        <a class="btn" href="#/login">Log ind</a>
      </div>`;
  }
  const u = state.user, p = u.profile;
  const name = displayName(u);
  const owned = new Set(C.ownedIds(p));
  const row = (href, title, value) =>
    `<li><a class="row" href="#${href}"><span class="grow">${title}</span><span class="val">${esc(value)}</span>${icon('chevron', 'ic ic-sm')}</a></li>`;
  const n = u.locations.length;

  return `
    <header class="who">
      <span class="avatar" aria-hidden="true">${esc(name.charAt(0).toUpperCase())}</span>
      <div><h1>${esc(name)}</h1><p class="small">${esc(u.username)}</p></div>
    </header>
    <section>
      <h2 class="overline">Mine præferencer</h2>
      <ul class="list">
        ${row('/profil/navn', 'Navn', p.displayName || 'Tilføj')}
        ${row('/profil/alder', 'Aldersgruppe', C.label(C.AGE_OPTIONS, p.ageGroup))}
        ${row('/profil/kulde', 'Kuldefølsomhed', C.label(C.COLD_OPTIONS, p.coldSensitivity))}
        ${row('/profil/transport', 'Transport', C.label(C.TRANSPORT_OPTIONS, p.transport))}
        ${row('/steder', 'Gemte steder', n === 1 ? '1 sted' : `${n} steder`)}
      </ul>
    </section>
    <section>
      <h2 class="overline" style="margin-bottom:12px">Tøj jeg har</h2>
      <div class="wardrobe" role="group" aria-label="Tøj jeg har">
        ${C.ITEMS.map(i => `<button class="chip" data-action="toggle-item" data-id="${i.id}" aria-pressed="${owned.has(i.id)}">${esc(i.label)}</button>`).join('')}
      </div>
      <p class="small" style="margin-top:12px">Tøj, du ikke har valgt, bliver ikke foreslået.
        ${Array.isArray(p.wardrobe) ? '<button class="link" data-action="reset-wardrobe" style="display:inline;padding:0 4px;min-height:0;font-size:13px">Brug standard for min alder</button>' : ''}</p>
    </section>
    <div class="actions">
      <button class="btn" data-action="logout">Log ud</button>
      <button class="link link-danger" data-action="delete-me">${state.confirmDelete ? 'Tryk igen for at slette profil og data' : 'Slet profil'}</button>
    </div>`;
}

function nameView() {
  return `
    <div class="topbar"><button class="iconbtn" data-action="back" aria-label="Tilbage">${icon('back')}</button></div>
    <h1 class="title">Hvad skal vi kalde dig?</h1>
    <form class="form" data-form="name" novalidate>
      ${field({ name: 'displayName', label: 'Navn', placeholder: 'fx Emma', autocomplete: 'given-name' })}
      <div class="actions"><button class="btn primary" type="submit">Gem</button></div>
    </form>`;
}

/* ============================================================
   11 · Gemte steder
   ============================================================ */
function placesView() {
  if (!state.user) {
    return `
      <h1 class="title-xl">Gemte steder</h1>
      <div class="empty">
        <span>Log ind for at gemme Hjem, Campus og Job</span>
        <a class="link" href="#/login">Log ind</a>
        <a class="link" href="#/opret" style="font-weight:500">Ny bruger? Opret profil</a>
      </div>`;
  }
  const locs = state.user.locations;
  const list = locs.length
    ? `<ul class="places" id="places">${locs.map(l => `
        <li class="place" data-id="${l.id}">
          <button class="iconbtn grip" data-drag aria-label="Flyt ${esc(l.label)} – brug pil op og ned">${icon('grip')}</button>
          <button class="go" data-action="place" data-id="${l.id}"><b>${esc(l.label)}</b><small>${esc([l.name, l.region].filter(Boolean).join(', '))}</small></button>
          <button class="iconbtn" data-action="loc-del" data-id="${l.id}" aria-label="Fjern ${esc(l.label)}">${icon('close')}</button>
        </li>`).join('')}</ul>`
    : `<div class="empty"><b>Ingen gemte steder endnu</b><span class="small">Gem fx Hjem, Campus og Job, så skifter du mellem dem med ét tryk på forsiden.</span></div>`;
  return `
    <div>
      <h1 class="title-xl">Gemte steder</h1>
      <p class="lead" style="margin-top:8px">Træk for at ændre rækkefølgen. Det første sted vises først på forsiden.</p>
    </div>
    ${list}
    <a class="btn" href="#/sog?tilfoej=1">${icon('plus', 'ic ic-sm')}Tilføj sted</a>`;
}

async function saveOrder(list) {
  const ids = [...list.children].map(li => li.dataset.id);
  if (ids.join() === state.user.locations.map(l => l.id).join()) return;
  try { state.user = (await api.reorderLocations(ids)).user; }
  catch (e) { toast(e.message, true); render(); }
}

// Træk-og-slip med mus og finger (pointer events virker også på mobil)
document.addEventListener('pointerdown', e => {
  const handle = e.target.closest('[data-drag]');
  if (!handle) return;
  e.preventDefault();
  const li = handle.closest('li');
  const list = li.parentElement;
  li.classList.add('dragging');
  handle.setPointerCapture(e.pointerId);
  const move = ev => {
    const others = [...list.children].filter(x => x !== li);
    const after = others.find(s => { const r = s.getBoundingClientRect(); return ev.clientY < r.top + r.height / 2; });
    if ((after || null) !== li.nextElementSibling) list.insertBefore(li, after || null);
  };
  const end = () => {
    handle.removeEventListener('pointermove', move);
    handle.removeEventListener('pointerup', end);
    handle.removeEventListener('pointercancel', end);
    li.classList.remove('dragging');
    saveOrder(list);
  };
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
});

// …og med tastaturet: pil op / ned på håndtaget
document.addEventListener('keydown', e => {
  const handle = e.target.closest?.('[data-drag]');
  if (!handle || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
  e.preventDefault();
  const li = handle.closest('li');
  const list = li.parentElement;
  if (e.key === 'ArrowUp' && li.previousElementSibling) list.insertBefore(li, li.previousElementSibling);
  if (e.key === 'ArrowDown' && li.nextElementSibling) list.insertBefore(li.nextElementSibling, li);
  handle.focus();
  saveOrder(list);
});

/* ============================================================
   Klik — alle knapper med data-action
   ============================================================ */
document.addEventListener('click', async e => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  const n = Number(el.dataset.n);
  const adding = parseRoute().params.has('tilfoej');

  switch (action) {
    case 'back': return goBack();
    case 'geo': return useMyLocation({ add: adding });
    case 'pick': return pickPlace(state.results[Number(el.dataset.i)], adding);
    case 'retry': state.weatherKey = null; return render();

    case 'clear-search':
      state.query = ''; state.results = []; state.searched = false;
      $('#q').value = ''; $('#q').focus();
      return updateResults();

    case 'place': {
      const loc = state.user?.locations.find(l => l.id === el.dataset.id);
      if (loc) { setPlace(loc); go('/'); }
      return;
    }

    case 'loc-del': {
      try {
        const removed = state.user.locations.find(l => l.id === el.dataset.id);
        state.user = (await api.deleteLocation(el.dataset.id)).user;
        if (samePlace(removed, state.place)) setPlace({ ...state.place, id: undefined });
        toast(`${removed.label} er fjernet`);
        render();
      } catch (err) { toast(err.message, true); }
      return;
    }

    case 'ob-back': return go(n === 0 ? '/' : `/onboarding/${n}`);
    case 'ob-skip': delete state.draft[STEPS[n].key];   // falder igennem til "næste"
    // eslint-disable-next-line no-fallthrough
    case 'ob-next': return n < 2 ? go(`/onboarding/${n + 2}`) : finishOnboarding();

    case 'pref-save': {
      const key = el.dataset.key;
      try {
        state.user = (await api.saveProfile({ [key]: state.draft[key] ?? state.user.profile[key] })).user;
        state.draft = {};
        toast('Gemt');
        go('/profil');
      } catch (err) { toast(err.message, true); }
      return;
    }

    case 'toggle-item': {
      const id = el.dataset.id;
      const owned = new Set(C.ownedIds(state.user.profile));
      owned.has(id) ? owned.delete(id) : owned.add(id);
      el.setAttribute('aria-pressed', owned.has(id));
      try { state.user = (await api.saveProfile({ wardrobe: [...owned] })).user; }
      catch (err) { toast(err.message, true); }
      render();
      $(`[data-action="toggle-item"][data-id="${id}"]`)?.focus();
      return;
    }

    case 'reset-wardrobe':
      try { state.user = (await api.saveProfile({ wardrobe: null })).user; render(); }
      catch (err) { toast(err.message, true); }
      return;

    case 'logout':
      try { await api.logout(); } catch { /* sessionen er måske allerede udløbet */ }
      api.setToken(null);
      state.user = null;
      toast('Du er logget ud');
      return go('/');

    case 'delete-me':
      if (!state.confirmDelete) { state.confirmDelete = true; return render(); }
      try {
        await api.deleteMe();
        api.setToken(null);
        state.user = null;
        toast('Din profil og alle dine data er slettet');
        go('/');
      } catch (err) { toast(err.message, true); }
      return;
  }
});

// Valg i onboarding / præferencer gemmes i en kladde, indtil man trykker Næste / Gem
document.addEventListener('change', e => {
  if (e.target.name === 'choice') state.draft[e.target.dataset.key] = e.target.value;
});

/* ============================================================
   Formularer
   ============================================================ */
document.addEventListener('submit', async e => {
  const form = e.target.closest('[data-form]');
  if (!form) return;
  e.preventDefault();
  const type = form.dataset.form;
  const f = Object.fromEntries(new FormData(form));
  const btn = form.querySelector('[type="submit"]');

  if (type === 'login') {
    const errors = {};
    if (!f.username.trim()) errors.username = 'Skriv dit brugernavn';
    if (!f.password) errors.password = 'Skriv din adgangskode';
    if (Object.keys(errors).length) return setErrors(form, errors);
    btn.disabled = true;
    try { onLoggedIn(await api.login(f.username.trim(), f.password), false); }
    catch (err) { setErrors(form, { [err.field || 'password']: err.message }); }
    finally { btn.disabled = false; }
  }

  if (type === 'register') {
    const errors = {};
    if (!/^[a-zA-Z0-9_.-]{3,24}$/.test(f.username.trim())) errors.username = 'Brug 3–24 tegn: bogstaver, tal og . _ -';
    if (f.password.length < 8) errors.password = 'Adgangskoden skal være mindst 8 tegn';
    else if (f.password !== f.password2) errors.password2 = 'De to adgangskoder er ikke ens';
    if (Object.keys(errors).length) return setErrors(form, errors);
    btn.disabled = true;
    try { onLoggedIn(await api.register(f.username.trim(), f.password), true); }
    catch (err) { setErrors(form, { [err.field || 'username']: err.message }); }
    finally { btn.disabled = false; }
  }

  if (type === 'name') {
    try {
      state.user = (await api.saveProfile({ displayName: f.displayName })).user;
      toast('Gemt');
      go('/profil');
    } catch (err) { setErrors(form, { displayName: err.message }); }
  }
});

/* ============================================================
   Opstart
   ============================================================ */
(async function init() {
  // US5: profilen hentes fra serveren, hvis browseren husker et login
  if (api.getToken()) {
    try { state.user = (await api.me()).user; }
    catch (e) { if (e.status === 401) api.setToken(null); }
  }

  if (state.user?.locations.length) setPlace(state.user.locations[0]);
  else state.place = store.get('klaedd-place');

  if (state.place && !location.hash) location.replace('#/');
  render();

  // Har brugeren før valgt "Brug min lokation" og givet lov, findes positionen automatisk
  if (!state.user?.locations.length && store.get('klaedd-geo') && navigator.permissions) {
    try {
      const status = await navigator.permissions.query({ name: 'geolocation' });
      if (status.state === 'granted') useMyLocation({ silent: true });
    } catch { /* ikke understøttet */ }
  }
})();
