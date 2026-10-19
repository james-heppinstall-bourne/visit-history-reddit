# Visit History: Reddit listener

Finds Reddit threads where Visit History is a genuine answer to a question
somebody has already asked, and prints them ranked. Read only by
construction: it cannot post, vote or comment.

One file, no dependencies beyond Node 18 or later.

## Two ways in

The script picks by whether `REDDIT_CLIENT_ID` is set in `.env`:

| | API | Public feeds (RSS) |
|---|---|---|
| Needs | An API app, which since 2025 Reddit will not create until the account is approved under its Responsible Builder Policy | Nothing |
| Speed | A minute or two | **One request a minute** is all Reddit allows an anonymous address, so a run is 50 to 60 requests and takes most of an hour |
| Knows | Everything | No comment counts, so that part of the score is skipped |

As of 19 Oct 2026 the app cannot be created (the form answers `success:
true` and does nothing until the account is approved), so the feeds are what
runs. Once approval lands, put the id in `.env` and nothing else changes.

## Running it

**Reddit listener** on the Desktop is a shortcut to `Reddit listener.cmd`.
It opens the last `report.txt` in Notepad, then asks whether to run a fresh
search now.

`report.txt` comes from **`Reddit listener (scheduled).cmd`**, which Task
Scheduler runs daily at 05:00 as "Visit History Reddit listener" (last 7
days, everything, not only what is new). It runs only while you are logged
in. Its console output goes to `run.log`. To remove it:
`schtasks /Delete /TN "Visit History Reddit listener" /F`.

From a terminal in this folder:

```
node reddit-listen.mjs                 # last 7 days, new only
node reddit-listen.mjs --days 30
node reddit-listen.mjs --all           # include ones already reported
node reddit-listen.mjs --json
node reddit-listen.mjs --misses        # also what a search found and no pattern kept
node reddit-listen.mjs --report        # also write the output to report.txt
```

The calibration run is `--days 30 --all --misses`. Read the two warnings at
the end before the list: a subreddit that 404s is misspelt or gone, and one
marked "busier than a listing reaches" was only partly read.

Threads already reported are remembered in `.reddit-seen.json`, so a run
without `--all` shows only what is new.

## The API route, once approval lands

1. <https://www.reddit.com/prefs/apps>, then "create another app..."
2. Type: **installed app**. Not "script", which wants a password
3. Redirect uri: `http://localhost:3000`. Unused, but the form requires one
4. Copy `.env.example` to `.env` and paste the id shown under the app name
   as `REDDIT_CLIENT_ID`

The registration that has to come first is the "register to use the API"
link at the top of that form.

## The rules

They matter more than the tool, and they live with the rest of the
marketing reasoning in the website repo:
`E:/code/visit-history-web/docs/advertising/reddit-organic.md`. In short:
never from u/VisitHistory, the account needs history first, answer the
question completely before mentioning the app, and say you built it every
time.

Tasks and status are in Linear, project "Organic and SEO":
<https://linear.app/visit-history>.
