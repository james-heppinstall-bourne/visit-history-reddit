#!/usr/bin/env node
/**
 * Find Reddit threads where Visit History is a genuine answer.
 *
 * Reddit blocks anonymous JSON entirely now (403 on every .json endpoint,
 * which is also why a bare curl check reports real subreddits as missing).
 * Two ways in, chosen by whether REDDIT_CLIENT_ID is set:
 *
 *   API  The official API with the **userless** OAuth grant: a client id
 *        and a device id, no password, no account actions. Fast: a run is
 *        a minute or two. Needs an app, and since 2025 Reddit will not
 *        create one until the account is approved under its Responsible
 *        Builder Policy (the "register to use the API" link on the
 *        create-app form). Measured 19 Oct 2026: the create call answers
 *        success:true and does nothing until then.
 *   RSS  The public Atom feeds at www.reddit.com, no credentials at all.
 *        Allowed **one request a minute** from an address (measured the
 *        same day: x-ratelimit-remaining is 0 after a single call), so a
 *        run is 50 to 60 requests and takes most of an hour. Feeds carry no
 *        comment count, so that part of the score is skipped. old.reddit.com
 *        feeds redirect to a login page and are no use.
 *
 * Read only by construction either way - nothing here can post, vote or
 * comment.
 *
 * Setup for the API route, once, by the account owner:
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
 *   node reddit-listen.mjs --report        # also write the output to report.txt
 *   node reddit-listen.mjs --rescore       # re-run the scoring over the last run's posts, no fetching
 *
 * "Reddit listener.cmd" is what the Desktop shortcut points at: it opens
 * the last report.txt if there is one and offers a fresh run.
 * "Reddit listener (scheduled).cmd" is the unattended daily run behind
 * report.txt, registered in Task Scheduler as "Visit History Reddit
 * listener".
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
const RSS_UA = "visit-history-listen/1.0 (read-only RSS; contact support@visithistory.online)";
const REPORT_PATH = path.join(HERE, "report.txt");
// Everything the last run fetched, so the scoring can be re-run with
// --rescore in seconds rather than another hour of feeds.
const DUMP_PATH = path.join(HERE, "last-posts.json");

/**
 * Where the people are. The specialist subreddits are about this subject,
 * so anything matched there is in context. The general ones are where the
 * questions get asked among everything else, so a match there has to
 * mention the subject too (see HERITAGE below).
 */
const SPECIALIST = [
  "castles", "Tudorhistory", "UKhistory", "nationaltrust", "EnglishHeritage",
  "Archaeology", "oldmaps", "OSmaps", "lidar", "metaldetectinguk",
];
const GENERAL = [
  "MapPorn", "AskUK", "CasualUK", "uktravel", "HistoryofIdeas", "AskBrits",
  "britishproblems", "walkingbritain", "hiking",
];
const SUBREDDITS = [...SPECIALIST, ...GENERAL];

/**
 * A post from anywhere but a specialist subreddit has to be about the
 * subject somewhere in its first few hundred characters. The first live
 * run (19 Oct 2026) ranked r/offmychest, r/HFY and r/fastfood at the top:
 * a pattern like "keep track ... places" matches most long prose.
 */
const HERITAGE = /\b(castles?|heritage|historic|listed buildings?|scheduled monuments?|earthworks?|hill ?forts?|national trust|english heritage|cadw|abbey|priory|ruins?|lidar|archaeolog\w*|motte|barrows?|tumulus|crop ?marks?|ridge and furrow|grade (i|ii|1|2)\*? listed|stately home)\b/i;

/**
 * High-intent phrasing, grouped so the report can say *why* a thread
 * matched. Order matters: the first group is where the product is the
 * literal answer to the question asked.
 *
 * Queries are what the search runs. **Quote the phrase.** Reddit's search
 * treats bare words as any-of: `keep track of castles visited` returned a
 * hundred posts about anything with "track" or "visited" in it, and the
 * first run's 29 unquoted searches brought back 1,982 posts of which none
 * was worth reading. `"is there an app" castles` returned three, all on
 * subject.
 *
 * Patterns are what keeps a result. The gap between the two halves is
 * bounded (`.{0,60}`) rather than `.*`, because across a whole post `.*`
 * is a different question: "is there a map" and "castle" somewhere in the
 * same two thousand words.
 */
