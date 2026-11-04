/**
 * clothing.js — tøjmotoren
 * --------------------------------------------------------------
 *  1. Den FØLTE temperatur justeres efter brugeren:
 *       kuldefølsomhed: fryser let −3°, normal 0°, varmblodig +3°   (US8)
 *       transport:      cykel −2° (fartvind), bil +2° (kort tid udenfor)
 *  2. Kroppen gennemgås plads for plads (hoved, hals, yderlag …). For hver plads
 *     vælges det første stykke tøj, der passer til vejret OG som brugeren har.
 *  3. Har brugeren fravalgt det, der passer bedst, bruges nærmeste alternativ (US11).
 *  4. Standardgarderoben afhænger af alder: flyverdragt, luffer, termo- og
 *     gummistøvler er kun med for børn. Voksne får dem kun, hvis de selv
 *     vælger dem under "Tøj jeg har" (US7).
 */
import { RAIN_CODES, SNOW_CODES } from './weather.js';

const KID = 'under12';

/* ---------- Valgmuligheder (bruges af onboarding 06–08 og profilen 10) ---------- */
export const AGE_OPTIONS = [
  { value: 'under12', label: 'Under 12 år', hint: 'Børneprofil – fx flyverdragt og luffer' },
  { value: '12-17', label: '12–17 år' },
  { value: '18-29', label: '18–29 år' },
  { value: '30-49', label: '30–49 år' },
  { value: '50+', label: '50 år eller ældre' }
];
export const COLD_OPTIONS = [
  { value: 'fryser', label: 'Jeg fryser let', hint: 'Vi lægger et lag ekstra på', short: 'Fryser let' },
  { value: 'normal', label: 'Normal', hint: 'Standardrådene passer til mig', short: 'Normal' },
  { value: 'varm', label: 'Jeg er varmblodig', hint: 'Vi foreslår lidt mindre tøj', short: 'Varmblodig' }
];
export const TRANSPORT_OPTIONS = [
  { value: 'cykel', label: 'Cykel', hint: 'Fartvind trækker 2° fra' },
  { value: 'gaar', label: 'Går', hint: 'Paraply i stedet for regnbukser' },
  { value: 'offentlig', label: 'Offentlig transport', hint: 'Paraply og vandtætte sko ved regn' },
  { value: 'bil', label: 'Bil', hint: 'Kort tid udenfor – lidt mindre tøj' }
];
export const label = (options, value, fallback = 'Ikke valgt') =>
  (options.find(o => o.value === value) || {}).short || (options.find(o => o.value === value) || {}).label || fallback;

/* ---------- Tøjpaletten ----------
   slot   = pladsen på kroppen
   who    = 'kids' / 'adults' -> kun i den gruppes STANDARDgarderobe (alle kan selv slå det til)
   optIn  = aldrig i standardgarderoben, kun hvis brugeren vælger det
   range  = temperaturinterval (bruges til at finde nærmeste alternativ)
   test   = hvornår tøjet passer til vejret (c = forholdene, se advise())                */
export const SLOTS = {
  hoved: 'Hoved', hals: 'Hals', ydre: 'Yderlag', mellem: 'Mellemlag', inderst: 'Inderst',
  overdel: 'Overdel', haender: 'Hænder', ben: 'Ben', foedder: 'Fødder', ekstra: 'Husk'
};

