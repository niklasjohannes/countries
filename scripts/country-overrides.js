// Hand-maintained metadata layered into `data/countries.json` by
// `scripts/build-countries.js`. This is the only file to edit when a name,
// alias, parent, sub-region or policy rule changes. There is no network access
// at build time: everything the generator needs is in this file.
//
// Adapted from the sibling flags app's `scripts/country-overrides.js`. Names,
// aliases, sovereignty and parent codes are copied from there; the flags app's
// flag-icons pin and its "drop territories that share their parent's flag" rule
// do not apply here, so those territories are back in.
//
// The rules applied below are written out in `POLICY` (copied into
// `countries.json` -> `meta.policy`) and explained for humans in `docs/DATA.md`.

/** UN M49 source, for the sub-region table below. No network fetch at build time. */
export const SOURCE = {
  name: 'UN M49 geoscheme (Standard country or area codes for statistical use)',
  publisher: 'United Nations Statistics Division',
  url: 'https://unstats.un.org/unsd/methodology/m49/overview/',
  accessed: '2026-11-12',
  note: 'English-language rows of the overview table, transcribed by hand into M49_SUBREGIONS. Taiwan (tw) and Kosovo (xk) are not in M49 and are placed in HAND_PLACED. Antarctica (aq) has no M49 region and is excluded.'
};

/** Closed continent list (the flags app's six). Nothing else may appear in `continent`. */
export const CONTINENTS = ['africa', 'asia', 'europe', 'north-america', 'south-america', 'oceania'];

/**
 * Closed sub-region list: the UN M49 intermediate regions where M49 defines
 * one, otherwise its sub-region. Each maps to exactly one continent.
 * M49 "Americas" is split: Northern America, Central America and the Caribbean
 * go to north-america, South America to south-america.
 */
export const SUBREGIONS = {
  'northern-africa': 'africa',
  'western-africa': 'africa',
  'middle-africa': 'africa',
  'eastern-africa': 'africa',
  'southern-africa': 'africa',
  'northern-america': 'north-america',
  'central-america': 'north-america',
  caribbean: 'north-america',
  'south-america': 'south-america',
  'central-asia': 'asia',
  'eastern-asia': 'asia',
  'south-eastern-asia': 'asia',
  'southern-asia': 'asia',
  'western-asia': 'asia',
  'northern-europe': 'europe',
  'western-europe': 'europe',
  'eastern-europe': 'europe',
  'southern-europe': 'europe',
  'australia-and-new-zealand': 'oceania',
  melanesia: 'oceania',
  micronesia: 'oceania',
  polynesia: 'oceania'
};

/**
 * M49 sub-region of every code M49 lists (247 of them), grouped by sub-region so
 * each group can be checked against the UN table by eye. Transcribed from SOURCE.
 */
