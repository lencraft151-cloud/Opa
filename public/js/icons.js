/** Inline-SVG-Icons (Strichzeichnungen, 24×24). Keine externe Icon-Bibliothek. */

const wrap = (paths) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
        stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

export const icons = {
  home: wrap('<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>'),
  rooms: wrap('<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>'),
  devices: wrap('<rect x="4" y="3" width="16" height="18" rx="3"/><path d="M9 17h6"/>'),
  energy: wrap('<path d="M13 2 4.5 13.5H11L9.5 22 19 10h-6.5z"/>'),
  chart: wrap('<path d="M4 20V9"/><path d="M10 20V4"/><path d="M16 20v-7"/><path d="M22 20H2"/>'),
  /** Uhr – für den Verlauf: was wann war. */
  clock: wrap('<circle cx="12" cy="12" r="9"/><path d="M12 7v5.4l3.4 2"/>'),
  automation: wrap('<circle cx="12" cy="12" r="3.2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1"/>'),
  settings: wrap('<circle cx="12" cy="12" r="3"/><path d="M4 12h2M18 12h2M12 4v2M12 18v2"/><circle cx="12" cy="12" r="8.5"/>'),
  more: wrap('<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>'),
  scene: wrap('<path d="m12 3 2.1 5.2L19.5 9l-4 3.7 1 5.4L12 15.6 7.5 18l1-5.4-4-3.7 5.4-.8z"/>'),
  user: wrap('<circle cx="12" cy="8" r="4"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/>'),
  update: wrap('<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/>'),
  power: wrap('<path d="M12 3v9"/><path d="M6.5 6.5a8 8 0 1 0 11 0"/>'),
  up: wrap('<path d="m6 15 6-6 6 6"/>'),
  down: wrap('<path d="m6 9 6 6 6-6"/>'),
  stop: wrap('<rect x="6.5" y="6.5" width="11" height="11" rx="2"/>'),
  refresh: wrap('<path d="M3 12a9 9 0 0 1 15.3-6.4L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.3 6.4L3 16"/><path d="M3 21v-5h5"/>'),
  warning: wrap('<path d="M12 3 2.5 20h19z"/><path d="M12 9.5v4.5"/><path d="M12 17.2v.1"/>'),
  plus: wrap('<path d="M12 5v14M5 12h14"/>'),
  trash: wrap('<path d="M4 7h16"/><path d="M9 7V5h6v2"/><path d="M6 7l1 13h10l1-13"/>'),
  temperature: wrap('<path d="M14 14.8V5a2 2 0 1 0-4 0v9.8a4 4 0 1 0 4 0z"/>'),
  drop: wrap('<path d="M12 3s6 6.6 6 10.5a6 6 0 1 1-12 0C6 9.6 12 3 12 3z"/>'),
  bulb: wrap('<path d="M9 18h6"/><path d="M10 21h4"/><path d="M12 3a6 6 0 0 0-3.5 10.9V16h7v-2.1A6 6 0 0 0 12 3z"/>'),
  music: wrap('<path d="M9 18V5l10-2v13"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/>'),
  book: wrap('<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H19v15H6.5A2.5 2.5 0 0 0 4 20.5z"/><path d="M19 18v3H6.5A2.5 2.5 0 0 1 4 18.5"/>'),
  blind: wrap('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 8h18M3 12h18M3 16h18"/>'),
};

/** Icon passend zu den Fähigkeiten eines Geräts. */
export function iconForDevice(device) {
  const has = (capability) => device.capabilities.includes(capability);
  if (has('cover')) return icons.blind;
  if (has('sensor.temperature') || has('sensor.humidity')) return icons.temperature;
  if (has('dimmer') || has('color')) return icons.bulb;
  if (has('switch')) return icons.power;
  return icons.devices;
}
