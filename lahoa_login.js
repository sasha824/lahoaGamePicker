#!/usr/bin/env node
/**
 * LAHOA unassigned games notifier.
 * Logs in, filters games by chosen leagues, sends matches to Telegram.
 *
 * When run locally: reads from lahoa_config.json (interactive setup on first run).
 * When run on Railway: reads from environment variables.
 *
 * Environment variables (set these in Railway):
 *   LAHOA_USERNAME
 *   LAHOA_PASSWORD
 *   TELEGRAM_TOKEN
 *   TELEGRAM_CHAT_ID
 *   LEAGUES  (comma-separated, e.g. "TRYHL,AIAHL")
 *   LINESMAN_ONLY  (optional, "true" = only games with an open linesman spot;
 *                   locally you're asked each run and the answer is saved)
 */

"use strict";

const fs   = require("fs");
const path = require("path");

const CONFIG_FILE  = path.join(__dirname, "lahoa_config.json");
const STATE_FILE   = path.join(__dirname, "lahoa_sent.json");
const BASE_URL     = "https://lahoa.timetoscore.com";
const LOGIN_URL    = `${BASE_URL}/`;
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

// Detect Railway by checking any of the env vars we set ourselves
const ON_RAILWAY = !!(
  process.env.RAILWAY_ENVIRONMENT ||
  process.env.RAILWAY_PROJECT_ID ||
  process.env.LAHOA_USERNAME  // if env vars are set, we're definitely not local
);

// --auto = unattended mode for Task Scheduler: no prompts, uses saved config,
// only messages about games not already sent.
const AUTO = process.argv.includes("--auto");

console.log(`Starting LAHOA notifier... (${new Date().toLocaleString()}) (Railway mode: ${ON_RAILWAY}, auto: ${AUTO})`);
console.log(`LAHOA_USERNAME set: ${!!process.env.LAHOA_USERNAME}`);
console.log(`TELEGRAM_TOKEN set: ${!!process.env.TELEGRAM_TOKEN}`);
console.log(`LEAGUES: ${process.env.LEAGUES || "(not set)"}`);

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

// ── Config ───────────────────────────────────────────────────────────────────

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); }
  catch { return null; }
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");
}

async function getConfig() {
  // On Railway: read purely from environment variables, no file/prompts
  if (ON_RAILWAY) {
    const leagues = (process.env.LEAGUES || "").split(",").map(l => l.trim()).filter(Boolean);
    return {
      lahoa_username:   process.env.LAHOA_USERNAME,
      lahoa_password:   process.env.LAHOA_PASSWORD,
      telegram_token:   process.env.TELEGRAM_TOKEN,
      telegram_chat_id: process.env.TELEGRAM_CHAT_ID,
      leagues,
    };
  }

  // Local: use config file, prompt if missing
  const saved = loadConfig();
  if (saved && saved.lahoa_username && saved.lahoa_password) {
    console.log("Loaded saved credentials from lahoa_config.json");
    return saved;
  }

  if (AUTO) {
    throw new Error("No saved credentials. Run run_lahoa_login_js.bat once (without --auto) to set up first.");
  }

  console.log("\nFirst run — enter your details. They'll be saved for next time.\n");
  const config = {
    ...(saved || {}),
    lahoa_username:   saved?.lahoa_username   || await ask("LAHOA username: "),
    lahoa_password:   saved?.lahoa_password   || await ask("LAHOA password: "),
    telegram_token:   saved?.telegram_token   || await ask("Telegram bot token: "),
    telegram_chat_id: saved?.telegram_chat_id || await ask("Telegram chat ID: "),
    leagues:          saved?.leagues          || [],
  };
  saveConfig(config);
  console.log(`\nSaved to ${CONFIG_FILE}\n`);
  return config;
}

// ── Sent-games state (auto mode) ─────────────────────────────────────────────

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); }
  catch { return {}; }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

function gameKey(game) {
  return `${game["Game"]}|${game["Date"]}|${game["Time"]}`;
}

// ── League picker (local only) ───────────────────────────────────────────────