export const M49_SUBREGIONS = {
  'northern-africa': [
    'dz', 'eg', 'eh', 'ly', 'ma', 'sd', 'tn'
  ],
  'western-africa': [
    'bf', 'bj', 'ci', 'cv', 'gh', 'gm', 'gn', 'gw', 'lr', 'ml', 'mr', 'ne', 'ng', 'sh',
    'sl', 'sn', 'tg'
  ],
  'middle-africa': [
    'ao', 'cd', 'cf', 'cg', 'cm', 'ga', 'gq', 'st', 'td'
  ],
  'eastern-africa': [
    'bi', 'dj', 'er', 'et', 'io', 'ke', 'km', 'mg', 'mu', 'mw', 'mz', 're', 'rw', 'sc',
    'so', 'ss', 'tf', 'tz', 'ug', 'yt', 'zm', 'zw'
  ],
  'southern-africa': [
    'bw', 'ls', 'na', 'sz', 'za'
  ],
  'northern-america': [
    'bm', 'ca', 'gl', 'pm', 'us'
  ],
  'central-america': [
    'bz', 'cr', 'gt', 'hn', 'mx', 'ni', 'pa', 'sv'
  ],
  'caribbean': [
    'ag', 'ai', 'aw', 'bb', 'bl', 'bq', 'bs', 'cu', 'cw', 'dm', 'do', 'gd', 'gp', 'ht',
    'jm', 'kn', 'ky', 'lc', 'mf', 'mq', 'ms', 'pr', 'sx', 'tc', 'tt', 'vc', 'vg', 'vi'
  ],
  'south-america': [
    'ar', 'bo', 'br', 'bv', 'cl', 'co', 'ec', 'fk', 'gf', 'gs', 'gy', 'pe', 'py', 'sr',
    'uy', 've'
  ],
  'central-asia': [
    'kg', 'kz', 'tj', 'tm', 'uz'
  ],
  'eastern-asia': [
    'cn', 'hk', 'jp', 'kp', 'kr', 'mn', 'mo'
  ],
  'south-eastern-asia': [
    'bn', 'id', 'kh', 'la', 'mm', 'my', 'ph', 'sg', 'th', 'tl', 'vn'
  ],
  'southern-asia': [
    'af', 'bd', 'bt', 'in', 'ir', 'lk', 'mv', 'np', 'pk'
  ],
  'western-asia': [
    'ae', 'am', 'az', 'bh', 'cy', 'ge', 'il', 'iq', 'jo', 'kw', 'lb', 'om', 'ps', 'qa',
    'sa', 'sy', 'tr', 'ye'
  ],
  'northern-europe': [
    'ax', 'dk', 'ee', 'fi', 'fo', 'gb', 'gg', 'ie', 'im', 'is', 'je', 'lt', 'lv', 'no',
    'se', 'sj'
  ],
  'western-europe': [
    'at', 'be', 'ch', 'de', 'fr', 'li', 'lu', 'mc', 'nl'
  ],
  'eastern-europe': [
    'bg', 'by', 'cz', 'hu', 'md', 'pl', 'ro', 'ru', 'sk', 'ua'
  ],
  'southern-europe': [
    'ad', 'al', 'ba', 'es', 'gi', 'gr', 'hr', 'it', 'me', 'mk', 'mt', 'pt', 'rs', 'si',
    'sm', 'va'
  ],
  'australia-and-new-zealand': [
    'au', 'cc', 'cx', 'hm', 'nf', 'nz'
  ],
  'melanesia': [
    'fj', 'nc', 'pg', 'sb', 'vu'
  ],
  'micronesia': [
    'fm', 'gu', 'ki', 'mh', 'mp', 'nr', 'pw', 'um'
  ],
  'polynesia': [
    'as', 'ck', 'nu', 'pf', 'pn', 'tk', 'to', 'tv', 'wf', 'ws'
  ],
};

/** Codes M49 does not list, placed by geography. Documented in docs/DATA.md. */
export const HAND_PLACED = {
  tw: 'eastern-asia',
  xk: 'southern-europe'
};

/**
 * Entries that are deliberately left out. Antarctica has no M49 region and is
 * not a country, so it has no continent in the closed list. PROVISIONAL: issue 5
 * reconciles this against what Natural Earth draws.
 */
export const EXCLUDED = {
  aq: 'Antarctica: not a country, no permanent population, and no M49 region, so it has no continent in the closed list (provisional; reconcile against Natural Earth in issue 5)'
};

/** Quizzed beyond the 193 UN member states: two UN observers plus Kosovo and Taiwan. */
export const QUIZZED_EXTRAS = ['va', 'ps', 'xk', 'tw'];

/** The 9 large territories that are quizzed (PLAN decision 2). */
export const QUIZZED_TERRITORIES = ['gl', 'eh', 'gf', 'pr', 'nc', 'fk', 'pf', 'sj', 'hk'];