const INTENT = [
  {
    tag: "asking for an app",
    weight: 10,
    queries: [
      "\"is there an app\" castles", "\"is there an app\" heritage",
      "\"is there an app\" \"historic sites\"", "\"app for\" castles",
      "\"app for\" \"english heritage\"", "\"app for\" \"national trust\"",
      "\"best app\" castles", "\"any apps\" heritage sites",
    ],
    patterns: [
      /\b(is|are) there (an?|any) (good |decent )?apps?\b/i,
      /\bapps? (that|which|to|for)\b.{0,60}\b(castles?|heritage|historic|monuments?|abbey|ruins?|national trust|english heritage)/i,
      /\bany (good |decent )?apps?\b.{0,60}\b(heritage|historic|castles?|history)/i,
      /\brecommend (an?|any|some) apps?\b/i,
    ],
  },
  {
    tag: "asking for a map",
    weight: 9,
    queries: [
      "\"map of listed buildings\"", "\"map of scheduled monuments\"",
      "\"map of\" \"historic sites\" uk", "\"map of\" castles uk",
      "\"map of\" earthworks", "\"lidar\" \"how do i\" earthworks",
      "\"interactive map\" \"listed buildings\"",
    ],
    patterns: [
      /\b(is|are) there an? (map|database|list|website|site)\b.{0,60}\b(listed|scheduled|monuments?|heritage|historic|castles?|earthworks?)/i,
      /\bwhere can (i|you) (find|see|get|view)\b.{0,60}\b(lidar|listed buildings?|scheduled monuments?|earthworks?)/i,
      /\bhow (do|can) (i|you) (find|see|check|view)\b.{0,60}\b(lidar|listed|scheduled|earthworks?)/i,
    ],
  },
  {
    tag: "identify this earthwork",
    weight: 8,
    queries: [
      "\"what is this\" earthwork", "\"lumps and bumps\" field", "\"crop marks\" field",
      "\"what are these\" rings field", "\"is this a\" motte", "\"is this an\" earthwork",
    ],
    patterns: [
      /\bwhat (is|are) (this|these)\b.{0,60}\b(earthworks?|mounds?|lumps?|bumps?|ditch|rings?|crop ?marks?|motte|banks?)/i,
      /\bany idea what (this|these)\b.{0,60}\b(field|mound|earthwork)/i,
      /\bis this an? (earthwork|motte|hill ?fort|barrow|tumulus|moat)\b/i,
    ],
  },
  {
    tag: "listed or scheduled question",
    weight: 7,
    queries: [
      "\"is my house listed\"", "\"if my house is listed\"",
      "\"what does scheduled monument mean\"", "\"listed and scheduled\"",
      "\"grade 2 listed\" \"what does\"", "\"grade ii listed\" mean",
    ],
    patterns: [
      /\b(how do i|how can i|how to)\b.{0,40}\b(find out|check|know|tell)\b.{0,40}\blisted\b/i,
      /\bdifference between\b.{0,40}\b(listed|scheduled)\b/i,
      /\bwhat (does|is) a? ?scheduled monument\b/i,
      /\bis (my|our|this) (house|home|building|property|cottage) listed\b/i,
      /\bgrade (i|ii|1|2)\*? listed\b.{0,60}\b(mean|what|can i|can we|allowed)/i,
    ],
  },
  {
    tag: "membership worth it",
    weight: 5,
    queries: [
      "\"national trust membership\" worth", "\"english heritage membership\" worth",
      "\"national trust or english heritage\"", "\"english heritage or national trust\"",
      "\"historic houses membership\"",
    ],
    patterns: [
      /\b(national trust|english heritage|historic houses|cadw)\b.{0,80}\bworth (it|the)\b/i,
      /\b(national trust|english heritage)\b.{0,30}\bor\b.{0,30}\b(english heritage|national trust)\b/i,
    ],
  },
  {
    tag: "keeping track of visits",
    weight: 6,
    queries: [
      "\"keep track of\" castles visited", "\"places I've visited\" app",
      "\"log\" \"places visited\" app", "\"tick off\" castles",
      "\"national trust\" \"keep track\" visited",
    ],
    patterns: [
      /\b(keep track|keeping track|log|record|tick off|ticking off)\b.{0,40}\b(castles?|properties|sites|places (i|we)('ve| have) (visited|been))/i,
    ],
  },
];

/**
 * Pages of a subreddit's /new to read, a hundred posts each. Fewer over RSS,
 * where every page is another minute.
 */
const MAX_PAGES = { api: 10, rss: 3 };
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

/**
 * The RSS route. One Atom feed per request, and Reddit allows an
 * anonymous address one request a minute, so this reads the window
 * headers and waits rather than being refused. Progress goes to stderr
 * because an hour of silence looks like a hang.
 */
let rssDone = 0;
let rssPlanned = 0;

async function rss(url, what, attempt = 0) {
  const r = await fetch(url, { headers: { "User-Agent": RSS_UA } });
  const text = await r.text();
  const reset = Math.min(Number(r.headers.get("x-ratelimit-reset")) || 60, 120);
  if (r.status === 429 && attempt < 3) {
    await sleep(reset + 1);
    return rss(url, what, attempt + 1);
  }
  rssDone++;
  if (!r.ok || !text.includes("<feed")) {
    failures.push({ status: r.ok ? "not a feed" : r.status, what });
    return [];
  }
  const posts = parseAtom(text);
  const left = r.headers.get("x-ratelimit-remaining");
  if (left !== null && Number(left) < 1) {
    process.stderr.write(
      `  ${what}: ${posts.length} posts. ${rssDone} of about ${rssPlanned} requests done; ` +
      `the next is allowed in ${reset}s.\n`,
    );
    await sleep(reset + 1);
  }
  return posts;
}

/** The same post shape the API gives, from an Atom feed. */
function parseAtom(xml) {
  const posts = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const e = m[1];
    const id = atomTag(e, "id");
    // A search feed lists matching subreddits (t5_) alongside posts (t3_).
    if (!id?.startsWith("t3_")) continue;
    const content = decodeEntities(atomTag(e, "content") ?? "");
    // Reddit wraps a self post's text in SC_OFF/SC_ON comments; a link post
    // has only the thumbnail and the "[link] [comments]" trailer.
    const isSelf = /SC_OFF/.test(content);
    const link = e.match(/<link href="([^"]+)"/)?.[1] ?? "https://www.reddit.com/";
    const when = atomTag(e, "published") ?? atomTag(e, "updated") ?? "";
    posts.push({
      id: id.slice(3),
      title: decodeEntities(atomTag(e, "title") ?? ""),
      selftext: isSelf ? decodeEntities(content.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim() : "",
      is_self: isSelf,
      num_comments: null,
      created_utc: Date.parse(when) / 1000,
      permalink: new URL(link).pathname,
      subreddit: e.match(/<category term="([^"]+)"/)?.[1] ?? "",
    });
  }
  return posts;
}