async function pickLeagues(allGames, config) {
  const available = [...new Set(allGames.map(g => g["League"]).filter(Boolean))].sort();
  if (available.length === 0) {
    console.log("\nNo leagues found in unassigned games.");
    return [];
  }

  console.log("\n" + "─".repeat(52));
  console.log("Which leagues do you want to be notified about?");
  console.log("(Enter numbers separated by spaces, e.g. 1 3)");
  console.log("─".repeat(52));
  available.forEach((league, i) => {
    const check = (config.leagues || []).includes(league) ? " ✓" : "";
    console.log(`  ${i + 1}) ${league}${check}`);
  });
  console.log("─".repeat(52));

  if (config.leagues && config.leagues.length > 0) {
    const stillValid = config.leagues.filter(l => available.includes(l));
    if (stillValid.length > 0) {
      console.log(`Currently selected: ${stillValid.join(", ")}`);
      const keep = await ask("Keep this selection? (y to keep / enter new numbers): ");
      if (keep.toLowerCase() === "y" || keep.toLowerCase() === "yes") {
        return stillValid;
      }
    }
  }

  const input = await ask("Enter numbers: ");
  const picks = input.split(/[\s,]+/).map(n => parseInt(n)).filter(n => !isNaN(n) && n >= 1 && n <= available.length);
  const chosen = [...new Set(picks.map(n => available[n - 1]))];
  if (chosen.length === 0) {
    console.log("No valid selection made.");
    return [];
  }

  config.leagues = chosen;
  saveConfig(config);
  console.log(`\nSaved league selection: ${chosen.join(", ")}\n`);
  return chosen;
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

function textOf(html) {
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

function parseUnassignedGames(html) {
  const tableMatch = html.match(/<table[\s\S]*?<\/table>/i);
  if (!tableMatch) return [];
  const rows = [...tableMatch[0].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map(m => m[1]);
  if (rows.length < 2) return [];
  const headers = [...rows[1].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)]
    .map(m => textOf(m[1]))
    .map((h, i, arr) => {
      const count = arr.slice(0, i).filter(x => x === h).length;
      return count > 0 ? `${h} ${count + 1}` : h;
    });
  const games = [];
  for (const row of rows.slice(2)) {
    const cellMatches = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)];
    if (!cellMatches.length) continue;
    const cells = cellMatches.map(m => textOf(m[1]));
    const game = {};
    headers.forEach((h, i) => { game[h] = cells[i] ?? ""; });

    // Detect request status from the last cell's link text:
    // "Unrequest Game" = already requested, "Request Game" = not yet requested
    const lastCellHtml = cellMatches[cellMatches.length - 1][1];
    game["Status"] = /unrequest/i.test(lastCellHtml) ? "REQUESTED" : "NEW";

    games.push(game);
  }
  return games;
}

// ── Telegram ─────────────────────────────────────────────────────────────────

async function sendMessage(config, message) {
  const url = `https://api.telegram.org/bot${config.telegram_token}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: config.telegram_chat_id, text: message }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Telegram error ${res.status}: ${err.description || res.statusText}`);
  }
}

// ── Display ──────────────────────────────────────────────────────────────────

function hasOpenLinesman(game) {
  return !game["Linesman"] || !game["Linesman 2"];
}

function formatGame(game) {
  const line = "─".repeat(52);
  return [
    line,
    `Status   : ${game["Status"]}`,
    `Game #   : ${game["Game"]}`,
    `Date     : ${game["Date"]}  ${game["Time"]}`,
    `Rink     : ${game["Rink"]}`,
    `League   : ${game["League"]}`,
    `Level    : ${game["Level"]}`,
    `Away     : ${game["Away"]       || "(TBD)"}`,
    `Home     : ${game["Home"]       || "(TBD)"}`,
    `Type     : ${game["Type"]}`,
    `Referee  : ${game["Referee"]    || "(open)"}`,
    `Referee 2: ${game["Referee 2"]  || "(open)"}`,
    `Linesman : ${game["Linesman"]   || "(open)"}`,
    `Linesman2: ${game["Linesman 2"] || "(open)"}`,
  ].join("\n");
}

