-- OKE Canada calculator — Supabase schema v2
-- Adds: server-side rates, view tracking, expiry, magic-link auth, admin gating.
-- Idempotent: safe to re-run in Supabase SQL Editor on top of the v1 schema.

create extension if not exists pgcrypto;

-- ============================================================
-- 1. LANE RATES — moved off the HTML client
-- ============================================================
create table if not exists public.lane_rates (
  id uuid primary key default gen_random_uuid(),
  origin text not null,
  destination text not null,
  min_charge numeric(12,4) not null,
  ltl_rate numeric(12,4) not null,
  cwt1000 numeric(12,4) not null,
  cwt2000 numeric(12,4) not null,
  cwt5000 numeric(12,4) not null,
  cwt10000 numeric(12,4) not null,
  updated_at timestamptz not null default now(),
  unique (origin, destination)
);

create index if not exists lane_rates_origin_idx on public.lane_rates(origin);
create index if not exists lane_rates_origin_upper_idx on public.lane_rates(upper(trim(origin)));
create index if not exists lane_rates_lane_upper_idx on public.lane_rates(upper(trim(origin)), upper(trim(destination)));

alter table public.lane_rates enable row level security;
-- intentionally NO select/insert/update/delete policies for anon or authenticated.
-- Only SECURITY DEFINER functions below can read this table.

-- ============================================================
-- 2. QUOTES — add expiry + ownership columns
-- ============================================================
alter table public.quotes add column if not exists user_id uuid references auth.users(id) on delete set null;
alter table public.quotes add column if not exists device_id text;
alter table public.quotes add column if not exists valid_until timestamptz not null default (now() + interval '14 days');
alter table public.quotes add column if not exists view_count integer not null default 0;
alter table public.quotes add column if not exists last_viewed_at timestamptz;
alter table public.quotes add column if not exists contact_name text;
alter table public.quotes add column if not exists contact_email text;

create index if not exists quotes_user_idx on public.quotes(user_id);
create index if not exists quotes_valid_until_idx on public.quotes(valid_until);
create index if not exists quotes_device_idx on public.quotes(device_id);

grant insert on public.quotes to anon, authenticated;
grant select, update on public.quotes to authenticated;

-- ============================================================
-- 3. QUOTE VIEWS — every share-link open is a lead signal
-- ============================================================
create table if not exists public.quote_views (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references public.quotes(id) on delete cascade,
  public_token uuid not null,
  viewed_at timestamptz not null default now(),
  user_agent text,
  referrer text,
  ip_hash text
);
create index if not exists quote_views_quote_idx on public.quote_views(quote_id, viewed_at desc);
create index if not exists quote_views_token_idx on public.quote_views(public_token);
alter table public.quote_views enable row level security;
-- No direct policies; access only via SECURITY DEFINER functions.

-- ============================================================
-- 4. ADMIN GATING
-- ============================================================
create table if not exists public.admin_emails (
  email text primary key,
  added_at timestamptz not null default now()
);

-- Seed your admin email. CHANGE THIS if you want different admins.
insert into public.admin_emails(email) values ('eger77.2@gmail.com')
on conflict (email) do nothing;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.admin_emails ae
    where ae.email = (auth.jwt() ->> 'email')
  );
$$;
grant execute on function public.is_admin() to authenticated;

-- ============================================================
-- 5. RLS POLICIES on quotes
-- ============================================================
-- Drop legacy policy from v1, replace with the full set
drop policy if exists "anon can create quotes" on public.quotes;

-- Anyone (anon or signed-in) can INSERT a quote. The check stamps it as their own
-- if they're signed in, otherwise it stays anonymous (user_id null, accessed via token only).
drop policy if exists "public insert quotes" on public.quotes;
create policy "public insert quotes"
on public.quotes
for insert
to anon, authenticated
with check (
  user_id is null
  or user_id = auth.uid()
);

-- Signed-in users see their own quotes
drop policy if exists "users see own quotes" on public.quotes;
create policy "users see own quotes"
on public.quotes
for select
to authenticated
using (user_id = auth.uid());

-- Signed-in users can UPDATE (e.g. attach contact info) on their own quotes
drop policy if exists "users update own quotes" on public.quotes;
create policy "users update own quotes"
on public.quotes
for update
to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

