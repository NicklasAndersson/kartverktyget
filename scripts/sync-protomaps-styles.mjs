import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { layers, namedFlavor } from '@protomaps/basemaps';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const stylesDir = join(repoRoot, 'apps', 'web', 'public', 'styles');

const ATTRIBUTION =
  '<a href="https://github.com/protomaps/basemaps">Protomaps</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
const GLYPHS_URL = 'https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf';
const SOURCE_ID = 'protomaps';
const TILEJSON_URL =
  'pmtiles://https://kartverktyget.s3.eu-central-003.backblazeb2.com/sweden-osm.pmtiles';
const LANGUAGE = 'sv';
const SAFE_FONTS = {
  regular: 'Noto Sans Regular',
  bold: 'Noto Sans Medium',
  italic: 'Noto Sans Italic',
};

function withSafeFonts(flavor) {
  return {
    ...flavor,
    ...SAFE_FONTS,
  };
}

function customFlavor(baseName, overrides = {}) {
  const base = namedFlavor(baseName);
  return withSafeFonts({
    ...base,
    ...overrides,
    landcover: {
      ...(base.landcover ?? {}),
      ...(overrides.landcover ?? {}),
    },
  });
}

const THEMES = [
  { id: 'protomaps-light', themeName: 'light', sprite: 'light', flavor: withSafeFonts(namedFlavor('light')) },
  { id: 'protomaps-dark', themeName: 'dark', sprite: 'dark', flavor: withSafeFonts(namedFlavor('dark')) },
  { id: 'protomaps-white', themeName: 'white', sprite: 'white', flavor: withSafeFonts(namedFlavor('white')) },
  { id: 'protomaps-grayscale', themeName: 'grayscale', sprite: 'grayscale', flavor: withSafeFonts(namedFlavor('grayscale')) },
  { id: 'protomaps-black', themeName: 'black', sprite: 'black', flavor: withSafeFonts(namedFlavor('black')) },
  {
    id: 'protomaps-bio',
    themeName: 'bio',
    sprite: 'light',
    flavor: customFlavor('light', {
      background: '#dddddd',
      earth: '#ededed',
      park_a: '#bfc99c',
      park_b: '#bfc99c',
      hospital: '#ffeae8',
      industrial: '#f8ffed',
      school: '#f2fef9',
      wood_a: '#bfc99c',
      wood_b: '#bfc99c',
      pedestrian: '#eef0f0',
      scrub_a: '#bfc99c',
      scrub_b: '#bfc99c',
      sand: '#ebe7da',
      beach: '#ebe7da',
      aerodrome: '#dbe7e7',
      runway: '#d1d9d9',
      water: '#84b7cf',
      zoo: '#ebe6ed',
      military: '#ebe6ed',
      buildings: '#cbcece',
      minor_a: '#fff2bb',
      minor_b: '#fff2bb',
      major_casing_early: '#e3cfd3',
      major: '#ffdf59',
      highway_casing_early: '#ebcea2',
      highway: '#e9ac77',
      boundaries: '#5c4a6b',
      roads_label_minor: '#91888b',
      roads_label_minor_halo: '#ffffff',
      roads_label_major: '#91888b',
      roads_label_major_halo: '#ffffff',
      ocean_label: '#ffffff',
      subplace_label: '#757d91',
      subplace_label_halo: '#ffffff',
      city_label: '#3c3c3c',
      city_label_halo: '#ffffff',
      state_label: '#777777',
      state_label_halo: '#ffffff',
      country_label: '#9590aa',
      address_label: 'black',
      address_label_halo: 'white',
      landcover: {
        grassland: '#bfc99c',
        farmland: '#bfc99c',
        scrub: '#bfc99c',
        forest: '#bfc99c',
        urban_area: '#ebe6ed',
        barren: '#ebe7da',
        glacier: '#ffffff',
      },
    }),
  },
  {
    id: 'protomaps-seafoam',
    themeName: 'seafoam',
    sprite: 'light',
    flavor: customFlavor('light', {
      background: 'rgba(231, 240, 221, 1)',
      earth: 'rgba(231, 240, 221, 1)',
      park_a: '#8ad3d4',
      park_b: '#8ad3d4',
      hospital: 'rgba(253, 160, 179, 1)',
      industrial: 'rgba(191, 189, 186, 1)',
      school: 'rgba(250, 220, 166, 1)',
      wood_a: '#94ccc3',
      wood_b: '#94ccc3',
      pedestrian: 'rgba(198, 220, 216, 1)',
      scrub_a: '#a4c6a2',
      scrub_b: '#a4c6a2',
      glacier: 'rgba(239, 240, 231, 1)',
      sand: 'rgba(222, 218, 189, 1)',
      beach: 'rgba(236, 251, 218, 1)',
      aerodrome: 'rgba(218, 211, 208, 1)',
      runway: 'rgba(232, 250, 238, 1)',
      water: 'rgba(173, 230, 221, 1)',
      zoo: 'rgba(143, 211, 167, 1)',
      military: 'rgba(173, 188, 195, 1)',
      buildings: 'rgba(218, 222, 217, 1)',
      boundaries: 'rgba(136, 148, 136, 1)',
      waterway_label: 'rgba(90, 145, 147, 1)',
      roads_label_minor: 'rgba(137, 149, 142, 1)',
      roads_label_minor_halo: '#ffffff',
      roads_label_major: 'rgba(137, 149, 142, 1)',
      roads_label_major_halo: '#ffffff',
      ocean_label: 'rgba(91, 179, 181, 1)',
      peak_label: 'rgba(95, 108, 135, 1)',
      subplace_label: 'rgba(131, 130, 130, 1)',
      subplace_label_halo: 'rgba(0,0,0,0)',
      city_label: 'rgba(84, 92, 94, 1)',
      city_label_halo: 'rgba(0,0,0,0)',
      state_label: 'rgba(118, 118, 118, 1)',
      state_label_halo: 'rgba(0,0,0,0)',
      country_label: 'rgba(130, 145, 155, 1)',
      address_label: 'black',
      address_label_halo: 'white',
      landcover: {
        grassland: 'rgba(143, 201, 173, 1)',
        barren: 'rgba(232, 214, 183, 1)',
        urban_area: 'rgba(224, 232, 216, 1)',
        farmland: 'rgba(165, 213, 166, 1)',
        glacier: 'rgba(239, 240, 231, 1)',
        scrub: 'rgba(176, 205, 174, 1)',
        forest: 'rgba(149, 207, 194, 1)',
      },
    }),
  },
  {
    id: 'protomaps-dusk-rose',
    themeName: 'dusk_rose',
    sprite: 'white',
    flavor: customFlavor('white', {
      background: 'rgba(255, 228, 207, 1)',
      earth: 'rgba(255, 195, 195, 1)',
      park_a: '#bbd285',
      park_b: '#bbd285',
      hospital: 'rgba(240, 149, 169, 1)',
      industrial: 'rgba(237, 188, 182, 1)',
      school: 'rgba(254, 185, 100, 1)',
      wood_a: '#d7cc7f',
      wood_b: '#d7cc7f',
      pedestrian: 'rgba(223, 197, 224, 1)',
      scrub_a: '#d8d3a0',
      scrub_b: '#d8d3a0',
      glacier: 'rgba(252, 218, 218, 1)',
      sand: 'rgba(245, 209, 169, 1)',
      beach: 'rgba(241, 225, 144, 1)',
      aerodrome: 'rgba(255, 202, 170, 1)',
      runway: 'rgba(254, 234, 210, 1)',
      water: 'rgba(255, 228, 207, 1)',
      zoo: 'rgba(134, 213, 161, 1)',
      military: 'rgba(227, 203, 171, 1)',
      buildings: 'rgba(229, 101, 114, 1)',
      minor_a: '#FEEBDC',
      minor_b: '#FEEBDC',
      major: 'rgba(254, 235, 220, 1)',
      highway: 'rgba(254, 235, 220, 1)',
      railway: 'rgba(255, 250, 217, 1)',
      boundaries: 'rgba(144, 91, 77, 1)',
      waterway_label: 'rgba(174, 136, 99, 1)',
      roads_label_minor: 'rgba(173, 119, 113, 1)',
      roads_label_minor_halo: 'rgba(254, 235, 220, 1)',
      roads_label_major: 'rgba(173, 119, 113, 1)',
      roads_label_major_halo: 'rgba(254, 235, 220, 1)',
      ocean_label: 'rgba(174, 136, 99, 1)',
      peak_label: 'rgba(119, 92, 47, 1)',
      subplace_label: 'rgba(138, 104, 113, 1)',
      subplace_label_halo: 'rgba(255, 195, 195, 1)',
      city_label: 'rgba(25, 4, 0, 1)',
      city_label_halo: 'rgba(0,0,0,0)',
      state_label: 'rgba(146, 121, 106, 1)',
      state_label_halo: 'rgba(0,0,0,0)',
      country_label: 'rgba(120, 75, 46, 1)',
      address_label: 'black',
      address_label_halo: 'white',
      landcover: {
        grassland: 'rgba(147, 214, 182, 1)',
        barren: 'rgba(246, 204, 157, 1)',
        urban_area: 'rgba(255, 168, 168, 1)',
        farmland: 'rgba(159, 211, 159, 1)',
        glacier: 'rgba(251, 213, 213, 1)',
        scrub: 'rgba(191, 211, 160, 1)',
        forest: 'rgba(136, 210, 168, 1)',
      },
    }),
  },
  {
    id: 'protomaps-flat',
    themeName: 'flat',
    sprite: 'black',
    flavor: customFlavor('dark', {
      background: '#2e2e2e',
      earth: '#2e2e2e',
      park_a: '#383838',
      park_b: '#383838',
      hospital: '#404040',
      industrial: '#383838',
      school: '#404040',
      wood_a: '#383838',
      wood_b: '#383838',
      pedestrian: '#404040',
      scrub_a: '#2e2e2e',
      scrub_b: '#2e2e2e',
      glacier: '#666666',
      sand: '#404040',
      beach: '#404040',
      aerodrome: '#383838',
      runway: '#666666',
      water: '#1d1d1d',
      zoo: '#383838',
      military: '#383838',
      buildings: '#525252',
      other: '#454545',
      minor_service: '#454545',
      minor_a: '#454545',
      minor_b: '#454545',
      link: '#454545',
      major: '#4b4b4b',
      highway: '#494949',
      railway: '#737373',
      boundaries: '#999999',
      waterway_label: '#b3b3b3',
      roads_label_minor: '#e6e6e6',
      roads_label_minor_halo: '#262626',
      roads_label_major: '#e6e6e6',
      roads_label_major_halo: '#262626',
      ocean_label: '#b3b3b3',
      peak_label: '#d9d9d9',
      subplace_label: '#d9d9d9',
      subplace_label_halo: '#262626',
      city_label: '#f2f2f2',
      city_label_halo: '#262626',
      state_label: '#b3b3b3',
      state_label_halo: '#262626',
      country_label: '#b3b3b3',
      address_label: '#d9d9d9',
      address_label_halo: '#262626',
      landcover: {
        grassland: '#323232',
        barren: '#323232',
        urban_area: '#323232',
        farmland: '#323232',
        glacier: '#323232',
        scrub: '#323232',
        forest: '#323232',
      },
    }),
  },
];

async function writeTheme(theme) {
  const style = {
    version: 8,
    metadata: {
      generatedBy: 'scripts/sync-protomaps-styles.mjs',
      flavor: theme.themeName,
      language: LANGUAGE,
    },
    sources: {
      [SOURCE_ID]: {
        type: 'vector',
        attribution: ATTRIBUTION,
        url: TILEJSON_URL,
      },
    },
    sprite: `https://protomaps.github.io/basemaps-assets/sprites/v4/${theme.sprite}`,
    glyphs: GLYPHS_URL,
    layers: layers(SOURCE_ID, theme.flavor, { lang: LANGUAGE }),
  };

  const outPath = join(stylesDir, `${theme.id}.json`);
  await writeFile(outPath, `${JSON.stringify(style, null, 2)}\n`, 'utf8');
  return outPath;
}

await mkdir(stylesDir, { recursive: true });
const written = await Promise.all(THEMES.map(writeTheme));
for (const filePath of written) {
  console.log(`wrote ${filePath}`);
}