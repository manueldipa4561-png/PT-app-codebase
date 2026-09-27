# App Store and Google Play (store plan)

The store plan gives a trainer real apps in the App Store and Google Play, in their own name. This is the playbook. The pipeline is not built yet: it waits until the first store plan is sold ([TODOS.md](../TODOS.md)).

## Sell it right

- Sell the first store app as **paid discovery**: time and materials, quoted up front. Fix a package price only after one trainer's app has passed both reviews and you know the real effort.
- **Promise no dates** until one binary has passed both stores. Google alone can take 4-6 weeks for a new account.
- The trainer pays Apple and Google directly: the Apple Developer Program costs about 99 EUR a year, Google Play 25 USD once.

## How the app is built

- Capacitor wraps the same web build (`dist/`). There is no second codebase.
- A native app has no hostname, so the trainer is baked in at build time with `VITE_TRAINER=<slug>`. It wins over every other way of picking the trainer (`trainerKey()` in `src/api.ts`).
- One app id per trainer, for example `it.mariorossi.app`. The name and icons come from the trainer's logo.
- **Android** builds on Windows (Android Studio).
- **iOS** needs a Mac. We have none, so we rent one in the cloud:
  - Codemagic, free tier of about 500 macOS build minutes a month, one workflow per trainer.
  - Alternatives: Capawesome Cloud, Capgo Build.

## Why the trainer's own developer accounts

Apple guideline 4.2.6 and Google Play's template-app policy do not let an agency publish its clients' template apps from the agency's own account. So each app lives in the **trainer's own** Apple and Google accounts, and Punto Due works there as an invited team member.

**Apple (App Store Connect)**
- The trainer enrolls in the Apple Developer Program (about 99 EUR a year). A sole trader enrolls as an individual.
- The trainer invites Punto Due with the **App Manager** role.
- Automated uploads (Codemagic) need an App Store Connect API key. **Only the Account Holder** (the trainer) can request API access. After that, they create a team key.
- The team key file (`.p8`) **downloads only once**. The trainer sends it through a password manager, never by email, and we store it in ours.
- If the yearly membership lapses, the app disappears from the App Store. Put the renewal date in the calendar.

**Google (Play Console)**
- The trainer creates a Play Console developer account (25 USD once).
- The trainer invites Punto Due as a user with release rights.
- **Back up the Android signing key** (the keystore file and its passwords) in two places. If it is lost, updates stop until Google approves a key reset.

## Google Play: the closed test

- Personal developer accounts created after 13 November 2023 must run a **closed test with at least 12 opted-in testers for 14 days in a row** before they can apply for production.
- The testers must be **Android users**. iPhone owners cannot help. Use the trainer's own clients.
- After the 14 days you apply for production access and answer questions about the test. **Google can still refuse.** Then you fix what they ask for and test again.
- **Organization accounts skip the test.** They need a D-U-N-S number. Ask the trainer whether their business has one before they create the account.
- Budget **4-6 weeks** for a first Android launch.

## Apple review checklist

- [ ] **More than a wrapped website** (guideline 4.2): native push notifications and the native share sheet for referral links.
- [ ] **Account deletion inside the app** (5.1.1(v)). It exists: Profile > delete account (`delete_my_account`).
- [ ] **Reviewer login.** A reviewer cannot receive our email code, so plan a password login for one review account and put its details in the review notes ([TODOS.md](../TODOS.md)).
- [ ] **Privacy labels** filled in (App Privacy in App Store Connect).
- [ ] **Privacy policy URL**: the trainer's privacy page.
- [ ] Login is email only, so Sign in with Apple is not required (4.8).

Google asks for the same things in its own forms: Data safety, a privacy policy URL, and the review login under App access.

## EU trader status (Digital Services Act)

Both stores ask whether the developer is a **trader**. A trainer who sells their services is one. For traders, the store shows their **address, phone number and email on the EU store page**.

Warn sole traders who work from home before they enroll: their home address becomes public.

## Payments inside the store apps

| What the client buys | How they pay | Rule |
|---|---|---|
| In-person sessions and packs | Stripe, or offline as today | App Store 3.1.3(e): services used outside the app |
| Physical goods (the shop) | Stripe Payment Link | App Store 3.1.3(e) |
| A live one-to-one online session | Stripe allowed | 3.1.3(d): person-to-person services |
| A live online group class | Apple in-app purchase | 3.1.3(d): one-to-few and one-to-many need it |
| Digital content (videos, programs) | Apple in-app purchase | 3.1.1 |

v1 sells no online classes and no digital content, so the store apps need no in-app purchase. Keep it that way unless a trainer pays for the extra work. Google Play has the same split: physical goods and services used outside the app do not go through Play billing.

## Keep store apps in step with the backend

A web deploy updates every trainer at once. A store app does not: each phone keeps its installed version until the client updates. Old binaries keep calling the new backend. So:

- **Migrations add before they remove** (expand, then contract). Add the new column or function, ship apps that use it, and remove the old one only when no installed app needs it.
- **A `min_app_version` check from the first store trainer.** The app compares its own version with a minimum stored in the database and asks the client to update when it is too old. It must be in the first binary ([TODOS.md](../TODOS.md)).
- Store releases go out in batches. Live updates (Capgo or Capawesome) come at 5 or more store trainers.

## Onboarding checklist for one store trainer

1. [ ] The trainer paid the discovery quote. No dates promised.
2. [ ] Before enrolling, the trainer knows two things: as a trader their address is public in the EU stores, and a D-U-N-S number lets them open a Google organization account and skip the closed test.
3. [ ] The trainer enrolled in the Apple Developer Program and created a Google Play developer account, both in their own name.
4. [ ] The trainer invited Punto Due: App Manager in App Store Connect, a user with release rights in Play Console.
5. [ ] The trainer requested App Store Connect API access, created a team key and sent the `.p8` through a password manager. It is stored in ours.
6. [ ] App id chosen (`it.<trainer>.app`). App records created in App Store Connect and Play Console.
7. [ ] Icons and splash screen made from the trainer's logo. Store texts and screenshots ready, in Italian.
8. [ ] Built with `VITE_TRAINER=<slug>`: Android on Windows, iOS on Codemagic.
9. [ ] Android keystore and passwords backed up in two places.
10. [ ] Review account with a password login. Details in the Apple review notes and in Google's App access.
11. [ ] Apple privacy labels and Google Data safety filled in. Privacy policy URL set to the trainer's privacy page.
12. [ ] Trader status declared in both stores.
13. [ ] Google closed test started with at least 12 of the trainer's clients on Android. Day 1 noted, production access requested after day 14.
14. [ ] iOS tested through TestFlight on a real iPhone, then submitted for review.
15. [ ] Both apps live. Clients told where to find them. The web app keeps working for everyone else.
16. [ ] Apple renewal date in the calendar.
