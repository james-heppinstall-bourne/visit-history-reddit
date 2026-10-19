#!/usr/bin/env node
/**
 * Find Reddit threads where Visit History is a genuine answer.
 *
 * Reddit blocks anonymous JSON entirely now (403 on every .json endpoint,
 * which is also why a bare curl check reports real subreddits as missing).
 * This uses the official API with the **userless** OAuth grant: a client id
 * and a device id, no password, no account actions. Read only by
 * construction - nothing here can post, vote or comment.
 *
 * Setup, once, by the account owner:
 *   1. https://www.reddit.com/prefs/apps  ->  "create another app..."
 *   2. Type: **installed app**  (not "script" - that one wants a password)
 *   3. Redirect uri: http://localhost:3000  (unused, but required)
 *   4. Copy the id under the app name into .env, next to this file:
 *        REDDIT_CLIENT_ID=...
 *      An installed app has no secret. If you made a "web app" instead,
 *      also set REDDIT_CLIENT_SECRET.
 *
 * Usage:
 *   node reddit-listen.mjs                 # last 7 days, ranked
 *   node reddit-listen.mjs --days 30
 *   node reddit-listen.mjs --all           # include already-seen
 *   node reddit-listen.mjs --json          # machine readable
 *   node reddit-listen.mjs --misses        # and what the patterns threw away
 *
 * "Reddit listener.cmd" runs it in a window that stays open, and is what
 * the Desktop shortcut points at.
 *
 * Threads already reported are remembered in .reddit-seen.json next to this
 * file, so a daily run only shows what is new. That file is gitignored.
 *
 * The rules for replying, which matter more than this tool, live with the
 * rest of the marketing reasoning in the website repo:
 * E:/code/visit-history-web/docs/advertising/reddit-organic.md
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SEEN_PATH = path.join(HERE, ".reddit-seen.json");

const UA = "web:visit-history-listen:1.0 (by /u/VisitHistory)";

/**
 * Where the people are. The first group is validated: these are the
 * communities the two paid tests actually ran against. The rest are the
 * places the questions get asked.
 */
const SUBREDDITS = [
  // from the ad tests
  "castles", "Tudorhistory", "UKhistory", "nationaltrust", "EnglishHeritage",
  "Archaeology", "MapPorn", "oldmaps", "OSmaps", "lidar",
  // where the questions live
  "AskUK", "CasualUK", "uktravel", "HistoryofIdeas", "AskBrits",
  "britishproblems", "walkingbritain", "hiking", "metaldetectinguk",
];

/**
 * High-intent phrasing, grouped so the report can say *why* a thread
 * matched. Order matters: the first group is where the product is the
 * literal answer to the question asked.
 */
const INTENT = [
  {
    tag: "asking for an app",
    weight: 10,
    queries: [
      "is there an app heritage", "app for castles", "app to track places visited",
      "app for historic sites", "app national trust english heritage",
      "best app for visiting castles",
    ],
    patterns: [
      /\b(is|are) there (an?|any) app\b/i,
      /\bapp (that|which|to|for)\b.*\b(castle|heritage|historic|monument|abbey|ruin)/i,
      /\bany (good )?apps?\b.*\b(heritage|historic|castle|history)/i,
      /\brecommend (an?|any) app\b/i,
    ],
  },
  {
    tag: "asking for a map",
    weight: 9,
    queries: [
      "map of listed buildings", "map of scheduled monuments",
      "is there a map of historic sites", "map of castles uk",
      "map of earthworks", "lidar map uk how to",
    ],
    patterns: [
      /\b(is|are) there a (map|database|list)\b.*\b(listed|scheduled|monument|heritage|historic|castle)/i,
      /\bwhere can i (find|see|get)\b.*\b(lidar|listed building|scheduled monument)/i,
      /\bhow (do|can) i (find|see|check)\b.*\b(lidar|listed|scheduled|earthwork)/i,
    ],
  },
  {
    tag: "identify this earthwork",
    weight: 8,
    queries: [
      "what is this earthwork", "lumps and bumps field", "crop marks field",
      "what are these rings in the field", "is this a motte",
    ],
    patterns: [
      /\bwhat (is|are) (this|these)\b.*\b(earthwork|mound|lump|bump|ditch|ring|crop ?mark|motte)/i,
      /\bany idea what (this|these)\b.*\b(field|mound|earthwork)/i,
    ],
  },
  {
    tag: "listed or scheduled question",
    weight: 7,
    queries: [
      "how do i know if my house is listed", "what does scheduled monument mean",
      "difference between listed and scheduled", "grade 2 listed what does it mean",
    ],
    patterns: [
      /\b(how do i|how can i)\b.*\b(find out|check|know)\b.*\blisted\b/i,
      /\bdifference between\b.*\b(listed|scheduled)\b/i,
      /\bwhat (does|is) a? ?scheduled monument\b/i,
    ],
  },
  {
    tag: "membership worth it",
    weight: 5,
    queries: [
      "national trust membership worth it", "english heritage membership worth it",
      "national trust or english heritage", "historic houses membership",
    ],
    patterns: [
      /\b(national trust|english heritage|historic houses|cadw)\b.*\bworth it\b/i,
      /\b(national trust|english heritage)\b.*\bor\b.*\b(english heritage|national trust)\b/i,
    ],
  },
  {
    tag: "keeping track of visits",
    weight: 6,
    queries: [
      "keep track of castles visited", "log places visited", "tick off places visited",
      "how do you record places you have been",
    ],
    patterns: [
      /\b(keep track|keeping track|log|record|tick off)\b.*\b(visited|been to|places|castles|properties)/i,
    ],
  },
];