function formatGameSMS(game) {
  return [
    ...(hasOpenLinesman(game) ? ["*** LINESMAN OPEN ***"] : []),
    `[${game["Status"]}] Game: ${game["Game"]}`,
    `${game["Date"]} ${game["Time"]}`,
    `Rink: ${game["Rink"]}`,
    `Level: ${game["Level"]}`,
    `${game["Away"] || "TBD"} vs ${game["Home"] || "TBD"}`,
    `Refs: ${game["Referee"] || "open"} / ${game["Referee 2"] || "open"}`,
    `Lines: ${game["Linesman"] || "open"} / ${game["Linesman 2"] || "open"}`,
  ].join("\n");
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  const config = await getConfig();
  const jar = new CookieJar();

  console.log(`Logging in as '${config.lahoa_username}'...`);
  const { finalUrl } = await login(jar, config.lahoa_username, config.lahoa_password);
  if (!finalUrl.includes("main.php")) {
    console.error("Login may have failed — did not land on main.php.");
    return 1;
  }

  console.log("Fetching unassigned games...");
  const html = await fetchPage(jar, SCHEDULE_URL, `${BASE_URL}/sidebar.php`);
  const allGames = parseUnassignedGames(html);

  // On Railway use env var leagues; locally use interactive picker
  let chosenLeagues;
  if (ON_RAILWAY) {
    chosenLeagues = config.leagues;
    console.log(`Filtering for leagues: ${chosenLeagues.join(", ")}`);
  } else if (AUTO) {
    chosenLeagues = config.leagues || [];
    console.log(`Filtering for leagues: ${chosenLeagues.join(", ")}`);
  } else {
    chosenLeagues = await pickLeagues(allGames, config);
  }

  if (!chosenLeagues || chosenLeagues.length === 0) {
    console.log("No leagues selected.");
    return 0;
  }

  let linesmanOnly;
  if (ON_RAILWAY) {
    linesmanOnly = process.env.LINESMAN_ONLY === "true";
  } else if (AUTO) {
    linesmanOnly = config.linesman_only === true;
  } else {
    const current = config.linesman_only === true;
    const answer = (await ask(
      `\nOnly show games with an open linesman spot? (y/n, enter = ${current ? "y" : "n"}): `
    )).toLowerCase();
    if (answer === "y" || answer === "yes") linesmanOnly = true;
    else if (answer === "n" || answer === "no") linesmanOnly = false;
    else linesmanOnly = current;
    config.linesman_only = linesmanOnly;
    saveConfig(config);
  }
  const leagueGames = allGames.filter(g => chosenLeagues.includes(g["League"]));

  // Games with an open linesman spot first (sort is stable, so schedule order is kept within each group)
  const matchingGames = (linesmanOnly ? leagueGames.filter(hasOpenLinesman) : [...leagueGames])
    .sort((a, b) => hasOpenLinesman(b) - hasOpenLinesman(a));

  // Diagnostics: shows where games get filtered out
  console.log(`Total unassigned games parsed: ${allGames.length}`);
  console.log(`Leagues found on site: ${[...new Set(allGames.map(g => g["League"]))].join(", ") || "(none)"}`);
  console.log(`In your leagues (${chosenLeagues.join(", ")}): ${leagueGames.length}`);
  console.log(`With an open linesman spot: ${leagueGames.filter(hasOpenLinesman).length}`);
  console.log(`Linesman-only filter: ${linesmanOnly ? "ON" : "OFF"}`);
  if (leagueGames[0]) {
    console.log(`Sample linesman values: Linesman=${JSON.stringify(leagueGames[0]["Linesman"])} Linesman 2=${JSON.stringify(leagueGames[0]["Linesman 2"])}`);
    console.log(`Column names: ${Object.keys(leagueGames[0]).join(", ")}`);
  }

  // Auto mode: only notify about new games, or games whose linesman spot just opened up.
  const state = AUTO ? loadState() : {};
  let toSend = matchingGames;
  if (AUTO) {
    toSend = matchingGames.filter(g => {
      const prev = state[gameKey(g)];
      return !prev || (!prev.open && hasOpenLinesman(g));
    });
  }

  if (toSend.length === 0) {
    if (AUTO) {
      console.log("No new games to report.");
    } else {
      console.log(`No unassigned games found for: ${chosenLeagues.join(", ")}`);
      if (ON_RAILWAY) {
        await sendMessage(config, `LAHOA: No unassigned games for ${chosenLeagues.join(", ")}`);
      }
    }
  } else {
    console.log(`Found ${toSend.length} game(s):\n`);
    for (const game of toSend) {
      console.log(formatGame(game));
    }
    console.log("─".repeat(52));

    console.log("\nSending Telegram message(s)...");
    for (let i = 0; i < toSend.length; i++) {
      const game = toSend[i];
      const msg = `LAHOA ${game["League"]} (${i + 1}/${toSend.length})\n\n${formatGameSMS(game)}`;
      await sendMessage(config, msg);
      console.log(`  Sent game ${i + 1} of ${toSend.length}`);
      if (AUTO) {
        state[gameKey(game)] = { open: hasOpenLinesman(game) };
        saveState(state);
      }
    }
    console.log("Done!");
  }

  if (AUTO) {
    // Record every league game's current state (so a later opening is detected),
    // and drop games that are no longer on the schedule.
    const next = {};
    for (const g of leagueGames) {
      const k = gameKey(g);
      next[k] = state[k] && toSend.includes(g) ? state[k] : (state[k] || { open: hasOpenLinesman(g) });
      if (!toSend.includes(g)) next[k] = { open: hasOpenLinesman(g) };
    }
    saveState(next);
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

  if (!ON_RAILWAY && !AUTO) {
    await ask("\nPress Enter to close...");
  }

  process.exit(exitCode);
}

main();
