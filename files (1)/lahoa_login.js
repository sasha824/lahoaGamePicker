#!/usr/bin/env node
/**
 * Logs in to the LAHOA scheduling system (lahoa.timetoscore.com),
 * fetches the Unassigned Games page, and prints all games whose
 * league is "TRYHL".
 *
 * Usage:
 *     node lahoa_login.js
 *
 * No npm packages required — uses only built-in Node.js (v18+).
 */

"use strict";

const BASE_URL  = "https://lahoa.timetoscore.com";
const LOGIN_URL = `${BASE_URL}/`;
const SCHEDULE_URL = `${BASE_URL}/show-schedule.php?anchor=current&official_id=1`;

const BASE_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9," +
    "image/avif,image/webp,image/apng,*/*;q=0.8," +
    "application/signed-exchange;v=b3;q=0.7",
  "Accept-Language": "en-US,en;q=0.9",
};

// ── Input ────────────────────────────────────────────────────────────────────

function ask(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    let buffer = "";
    function onData(chunk) {
      buffer += chunk;
      const nl = buffer.search(/[\r\n]/);
      if (nl !== -1) {
        process.stdin.removeListener("data", onData);
        process.stdin.pause();
        resolve(buffer.slice(0, nl).trim());
      }
    }
    process.stdin.on("data", onData);
  });
}

async function getCredentials() {
  const username = process.env.LAHOA_USERNAME || await ask("Username: ");
  const password = process.env.LAHOA_PASSWORD || await ask("Password: ");
  return { username, password };
}

// ── Cookie jar ───────────────────────────────────────────────────────────────

class CookieJar {
  constructor() { this.cookies = new Map(); }
  store(res) {
    const headers = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const raw of headers) {
      const [pair] = raw.split(";");
      const eq = pair.indexOf("=");
      if (eq === -1) continue;
      this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }
  header() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  headers(extra = {}) {
    const h = { ...BASE_HEADERS, ...extra };
    if (this.header()) h["Cookie"] = this.header();
    return h;
  }
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

async function fetchFollowing(jar, url, options = {}) {
  let res = await fetch(url, { ...options, redirect: "manual" });
  jar.store(res);
  let hops = 0;
  while ([301, 302, 303, 307, 308].includes(res.status) && hops++ < 5) {
    const loc = res.headers.get("location");
    if (!loc) break;
    url = new URL(loc, url).toString();
    res = await fetch(url, { headers: jar.headers({ Referer: url }), redirect: "manual" });
    jar.store(res);
  }
  return { res, finalUrl: url };
}

async function login(jar, username, password) {
  const body = new URLSearchParams({ username, password, login: "" }).toString();
  return fetchFollowing(jar, LOGIN_URL, {
    method: "POST",
    headers: jar.headers({
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: BASE_URL,
      Referer: LOGIN_URL,
    }),
    body,
  });
}

async function fetchPage(jar, url, referer) {
  const res = await fetch(url, { headers: jar.headers({ Referer: referer }) });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.text();
}

// ── HTML parsing ─────────────────────────────────────────────────────────────

/** Extract text from an HTML snippet, decoding common entities. */
function text(html) {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parse the Unassigned Games table from the schedule page HTML.
 * Returns an array of objects keyed by the column headers.
 */
function parseUnassignedGames(html) {
  // Grab the single <table> on the page
  const tableMatch = html.match(/<table[\s\S]*?<\/table>/i);
  if (!tableMatch) return [];

  // Pull all <tr> blocks
  const rows = [...tableMatch[0].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map(m => m[1]);
  if (rows.length < 2) return [];

  // Row 0 is the title ("Unassigned Games"), row 1 is the header row
  const headers = [...rows[1].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)]
    .map(m => text(m[1]))
    .map((h, i, arr) => {
      // The two "Linesman" headers and two "Referee" headers are duplicated;
      // make them unique so we can use them as keys.
      const count = arr.slice(0, i).filter(x => x === h).length;
      return count > 0 ? `${h} ${count + 1}` : h;
    });

  const games = [];
  for (const row of rows.slice(2)) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m => text(m[1]));
    if (cells.length === 0) continue;
    const game = {};
    headers.forEach((h, i) => { game[h] = cells[i] ?? ""; });
    games.push(game);
  }
  return games;
}

// ── Display ──────────────────────────────────────────────────────────────────

function printGame(game) {
  const line = "─".repeat(52);
  console.log(line);
  console.log(`Game #   : ${game["Game"]}`);
  console.log(`Date     : ${game["Date"]}  ${game["Time"]}`);
  console.log(`Rink     : ${game["Rink"]}`);
  console.log(`League   : ${game["League"]}`);
  console.log(`Level    : ${game["Level"]}`);
  console.log(`Away     : ${game["Away"] || "(TBD)"}`);
  console.log(`Home     : ${game["Home"] || "(TBD)"}`);
  console.log(`Type     : ${game["Type"]}`);
  console.log(`Referee  : ${game["Referee"]  || "(open)"}`);
  console.log(`Referee 2: ${game["Referee 2"] || "(open)"}`);
  console.log(`Linesman : ${game["Linesman"]  || "(open)"}`);
  console.log(`Linesman2: ${game["Linesman 2"] || "(open)"}`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  const { username, password } = await getCredentials();
  const jar = new CookieJar();

  console.error(`\nLogging in as '${username}'...`);
  const { finalUrl } = await login(jar, username, password);
  if (!finalUrl.includes("main.php")) {
    console.error("Login may have failed — did not land on main.php.");
    console.error(`Landed at: ${finalUrl}`);
    return 1;
  }

  console.error("Fetching unassigned games...");
  const html = await fetchPage(jar, SCHEDULE_URL, `${BASE_URL}/sidebar.php`);

  const allGames = parseUnassignedGames(html);
  const tryhlGames = allGames.filter(g => g["League"] === "TRYHL");

  if (tryhlGames.length === 0) {
    console.log("\nNo unassigned TRYHL games found.");
  } else {
    console.log(`\nFound ${tryhlGames.length} unassigned TRYHL game(s):\n`);
    tryhlGames.forEach(printGame);
    console.log("─".repeat(52));
  }

  return 0;
}

async function main() {
  let exitCode = 0;
  try {
    exitCode = await run();
  } catch (err) {
    console.error(`\nError: ${err.message}`);
    exitCode = 1;
  }
  await ask("\nPress Enter to close...");
  process.exit(exitCode);
}

main();