/** Pages of a subreddit's /new to read, a hundred posts each. */
const MAX_PAGES = 10;
const MAX_MISSES = 80;

const NEGATIVE = [
  /\bfor sale\b/i, /\bgiveaway\b/i, /\bdiscount code\b/i, /\bhiring\b/i,
  /\b(minecraft|skyrim|assassin'?s creed|total war)\b/i,
];

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  return next && !next.startsWith("--") ? next : true;
}

function loadEnv() {
  const p = path.join(HERE, ".env");
  if (!fs.existsSync(p)) return {};
  return Object.fromEntries(
    fs.readFileSync(p, "utf8").split(/\r?\n/)
      .filter((l) => l && !l.startsWith("#") && l.includes("="))
      .map((l) => {
        const i = l.indexOf("=");
        return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
      }),
  );
}

/** Userless OAuth. No account, no password, read only. */
async function token(clientId, clientSecret) {
  const body = new URLSearchParams({
    grant_type: "https://oauth.reddit.com/grants/installed_client",
    device_id: "DO_NOT_TRACK_THIS_DEVICE",
  });
  const auth = Buffer.from(`${clientId}:${clientSecret ?? ""}`).toString("base64");
  const r = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": UA,
    },
    body,
  });
  if (!r.ok) {
    throw new Error(
      `token request failed: ${r.status} ${await r.text()}\n` +
      `Check REDDIT_CLIENT_ID, and that the app type is "installed app".`,
    );
  }
  return (await r.json()).access_token;
}

const sleep = (seconds) => new Promise((res) => setTimeout(res, seconds * 1000));

/**
 * Requests that did not come back as a listing. A failed request reads as
 * an empty one, so without this a run where every call was refused prints
 * "Nothing new", and a subreddit that is misspelt, private or banned is
 * never noticed.
 */
const failures = [];

