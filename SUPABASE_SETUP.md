# Monte Design Supabase Setup

## Recommended Platform

Use Supabase first. It is the best fit for this calculator because it gives you Postgres, Auth, Storage, Realtime, Edge Functions, Cron, and AI/vector features in one place. The current app can already save quotes locally, and it will start saving to Supabase once you add credentials.

Neon is cheaper if you only need Postgres, but then you still need separate storage, functions, and customer/auth tooling. Firebase is strong, but this calculator needs relational quote/rate history, which is cleaner in Postgres. Appwrite is nice, but its free cloud plan is less useful for automation if function execution is disabled.

## 1. Create The Supabase Project

1. Go to `https://supabase.com`.
2. Create a new project.
3. Choose the closest region to your customers/team.
4. Open `SQL Editor`.
5. Paste and run the contents of `supabase-schema.sql`.

## 2. Add Browser Credentials

In Supabase:

1. Go to `Project Settings`.
2. Open `API`.
3. Copy your `Project URL`.
4. Copy your `anon public` key.

In `index.html`, add this before the main calculator script:

```html
<script>
  window.MONTE_SUPABASE = {
    url: "https://YOUR_PROJECT_REF.supabase.co",
    anonKey: "YOUR_ANON_PUBLIC_KEY"
  };
</script>
```

Do not put the Supabase service-role secret key in `index.html`.

## 3. What Works Immediately

After credentials are added:

- The `Save` button inserts the quote into `public.quotes`.
- The quote record includes lane, items, service, totals, tax, fuel, and full calculator state.
- A share token is generated as `?quote=<token>`.
- Opening the same page with that token reloads the saved quote through `get_quote_by_token`.

Without Supabase credentials, the same button saves to browser `localStorage` so you can test the workflow safely.

## 4. Next Backend Features

Build these in order:

1. Customer quote page: read saved quote by token, show accept/request changes buttons.
2. Admin dashboard: list quotes, filter by status/date/lane, and search by customer.
3. Booking requests: write customer contact and notes into `booking_requests`.
4. Email automations: Supabase Edge Function + Resend for quote sent/viewed/approved.
5. File uploads: Supabase Storage bucket for product photos, BOLs, dock photos, and PODs.
6. Realtime ops board: live quote/booked/in-transit/delivered status updates.
7. AI assistant: explain price, dim weight, lane logic, and create polished quote emails.

