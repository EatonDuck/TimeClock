#!/usr/bin/env node
/* ============================================================================
   Rebel Athletics data collector  (runs in GitHub Actions, NOT in the browser)

   Why this exists: browsers refuse to read unlvrebels.com from another origin
   (no CORS headers), and a GitHub Pages site has no backend. This script runs
   on GitHub's servers on a schedule, where CORS does not apply, reads the
   public pages, and writes a small same-origin file:  data/rebels.json
   The page then simply fetches that file.

   Sources (same pages you pointed to):
     /calendar  -> upcoming events  (aria-label "Upcoming Event: ... on <date> at <time>")
     /archives, /news, /  -> news story links  (/news/YYYY/M/D/slug)
   Each recent story page is opened once to read its exact publish time
   (article:published_time / JSON-LD datePublished / <time datetime>).

   Output rules:
     - Never overwrites good data with an empty scrape: if nothing at all could
       be parsed, the script exits with an error so the workflow run turns red.
     - Only writes the file when something changed, or every FORCE_REFRESH_HOURS
       so the page can tell "feed is alive" from "feed is stale".
   Usage:  node scripts/update-data.mjs        (needs Node 18+ and `cheerio`)
   ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as cheerio from 'cheerio';

const BASE = process.env.REBELS_BASE || 'https://unlvrebels.com';   // env override is for local testing only
const TZ = 'America/Los_Angeles';               // Las Vegas local time (PST in winter, PDT in summer)
const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'rebels.json');
const NEWS_KEEP_DAYS = 5;                       // keep a little more than the 48h the page shows
const MAX_ARTICLE_FETCHES = 20;
const FORCE_REFRESH_HOURS = 6;
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 RebelSignageFeed/1.0';

export const SPORTS = ["Baseball","Cheer","Dance","Football","Men's Basketball","Men's Golf","Men's Soccer",
  "Men's Swimming & Diving","Men's Tennis","Softball","Swimming & Diving","Women's Basketball",
  "Women's Cross Country","Women's Golf","Women's Soccer","Women's Swimming & Diving","Women's Tennis",
  "Women's Track & Field","Women's Volleyball"];
const SPORTS_LONGEST_FIRST = SPORTS.slice().sort((a, b) => b.length - a.length);

/* ---------- Las Vegas time helpers ---------- */
function tzOffsetMs(utcMs) {                    // (Las Vegas wall clock) - (UTC), in ms
  const p = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(utcMs));
  const g = t => parseInt(p.find(x => x.type === t).value, 10);
  return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - Math.floor(utcMs / 1000) * 1000;
}
export function lvEpoch(ds, hh = 12, mm = 0) {  // 'YYYY-MM-DD' + Las Vegas clock time -> epoch ms
  const [y, m, d] = ds.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let t = guess - tzOffsetMs(guess);
  t = guess - tzOffsetMs(t);                    // second pass handles DST edges
  return t;
}
export function lvDateStr(ms = Date.now()) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms));
  const g = t => p.find(x => x.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')}`;
}
const MONTHS = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };
function parseLongDate(str) {                   // "Nov 18, 2026" / "April 22, 2027"
  const m = String(str).match(/([A-Za-z]{3})[A-Za-z]*\.?\s+(\d{1,2}),\s*(\d{4})/);
  const mo = m && MONTHS[m[1].toLowerCase()];
  return mo ? `${m[3]}-${String(mo).padStart(2, '0')}-${String(parseInt(m[2], 10)).padStart(2, '0')}` : null;
}
function parseTimeToMin(text) {
  if (!text || /\bor\b/i.test(text)) return null;
  const m = String(text).match(/(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m/i);
  if (!m) return null;
  return (parseInt(m[1], 10) % 12 + (m[3].toLowerCase() === 'p' ? 12 : 0)) * 60 + (m[2] ? parseInt(m[2], 10) : 0);
}

/* ---------- parsers (exported so they can be unit-tested with fixtures) ---------- */
export function parseCalendar(html) {
  const $ = cheerio.load(html);
  const out = [], seen = new Set();
  $('li').each((_, li) => {
    const $li = $(li);
    const label = `${$li.attr('aria-label') || ''} ${$li.text() || ''}`.replace(/\s+/g, ' ');
    const m = label.match(/Upcoming Event:\s*(.+?)\s+on\s+([A-Za-z]+\.?\s+\d{1,2},\s*\d{4})(?:\s+at\s+(.+?))?\s*(?:Tickets|Watch|Listen|Stats|$)/i);
    if (!m) return;
    const body = m[1].trim();
    const sport = SPORTS_LONGEST_FIRST.find(s => body.toLowerCase().startsWith(s.toLowerCase()));
    if (!sport) return;
    const rest = body.slice(sport.length).trim();
    const rm = rest.match(/^(versus|vs\.?|at)\s+(.+)$/i);
    const rel = rm && /^at$/i.test(rm[1]) ? 'at' : 'vs';
    const opp = (rm ? rm[2] : rest).trim();
    const ds = parseLongDate(m[2]);
    if (!ds || !opp) return;
    const timeText = (m[3] || 'TBA').replace(/[,\s]+$/, '').trim();
    const links = $li.find('a').map((__, a) => $(a).text().trim().toLowerCase()).get();
    const flags = (links.includes('tickets') ? 'T' : '') + (links.includes('watch') ? 'W' : '') +
                  (links.includes('listen') ? 'L' : '') + (links.includes('stats') ? 'S' : '');
    let logo = null;
    const img = $li.find('img[src*="sidearmdev"], img[src*="cloudfront"], img[data-src*="sidearmdev"], img[data-src*="cloudfront"]').first();
    if (img.length) {
      logo = (img.attr('src') || img.attr('data-src') || '').replace(/width=\d+/, 'width=200').replace(/height=\d+/, 'height=200');
      if (logo.startsWith('//')) logo = 'https:' + logo;
      else if (logo.startsWith('/')) logo = BASE + logo;
    }
    const key = ds + sport + opp;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ ds, timeText, sport, rel, opp, logo: logo || null, flags });
  });
  return out;
}

