/**
 * Minimal 24×24 line-icon set, stroke = currentColor. Categories store an icon
 * `key` (see db.ts); custom categories fall back to `tag`. Keeping these inline
 * avoids an icon-library dependency and keeps the PWA fully offline.
 *
 * PATHS holds category glyphs plus the navigation glyphs that already shipped;
 * UI_PATHS holds chrome-only glyphs that must never appear in the category picker.
 */
export const PATHS: Record<string, string> = {
  cart: 'M2.5 3.5h2l2.4 11.2a1.7 1.7 0 0 0 1.7 1.3h8a1.7 1.7 0 0 0 1.7-1.3L20 7H6 M9 19.25a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 1 0 0-2.5z M17 19.25a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 1 0 0-2.5z',
  utensils: 'M5 3v5.5a2.5 2.5 0 0 0 5 0V3 M7.5 3v18 M18.5 21V3c-2.2 1.2-3.5 3.7-3.5 7v2.5a1 1 0 0 0 1 1h2.5',
  home: 'M3 10.5 12 3l9 7.5 M5.5 9v11.5h13V9',
  car: 'M5 11.5 6.6 7.3A2 2 0 0 1 8.5 6h7a2 2 0 0 1 1.9 1.3l1.6 4.2 M4.5 11.5h15a1.5 1.5 0 0 1 1.5 1.5v4H3v-4a1.5 1.5 0 0 1 1.5-1.5z M5.5 17v2.5 M18.5 17v2.5 M7 14.3h1.5 M15.5 14.3H17',
  repeat: 'M17 2.5 21 6l-4 3.5 M21 6H7a4 4 0 0 0-4 4v1 M7 21.5 3 18l4-3.5 M3 18h14a4 4 0 0 0 4-4v-1',
  heart: 'M12 20.5C8 17.5 3.5 13.8 3.5 9.5A4.2 4.2 0 0 1 12 7a4.2 4.2 0 0 1 8.5 2.5c0 4.3-4.5 8-8.5 11z',
  bag: 'M5.5 8h13l1 12.5h-15zM9 8V6a3 3 0 0 1 6 0v2',
  sparkles: 'M12 3l1.7 4.6L18.5 9.5l-4.8 1.9L12 16l-1.7-4.6L5.5 9.5l4.8-1.9zM18.5 16l.7 1.9 2 .8-2 .8-.7 1.9-.7-1.9-2-.8 2-.8z',
  box: 'M21 8 12 3 3 8l9 5 9-5z M3 8v8l9 5 9-5V8 M12 13v8',
  briefcase: 'M4 7.5h16v12H4z M8.5 7.5V5.5a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v2 M4 12.5h16',
  receipt: 'M6 2.5h12v19l-2-1.3-2 1.3-2-1.3-2 1.3-2-1.3-2 1.3zM9 7.5h6 M9 11.5h6 M9 15.5h4',
  'plus-circle': 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 8v8 M8 12h8',
  tag: 'M3.5 3.5H10l10.5 10.5-6.5 6.5L3.5 10zM7.5 7.5h.01',
  // Category glyphs: everyday spending plus a few lifestyle ones.
  paw: 'M7 6.5a1.5 2 0 1 0 3 0 1.5 2 0 1 0-3 0z M14 6.5a1.5 2 0 1 0 3 0 1.5 2 0 1 0-3 0z M3.4 11.2a1.4 1.8 0 1 0 2.8 0 1.4 1.8 0 1 0-2.8 0z M17.8 11.2a1.4 1.8 0 1 0 2.8 0 1.4 1.8 0 1 0-2.8 0z M12 12c-2.8 0-5.5 3.3-5.5 5.6 0 1.6 1.2 2.4 2.6 2.4 1.2 0 1.9-.6 2.9-.6s1.7.6 2.9.6c1.4 0 2.6-.8 2.6-2.4 0-2.3-2.7-5.6-5.5-5.6z',
  plane: 'M12 2.8a1.5 1.5 0 0 1 1.5 1.5v5.2l7 4.2v2l-7-2.1v4.2l2.4 1.8v1.6L12 20.3l-3.9.9v-1.6l2.4-1.8v-4.2l-7 2.1v-2l7-4.2V4.3A1.5 1.5 0 0 1 12 2.8z',
  coffee: 'M4.5 9.5h12v4.5a5 5 0 0 1-5 5h-2a5 5 0 0 1-5-5z M16.5 11h1.25a2.5 2.5 0 0 1 0 5H16 M8.5 3.5v2.5 M12.5 3.5v2.5',
  gift: 'M4 8.5h16v3.5H4z M5.5 12v8.5h13V12 M12 8.5v12 M12 8.5C10.5 5 7 4.5 7 6.8S10 8.5 12 8.5c2 0 5 .6 5-1.7S13.5 5 12 8.5',
  bolt: 'M13 2.5 4.5 13.5H12l-1 8 8.5-11H12z',
  phone: 'M8 2.5h8a1.5 1.5 0 0 1 1.5 1.5v16a1.5 1.5 0 0 1-1.5 1.5H8A1.5 1.5 0 0 1 6.5 20V4A1.5 1.5 0 0 1 8 2.5z M10.5 18.5h3',
  dumbbell: 'M7 12h10 M7 6.5v11 M17 6.5v11 M4 9v6 M20 9v6',
  music: 'M9 18V5.5l11-2V16 M9 18a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z M20 16a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z',
  book: 'M3.5 5a1.5 1.5 0 0 1 1.5-1.5h5.5a1.5 1.5 0 0 1 1.5 1.5v15.5a1.5 1.5 0 0 0-1.5-1.5H3.5z M20.5 5A1.5 1.5 0 0 0 19 3.5h-5.5A1.5 1.5 0 0 0 12 5v15.5a1.5 1.5 0 0 1 1.5-1.5h7z',
  ticket: 'M3.5 7.5a1 1 0 0 1 1-1h15a1 1 0 0 1 1 1V10a2 2 0 0 0 0 4v2.5a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1V14a2 2 0 0 0 0-4z M14.5 7v1.5 M14.5 11.25v1.5 M14.5 15.5V17',
  shirt: 'M8.5 3.5 4 6l-1.5 4.5 3 1V20.5h13V11.5l3-1L20 6l-4.5-2.5c-.6 1.5-2 2.5-3.5 2.5S9.1 5 8.5 3.5z',
  // Navigation
  pie: 'M21 12a9 9 0 1 1-9-9v9z M21 11.5A9 9 0 0 0 12.5 3v8.5z',
  list: 'M8 6h13 M8 12h13 M8 18h13 M3.5 6h.01 M3.5 12h.01 M3.5 18h.01',
  download: 'M12 3v12 M7.5 11l4.5 4.5 4.5-4.5 M4 20.5h16',
  alert: 'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z M12 9v4 M12 17h.01',
  sun: 'M12 8a4 4 0 1 0 .01 0 M12 2v2 M12 20v2 M2 12h2 M20 12h2 M5 5l1.4 1.4 M17.6 17.6 19 19 M19 5l-1.4 1.4 M6.4 17.6 5 19',
  moon: 'M20 14.5A8 8 0 1 1 9.5 4 6.5 6.5 0 0 0 20 14.5z',
  plus: 'M12 5v14 M5 12h14',
  cloud: 'M17.5 18.5a3.75 3.75 0 0 0 .4-7.48 5.25 5.25 0 0 0-10.1-1.1A4.25 4.25 0 0 0 7.2 18.5z',
  check: 'M4 12.5 9 17.5 20 6.5',
  wallet: 'M4 7.5h13a1 1 0 0 1 1 1V10 M3 6.5v11a2 2 0 0 0 2 2h14a1 1 0 0 0 1-1v-7a1 1 0 0 0-1-1H5a2 2 0 0 1-2-2 2 2 0 0 1 2-2h12 M17.5 14h.01',
  card: 'M3.5 6.5h17a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-17a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z M2.5 10.5h19 M6 14.5h4',
  chart: 'M3.5 21h17 M6.5 21V11 M11.5 21V5 M16.5 21v-8',
  bank: 'M3.5 10 12 4.5 20.5 10 M4.5 10v8 M9.5 10v8 M14.5 10v8 M19.5 10v8 M3 21h18',
  chevron: 'M9 5.5 15.5 12 9 18.5',
}

