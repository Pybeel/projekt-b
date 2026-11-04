/**
 * icons.js — enkle streg-ikoner som inline SVG (24 × 24, arver tekstfarven).
 * Skift dem ud med jeres egne ikoner fra Figma ved at erstatte stierne her.
 */
const CLOUD = 'M7 17a4 4 0 0 1-.6-8 5.5 5.5 0 0 1 10.7 1.5A3.5 3.5 0 0 1 17 17z';
const CLOUD_UP = 'M7 14a4 4 0 0 1-.6-8 5.5 5.5 0 0 1 10.7 1.5A3.5 3.5 0 0 1 17 14z';
const JACKET = 'M9 3L5 5 4 20h5v-8M15 3l4 2 1 15h-5v-8M9 3l3 3 3-3M12 6v14';

const PATHS = {
  // Vejr
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  partly: '<circle cx="8.5" cy="8.5" r="3"/><path d="M8.5 2.5v1.2M2.5 8.5h1.2M4.3 4.3l.9.9M12.7 4.3l-.9.9"/><path d="M9.5 20a3.5 3.5 0 0 1-.5-7 5 5 0 0 1 9.6 1.3A3 3 0 0 1 18.5 20z"/>',
  cloud: `<path d="${CLOUD}"/>`,
  fog: '<path d="M4 9h16M6 13h12M4 17h16"/>',
  drizzle: `<path d="${CLOUD_UP}"/><path d="M9 18v.5M12 19.5v.5M15 18v.5"/>`,
  rain: `<path d="${CLOUD_UP}"/><path d="M9 17l-1 3M13 17l-1 3M17 17l-1 3"/>`,
  snow: `<path d="${CLOUD_UP}"/><path d="M9 18h.01M12 20.5h.01M15 18h.01M12 17h.01"/>`,
  thunder: `<path d="${CLOUD_UP}"/><path d="M13 15l-2 3.5h3L12 22"/>`,

  // Tøj
  raincoat: `<path d="${JACKET}"/><path d="M9 3a3 3 0 0 1 6 0"/>`,
  parka: `<path d="${JACKET}"/><path d="M8.5 3.3a3.5 3.5 0 0 1 7 0M4.5 15h4.5M15 15h4.5"/>`,
  jacket: `<path d="${JACKET}"/>`,
  snowsuit: '<path d="M8 3h8l3 5-2 1v12h-4v-7h-2v7H7V9L5 8z"/><path d="M12 3v11"/>',
  sweater: '<path d="M8 4h8l5 4-2 4-2-1v9H7v-9l-2 1-2-4z"/><path d="M10 4a2 2 0 0 0 4 0M7 17h10"/>',
  hoodie: '<path d="M8 4h8l5 4-2 4-2-1v9H7v-9l-2 1-2-4z"/><path d="M9 4a3 3 0 0 0 6 0M11 8v3M13 8v3"/>',
  tshirt: '<path d="M8 4h8l4 3-2 3-2-1v11H8V9L6 10 4 7z"/><path d="M10 4a2 2 0 0 0 4 0"/>',
  top: '<path d="M9 4v3l-2 3v10h10V10l-2-3V4"/>',
  longsleeve: '<path d="M9 4h6l5 3v13h-3V9M9 4L4 7v13h3V9M7 9v11h10"/><path d="M10 4a2 2 0 0 0 4 0"/>',
  dress: '<path d="M9 3h6l-1 5 4 12H6l4-12z"/>',
  beanie: '<path d="M5 16a7 7 0 0 1 14 0"/><path d="M4 16h16v3H4z"/><circle cx="12" cy="6.5" r="1.5"/>',
  cap: '<path d="M5 15a7 7 0 0 1 14 0v1H5z"/><path d="M19 16h3"/>',
  scarf: '<path d="M5 6c2 2 12 2 14 0v4c-2 2-12 2-14 0z"/><path d="M13 11v9h3v-9"/>',
  gloves: '<path d="M8 21v-5l-3-4 1-1 3 2V5a1 1 0 0 1 2 0v5V4a1 1 0 0 1 2 0v6V5a1 1 0 0 1 2 0v6V7a1 1 0 0 1 2 0v8l-2 6z"/>',
  mittens: '<path d="M8 21v-6l-3-3a1.5 1.5 0 0 1 2-2l1 1V7a4 4 0 0 1 8 0v8l-1 6z"/><path d="M8 18h8"/>',
  pants: '<path d="M7 3h10l1 18h-4l-2-11-2 11H6z"/><path d="M7 6h10"/>',
  rainpants: '<path d="M7 3h10l1 18h-4l-2-11-2 11H6z"/><path d="M8 13l-.5 2M16 13l.5 2"/>',
  shorts: '<path d="M6 5h12l1 10h-5l-2-5-2 5H5z"/>',
  skirt: '<path d="M8 5h8l3 13H5z"/><path d="M8 8h8"/>',
  boots: '<path d="M7 3h6v10l6 3v4H7z"/><path d="M7 17h12"/>',
  shoes: '<path d="M3 15l2-6h5l2 3 8 2v4H3z"/><path d="M3 18h17"/>',
  sneakers: '<path d="M3 16l1-6 4 1 3 3 7 1a2 2 0 0 1 2 2v2H3z"/><path d="M8 12l1-1M10 13.5l1-1"/>',
  sandals: '<path d="M4 18h16M7 18l2-8h6l2 8"/><path d="M9 10l3 4 3-4"/>',
  umbrella: '<path d="M3 12a9 9 0 0 1 18 0z"/><path d="M12 12v7a2 2 0 0 1-4 0"/>',
  socks: '<path d="M9 3h6v9l3 4a3 3 0 0 1-4 4l-5-5z"/><path d="M9 6h6"/>',
  sunglasses: '<path d="M3 10h18"/><path d="M5 10l1 5h4l1-5M13 10l1 5h4l1-5"/>',
  sunscreen: '<path d="M9 8h6v13H9z"/><path d="M10 4h4v4h-4z"/>',
  reflector: '<path d="M12 3l2.5 5.5L20 9l-4 4 1 6-5-3-5 3 1-6-4-4 5.5-.5z"/>',

  // Brugerflade
  home: '<path d="M3 11l9-7 9 7v9h-6v-6H9v6H3z"/>',
  bookmark: '<path d="M6 3h12v18l-6-4-6 4z"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  pin: '<path d="M12 21s-6-5.5-6-11a6 6 0 0 1 12 0c0 5.5-6 11-6 11z"/><circle cx="12" cy="10" r="2.2"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  chevron: '<path d="M9 5l7 7-7 7"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  grip: '<path d="M5 9h14M5 15h14"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  wind: '<path d="M3 8h10a3 3 0 1 0-3-3M3 12h15a3 3 0 1 1-3 3M3 16h7"/>'
};

// Kun stierne — bruges til at sætte flere ikoner sammen til illustrationen på velkomstskærmen
export const glyph = name => PATHS[name] || '';

export function icon(name, cls = 'ic', label = '') {
  const a11y = label ? `role="img" aria-label="${label}"` : 'aria-hidden="true"';
  return `<svg class="${cls}" viewBox="0 0 24 24" ${a11y}>${PATHS[name] || PATHS.cloud}</svg>`;
}
