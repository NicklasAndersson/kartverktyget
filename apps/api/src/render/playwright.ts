import { chromium, type Browser } from 'playwright';
import type { Overlays } from '@kvg/shared';

interface RenderArgs {
  style: object;       // Stil-JSON med absoluta tile-URLs (inte en URL-sträng)
  bounds: { west: number; south: number; east: number; north: number };
  widthPx: number;
  heightPx: number;
  overlays: Overlays;
  contours: boolean;
}

const RENDER_TIMEOUT_MS = 45_000;

let browserPromise: Promise<Browser> | null = null;
function getBrowser() {
  if (!browserPromise) browserPromise = chromium.launch({ args: ['--no-sandbox'] });
  return browserPromise;
}

export async function shutdownBrowser() {
  if (browserPromise) {
    const b = await browserPromise;
    await b.close();
    browserPromise = null;
  }
}

/**
 * Renderar en MapLibre-karta vid given bounds och pixelstorlek till en PNG.
 *
 * Strategi: en intern render-sida laddas i headless Chromium. Sidan exponerar en
 * global `window.kvgRender(args)` som mountar MapLibre, sätter exakt bounds, väntar
 * på 'idle' och returnerar när allt är ritat. Sedan tas en screenshot av kartytan.
 */
export async function renderMapPng(args: RenderArgs): Promise<Uint8Array> {
  const browser = await getBrowser();
  const ctx = await browser.newContext({
    viewport: { width: args.widthPx, height: args.heightPx },
    deviceScaleFactor: 1,
  });
  const pageUrl = process.env.RENDER_PAGE_URL ?? 'http://127.0.0.1:8787/render-page/index.html';
  const page = await ctx.newPage();
  try {
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await Promise.race([
      page.evaluate(async (a) => {
        // @ts-expect-error – injicerad i render-page
        await window.kvgRender(a);
      }, args),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`render timeout after ${RENDER_TIMEOUT_MS}ms`)), RENDER_TIMEOUT_MS),
      ),
    ]);
    // Screenshot av hela viewport (kartan fyller hela ytan).
    const buf = await page.screenshot({ type: 'png', omitBackground: false });
    return buf;
  } finally {
    await ctx.close();
  }
}