const atomTag = (entry, name) =>
  entry.match(new RegExp(`<${name}(?: [^>]*)?>([\\s\\S]*?)</${name}>`))?.[1];

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
    .replace(/&amp;/g, "&");
}

const specialist = new Set(SPECIALIST.map((s) => s.toLowerCase()));

function score(post) {
  const hay = `${post.title}\n${post.selftext ?? ""}`;
  if (NEGATIVE.some((re) => re.test(hay))) return null;
  // Outside the specialist subreddits the post has to be about the subject,
  // and near the top, not in paragraph nine.
  if (!specialist.has(post.subreddit.toLowerCase()) && !HERITAGE.test(hay.slice(0, 800))) return null;

  let best = null;
  for (const group of INTENT) {
    if (group.patterns.some((re) => re.test(hay))) {
      if (!best || group.weight > best.weight) best = group;
    }
  }
  if (!best) return null;

  // A question with few answers is worth more than a busy thread you are
  // arriving late to, and self-posts beat link posts because there is
  // something to reply to. A feed does not say how many comments there
  // are, so over RSS that part is skipped.
  let s = best.weight;
  if (/\?/.test(post.title)) s += 3;
  if (post.is_self) s += 2;
  if (post.num_comments === 0) s += 2;
  else if (post.num_comments !== null && post.num_comments < 5) s += 1;
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
  const source = clientId ? "api" : "rss";

  const days = Number(arg("days", 7));
  const asJson = Boolean(arg("json", false));
  const includeSeen = Boolean(arg("all", false));
  const showMisses = Boolean(arg("misses", false));
  const writeReport = Boolean(arg("report", false));
  const rescore = Boolean(arg("rescore", false));
  const cutoff = Date.now() / 1000 - days * 86400;
  const period = days > 30 ? "year" : "month";

  const seen = includeSeen
    ? new Set()
    : new Set(fs.existsSync(SEEN_PATH) ? JSON.parse(fs.readFileSync(SEEN_PATH, "utf8")) : []);

  const queries = INTENT.flatMap((g) => g.queries);

  // The two routes answer the same two questions: what does a search return,
  // and what is on a page of a subreddit's /new. Everything after is shared.
  let search;
  let listPage;
  if (source === "api") {
    const tok = await token(clientId, env.REDDIT_CLIENT_SECRET);
    search = async (q) => {
      const j = await api(tok, "/search", { q, limit: "100", sort: "new", t: period, type: "link" });
      return (j.data?.children ?? []).map((c) => c.data);
    };
    listPage = async (sub, after) => {
      const j = await api(tok, `/r/${sub}/new`, { limit: "100", ...(after ? { after } : {}) });
      return { posts: (j.data?.children ?? []).map((c) => c.data), after: j.data?.after ?? null };
    };
  } else {
    rssPlanned = queries.length + SUBREDDITS.length;
    console.error(
      `No REDDIT_CLIENT_ID, so reading Reddit's public feeds instead: about ${rssPlanned} requests ` +
      `at the one a minute Reddit allows, so most of an hour. See the header of this file.\n`,
    );
    search = (q) => rss(
      `https://www.reddit.com/search.rss?q=${encodeURIComponent(q)}&sort=new&t=${period}&limit=100`,
      `search "${q}"`,
    );
    listPage = async (sub, after) => {
      const posts = await rss(
        `https://www.reddit.com/r/${sub}/new.rss?limit=100${after ? `&after=${after}&count=100` : ""}`,
        `/r/${sub}/new${after ? ` after ${after}` : ""}`,
      );
      return { posts, after: posts.length ? `t3_${posts[posts.length - 1].id}` : null };
    };
  }

  let found = new Map();
  let foundBy = new Map();
  const shortfalls = [];

  // --rescore skips the fetching and reruns the scoring over what the
  // last run saved, which is how the patterns get tuned without an hour
  // of feeds per attempt. The window is the one that run asked for.
  if (rescore) {
    if (!fs.existsSync(DUMP_PATH)) throw new Error(`--rescore needs ${DUMP_PATH}, which a run writes.`);
    const dump = JSON.parse(fs.readFileSync(DUMP_PATH, "utf8"));
    found = new Map(dump.posts.map((p) => [p.id, p]));
    foundBy = new Map(dump.foundBy);
    shortfalls.push(...dump.shortfalls);
    failures.push(...dump.failures);
    console.error(`Rescoring ${found.size} posts fetched ${dump.fetchedAt} over the ${dump.source === "api" ? "API" : "public feeds"}.\n`);
  }

  // 1. Targeted search across all of Reddit, which catches the subreddits
  //    nobody thought to list.
  for (const q of rescore ? [] : queries) {
    for (const post of await search(q)) {
      found.set(post.id, post);
      if (!foundBy.has(post.id)) foundBy.set(post.id, q);
    }
  }

  // 2. Recent posts from the named subreddits, matched on pattern. Catches
  //    the ones phrased in a way no query anticipated. One page of r/AskUK
  //    is a few hours, so this pages back until it passes the cutoff, and
  //    says so where it could not: Reddit ends a listing at about a
  //    thousand posts whatever is asked for.
  for (const sub of rescore ? [] : SUBREDDITS) {
    let after = null;
    let oldest = null;
    let count = 0;
    for (let page = 0; page < MAX_PAGES[source]; page++) {
      const r = await listPage(sub, after);
      // A page that adds nothing is a feed that ignored `after`; stop
      // rather than read the same hundred posts three times.
      if (!r.posts.some((p) => !found.has(p.id))) { after = null; break; }
      for (const post of r.posts) {
        found.set(post.id, post);
        oldest = post.created_utc;
        count++;
      }
      after = r.after;
      if (!after || oldest < cutoff) break;
    }
    if (oldest !== null && oldest > cutoff && (after || count >= 900)) {
      shortfalls.push({ sub, reached: (Date.now() / 1000 - oldest) / 86400 });
    }
  }

  if (!rescore) {
    fs.writeFileSync(DUMP_PATH, JSON.stringify({
      fetchedAt: new Date().toISOString(), days, source,
      posts: [...found.values()], foundBy: [...foundBy], shortfalls, failures,
    }));
  }

  // The same post put in ten subreddits is one thread to read, not ten.
  const hits = [];
  const misses = [];
  const byTitle = new Map();
  for (const post of found.values()) {
    if (post.created_utc < cutoff) continue;
    if (!includeSeen && seen.has(post.id)) continue;
    // Nothing can be said in a thread that is locked, archived or removed,
    // and a user-profile "subreddit" (u_name) is somebody's own noticeboard.
    if (post.locked || post.archived || post.removed_by_category) continue;
    if (post.subreddit.startsWith("u_")) continue;
    const s = score(post);
    if (!s) {
      if (foundBy.has(post.id)) misses.push(post);
      continue;
    }
    const hit = {
      id: post.id,
      score: s.score,
      why: s.why,
      age: `${s.ageDays.toFixed(1)}d`,
      sub: `r/${post.subreddit}`,
      alsoIn: [],
      comments: post.num_comments,
      title: post.title,
      url: `https://www.reddit.com${post.permalink}`,
    };
    const key = post.title.toLowerCase().replace(/\s+/g, " ").trim();
    const prior = byTitle.get(key);
    if (!prior) {
      byTitle.set(key, hit);
      hits.push(hit);
    } else if (hit.score > prior.score) {
      prior.alsoIn.push(prior.sub);
      Object.assign(prior, hit, { alsoIn: prior.alsoIn });
    } else {
      prior.alsoIn.push(hit.sub);
    }
  }
  hits.sort((a, b) => b.score - a.score);

  // Everything printed is also kept for report.txt. Warnings go to stderr
  // so --json stays parseable on stdout.
  const lines = [];
  const say = (s = "") => { lines.push(s); console.log(s); };
  const warn = (s = "") => { lines.push(s); console.error(s); };
  const comments = (n) => (n === null ? "" : `${n} comments  `);

  if (asJson) {
    console.log(JSON.stringify(hits, null, 2));
  } else if (hits.length === 0) {
    say(`Nothing new in the last ${days} days.`);
  } else {
    say(`${hits.length} threads worth a look, best first:\n`);
    for (const h of hits) {
      const also = h.alsoIn.length ? `  also in ${h.alsoIn.join(", ")}` : "";
      say(`[${String(h.score).padStart(2)}] ${h.sub}  ${h.age}  ${comments(h.comments)}(${h.why})${also}`);
      say(`     ${h.title}`);
      say(`     ${h.url}\n`);
    }
    say(
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
    say(`\n${shown.length} of ${misses.length} threads a search returned and no pattern kept, newest first:\n`);
    for (const p of shown) {
      say(`     r/${p.subreddit}  ${comments(p.num_comments)}(found by "${foundBy.get(p.id)}")`);
      say(`     ${p.title}`);
      say(`     https://www.reddit.com${p.permalink}\n`);
    }
  }

  if (failures.length > 0) {
    warn(`\n${failures.length} requests failed, so the list above is short by whatever they would have found:`);
    for (const f of failures) warn(`  ${f.status}  ${f.what}`);
  }
  if (shortfalls.length > 0) {
    warn(`\nBusier than a listing reaches, so only part of the ${days} days was read:`);
    for (const s of shortfalls) warn(`  r/${s.sub}  back ${s.reached.toFixed(1)} days`);
  }

  if (writeReport) {
    const stamp = new Date().toLocaleString("en-GB", { dateStyle: "full", timeStyle: "short" });
    const header = `Reddit listener, ${stamp}. Last ${days} days${includeSeen ? "" : ", new only"}, ` +
      `read over the ${source === "api" ? "API" : "public feeds"}.\n` +
      "=".repeat(72) + "\n\n";
    fs.writeFileSync(REPORT_PATH, header + lines.join("\n") + "\n");
    console.error(`\nWritten to ${REPORT_PATH}`);
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
