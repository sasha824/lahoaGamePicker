#!/usr/bin/env node
/**
 * Logs in to the LAHOA scheduling system (lahoa.timetoscore.com) and prints
 * the first sentence of text shown on the post-login home page.
 *
 * Login flow (reverse-engineered from the provided HAR capture):
 *   1. POST https://lahoa.timetoscore.com/
 *        form fields: username, password, login=""
 *        -> 302 redirect to main.php?user=<username>
 *   2. GET main.php?user=<username>   (a <frameset> page, no visible text)
 *        It loads two frames:
 *          - sidebar.php  (left nav)
 *          - home.php     (main content -- this is where the visible text lives)
 *   3. GET home.php   -> contains the actual welcome message / page content.
 *
 * Credentials are NOT hardcoded. Provide them via environment variables:
 *     LAHOA_USERNAME
 *     LAHOA_PASSWORD
 * or you'll be prompted for them interactively (input is visible, not masked,
 * so it can be pasted/seen while typing).
 *
 * Usage:
 *     node lahoa_login.js
 *     LAHOA_USERNAME=myuser LAHOA_PASSWORD=mypass node lahoa_login.js
 *
 * Requires only Node.js itself -- no npm install needed (Node 18+).
 */

"use strict";

const BASE_URL = "https://lahoa.timetoscore.com";
const LOGIN_URL = `${BASE_URL}/`;
const HOME_URL = `${BASE_URL}/home.php`;

// Headers modeled after the captured browser request so the server treats
// us like a normal browser session.
const BASE_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9," +
    "image/avif,image/webp,image/apng,*/*;q=0.8," +
    "application/signed-exchange;v=b3;q=0.7",
  "Accept-Language": "en-US,en;q=0.9",
};

const BLOCK_LEVEL_TAGS = new Set([
  "p", "div", "br", "h1", "h2", "h3", "h4", "h5", "h6",
  "li", "tr", "table", "ul", "ol", "section", "article",
  "header", "footer", "blockquote", "hr",
]);

/**
 * Reads a line of input from stdin, echoing whatever is typed/pasted.
 * Uses raw stdin reading instead of the readline module, since readline's
 * line-editing mode can be unreliable with Ctrl+V paste in some Windows
 * Command Prompt configurations.
 */
function ask(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    let buffer = "";

    function onData(chunk) {
      buffer += chunk;
      // Treat \n, \r, or \r\n as "submit" (Enter pressed, or a pasted
      // string that itself ends in a newline).
      const newlineIdx = buffer.search(/[\r\n]/);
      if (newlineIdx !== -1) {
        cleanup();
        resolve(buffer.slice(0, newlineIdx).trim());
      }
    }

    function cleanup() {
      process.stdin.removeListener("data", onData);
      process.stdin.pause();
    }

    process.stdin.on("data", onData);
  });
}

async function getCredentials() {
  let username = process.env.LAHOA_USERNAME;
  let password = process.env.LAHOA_PASSWORD;
  if (!username) {
    username = await ask("Username: ");
  }
  if (!password) {
    // Visible input (not masked) so it can be pasted/seen while typing.
    password = await ask("Password: ");
  }
  return { username, password };
}

