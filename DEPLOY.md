# Deploy checklist — Music Player 2.0 to TestFlight

Run these in order, in your real terminal, **not** in the Claude/sandbox session. Anything that needs your Apple ID or Expo password has to be you. Estimated total time: half a day, plus 1-2 days waiting for Apple Developer enrolment verification (only the first time).

## 0. One-time accounts (skip if already done)

### Apple Developer ($99/year — required for TestFlight)
1. Go to [developer.apple.com/programs/enroll](https://developer.apple.com/programs/enroll/)
2. Sign in with your Apple ID, pay the $99 fee.
3. Apple verifies your identity. Takes 24–48 hours. You can do all the other steps below in parallel — just can't run `eas submit` until this is approved.

### Expo / EAS (free for our build volume)
1. [expo.dev/signup](https://expo.dev/signup) — create an account.
2. Install the EAS CLI globally:
   ```
   npm install -g eas-cli
   ```
3. Log in:
   ```
   eas login
   ```

## 1. Upgrade Railway to Hobby ($5/mo)

The free tier sleeps after inactivity. The first user every morning would wait ~30 seconds for a cold start. With Hobby it stays warm.

1. Open the Railway dashboard for `music-player`.
2. Settings → Plan → upgrade to Hobby.
3. Done. No code changes needed.

## 2. Initialise EAS in the project

```
cd ~/projects/music-player/MusicPlayer20
eas build:configure
```

This:
- Asks which platforms (pick `iOS` and `Android`).
- Fills in `extra.eas.projectId` in `app.json` automatically (the placeholder I left will be overwritten).
- Reads my `eas.json` and keeps the profiles I set up (`development`, `preview`, `production`).

## 3. Update `eas.json` with your Apple info

Open `MusicPlayer20/eas.json` and replace the three placeholders in the `submit.production.ios` block:

```json
"appleId":     "your-apple-id@example.com",
"ascAppId":    "1234567890",   // from App Store Connect after you create the app record
"appleTeamId": "ABCDE12345"     // Apple Developer Team ID, find at developer.apple.com → Membership
```

You won't have `ascAppId` until step 5. Skip it for now — only matters for `eas submit`.

## 4. Build the iOS preview (for TestFlight)

```
cd ~/projects/music-player/MusicPlayer20
eas build --platform ios --profile preview
```

EAS will:
- Ask you to log in to your Apple Developer account in the browser.
- Generate or use existing signing certificates (let EAS manage them — pick "Yes" when prompted).
- Build remotely on EAS servers (~15-20 minutes).
- Show you a URL to download the `.ipa`.

While that runs, do step 5.

## 5. Create the App Store Connect app record

1. Go to [appstoreconnect.apple.com](https://appstoreconnect.apple.com).
2. Apps → "+" → New App.
3. Fill in:
   - **Platform**: iOS
   - **Name**: Music Player 2.0
   - **Primary Language**: English (or your choice)
   - **Bundle ID**: `com.raresbilcea.musicplayer20` (must match `app.json`)
   - **SKU**: `musicplayer20-001` (any string, internal only)
   - **User Access**: Full Access
4. After creation, the app's **App Store Connect ID** appears at the top — copy it into the `ascAppId` field in `eas.json` (step 3).

## 6. Submit the build to TestFlight

Once `eas build --platform ios --profile preview` from step 4 has completed:

```
cd ~/projects/music-player/MusicPlayer20
eas submit --platform ios --profile production --latest
```

EAS uploads the most recent build to App Store Connect. Apple processes it for ~10 minutes. You get an email when it's ready.

## 7. Invite testers

1. App Store Connect → your app → TestFlight tab.
2. Internal Testing → "+" next to Testers → invite up to 100 people from your team by Apple ID email.
3. (Optional) External Testing → up to 10,000 testers, but requires a short Apple Beta App Review (~24h first time).
4. Testers download the [TestFlight app](https://apps.apple.com/app/testflight/id899247664) from the App Store, accept your invite email, install Music Player 2.0.

## 8. Android (Google Play internal testing)

Parallel track, can be done after iOS. Requires a one-time $25 fee at [play.google.com/console](https://play.google.com/console). Then:

```
eas build --platform android --profile preview
eas submit --platform android --profile production --latest
```

Set up an Internal Testing track in the Play Console, add tester emails, share the opt-in link.

## 9. Smoke test before sharing the invites

On your own device (TestFlight build installed):

- [ ] Open the app → Home tab loads, no errors.
- [ ] Search "Wonderwall" → tap result → chord chart loads → source badge says "from Ultimate-Guitar" or "from Cifra Club".
- [ ] Tap Lessons tab → see "Coming soon" placeholders, no fake teacher names.
- [ ] Tap "Start recording" in Lessons → modal opens → record 5 sec → see Whisper transcript.
- [ ] Tap Record tab → record 10 sec → AudD identifies the song → chord chart opens.
- [ ] Sign up with a fresh email → confirm sign-in works.
- [ ] Sign out → sign back in → confirm session persists.
- [ ] Spam `↻ REGENERATE CHART` 51 times → after 50 you should see "Daily limit reached" error (proves rate-limit works).

If any of those fail, fix before sharing the TestFlight invite.

## 10. What you DON'T have yet (and need before public App Store launch)

These are fine to skip for TestFlight (internal/external beta) but required for a real public App Store release later:

- A privacy policy hosted at a public URL (Apple requires a link in App Store metadata).
- App screenshots in the required sizes (6.7", 6.5", 5.5" — three each minimum).
- App description text, keywords, support URL.
- Age rating questionnaire.
- App Review demo account credentials (if your app requires login to see content — ours does, behind the free gate).

A minimal privacy policy template is on [termsfeed.com](https://www.termsfeed.com/privacy-policy-generator/) — paste your details and host the resulting HTML on Vercel/Netlify free tier.