/** Chrome-only glyphs (never offered as a category icon). */
export const UI_PATHS: Record<string, string> = {
  x: 'M6 6l12 12 M18 6 6 18',
  lock: 'M6.5 10.5h11a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1z M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5',
  share: 'M12 3.5v11 M8 7.5l4-4 4 4 M8.5 10.5h-2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-2',
  'arrow-up-right': 'M7 17 17 7 M9 7h8v8',
  prompt: 'M4.5 7 9.5 12l-5 5 M12.5 17.5h7',
  person: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 12.25a3.25 3.25 0 1 0 0-6.5 3.25 3.25 0 0 0 0 6.5z M6.3 18.6a6.5 6.5 0 0 1 11.4 0',
}

/** The category picker's keys, in display order. */
export const CATEGORY_ICONS = [
  'home', 'cart', 'utensils', 'coffee', 'car', 'plane', 'bolt', 'phone', 'repeat', 'heart', 'paw', 'dumbbell', 'bag',
  'shirt', 'gift', 'sparkles', 'ticket', 'music', 'book', 'briefcase', 'receipt', 'bank', 'card', 'wallet', 'chart',
  'plus-circle', 'box', 'tag',
]

/** Human names for the picker (aria-labels). */
export const ICON_LABELS: Record<string, string> = {
  home: 'Home',
  cart: 'Groceries',
  utensils: 'Dining',
  coffee: 'Coffee',
  car: 'Car',
  plane: 'Travel',
  bolt: 'Utilities',
  phone: 'Phone',
  repeat: 'Subscriptions',
  heart: 'Health',
  paw: 'Pets',
  dumbbell: 'Fitness',
  bag: 'Shopping',
  shirt: 'Clothing',
  gift: 'Gifts',
  sparkles: 'Fun',
  ticket: 'Tickets',
  music: 'Music',
  book: 'Books',
  briefcase: 'Work',
  receipt: 'Bills',
  bank: 'Bank',
  card: 'Card',
  wallet: 'Wallet',
  chart: 'Investing',
  'plus-circle': 'Income',
  box: 'Other',
  tag: 'Tag',
}