-- Admins see everything
drop policy if exists "admins see all quotes" on public.quotes;
create policy "admins see all quotes"
on public.quotes
for select
to authenticated
using (public.is_admin());

drop policy if exists "admins update all quotes" on public.quotes;
create policy "admins update all quotes"
on public.quotes
for update
to authenticated
using (public.is_admin())
with check (public.is_admin());

-- booking_requests: keep anon insert (existing v1 policy stays). Add admin read.
drop policy if exists "admins see all bookings" on public.booking_requests;
create policy "admins see all bookings"
on public.booking_requests
for select
to authenticated
using (public.is_admin());

-- quote_events: admin-only read
drop policy if exists "admins see all events" on public.quote_events;
create policy "admins see all events"
on public.quote_events
for select
to authenticated
using (public.is_admin());

drop policy if exists "anyone can append events" on public.quote_events;
create policy "anyone can append events"
on public.quote_events
for insert
to anon, authenticated
with check (true);

-- ============================================================
-- 6. PUBLIC RPCs — the only way to touch lane_rates / quote_views
-- ============================================================

-- 6a. List origins (for autocomplete) — not sensitive (just cities OKE serves)
create or replace function public.list_origins()
returns setof text
language sql
stable
security definer
set search_path = public
as $$
  select distinct origin from public.lane_rates order by origin;
$$;
revoke all on function public.list_origins() from public;
grant execute on function public.list_origins() to anon, authenticated;

-- 6b. List destinations for a chosen origin
create or replace function public.list_destinations(p_origin text)
returns setof text
language sql
stable
security definer
set search_path = public
as $$
  select destination from public.lane_rates
  where upper(trim(origin)) = upper(trim(p_origin))
  order by destination;
$$;
revoke all on function public.list_destinations(text) from public;
grant execute on function public.list_destinations(text) to anon, authenticated;

