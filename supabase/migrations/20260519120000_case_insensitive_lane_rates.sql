create index if not exists lane_rates_origin_upper_idx
on public.lane_rates (upper(trim(origin)));

create index if not exists lane_rates_lane_upper_idx
on public.lane_rates (upper(trim(origin)), upper(trim(destination)));

create or replace function public.list_destinations(p_origin text)
returns setof text
language sql
stable
security definer
set search_path = public
as $$
  select destination
  from public.lane_rates
  where upper(trim(origin)) = upper(trim(p_origin))
  order by destination;
$$;

revoke all on function public.list_destinations(text) from public;
grant execute on function public.list_destinations(text) to anon, authenticated;

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
  select * into r
  from public.lane_rates
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

  best_col := 'LTL'; best_rate := r.ltl_rate; best_charge := ltl_charge;
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
