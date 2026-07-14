const admin = require("firebase-admin");

const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;
const databaseURL = process.env.FIREBASE_DATABASE_URL;

if (!serviceAccountJson || !databaseURL) {
  console.error("Missing FIREBASE_SERVICE_ACCOUNT or FIREBASE_DATABASE_URL env vars.");
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(serviceAccountJson)),
  databaseURL,
});

// Don't fire a reminder more than this many minutes after it was due —
// avoids a flood of stale notifications if a run was ever skipped/delayed.
const OVERDUE_WINDOW_MS = 20 * 60 * 1000;

// "YYYY-MM-DDTHH:MM" for `date` as observed in `timeZone`, no date library needed.
function localDateTimeString(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

// Approximate UTC ms for a local Y/M/D H:M in an IANA timezone. Only used for the
// staleness check below, so a minute or two of DST-edge imprecision is acceptable.
function zonedTimeToUtcMs(y, m, d, hh, mm, timeZone) {
  const utcGuess = Date.UTC(y, m - 1, d, hh, mm);
  const localStr = localDateTimeString(new Date(utcGuess), timeZone);
  const [dp, tp] = localStr.split("T");
  const [ly, lm, ld] = dp.split("-").map(Number);
  const [lh, lmin] = tp.split(":").map(Number);
  const localAsUtc = Date.UTC(ly, lm - 1, ld, lh, lmin);
  return utcGuess - (localAsUtc - utcGuess);
}

// Trace's client dates tasks with `new Date().toISOString().slice(0,10)` (UTC calendar
// day) — mirrored here so "today"/streaks agree with what the app itself shows.
function utcDateStr(date) {
  return date.toISOString().slice(0, 10);
}

function computeDoneDatesUTC(tasks) {
  const set = new Set();
  tasks.forEach((t) => {
    if (t && t.done && t.doneAt) set.add(utcDateStr(new Date(t.doneAt)));
  });
  return set;
}

// Length of the consecutive-day run ending exactly at `dateStr` (inclusive), 0 if absent.
function streakEndingAt(doneDatesSet, dateStr) {
  if (!doneDatesSet.has(dateStr)) return 0;
  let streak = 1;
  let cursor = new Date(dateStr + "T00:00:00Z");
  for (;;) {
    cursor = new Date(cursor.getTime() - 86400000);
    if (doneDatesSet.has(utcDateStr(cursor))) streak++; else break;
  }
  return streak;
}

// Sends a push to every token in the group, prunes any FCM reports as dead, returns
// how many sends succeeded.
async function sendToGroup(db, groupId, tokenKeys, tokens, title, body, tag) {
  const response = await admin.messaging().sendEachForMulticast({
    tokens,
    data: { title, body, taskId: tag },
  });
  const updates = {};
  response.responses.forEach((r, i) => {
    const code = r.error && r.error.code;
    if (!r.success && (code === "messaging/invalid-registration-token" || code === "messaging/registration-token-not-registered")) {
      updates["trace-push/" + groupId + "/tokens/" + tokenKeys[i]] = null;
    }
  });
  if (Object.keys(updates).length) await db.ref().update(updates);
  return response.successCount;
}

async function main() {
  const db = admin.database();
  const [syncSnap, pushSnap] = await Promise.all([
    db.ref("trace-sync").once("value"),
    db.ref("trace-push").once("value"),
  ]);
  const syncData = syncSnap.val() || {};
  const pushData = pushSnap.val() || {};
  const now = new Date();
  const todayUTC = utcDateStr(now);
  const yesterdayUTC = utcDateStr(new Date(now.getTime() - 86400000));
  let sent = 0;

  for (const groupId of Object.keys(syncData)) {
    const group = syncData[groupId];
    const tasks = Array.isArray(group && group.tasks) ? group.tasks : [];
    const pushGroup = pushData[groupId];
    if (!pushGroup || !pushGroup.tokens || !tasks.length) continue;

    const tz = pushGroup.tz || "UTC";
    const notified = pushGroup.notified || {};
    // Tokens are stored keyed by encodeURIComponent(token) so re-registering the same
    // device overwrites instead of duplicating.
    const tokenKeys = Object.keys(pushGroup.tokens);
    const tokens = tokenKeys.map((key) => decodeURIComponent(key));
    if (!tokens.length) continue;

    // Do-not-disturb: an active focus session suppresses pushes for this group.
    // Not marked "notified" here, so it's retried (or aged out) on the next run.
    const timer = group.timer;
    if (timer && timer.running && timer.mode === "focus") continue;

    const nowLocal = localDateTimeString(now, tz);

    // --- Per-task reminders ---
    for (const task of tasks) {
      if (!task || task.done || !task.date || !task.notifyTime || !task.id) continue;
      if (notified[task.id]) continue;
      const target = task.date + "T" + task.notifyTime;
      if (target > nowLocal) continue; // not due yet

      const [y, m, d] = task.date.split("-").map(Number);
      const [hh, mm] = task.notifyTime.split(":").map(Number);
      const targetUtcMs = zonedTimeToUtcMs(y, m, d, hh, mm, tz);
      if (now.getTime() - targetUtcMs > OVERDUE_WINDOW_MS) {
        // Too stale to be worth surfacing — mark as handled so it doesn't linger forever.
        await db.ref("trace-push/" + groupId + "/notified/" + task.id).set(true);
        continue;
      }

      sent += await sendToGroup(db, groupId, tokenKeys, tokens, "Trace", task.text, task.id);
      await db.ref("trace-push/" + groupId + "/notified/" + task.id).set(true);
    }

    // --- Streak protection ---
    const streakNotifyTime = group.streakNotifyTime;
    if (streakNotifyTime && pushGroup.streakNotifiedDate !== todayUTC) {
      const doneDates = computeDoneDatesUTC(tasks);
      if (!doneDates.has(todayUTC)) {
        const atRiskStreak = streakEndingAt(doneDates, yesterdayUTC);
        const localTimePart = nowLocal.split("T")[1];
        if (atRiskStreak >= 1 && localTimePart >= streakNotifyTime) {
          const body = atRiskStreak === 1
            ? "Your streak ends tonight if you don't complete something today."
            : `Your ${atRiskStreak}-day streak ends tonight if you don't complete something today.`;
          sent += await sendToGroup(db, groupId, tokenKeys, tokens, "Trace", body, "streak-" + todayUTC);
          await db.ref("trace-push/" + groupId + "/streakNotifiedDate").set(todayUTC);
        }
      }
    }
  }

  console.log(`Checked reminders — sent ${sent} notification(s).`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Reminder check failed:", err);
    process.exit(1);
  });
