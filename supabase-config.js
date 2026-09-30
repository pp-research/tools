/* ══════════ SHARED LIST — CONNECTION DETAILS ══════════

   Fill in the two values below and the IRR Calculator becomes one shared list:
   everyone who opens the page reads it, and the people who sign in can change
   it. Leave them as they are and the tool behaves exactly as it always has —
   one browser's own list, kept in that browser.

   Both values come from the Supabase dashboard for the `irr-calculator`
   project (pp-research organisation):

       Project Settings → API Keys → "Publishable and secret API keys"

   url  — Project Settings → Data API → Project URL
          it looks like  https://xxxxxxxxxxxx.supabase.co
   key  — the PUBLISHABLE key, the one that starts  sb_publishable_

   Use the PUBLISHABLE key, never a secret one. The publishable key is designed
   to sit in a public web page: on its own it can read this one table and
   nothing else, and it cannot write. That is enforced by the database, not by
   this file — it was verified by calling the API anonymously and confirming a
   write comes back "new row violates row-level security policy".

   A secret key would bypass all of that. If one is ever pasted here by
   mistake, treat it as compromised and roll it in the dashboard.           */

window.PP_SUPABASE = {
  url: 'YOUR_PROJECT_URL',
  key: 'YOUR_PUBLISHABLE_KEY',

  /* The row that holds the book. Leave this alone unless you want a second,
     separate shared list — a different name here is a different list. */
  row: 'adelaide'
};