export const POLICY = {
  scope: 'Quizzed (206): the 193 UN member states, the extras Vatican City (va), Palestine (ps), Kosovo (xk) and Taiwan (tw), and nine large territories: Greenland, Western Sahara, French Guiana, Puerto Rico, New Caledonia, Falkland Islands, French Polynesia, Svalbard and Hong Kong. Every other ISO 3166-1 territory is context-only land (`quizzed: false`): drawn, never asked. The context-only list is PROVISIONAL until issue 5 reconciles it against Natural Earth.',
  continentBasis: 'Continent and sub-region come from the UN M49 geoscheme (see `meta.source`). M49 Africa, Asia, Europe and Oceania map 1:1; M49 Americas splits into north-america (Northern America, Central America, Caribbean) and south-america. Sub-regions are the 22 M49 intermediate regions (or the M49 sub-region where it has no intermediate regions). Taiwan and Kosovo are not in M49 and are placed by geography (Eastern Asia, Southern Europe).',
  transcontinental: {
    ru: 'europe (M49 Eastern Europe)',
    tr: 'asia (M49 Western Asia)',
    cy: 'asia (M49 Western Asia), although an EU member',
    am: 'asia (M49 Western Asia)',
    az: 'asia (M49 Western Asia)',
    ge: 'asia (M49 Western Asia)',
    kz: 'asia (M49 Central Asia)',
    eg: 'africa (M49 Northern Africa)',
    id: 'asia (M49 South-eastern Asia)',
    tl: 'asia (M49 South-eastern Asia)',
    pg: 'oceania (M49 Melanesia)',
    pa: 'north-america (M49 Central America)',
    gl: 'north-america (M49 Northern America)',
    tw: 'asia (not in M49; placed by geography, Eastern Asia)',
    xk: 'europe (not in M49; placed by geography, Southern Europe)'
  },
  sovereignty: '`sovereign` is true iff the entry is a UN member state or a UN non-member observer state (ps, va). Everything else is false, including Kosovo and Taiwan. No judgement about recognition is made beyond that rule (same rule as the flags app).',
  parentCode: '`parentCode` is the lowercase code of the single UN-member state that de facto administers a dependency or territory (for Cook Islands and Niue: the state they are in free association with). It is null for sovereign entries and for entries whose own status is disputed with no single administering state (tw, eh, xk). A sovereignty claim by another state does not change `parentCode`. The field records administration, not legitimacy.',
  naming: '`name` is the common English short name, without political qualifiers, with diacritics kept (e.g. Côte d\'Ivoire, Türkiye). `aliases` are former, long-form or colloquial English names used only for typing-mode search; they are not endorsements. An alias that is the shared bare name of two entries ("Korea" for kp/kr, "Congo" for cd/cg) is given to neither.',
  borders: {
    crimea: 'Part of Ukraine (ua). No separate entry.',
    'northern-cyprus': 'Part of Cyprus (cy). No separate entry.',
    somaliland: 'Part of Somalia (so). No separate entry.',
    abkhazia: 'Part of Georgia (ge). No separate entry.',
    'south-ossetia': 'Part of Georgia (ge). No separate entry.',
    transnistria: 'Part of Moldova (md). No separate entry.',
    kashmir: 'Split along the line of control: the Indian-administered side is drawn as part of India (in), the Pakistani-administered side as part of Pakistan (pk). The geometry is issue 5\'s job. Aksai Chin is an open question.',
    'western-sahara': 'Its own entry (eh): non-sovereign, parentCode null, quizzed.',
    kosovo: 'Its own entry (xk): quizzed, non-sovereign, parentCode null, southern-europe.'
  },
  contested: {
    tw: 'Taiwan: not a UN member or observer -> sovereign false. Status disputed, no single administering UN-member state -> parentCode null.',
    xk: 'Kosovo: not a UN member or observer -> sovereign false; status disputed, no single administering UN-member state -> parentCode null. Alias "Kosova". Own entry by PLAN decision 2 and 15.',
    eh: 'Western Sahara: non-self-governing territory; administration divided between Morocco and the Sahrawi Republic -> sovereign false, parentCode null.',
    ps: 'Palestine: UN non-member observer state -> sovereign true. Alias "State of Palestine".',
    va: 'Vatican City: UN non-member observer state (as the Holy See) -> sovereign true. Aliases "Holy See", "Vatican".',
    fk: 'Falkland Islands: administered by the United Kingdom, claimed by Argentina -> parentCode gb. Aliases "Falklands", "Malvinas".',
    gi: 'Gibraltar: administered by the United Kingdom, claimed by Spain -> parentCode gb.',
    hk: 'Hong Kong: special administrative region of China -> sovereign false, parentCode cn.',
    mo: 'Macau: special administrative region of China -> sovereign false, parentCode cn.',
    ck: 'Cook Islands: free association with New Zealand, not a UN member -> parentCode nz.',
    nu: 'Niue: free association with New Zealand, not a UN member -> parentCode nz.',
    io: 'British Indian Ocean Territory: administered by the United Kingdom, claimed by Mauritius -> parentCode gb. Context-only.',
    sj: 'Svalbard (ISO "Svalbard and Jan Mayen"): parentCode no.',
    cy: 'Cyprus: one entry for the UN member state (see borders.northern-cyprus).'
  }
};

