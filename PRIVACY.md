# Privacy notes

## Data the extension handles

- **Recipes**: recipe names, steps (locators, values, conditions) from
  `browser_automation_recipes`, fetched over authenticated Supabase queries.
  Visibility is enforced server-side by Row Level Security — the extension
  never sees recipes the account cannot access.
- **Variables**: values you enter for a recipe's `replace_map` placeholders.
  If "Remember these values" is checked they are stored in
  `chrome.storage.local` (device-local, keyed per user + recipe). Uncheck to
  keep them session-only.
- **Tokens**: token definitions are stored in your Supabase project
  (`automation_tokens`, RLS-scoped to your account). Static values are stored
  there too — only store non-secrets as static tokens (the web app warns the
  same way). Sensitive tokens are never persisted in the extension: their
  values are prompted before each run and discarded.
- **Data files**: when you load an XLSX/CSV file for a run (or to generate
  tokens), it is parsed **entirely in the browser** — rows are held in memory
  only, never uploaded, and never written to storage. Only the generated
  token definitions (name + column header) are saved to your Supabase
  project, matching the web app.
- **Run history**: when you run a recipe, a summary (recipe, target URL,
  variable values, per-step status/messages/durations) is written to the
  `automation_runs` / `automation_run_steps` tables in your own Supabase
  project, same as runs started from the Revjuvenate web app.
- **Auth session**: stored in `chrome.storage.session` (cleared automatically
  when the browser closes) and used only to authenticate against your
  Supabase project.

The extension performs **no analytics, no tracking, no third-party network
calls** other than your own Supabase project (and the pages your recipes
operate on).

## Permissions requested and why

| Permission | Why |
| --- | --- |
| `sidePanel` | Open the control panel next to the browser |
| `storage` | Persist the auth session and remembered variables |
| `activeTab` | Interact with the tab a run is started from |
| `tabs` | Create/navigate/close tabs during recipe runs |
| `scripting` | Inject the recipe executor (`evaluate_js`, content execution) |
| `host_permissions: <all_urls>` | Recipes may target any URL; the executor must be injected into the recipe's target page to read/click elements, handle uploads and dialogs |

`<all_urls>` is required because recipes are user-authored with arbitrary
target URLs (e.g. supplier extranets, PMS dashboards). The executor is only
injected into tabs you explicitly run a recipe against — the extension does
not read or modify pages outside an active run.

## What the extension does NOT do

- Does not collect or transmit browsing history
- Does not upload page contents outside the recipe steps you run (a run may
  read elements/values you defined in the recipe, which is the recipe's
  purpose)
- Does not include cookies or credentials in any sync payload
- Does not run in the background outside user-initiated runs

## Questions

Contact your Revjuvenate administrator for questions about the Supabase
project this extension connects to.