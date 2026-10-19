# Visit History: Reddit listener

Finds Reddit threads where Visit History is a genuine answer to a question
somebody has already asked, and prints them ranked. Read only by
construction: it cannot post, vote or comment.

One file, no dependencies beyond Node 18 or later.

## Setup, once

1. <https://www.reddit.com/prefs/apps>, then "create another app..."
2. Type: **installed app**. Not "script", which wants a password
3. Redirect uri: `http://localhost:3000`. Unused, but the form requires one
4. Copy `.env.example` to `.env` and paste the id shown under the app name
   as `REDDIT_CLIENT_ID`

## Running it

Double-click **Reddit listener.cmd**, or the Desktop shortcut to it. The
window stays open so the list can be read. From a terminal:

```
node reddit-listen.mjs                 # last 7 days, new only
node reddit-listen.mjs --days 30
node reddit-listen.mjs --all           # include ones already reported
node reddit-listen.mjs --json
node reddit-listen.mjs --misses        # also what a search found and no pattern kept
```

The first, calibration run is `--days 30 --all --misses`. Read the two
warnings at the end before the list: a subreddit that 404s is misspelt or
gone, and one marked "busier than a listing reaches" was only partly read.

Threads already reported are remembered in `.reddit-seen.json`, so a daily
run shows only what is new.

## The rules

They matter more than the tool, and they live with the rest of the
marketing reasoning in the website repo:
`E:/code/visit-history-web/docs/advertising/reddit-organic.md`. In short:
never from u/VisitHistory, the account needs history first, answer the
question completely before mentioning the app, and say you built it every
time.

Tasks and status are in Linear, project "Organic and SEO":
<https://linear.app/visit-history>.
