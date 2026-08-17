# Revjuvenate Browser Automation (Chrome/Edge extension)

Runs Revjuvenate automation recipes directly in your browser with your own
login and access levels. No local backend required — recipe execution happens
inside the browser tab, with the side panel as the control surface.

## Features

- Standalone Supabase sign-in (session kept in `chrome.storage.session`, cleared on browser close)
- Recipes tab: list/search your `browser_automation_recipes` (mine/shared), view steps, run with variables
- Run view: live step log, conditions, getter values, abort, run history
- Tokens tab: manage `automation_tokens` (static / data-column / login-config / sensitive), generate tokens from a data file (`.xlsx`/`.csv`) — the same import step as the web app
- Token-driven runs: `{{TOKEN}}` placeholders auto-resolve from tokens and from loaded data files (row 1), sensitive values are prompted and never persisted
- AI tab: view AI-assisted recipes from the web app automation builder (read via the `recipes-read` edge function)
- History tab: recent runs from `automation_runs`
- Content-script executor supporting the full legacy action set (click family, inputs, selects, checkboxes, uploads, getters, scrolls, dialogs, loops, `evaluate_js`, navigation waits, iframes)

## Requirements

- Node.js 18+ and npm
- A Supabase project with the Revjuvenate schema (recipes visibility via RLS, `automation_runs`/`automation_run_steps` writable by authenticated users, AI tables behind the `recipes-read` edge function)
- Chrome or Edge (111+ for the MAIN-world dialog shim)

## Setup

```cmd
npm install
copy .env.example .env        :: fill in VITE_SUPABASE_URL + VITE_SUPABASE_PUBLISHABLE_KEY
npm run build
```

Load the unpacked extension from `dist`:
- Chrome: `chrome://extensions` → Developer mode → Load unpacked
- Edge: `edge://extensions` → Developer mode → Load unpacked

## Development

```cmd
npm run dev        :: watch build (crxjs), no HMR — reload the extension manually
npm run typecheck  :: tsc -b
npm run icons      :: regenerate public/icons/*.png
```

## Edge function deployment

The AI tab reads through `supabase/functions/recipes-read` (service role; the
AI tables are FORCE RLS with no client policies). Deploy from this repo root:

```cmd
npx supabase login
npx supabase functions deploy recipes-read --project-ref tpoazafyhrtteqerceuv
```

## Packaging

```cmd
npm run package    :: builds, then packs dist/ into releases/revjuvenate-extension-v<version>.zip
```

The ZIP can be loaded unpacked as-is or uploaded to the Chrome Web Store.

## Permissions & privacy

See [PRIVACY.md](PRIVACY.md) for what the extension accesses and why.

## Project structure

```
src/
  manifest.ts        MV3 manifest (permissions, content scripts, dialog shim)
  background/        service worker: auth + recipe list + tab orchestration
  content/           executor, element finding, dialog shim (MAIN world)
  sidepanel/         React UI: login, recipes, tokens, run, history, AI
  shared/            types, protocol, conditions, token resolver, run logging, labels
assets/              brand logo (source for generated icons)
supabase/functions/recipes-read/   edge function for AI recipe reads
scripts/             icon generation, zip packaging, setup
```

Icons are generated from `assets/revjuvenate-logo.png` (copy it from
`Revjuvenate-Web/src/assets/revjuvenate-logo.png`; `npm run icons` falls back
to that path when the repo-local copy is missing).