export const ITEMS = [
  // Yderlag (rækkefølgen = prioritet)
  { id: 'flyverdragt', slot: 'ydre', label: 'Flyverdragt', icon: 'snowsuit', who: 'kids', covers: ['ben'], range: [-30, 5], test: c => c.t <= 5 },
  { id: 'regnjakke', slot: 'ydre', label: 'Regnjakke', icon: 'raincoat', range: [0, 20], test: c => c.rain && c.t > 0 },
  { id: 'vinterjakke', slot: 'ydre', label: 'Vinterjakke', icon: 'parka', range: [-30, 5], test: c => c.t <= 5 },
  { id: 'overgangsjakke', slot: 'ydre', label: 'Overgangsjakke', icon: 'jacket', range: [5, 13], test: c => c.t > 5 && c.t <= 13 },
  { id: 'let-jakke', slot: 'ydre', label: 'Let jakke', icon: 'jacket', range: [13, 20], test: c => c.t > 13 },

  // Mellemlag
  { id: 'uldtroeje', slot: 'mellem', label: 'Uldtrøje', icon: 'sweater', range: [-30, 8], test: c => c.t <= 8 },
  { id: 'haettetroeje', slot: 'mellem', label: 'Hættetrøje', icon: 'hoodie', range: [8, 16], test: c => c.t > 8 },

  // Inderst
  { id: 'uldundertoej', slot: 'inderst', label: 'Uldundertøj', icon: 'longsleeve', range: [-30, -3], test: c => c.t <= -3 },

  // Overdel
  { id: 'top', slot: 'overdel', label: 'Top', icon: 'top', range: [24, 45], test: c => c.t >= 24 },
  { id: 'kjole', slot: 'overdel', label: 'Kjole', icon: 'dress', optIn: true, covers: ['ben'], range: [18, 45], test: c => c.t >= 18 && !c.rain },
  { id: 'tshirt', slot: 'overdel', label: 'T-shirt', icon: 'tshirt', range: [17, 30], test: c => c.t >= 17 },
  { id: 'langaermet', slot: 'overdel', label: 'Langærmet trøje', icon: 'longsleeve', range: [-30, 17], test: c => c.t < 17 },

  // Hænder
  { id: 'luffer', slot: 'haender', label: 'Luffer', icon: 'mittens', who: 'kids', range: [-30, 4], test: c => c.t <= 4 },
  { id: 'handsker', slot: 'haender', label: 'Handsker', icon: 'gloves', who: 'adults', range: [-30, 4], test: c => c.t <= 4 },

  // Hoved og hals
  { id: 'hue', slot: 'hoved', label: 'Hue', icon: 'beanie', range: [-30, 6], test: c => c.t <= 6 || (c.t <= 10 && c.wind >= 8) },
  { id: 'kasket', slot: 'hoved', label: 'Kasket', icon: 'cap', range: [15, 45], test: c => c.t >= 15 && (c.uv >= 4 || (c.sunny && c.t >= 22)) },
  { id: 'halstoerklaede', slot: 'hals', label: 'Halstørklæde', icon: 'scarf', range: [-30, 3], test: c => c.t <= 3 || (c.t <= 8 && c.wind >= 8) },

  // Ben
  { id: 'termobukser', slot: 'ben', label: 'Termobukser', icon: 'pants', who: 'kids', range: [-30, 0], test: c => c.t <= 0 },
  { id: 'shorts', slot: 'ben', label: 'Shorts', icon: 'shorts', range: [20, 45], test: c => c.t >= 21 },
  { id: 'nederdel', slot: 'ben', label: 'Nederdel', icon: 'skirt', optIn: true, range: [18, 45], test: c => c.t >= 18 && !c.rain },
  { id: 'lange-bukser', slot: 'ben', label: 'Lange bukser', icon: 'pants', range: [-30, 22], test: () => true },

  // Fødder
  { id: 'vinterstoevler', slot: 'foedder', label: 'Vinterstøvler', icon: 'boots', range: [-30, 0], test: c => c.t <= 0 || c.snow },
  { id: 'gummistoevler', slot: 'foedder', label: 'Gummistøvler', icon: 'boots', who: 'kids', range: [0, 18], test: c => c.rain && c.t > 0 },
  { id: 'vandtaette-sko', slot: 'foedder', label: 'Vandtætte sko', icon: 'shoes', range: [-5, 10], test: c => c.rain || c.t <= 7 },
  { id: 'sandaler', slot: 'foedder', label: 'Sandaler', icon: 'sandals', range: [22, 45], test: c => c.t >= 22 && !c.rain },
  { id: 'sneakers', slot: 'foedder', label: 'Sneakers', icon: 'sneakers', range: [7, 30], test: () => true },

  // Ting at huske
  { id: 'regnbukser', slot: 'ekstra', label: 'Regnbukser', icon: 'rainpants', test: c => c.rain && c.t < 18 && (c.transport === 'cykel' || c.kid) },
  { id: 'paraply', slot: 'ekstra', label: 'Paraply', icon: 'umbrella', test: c => c.rain && c.wind < 9 && c.transport !== 'cykel' && !c.kid },
  { id: 'uldsokker', slot: 'ekstra', label: 'Uldsokker', icon: 'socks', test: c => c.t <= 0 },
  { id: 'refleks', slot: 'ekstra', label: 'Refleks', icon: 'reflector', test: c => c.dark && c.transport !== 'bil' },
  { id: 'solbriller', slot: 'ekstra', label: 'Solbriller', icon: 'sunglasses', test: c => c.uv >= 3 || (c.sunny && c.snow) },
  { id: 'solcreme', slot: 'ekstra', label: 'Solcreme', icon: 'sunscreen', test: c => c.uv >= 3 }
];

export const byId = Object.fromEntries(ITEMS.map(i => [i.id, i]));
const SLOT_ORDER = ['hoved', 'hals', 'ydre', 'mellem', 'inderst', 'overdel', 'haender', 'ben', 'foedder'];
const OPTIONAL = new Set(['hoved', 'hals']);
const MISSING = { ydre: 'en jakke', mellem: 'et mellemlag', overdel: 'en overdel', ben: 'bukser', foedder: 'sko', hoved: 'en hue', haender: 'handsker' };

export function defaultWardrobe(profile) {
  const kid = profile?.ageGroup === KID;
  return ITEMS
    .filter(i => !i.optIn && (i.who === 'kids' ? kid : i.who === 'adults' ? !kid : true))
    .map(i => i.id);
}