// Shorthands keep the table below to one line per entry.

/**
 * Sovereign state (UN member or observer).
 * @param {string} name
 * @param {string[]} [aliases]
 * @returns {{name: string, aliases: string[], sovereign: boolean, parentCode: null}}
 */
function state(name, aliases = []) {
  return { name, aliases, sovereign: true, parentCode: null };
}

/**
 * Non-sovereign entry: a dependency or territory (`parentCode` set) or an entry
 * with disputed status (`parentCode` null).
 * @param {string} name
 * @param {string | null} parentCode
 * @param {string[]} [aliases]
 * @returns {{name: string, aliases: string[], sovereign: boolean, parentCode: string | null}}
 */
function territory(name, parentCode, aliases = []) {
  return { name, aliases, sovereign: false, parentCode };
}

/** Every entry, keyed by lowercase code. Continent and sub-region are derived. */
export const ENTRIES = {
  ad: state('Andorra'),
  ae: state('United Arab Emirates', ['UAE', 'Emirates']),
  af: state('Afghanistan'),
  ag: state('Antigua and Barbuda', ['Antigua']),
  ai: territory('Anguilla', 'gb'),
  al: state('Albania'),
  am: state('Armenia'),
  ao: state('Angola'),
  ar: state('Argentina'),
  as: territory('American Samoa', 'us'),
  at: state('Austria'),
  au: state('Australia'),
  aw: territory('Aruba', 'nl'),
  ax: territory('Åland Islands', 'fi', ['Aland Islands', 'Aland']),
  az: state('Azerbaijan'),
  ba: state('Bosnia and Herzegovina', ['Bosnia']),
  bb: state('Barbados'),
  bd: state('Bangladesh'),
  be: state('Belgium'),
  bf: state('Burkina Faso'),
  bg: state('Bulgaria'),
  bh: state('Bahrain'),
  bi: state('Burundi'),
  bj: state('Benin'),
  bl: territory('Saint Barthélemy', 'fr', ['Saint Barthelemy', 'St Barts', 'St. Barthélemy']),
  bm: territory('Bermuda', 'gb'),
  bn: state('Brunei', ['Brunei Darussalam']),
  bo: state('Bolivia'),
  bq: territory('Caribbean Netherlands', 'nl', ['Bonaire, Sint Eustatius and Saba', 'Bonaire', 'Sint Eustatius', 'Saba']),
  br: state('Brazil'),
  bs: state('Bahamas', ['The Bahamas']),
  bt: state('Bhutan'),
  bv: territory('Bouvet Island', 'no'),
  bw: state('Botswana'),
  by: state('Belarus'),
  bz: state('Belize'),
  ca: state('Canada'),
  cc: territory('Cocos (Keeling) Islands', 'au', ['Cocos Islands', 'Keeling Islands']),
  cd: state('Democratic Republic of the Congo', ['DR Congo', 'DRC', 'Congo-Kinshasa']),
  cf: state('Central African Republic', ['CAR']),
  cg: state('Republic of the Congo', ['Congo-Brazzaville']),
  ch: state('Switzerland'),
  ci: state('Côte d\'Ivoire', ['Ivory Coast', 'Cote d\'Ivoire']),
  ck: territory('Cook Islands', 'nz'),
  cl: state('Chile'),
  cm: state('Cameroon'),
  cn: state('China', ['People\'s Republic of China', 'PRC']),
  co: state('Colombia'),
  cr: state('Costa Rica'),
  cu: state('Cuba'),
  cv: state('Cabo Verde', ['Cape Verde']),
  cw: territory('Curaçao', 'nl', ['Curacao']),
  cx: territory('Christmas Island', 'au'),
  cy: state('Cyprus'),
  cz: state('Czechia', ['Czech Republic']),
  de: state('Germany'),
  dj: state('Djibouti'),
  dk: state('Denmark'),
  dm: state('Dominica'),
  do: state('Dominican Republic'),
  dz: state('Algeria'),
  ec: state('Ecuador'),
  ee: state('Estonia'),
  eg: state('Egypt'),
  eh: territory('Western Sahara', null),
  er: state('Eritrea'),
  es: state('Spain'),
  et: state('Ethiopia'),
  fi: state('Finland'),
  fj: state('Fiji'),
  fk: territory('Falkland Islands', 'gb', ['Falklands', 'Malvinas']),
  fm: state('Micronesia', ['Federated States of Micronesia']),
  fo: territory('Faroe Islands', 'dk', ['Faroes']),
  fr: state('France'),
  ga: state('Gabon'),
  gb: state('United Kingdom', ['UK', 'Great Britain', 'Britain', 'England', 'Scotland', 'Wales', 'Northern Ireland']),
  gd: state('Grenada'),
  ge: state('Georgia'),
  gf: territory('French Guiana', 'fr'),
  gg: territory('Guernsey', 'gb'),
  gh: state('Ghana'),
  gi: territory('Gibraltar', 'gb'),
  gl: territory('Greenland', 'dk'),
  gm: state('Gambia', ['The Gambia']),
  gn: state('Guinea'),
  gp: territory('Guadeloupe', 'fr'),
  gq: state('Equatorial Guinea'),
  gr: state('Greece'),
  gs: territory('South Georgia and the South Sandwich Islands', 'gb', ['South Georgia']),
  gt: state('Guatemala'),
  gu: territory('Guam', 'us'),
  gw: state('Guinea-Bissau'),
  gy: state('Guyana'),
  hk: territory('Hong Kong', 'cn'),
  hm: territory('Heard Island and McDonald Islands', 'au', ['Heard Island']),
  hn: state('Honduras'),
  hr: state('Croatia'),
  ht: state('Haiti'),
  hu: state('Hungary'),
  id: state('Indonesia'),
  ie: state('Ireland', ['Republic of Ireland']),
  il: state('Israel'),
  im: territory('Isle of Man', 'gb'),
  in: state('India'),
  io: territory('British Indian Ocean Territory', 'gb', ['Chagos Islands', 'BIOT']),
  iq: state('Iraq'),
  ir: state('Iran'),
  is: state('Iceland'),
  it: state('Italy'),
  je: territory('Jersey', 'gb'),
  jm: state('Jamaica'),
  jo: state('Jordan'),
  jp: state('Japan'),
  ke: state('Kenya'),
  kg: state('Kyrgyzstan'),
  kh: state('Cambodia'),
  ki: state('Kiribati'),
  km: state('Comoros'),
  kn: state('Saint Kitts and Nevis', ['St Kitts and Nevis', 'St. Kitts and Nevis']),
  kp: state('North Korea', ['DPRK', 'Democratic People\'s Republic of Korea']),
  kr: state('South Korea', ['Republic of Korea']),
  kw: state('Kuwait'),
  ky: territory('Cayman Islands', 'gb'),
  kz: state('Kazakhstan'),
  la: state('Laos'),
  lb: state('Lebanon'),
  lc: state('Saint Lucia', ['St Lucia', 'St. Lucia']),
  li: state('Liechtenstein'),
  lk: state('Sri Lanka', ['Ceylon']),
  lr: state('Liberia'),
  ls: state('Lesotho'),
  lt: state('Lithuania'),
  lu: state('Luxembourg'),
  lv: state('Latvia'),
  ly: state('Libya'),
  ma: state('Morocco'),
  mc: state('Monaco'),
  md: state('Moldova'),
  me: state('Montenegro'),
  mf: territory('Saint Martin', 'fr', ['St Martin', 'St. Martin']),
  mg: state('Madagascar'),
  mh: state('Marshall Islands'),
  mk: state('North Macedonia', ['Macedonia']),
  ml: state('Mali'),
  mm: state('Myanmar', ['Burma']),
  mn: state('Mongolia'),
  mo: territory('Macau', 'cn', ['Macao']),
  mp: territory('Northern Mariana Islands', 'us', ['Northern Marianas']),
  mq: territory('Martinique', 'fr'),
  mr: state('Mauritania'),
  ms: territory('Montserrat', 'gb'),
  mt: state('Malta'),
  mu: state('Mauritius'),
  mv: state('Maldives'),
  mw: state('Malawi'),
  mx: state('Mexico'),
  my: state('Malaysia'),
  mz: state('Mozambique'),
  na: state('Namibia'),
  nc: territory('New Caledonia', 'fr'),
  ne: state('Niger'),
  nf: territory('Norfolk Island', 'au'),
  ng: state('Nigeria'),
  ni: state('Nicaragua'),
  nl: state('Netherlands', ['Holland', 'The Netherlands']),
  no: state('Norway'),
  np: state('Nepal'),
  nr: state('Nauru'),
  nu: territory('Niue', 'nz'),
  nz: state('New Zealand', ['Aotearoa']),
  om: state('Oman'),
  pa: state('Panama'),
  pe: state('Peru'),
  pf: territory('French Polynesia', 'fr', ['Tahiti']),
  pg: state('Papua New Guinea', ['PNG']),
  ph: state('Philippines'),
  pk: state('Pakistan'),
  pl: state('Poland'),
  pm: territory('Saint Pierre and Miquelon', 'fr', ['St Pierre and Miquelon']),
  pn: territory('Pitcairn Islands', 'gb', ['Pitcairn']),
  pr: territory('Puerto Rico', 'us'),
  ps: state('Palestine', ['State of Palestine']),
  pt: state('Portugal'),
  pw: state('Palau'),
  py: state('Paraguay'),
  qa: state('Qatar'),
  re: territory('Réunion', 'fr', ['Reunion']),
  ro: state('Romania'),
  rs: state('Serbia'),
  ru: state('Russia', ['Russian Federation']),
  rw: state('Rwanda'),
  sa: state('Saudi Arabia'),
  sb: state('Solomon Islands'),
  sc: state('Seychelles'),
  sd: state('Sudan'),
  se: state('Sweden'),
  sg: state('Singapore'),
  sh: territory('Saint Helena', 'gb', ['Saint Helena, Ascension and Tristan da Cunha', 'St Helena', 'Ascension Island', 'Tristan da Cunha']),
  si: state('Slovenia'),
  sj: territory('Svalbard', 'no', ['Svalbard and Jan Mayen', 'Jan Mayen']),
  sk: state('Slovakia'),
  sl: state('Sierra Leone'),
  sm: state('San Marino'),
  sn: state('Senegal'),
  so: state('Somalia'),
  sr: state('Suriname', ['Surinam']),
  ss: state('South Sudan'),
  st: state('São Tomé and Príncipe', ['Sao Tome and Principe']),
  sv: state('El Salvador'),
  sx: territory('Sint Maarten', 'nl'),
  sy: state('Syria'),
  sz: state('Eswatini', ['Swaziland']),
  tc: territory('Turks and Caicos Islands', 'gb'),
  td: state('Chad'),
  tf: territory('French Southern and Antarctic Lands', 'fr', ['French Southern Territories', 'TAAF']),
  tg: state('Togo'),
  th: state('Thailand'),
  tj: state('Tajikistan'),
  tk: territory('Tokelau', 'nz'),
  tl: state('Timor-Leste', ['East Timor']),
  tm: state('Turkmenistan'),
  tn: state('Tunisia'),
  to: state('Tonga'),
  tr: state('Türkiye', ['Turkey']),
  tt: state('Trinidad and Tobago', ['Trinidad']),
  tv: state('Tuvalu'),
  tw: territory('Taiwan', null),
  tz: state('Tanzania'),
  ua: state('Ukraine'),
  ug: state('Uganda'),
  um: territory('United States Minor Outlying Islands', 'us', ['US Minor Outlying Islands']),
  us: state('United States', ['USA', 'US', 'United States of America', 'America']),
  uy: state('Uruguay'),
  uz: state('Uzbekistan'),
  va: state('Vatican City', ['Holy See', 'Vatican']),
  vc: state('Saint Vincent and the Grenadines', ['St Vincent and the Grenadines', 'St. Vincent']),
  ve: state('Venezuela'),
  vg: territory('British Virgin Islands', 'gb', ['Virgin Islands (British)']),
  vi: territory('U.S. Virgin Islands', 'us', ['US Virgin Islands', 'United States Virgin Islands']),
  vn: state('Vietnam', ['Viet Nam']),
  vu: state('Vanuatu'),
  wf: territory('Wallis and Futuna', 'fr'),
  ws: state('Samoa'),
  xk: territory('Kosovo', null, ['Kosova']),
  ye: state('Yemen'),
  yt: territory('Mayotte', 'fr'),
  za: state('South Africa'),
  zm: state('Zambia'),
  zw: state('Zimbabwe')

};