-- 6c. Get the cheapest line-haul charge for a lane + weight.
-- Returns the resolved breakdown WITHOUT exposing the other 5 rate columns.
-- This is what protects the rate matrix: a competitor can probe one lane+weight at a time,
-- not download the whole table.
create or replace function public.calculate_line_haul(
  p_origin text,
  p_destination text,
  p_billable_lbs integer
)
returns table (
  middle_mile_sell numeric,
  cwt_col text,
  cwt_rate numeric,
  weight_charge numeric,
  min_charge numeric,
  lane_found boolean
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  r public.lane_rates%rowtype;
  ltl_charge numeric;
  c1k numeric; c2k numeric; c5k numeric; c10k numeric;
  best_col text; best_rate numeric; best_charge numeric;
begin
  select * into r from public.lane_rates
   where upper(trim(origin)) = upper(trim(p_origin))
     and upper(trim(destination)) = upper(trim(p_destination));
  if not found then
    lane_found := false;
    return next;
    return;
  end if;

  ltl_charge := p_billable_lbs * r.ltl_rate / 100.0;
  c1k  := greatest(p_billable_lbs,  1000) * r.cwt1000  / 100.0;
  c2k  := greatest(p_billable_lbs,  2000) * r.cwt2000  / 100.0;
  c5k  := greatest(p_billable_lbs,  5000) * r.cwt5000  / 100.0;
  c10k := greatest(p_billable_lbs, 10000) * r.cwt10000 / 100.0;

  best_col := 'LTL';     best_rate := r.ltl_rate;  best_charge := ltl_charge;
  if c1k  < best_charge then best_col := 'CWT 1k';  best_rate := r.cwt1000;  best_charge := c1k;  end if;
  if c2k  < best_charge then best_col := 'CWT 2k';  best_rate := r.cwt2000;  best_charge := c2k;  end if;
  if c5k  < best_charge then best_col := 'CWT 5k';  best_rate := r.cwt5000;  best_charge := c5k;  end if;
  if c10k < best_charge then best_col := 'CWT 10k'; best_rate := r.cwt10000; best_charge := c10k; end if;

  middle_mile_sell := greatest(best_charge, r.min_charge);
  cwt_col := best_col;
  cwt_rate := best_rate;
  weight_charge := best_charge;
  min_charge := r.min_charge;
  lane_found := true;
  return next;
end;
$$;
revoke all on function public.calculate_line_haul(text, text, integer) from public;
grant execute on function public.calculate_line_haul(text, text, integer) to anon, authenticated;

-- 6d. Log a quote view (called from the shared quote page)
create or replace function public.log_quote_view(
  p_token uuid,
  p_user_agent text,
  p_referrer text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  q_id uuid;
begin
  select id into q_id from public.quotes where public_token = p_token;
  if not found then
    return;
  end if;
  insert into public.quote_views (quote_id, public_token, user_agent, referrer)
  values (q_id, p_token, p_user_agent, p_referrer);
  update public.quotes
     set view_count = view_count + 1,
         last_viewed_at = now(),
         status = case when status in ('draft', 'shared') then 'viewed' else status end
   where id = q_id;
end;
$$;
revoke all on function public.log_quote_view(uuid, text, text) from public;
grant execute on function public.log_quote_view(uuid, text, text) to anon, authenticated;

-- 6d-2. Submit a booking/change request from a public quote link.
-- This updates the CRM status even though the customer is anonymous.
create or replace function public.submit_quote_request(
  p_token uuid,
  p_action text,
  p_contact_name text default null,
  p_contact_email text default null,
  p_contact_phone text default null,
  p_notes text default null,
  p_user_agent text default null
)
returns table (
  request_id uuid,
  quote_id uuid,
  quote_ref text,
  status text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  q public.quotes%rowtype;
  new_status text;
  req_id uuid;
begin
  select * into q from public.quotes where public_token = p_token;
  if not found then
    raise exception 'Quote not found';
  end if;

  new_status := case
    when p_action = 'accept' then 'booking_requested'
    else 'changes_requested'
  end;

  insert into public.booking_requests (
    quote_id, quote_ref, contact_name, contact_email, contact_phone, notes, status, metadata
  )
  values (
    q.id,
    q.quote_ref,
    nullif(p_contact_name, ''),
    nullif(p_contact_email, ''),
    nullif(p_contact_phone, ''),
    nullif(p_notes, ''),
    new_status,
    jsonb_build_object(
      'action', p_action,
      'public_token', p_token,
      'quote_total', q.total_after_tax,
      'lane', concat_ws(' -> ', q.origin, q.destination),
      'user_agent', p_user_agent
    )
  )
  returning id into req_id;

  update public.quotes
     set status = new_status,
         contact_name = coalesce(nullif(p_contact_name, ''), contact_name),
         contact_email = coalesce(nullif(p_contact_email, ''), contact_email)
   where id = q.id;

  insert into public.quote_events (quote_id, event_type, metadata)
  values (q.id, new_status, jsonb_build_object('request_id', req_id, 'action', p_action))
  on conflict do nothing;

  request_id := req_id;
  quote_id := q.id;
  quote_ref := q.quote_ref;
  status := new_status;
  return next;
end;
$$;
revoke all on function public.submit_quote_request(uuid, text, text, text, text, text, text) from public;
grant execute on function public.submit_quote_request(uuid, text, text, text, text, text, text) to anon, authenticated;

-- 6e. Replace v1's get_quote_by_token — return expiry + view count too
drop function if exists public.get_quote_by_token(uuid);
create or replace function public.get_quote_by_token(share_token uuid)
returns table (
  id uuid,
  quote_ref text,
  public_token uuid,
  status text,
  lane_mode text,
  origin text,
  destination text,
  service_id text,
  service_name text,
  pickup_date date,
  measurement_mode text,
  total_pcs integer,
  actual_weight_lbs numeric,
  cubic_ft numeric,
  dim_weight_lbs numeric,
  billable_weight_lbs integer,
  middle_mile_sell numeric,
  final_mile_base numeric,
  extra_piece_charge numeric,
  accessorials_amount numeric,
  subtotal numeric,
  fuel_pct numeric,
  fuel_amount numeric,
  tax_id text,
  tax_label text,
  tax_rate numeric,
  tax_amount numeric,
  total_before_tax numeric,
  total_after_tax numeric,
  payload jsonb,
  valid_until timestamptz,
  view_count integer,
  last_viewed_at timestamptz,
  expired boolean,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select q.id, q.quote_ref, q.public_token, q.status, q.lane_mode, q.origin, q.destination,
         q.service_id, q.service_name, q.pickup_date, q.measurement_mode, q.total_pcs,
         q.actual_weight_lbs, q.cubic_ft, q.dim_weight_lbs, q.billable_weight_lbs,
         q.middle_mile_sell, q.final_mile_base, q.extra_piece_charge, q.accessorials_amount,
         q.subtotal, q.fuel_pct, q.fuel_amount, q.tax_id, q.tax_label, q.tax_rate, q.tax_amount,
         q.total_before_tax, q.total_after_tax, q.payload,
         q.valid_until, q.view_count, q.last_viewed_at,
         (q.valid_until < now()) as expired,
         q.created_at
    from public.quotes q
   where q.public_token = share_token
   limit 1;
$$;
revoke all on function public.get_quote_by_token(uuid) from public;
grant execute on function public.get_quote_by_token(uuid) to anon, authenticated;

-- 6f. Claim anonymous quotes after magic-link login
create or replace function public.claim_quotes_for_device(p_device_id text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  if auth.uid() is null then
    return 0;
  end if;
  update public.quotes
     set user_id = auth.uid()
   where device_id = p_device_id
     and user_id is null;
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke all on function public.claim_quotes_for_device(text) from public;
grant execute on function public.claim_quotes_for_device(text) to authenticated;

create or replace function public.claim_quote_by_token(p_token uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  if auth.uid() is null then
    return 0;
  end if;
  update public.quotes
     set user_id = auth.uid()
   where public_token = p_token
     and (user_id is null or user_id = auth.uid());
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke all on function public.claim_quote_by_token(uuid) from public;
grant execute on function public.claim_quote_by_token(uuid) to authenticated;

-- 6g. Admin: list quotes with filters (server-side filter respects RLS via is_admin())
create or replace function public.admin_list_quotes(
  p_status text default null,
  p_search text default null,
  p_since timestamptz default null,
  p_limit integer default 200
)
returns setof public.quotes
language sql
stable
security definer
set search_path = public
as $$
  select *
    from public.quotes
   where public.is_admin()
     and (p_status is null or status = p_status)
     and (p_since is null or created_at >= p_since)
     and (
       p_search is null or p_search = '' or
       quote_ref ilike '%' || p_search || '%' or
       coalesce(origin,'') ilike '%' || p_search || '%' or
       coalesce(destination,'') ilike '%' || p_search || '%' or
       coalesce(contact_name,'') ilike '%' || p_search || '%' or
       coalesce(contact_email,'') ilike '%' || p_search || '%'
     )
   order by created_at desc
   limit greatest(1, least(p_limit, 1000));
$$;
revoke all on function public.admin_list_quotes(text, text, timestamptz, integer) from public;
grant execute on function public.admin_list_quotes(text, text, timestamptz, integer) to authenticated;

-- 6h. Admin: aggregate stats for the dashboard header
create or replace function public.admin_stats(p_since timestamptz default null)
returns table (
  total_quotes bigint,
  total_shared bigint,
  total_viewed bigint,
  total_booked bigint,
  total_value numeric,
  booked_value numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select
    count(*) filter (where public.is_admin()),
    count(*) filter (where public.is_admin() and status in ('shared','viewed','booked')),
    count(*) filter (where public.is_admin() and view_count > 0),
    count(*) filter (where public.is_admin() and status = 'booked'),
    coalesce(sum(total_after_tax) filter (where public.is_admin()), 0),
    coalesce(sum(total_after_tax) filter (where public.is_admin() and status = 'booked'), 0)
  from public.quotes
  where p_since is null or created_at >= p_since;
$$;
revoke all on function public.admin_stats(timestamptz) from public;
grant execute on function public.admin_stats(timestamptz) to authenticated;

-- ============================================================
-- 7. Quote ref generator (auto-fill quote_ref if not supplied)
-- ============================================================
create or replace function public.set_quote_ref()
returns trigger
language plpgsql
as $$
begin
  if new.quote_ref is null or new.quote_ref = '' then
    new.quote_ref := 'OKE-' || to_char(now() at time zone 'America/Toronto', 'YYMMDD') ||
                     '-' || upper(substring(replace(gen_random_uuid()::text,'-',''),1,5));
  end if;
  return new;
end;
$$;

drop trigger if exists set_quote_ref_before_insert on public.quotes;
create trigger set_quote_ref_before_insert
before insert on public.quotes
for each row execute function public.set_quote_ref();