// Det tøj brugeren har: eget valg eller standarden for alderen
export function ownedIds(profile) {
  return Array.isArray(profile?.wardrobe) ? profile.wardrobe : defaultWardrobe(profile);
}

function isRequired(slot, c) {
  switch (slot) {
    case 'overdel': case 'ben': case 'foedder': return true;
    case 'ydre': return c.t < 19 || (c.rain && c.t < 22);
    case 'mellem': return c.t < 14;
    case 'inderst': return c.t <= -3;
    case 'hoved': case 'hals': case 'haender': return c.t <= 4;
    default: return false;
  }
}

function rangeDistance(item, t) {
  const [lo, hi] = item.range;
  return t < lo ? lo - t : t > hi ? t - hi : 0;
}

function chooseForSlot(slot, c, owned) {
  const mine = ITEMS.filter(i => i.slot === slot && owned.has(i.id));
  const matching = mine.filter(i => i.test(c));

  if (!isRequired(slot, c)) {
    // Valgfrie pladser (fx kasket i solskin): kun hvis noget passer præcist
    return OPTIONAL.has(slot) && matching.length ? { item: matching[0] } : null;
  }
  if (matching.length) return { item: matching[0] };

  // US11: intet passer præcist -> nærmeste alternativ fra garderoben
  const nearest = mine.map(i => ({ i, d: rangeDistance(i, c.t) })).sort((a, b) => a.d - b.d)[0];
  const mustCover = ['overdel', 'ben', 'foedder'].includes(slot);
  if (nearest && (nearest.d <= 10 || mustCover)) return { item: nearest.i, approx: true };
  if (slot === 'hals' || slot === 'inderst' || slot === 'mellem') return null;
  return { item: null, missing: MISSING[slot] };
}

/**
 * @param cond     fra weather.conditions(): { apparent, air, precipProb, precip, wind, uv, code, codes, dark }
 * @param profile  brugerens profil — eller null for en gæst (generiske råd)
 */
export function advise(cond, profile) {
  const p = profile || {};
  let adj = 0;
  if (p.coldSensitivity === 'fryser') adj -= 3;
  if (p.coldSensitivity === 'varm') adj += 3;
  if (p.transport === 'cykel') adj -= 2;
  if (p.transport === 'bil') adj += 2;

  const codes = cond.codes?.length ? cond.codes : [cond.code];
  const c = {
    t: cond.apparent + adj,
    rain: codes.some(x => RAIN_CODES.has(x)) || cond.precipProb >= 50 || cond.precip >= 0.5,
    snow: codes.some(x => SNOW_CODES.has(x)),
    wind: cond.wind || 0,
    uv: cond.uv || 0,
    dark: !!cond.dark,
    sunny: cond.code <= 1,
    transport: p.transport || null,
    kid: p.ageGroup === KID
  };

  const owned = new Set(ownedIds(p));
  const picks = {};
  const covered = new Set();
  for (const slot of SLOT_ORDER) {
    if (covered.has(slot)) continue;
    const pick = chooseForSlot(slot, c, owned);
    if (pick) picks[slot] = pick;
    if (pick?.item?.covers) pick.item.covers.forEach(s => covered.add(s));
  }
  const extras = ITEMS.filter(i => i.slot === 'ekstra' && owned.has(i.id) && i.test(c));

  // De vigtigste ting vises som illustrationer på forsiden (D8)
  const item = s => picks[s]?.item;
  const extra = id => extras.find(e => e.id === id);
  let key = [item('ydre'), extra('regnbukser'), item('hoved'), item('haender'), extra('paraply'), item('hals')];
  const feet = item('foedder');
  if (feet && ['vinterstoevler', 'gummistoevler'].includes(feet.id)) key.push(feet);
  key = key.filter(Boolean);
  if (key.length < 3) key.push(item('overdel'), item('ben'), feet, extra('solbriller'), extra('solcreme'));
  key = [...new Set(key.filter(Boolean))].slice(0, 4);

  // Hele påklædningen fra top til tå
  const outfit = SLOT_ORDER
    .filter(s => picks[s])
    .map(s => ({ slot: s, slotLabel: SLOTS[s], ...picks[s] }));

  return { t: c.t, adj, ctx: c, key, outfit, extras, generic: !profile };
}

// "Regnjakke, hue og handsker" / "Tag regnjakke og hue på"
export function headline(advice) {
  const names = advice.key.map(i => i.label.toLowerCase());
  const join = list => list.length > 1 ? list.slice(0, -1).join(', ') + ' og ' + list.at(-1) : list[0] || '';
  if (advice.generic) return 'Tag ' + join(names.slice(0, 2)) + ' på';
  const text = join(names.slice(0, 3));
  return text.charAt(0).toUpperCase() + text.slice(1);
}
