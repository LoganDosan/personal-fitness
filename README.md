# personal-fitness

A phone app that tells me what to train today and records what I did.
Live at https://logandosan.github.io/personal-fitness/ (open it in Safari or Chrome, then "Add to Home Screen").

## How it is put together

| Path | What it is |
|---|---|
| `program/program.json` | **The training plan.** Sessions, exercises, substitutes, circuits, morning routine, rebalancing rules. Change the plan here; no code changes needed. |
| `js/engine.js` | Scheduling logic: which session is today, swap and rebalance, weight suggestions. No screen code. |
| `js/app.js` | The screens (Today, Week, Progress, Settings) and button handling. |
| `js/store.js` | Saving to the phone, backup export and restore, CSV export. |
| `js/garmin.js` | Garmin Connect CSV import. |
| `js/charts.js` | The small line charts. |
| `sw.js`, `manifest.webmanifest`, `icons/` | Makes it installable and usable offline. |
| `test/engine.test.js` | Checks for the plan file and the scheduling rules. Run with `npm test` (needs Node 20+). |

There is no build step and there are no dependencies. GitHub Pages serves the files as they are.

## Where my data lives

Everything I log is stored in the browser on my phone (localStorage). Nothing is uploaded, and nothing personal is in this repo.
Use **Settings > Export backup** regularly. Clearing Safari data or deleting the home-screen app deletes the log.

## Changing the program

Ask Claude to edit `program/program.json`. Useful requests:

- "Write Block 2" (attach a backup export so it can see what I actually lifted).
- "My back is worse / better: adjust the exercise menu."
- "Lacrosse is in season: team lifts are now Monday and Thursday, cut my own sessions to two."
- "Add a substitute for X."

The app repeats the last block when the written program runs out, and says so on the Week screen.

### How the rebalancer works (rules live in `program.json` under `rules`)

Each session is scored 0 to 3 for legs, upper body and intensity.

1. When I log something else in place of a session, the missed session slides to the next recovery day this week, unless what I did already covers it.
2. Two hard leg days in a row: the second becomes its lighter version (`lightAlt`). Team lifts are fixed and never changed.
3. More than `maxHardDaysPerWeek` hard days: the lowest-priority remaining session becomes its lighter version.

These are fixed rules, not AI judgment.

### How weight suggestions work

From the last logged session of that lift, the app estimates a one-rep max (Epley formula, counting reps left in the tank from RPE) and works back to the weight for this week's sets, reps and target RPE. Before any history exists it uses the `e1rm` or `start` value in `program.json`.

## Garmin

v1 imports the CSV from Garmin Connect on the web: Activities > All Activities > Export CSV. Runs and swims go into the charts.

A live sync is not built. As far as I know it would need either:

- Garmin's Connect Developer Program (an application Garmin has to approve, plus a server to receive the data; GitHub Pages cannot run a server), or
- Strava as a go-between (Garmin syncs to Strava automatically, and Strava's API is open to individuals), with a small serverless function to hold the API secret.

## Ideas for v2

- Direct .FIT file import, then live Garmin or Strava sync
- Separate charts for easy runs and interval paces; a 2-mile retest at the end of each block
- Rest timer between sets
- Team-lift days picked in Settings instead of by moving days each week
- An in-season block and a travel-week block
- One-tap "summary for Claude" export for writing the next block
- Sync between phone and laptop