export function parseNewsLinks(html) {
  const $ = cheerio.load(html);
  const out = [], seen = new Set();
  $('a[href*="/news/"]').each((_, a) => {
    const href = $(a).attr('href') || '';
    const m = href.match(/\/news\/(\d{4})\/(\d{1,2})\/(\d{1,2})\/([a-z0-9-]+)/i);
    if (!m) return;
    const title = ($(a).attr('title') || $(a).attr('aria-label') || $(a).text() || '').replace(/\s+/g, ' ').trim();
    if (title.length < 15 || seen.has(m[4])) return;
    seen.add(m[4]);
    const ds = `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
    const abs = href.startsWith('http') ? href : BASE + (href.startsWith('/') ? '' : '/') + href;
    out.push({ title, slug: m[4], ds, url: abs.split('#')[0] });
  });
  return out;
}

export function parsePublishedTime(html) {      // -> epoch ms or null
  const $ = cheerio.load(html);
  const cands = [
    $('meta[property="article:published_time"]').attr('content'),
    $('meta[itemprop="datePublished"]').attr('content'),
    $('meta[name="date"]').attr('content'),
    $('time[datetime]').first().attr('datetime')
  ];
  $('script[type="application/ld+json"]').each((_, s) => {
    try {
      const walk = o => { if (!o || typeof o !== 'object') return;
        if (o.datePublished) cands.push(o.datePublished);
        (Array.isArray(o) ? o : Object.values(o)).forEach(walk); };
      walk(JSON.parse($(s).contents().text()));
    } catch { /* ignore bad JSON-LD */ }
  });
  for (const c of cands) {
    if (!c) continue;
    const t = Date.parse(c);
    // A bare "2026-11-18" date has no clock time -> not precise enough
    if (Number.isFinite(t) && /\d{2}:\d{2}/.test(c)) return t;
  }
  return null;
}

/* ---------- network ---------- */
async function get(url, ms = 20000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctl.signal, redirect: 'follow',
      headers: { 'user-agent': UA, 'accept': 'text/html,application/xhtml+xml', 'accept-language': 'en-US,en;q=0.9' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally { clearTimeout(timer); }
}
async function tryGet(url) {
  try { return await get(url); } catch (e) { console.warn(`  ! ${url} -> ${e.message}`); return null; }
}

/* ---------- main ---------- */
async function main() {
  const now = Date.now();
  const today = lvDateStr(now);
  const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { events: [], news: [] };

  console.log('Calendar…');
  const calHtml = await tryGet(BASE + '/calendar');
  let events = calHtml ? parseCalendar(calHtml) : [];
  const scrapedEvents = events.length;
  console.log(`  ${events.length} events`);

  console.log('News links…');
  const found = new Map();
  for (const p of ['/', '/news', '/archives', '/calendar']) {
    const html = p === '/calendar' ? calHtml : await tryGet(BASE + p);
    if (!html) continue;
    const list = parseNewsLinks(html);
    console.log(`  ${p}: ${list.length} story links`);
    list.forEach(n => { if (!found.has(n.slug)) found.set(n.slug, n); });
  }

  const scrapedLinks = found.size;
  const oldestDs = lvDateStr(now - NEWS_KEEP_DAYS * 86400000);
  const recent = [...found.values()].filter(n => n.ds >= oldestDs).sort((a, b) => b.ds.localeCompare(a.ds)).slice(0, MAX_ARTICLE_FETCHES);
  const prevBySlug = new Map((prev.news || []).map(n => [n.slug, n]));
  const news = [];
  for (const n of recent) {
    const old = prevBySlug.get(n.slug);
    let ts = old && old.precise ? Date.parse(old.publishedAt) : null;       // don't re-fetch what we already know exactly
    if (ts === null) { const html = await tryGet(n.url); ts = html ? parsePublishedTime(html) : null; }
    news.push({ title: n.title, slug: n.slug, url: n.url,
      publishedAt: new Date(ts ?? lvEpoch(n.ds, 12, 0)).toISOString(), precise: ts !== null });
  }
  // keep earlier stories that dropped off the front pages but are still inside the keep window
  for (const old of prev.news || []) {
    if (!news.some(n => n.slug === old.slug) && old.publishedAt >= new Date(now - NEWS_KEEP_DAYS * 86400000).toISOString()) news.push(old);
  }
  news.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  console.log(`  ${news.length} stories kept (${news.filter(n => n.precise).length} with exact time)`);

  // Calendar pages usually drop an event once it starts. Carry today's recently-started
  // events over from the previous run so "Rebels Today" doesn't lose a game mid-day.
  if (events.length) {
    for (const o of prev.events || []) {
      if (o.ds !== today || events.some(e => e.ds === o.ds && e.sport === o.sport && e.opp === o.opp)) continue;
      const min = parseTimeToMin(o.timeText);
      if (min === null || lvEpoch(o.ds, Math.floor(min / 60), min % 60) > now - 6 * 3600000) events.push(o);
    }
  } else {
    events = (prev.events || []).filter(e => e.ds >= today);                  // scrape failed: keep still-future events only
  }

  // Judge success on what was actually scraped THIS run, not on recycled data: if the site
  // blocked us or its layout changed, fail loudly (red workflow run) instead of looking healthy.
  if (!scrapedEvents && !scrapedLinks) {
    console.error('Nothing could be parsed from unlvrebels.com (blocked, or the page layout changed). Leaving data/rebels.json untouched.');
    process.exit(1);
  }

  events.sort((a, b) => a.ds.localeCompare(b.ds));
  const next = {
    generatedAt: new Date(now).toISOString(),
    timezone: TZ,
    coveredThrough: events.length ? events[events.length - 1].ds : null,
    events, news
  };
  const strip = o => JSON.stringify({ ...o, generatedAt: null });
  const ageH = prev.generatedAt ? (now - Date.parse(prev.generatedAt)) / 3600000 : Infinity;
  if (strip(next) === strip(prev) && ageH < FORCE_REFRESH_HOURS) { console.log('No changes — not writing.'); return; }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(next, null, 1) + '\n');
  console.log(`Wrote ${path.relative(process.cwd(), OUT)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(e); process.exit(1); });
}
