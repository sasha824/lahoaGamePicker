# lahoaGamePicker

A small Node.js script that logs in to the LAHOA scheduling system
(`lahoa.timetoscore.com`) and prints the first sentence of text shown on the
post-login home page.

## How it works

1. `POST https://lahoa.timetoscore.com/` with `username`, `password`, and
   `login=""` — this returns a `302` redirect to `main.php?user=<username>`.
2. `GET main.php?user=<username>` — a `<frameset>` page (no visible text)
   that loads two frames: `sidebar.php` and `home.php`.
3. `GET home.php` — the actual page content lives here, and its first
   sentence is printed to stdout.

## Requirements

- Node.js 18+ (uses the built-in `fetch` API — no npm install needed)

## Usage

Credentials are **not** hardcoded. Provide them via environment variables:

```bash
LAHOA_USERNAME=myuser LAHOA_PASSWORD=mypass node lahoa_login.js
```

Or just run it and you'll be prompted interactively (input is visible, not
masked, so it can be pasted/seen while typing):

```bash
node lahoa_login.js
```

### Windows

Double-click `run_lahoa_login_js.bat`, or run it from a Command Prompt. It
calls `node lahoa_login.js` and keeps the window open afterward so you can
read the output.

## Files

- `lahoa_login.js` — main script
- `run_lahoa_login_js.bat` — Windows launcher
- `package.json` — lets Railway (or any Node host) recognize this as a Node app
- `railway.json` — configures this to run as a daily scheduled job on Railway

## Running on a schedule (Railway)

This script is a one-shot CLI tool, not a web server, so on Railway it's
deployed as a **cron job** rather than a normal web service.

1. In the Railway project, go to the service's **Settings** and set the two
   required environment variables:
   - `LAHOA_USERNAME`
   - `LAHOA_PASSWORD`
2. `railway.json` in this repo tells Railway to run `node lahoa_login.js`
   twice a day, at 8:00 AM and 8:00 PM **Pacific time** (`0 15,3 * * *` in
   UTC, which is what Railway's cron schedule always uses). Change the
   `cronSchedule` value to run at different times.

   ⚠️ Because this is written in UTC, it will be off by an hour for part
   of the year around Daylight Saving time changes (Railway's cron does
   not auto-adjust for time zones). If that matters to you, just let me
   know and I can help you update it twice a year, or switch to a fixed
   UTC time instead.
3. When running non-interactively like this, the script will error out
   immediately if either environment variable is missing, instead of
   hanging while waiting for someone to type a password.

## Notes

- Login flow was reverse-engineered from a captured HAR file.
- No third-party dependencies; only Node's built-in `fetch`.