async function api(tok, pathname, params, attempt = 0) {
  const url = new URL(`https://oauth.reddit.com${pathname}`);
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${tok}`, "User-Agent": UA },
  });
  const reset = Math.min(Number(r.headers.get("x-ratelimit-reset")) || 5, 60);
  if (r.status === 429 && attempt < 3) {
    await sleep(reset);
    return api(tok, pathname, params, attempt + 1);
  }
  if (!r.ok) {
    failures.push({ status: r.status, what: params?.q ? `search "${params.q}"` : pathname });
    return { data: { children: [] } };
  }
  // Reddit reports what is left of the window on every response. Waiting
  // it out is cheaper than being refused and retrying.
  const left = r.headers.get("x-ratelimit-remaining");
  if (left !== null && Number(left) < 2) await sleep(reset);
  return r.json();
}

function score(post) {
  const hay = `${post.title}\n${post.selftext ?? ""}`;
  if (NEGATIVE.some((re) => re.test(hay))) return null;

  let best = null;
  for (const group of INTENT) {
    if (group.patterns.some((re) => re.test(hay))) {
      if (!best || group.weight > best.weight) best = group;
    }
  }
  if (!best) return null;

  // A question with few answers is worth more than a busy thread you are
  // arriving late to, and self-posts beat link posts because there is
  // something to reply to.
  let s = best.weight;
  if (/\?/.test(post.title)) s += 3;
  if (post.is_self) s += 2;
  if (post.num_comments === 0) s += 2;
  else if (post.num_comments < 5) s += 1;
  else if (post.num_comments > 40) s -= 3;
  const ageDays = (Date.now() / 1000 - post.created_utc) / 86400;
  if (ageDays < 1) s += 3;
  else if (ageDays < 3) s += 1;
  else if (ageDays > 14) s -= 2;

  return { score: s, why: best.tag, ageDays };
}

async function main() {
  const env = { ...loadEnv(), ...process.env };
  const clientId = env.REDDIT_CLIENT_ID;
  if (!clientId) {
    console.error(
      "REDDIT_CLIENT_ID is not set. See the header of this file for the\n" +
      "four steps to create one. It is read only and needs no password.",
    );
    process.exit(1);
  }

  const days = Number(arg("days", 7));
  const asJson = Boolean(arg("json", false));
  const includeSeen = Boolean(arg("all", false));
  const showMisses = Boolean(arg("misses", false));
  const cutoff = Date.now() / 1000 - days * 86400;

  const seen = includeSeen
    ? new Set()
    : new Set(fs.existsSync(SEEN_PATH) ? JSON.parse(fs.readFileSync(SEEN_PATH, "utf8")) : []);

  const tok = await token(clientId, env.REDDIT_CLIENT_SECRET);
  const found = new Map();

  // 1. Targeted search across all of Reddit, which catches the subreddits
  //    nobody thought to list.
  const queries = INTENT.flatMap((g) => g.queries);
  const foundBy = new Map();
  for (const q of queries) {
    const j = await api(tok, "/search", {
      q, limit: "100", sort: "new", t: days > 30 ? "year" : "month", type: "link",
    });
    for (const c of j.data?.children ?? []) {
      found.set(c.data.id, c.data);
      if (!foundBy.has(c.data.id)) foundBy.set(c.data.id, q);
    }
  }

  // 2. Recent posts from the named subreddits, matched on pattern. Catches
  //    the ones phrased in a way no query anticipated. One page of r/AskUK
  //    is a few hours, so this pages back until it passes the cutoff, and
  //    says so where it could not: Reddit ends a listing at about a
  //    thousand posts whatever is asked for.
  const shortfalls = [];
  for (const sub of SUBREDDITS) {
    let after = null;
    let oldest = null;
    let count = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const j = await api(tok, `/r/${sub}/new`, { limit: "100", ...(after ? { after } : {}) });
      for (const c of j.data?.children ?? []) {
        found.set(c.data.id, c.data);
        oldest = c.data.created_utc;
        count++;
      }
      after = j.data?.after ?? null;
      if (!after || oldest < cutoff) break;
    }
    if (oldest !== null && oldest > cutoff && (after || count >= 900)) {
      shortfalls.push({ sub, reached: (Date.now() / 1000 - oldest) / 86400 });
    }
  }

  const hits = [];
  const misses = [];
  for (const post of found.values()) {
    if (post.created_utc < cutoff) continue;
    if (!includeSeen && seen.has(post.id)) continue;
    // Nothing can be said in a thread that is locked, archived or removed.
    if (post.locked || post.archived || post.removed_by_category) continue;
    const s = score(post);
    if (!s) {
      if (foundBy.has(post.id)) misses.push(post);
      continue;
    }
    hits.push({
      id: post.id,
      score: s.score,
      why: s.why,
      age: `${s.ageDays.toFixed(1)}d`,
      sub: `r/${post.subreddit}`,
      comments: post.num_comments,
      title: post.title,
      url: `https://www.reddit.com${post.permalink}`,
    });
  }
  hits.sort((a, b) => b.score - a.score);

  if (asJson) {
    console.log(JSON.stringify(hits, null, 2));
  } else if (hits.length === 0) {
    console.log(`Nothing new in the last ${days} days.`);
  } else {
    console.log(`${hits.length} threads worth a look, best first:\n`);
    for (const h of hits) {
      console.log(`[${String(h.score).padStart(2)}] ${h.sub}  ${h.age}  ${h.comments} comments  (${h.why})`);
      console.log(`     ${h.title}`);
      console.log(`     ${h.url}\n`);
    }
    console.log(
      "Before replying, read E:/code/visit-history-web/docs/advertising/reddit-organic.md.\n" +
      "Answer the question first. Mention the app only if it is genuinely\n" +
      "the answer, and say you built it when you do.",
    );
  }

  // What a search returned and no pattern matched. The ranked list can only
  // show a pattern that is too loose; one that is too tight shows up here.
  if (showMisses && !asJson) {
    misses.sort((a, b) => b.created_utc - a.created_utc);
    const shown = misses.slice(0, MAX_MISSES);
    console.log(`\n${shown.length} of ${misses.length} threads a search returned and no pattern kept, newest first:\n`);
    for (const p of shown) {
      console.log(`     r/${p.subreddit}  ${p.num_comments} comments  (found by "${foundBy.get(p.id)}")`);
      console.log(`     ${p.title}`);
      console.log(`     https://www.reddit.com${p.permalink}\n`);
    }
  }

  // On stderr, so --json stays parseable.
  if (failures.length > 0) {
    console.error(`\n${failures.length} requests failed, so the list above is short by whatever they would have found:`);
    for (const f of failures) console.error(`  ${f.status}  ${f.what}`);
  }
  if (shortfalls.length > 0) {
    console.error(`\nBusier than a listing reaches, so only part of the ${days} days was read:`);
    for (const s of shortfalls) console.error(`  r/${s.sub}  back ${s.reached.toFixed(1)} days`);
  }

  if (!includeSeen) {
    for (const h of hits) seen.add(h.id);
    fs.writeFileSync(SEEN_PATH, JSON.stringify([...seen].slice(-5000)));
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
