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

## Notes

- Login flow was reverse-engineered from a captured HAR file.
- No third-party dependencies; only Node's built-in `fetch`.