/** Minimal cookie jar: stores name=value pairs and re-sends them on every request. */
class CookieJar {
  constructor() {
    this.cookies = new Map();
  }
  storeFromResponse(res) {
    const setCookieHeaders = res.headers.getSetCookie
      ? res.headers.getSetCookie()
      : res.headers.raw
      ? res.headers.raw()["set-cookie"] || []
      : [];
    for (const raw of setCookieHeaders) {
      const [pair] = raw.split(";");
      const eqIdx = pair.indexOf("=");
      if (eqIdx === -1) continue;
      const name = pair.slice(0, eqIdx).trim();
      const value = pair.slice(eqIdx + 1).trim();
      this.cookies.set(name, value);
    }
  }
  header() {
    return Array.from(this.cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }
}

async function login(jar, username, password) {
  const body = new URLSearchParams({
    username,
    password,
    login: "",
  }).toString();

  const headers = {
    ...BASE_HEADERS,
    "Content-Type": "application/x-www-form-urlencoded",
    Origin: BASE_URL,
    Referer: LOGIN_URL,
  };
  if (jar.header()) headers["Cookie"] = jar.header();

  // redirect: "manual" so we can capture cookies at each hop and follow
  // the chain ourselves, mirroring how a browser would.
  let res = await fetch(LOGIN_URL, {
    method: "POST",
    headers,
    body,
    redirect: "manual",
  });
  jar.storeFromResponse(res);

  let finalUrl = LOGIN_URL;
  let hops = 0;
  while ([301, 302, 303, 307, 308].includes(res.status) && hops < 5) {
    const location = res.headers.get("location");
    if (!location) break;
    finalUrl = new URL(location, finalUrl).toString();
    const redirHeaders = { ...BASE_HEADERS, Referer: LOGIN_URL };
    if (jar.header()) redirHeaders["Cookie"] = jar.header();
    res = await fetch(finalUrl, { headers: redirHeaders, redirect: "manual" });
    jar.storeFromResponse(res);
    hops += 1;
  }

  return { res, finalUrl };
}

async function fetchHome(jar) {
  const headers = { ...BASE_HEADERS, Referer: `${BASE_URL}/main.php` };
  if (jar.header()) headers["Cookie"] = jar.header();
  const res = await fetch(HOME_URL, { headers });
  if (!res.ok) {
    throw new Error(`Failed to fetch home.php: HTTP ${res.status}`);
  }
  return res.text();
}

/**
 * Strip HTML and pull out the first sentence/line of visible text, without
 * any external HTML-parsing library. Inline tags (e.g. <b>, <font>, <a>)
 * are treated as part of the surrounding text so phrases like
 * "Welcome back <b>Name</b>" stay together. Only block-level tags / <br>
 * introduce a line break.
 */
function extractFirstSentence(html) {
  // Remove <style>, <script>, <head> blocks entirely (including content).
  let cleaned = html.replace(/<style[\s\S]*?<\/style>/gi, "");
  cleaned = cleaned.replace(/<script[\s\S]*?<\/script>/gi, "");
  cleaned = cleaned.replace(/<head[\s\S]*?<\/head>/gi, "");

  // Insert a newline after each block-level tag's closing/self-closing form,
  // so inline tags stay joined but block boundaries become line breaks.
  const blockPattern = new RegExp(
    `</?(?:${Array.from(BLOCK_LEVEL_TAGS).join("|")})\\b[^>]*>`,
    "gi"
  );
  cleaned = cleaned.replace(blockPattern, (match) => `${match}\n`);

  // Strip all remaining tags.
  let text = cleaned.replace(/<[^>]+>/g, "");

  // Decode common HTML entities.
  const entities = {
    "&nbsp;": " ",
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
    "&middot;": "\u00b7",
  };
  text = text.replace(/&[a-zA-Z#0-9]+;/g, (e) => entities[e] ?? e);

  const lines = text
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean);

  if (lines.length === 0) return "";

  const firstLine = lines[0];

  // Within that first line/block, prefer to stop at the first real
  // sentence-ending punctuation if one exists.
  const match = firstLine.match(/.+?[.!?](?=\s|$)/);
  return (match ? match[0] : firstLine).trim();
}

async function run() {
  const { username, password } = await getCredentials();

  const jar = new CookieJar();

  console.error(`Logging in as '${username}'...`);
  const { res: loginRes, finalUrl } = await login(jar, username, password);

  if (!loginRes.ok && ![301, 302, 303, 307, 308].includes(loginRes.status)) {
    console.error(`Login request failed: HTTP ${loginRes.status}`);
    return 1;
  }

  if (!finalUrl.includes("main.php")) {
    console.error(
      `Login may have failed: did not land on main.php (ended up at ${finalUrl}). Check your credentials.`
    );
  }

  console.error("Fetching home page content...");
  const homeHtml = await fetchHome(jar);

  const firstSentence = extractFirstSentence(homeHtml);

  if (firstSentence) {
    console.log(firstSentence);
  } else {
    console.error("Could not find any readable text on the page.");
    return 1;
  }

  return 0;
}

async function main() {
  let exitCode = 0;
  try {
    exitCode = await run();
  } catch (err) {
    console.error(`\nUnexpected error: ${err.message}`);
    exitCode = 1;
  }

  // Keep the window open so the output/error is readable when the script
  // was launched by double-clicking rather than from an existing terminal.
  await ask("\nPress Enter to close...");
  process.exit(exitCode);
}

main();
