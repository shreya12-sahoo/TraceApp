# One-time setup: Firebase (for reliable syncing)

Two free hobby services (jsonbin.io, kvdb.io) turned out to be unreliable — one needed a finicky API key, the other's server kept erroring. Firebase is Google's own service, free, and much more solid. This setup takes about 5 minutes and you only do it once, ever.

## Step 1 — Create a free Firebase project

1. Go to **console.firebase.google.com**
2. Sign in with any Google account (or create one — it's free)
3. Click **Create a project** (or **Add project**)
4. Name it anything, e.g. `trace-sync`
5. When asked about Google Analytics, you can turn it **off** — not needed
6. Click **Create project**, wait for it to finish, click **Continue**

## Step 2 — Create the database

1. In the left sidebar, find **Build** → click **Realtime Database**
2. Click **Create Database**
3. Pick any location (default is fine) → click **Next**
4. Choose **Start in test mode** → click **Enable**

## Step 3 — Open up read/write access

By default, test mode only allows access for 30 days. Let's make it permanent (since there's no login system in this app):

1. Still on the Realtime Database page, click the **Rules** tab (next to "Data")
2. Replace whatever is there with exactly this:
   ```json
   {
     "rules": {
       ".read": true,
       ".write": true
     }
   }
   ```
3. Click **Publish**

**Important:** this makes your data readable by anyone who has your database URL *and* your sync code — neither of which you'll share publicly. Don't put anything sensitive in the app, and don't post your sync code anywhere.

## Step 4 — Get your Database URL

1. Click the **Data** tab (next to Rules)
2. Near the top, you'll see a URL like:
   `https://trace-sync-xxxxx-default-rtdb.firebaseio.com/`
3. Copy that entire URL

## Step 5 — Put it into the app

1. Open your Trace app (the `github.io` link)
2. Go to **Stats** tab → **Cloud Sync**
3. Paste the URL into the box → click **Save**
4. Click **Start new sync** → you should see "Linked just now" and a sync code appear
5. Copy that code
6. On your other device, open the app → Stats → Cloud Sync → paste the **same Database URL** → Save → **Join with code** → paste the code → Connect

That's it — both devices are linked for good. You only ever do Steps 1–4 once.

## If it still fails

Copy the exact text shown under "Couldn't start sync (...)" and send it to me — with Firebase, that message will point to something concrete (like a rules mistake or a typo'd URL) rather than a mystery server error.
