-- ============================================================
-- Şoför Performans ve Operasyon Takip Sistemi
-- Supabase Tam Schema — v2.1
-- ============================================================
-- SQL Editor'de "New query" açın, bu kodu yapıştırın, Run edin.
-- ============================================================


-- ============================================================
-- 1. ROUTES
-- ============================================================
create table if not exists routes (
  id                   uuid primary key default gen_random_uuid(),
  created_at           timestamptz default now(),
  name                 text not null,
  code                 text unique not null,
  description          text,
  ref_fuel_per_100km   numeric(5,2),
  ref_trip_duration_hr numeric(4,2),
  ref_idle_min         numeric(6,2),
  ref_empty_km_pct     numeric(5,2),
  ref_trips_per_day    numeric(4,2),
  min_trips_required   int default 10,
  min_km_required      numeric(8,2) default 500,
  is_pilot             boolean default false,
  is_active            boolean default true
);

alter table routes enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='routes' and policyname='anon okuma routes') then
    create policy "anon okuma routes" on routes for select using (true);
  end if;
  if not exists (select 1 from pg_policies where tablename='routes' and policyname='anon yazma routes') then
    create policy "anon yazma routes" on routes for insert with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename='routes' and policyname='anon guncelleme routes') then
    create policy "anon guncelleme routes" on routes for update using (true);
  end if;
end $$;

insert into routes (name, code, description, ref_fuel_per_100km, ref_trip_duration_hr, ref_idle_min, ref_empty_km_pct, ref_trips_per_day, is_pilot, is_active)
values
  ('Hat A — Fabrika / Depo',   'HAT_A', 'Pilot hat',     33.8, 4.5, 38, 15, 3.2, true,  true),
  ('Hat B — Liman / Şantiye',  'HAT_B', 'Pilot hat',     34.2, 4.8, 42, 18, 2.8, true,  true),
  ('Hat C — Merkez / Dağıtım', 'HAT_C', 'Tam operasyon', 35.0, 5.0, 45, 22, 2.5, false, true),
  ('Hat D — İç Saha',          'HAT_D', 'Tam operasyon', 29.5, 3.1, 30, 8,  4.1, false, true)
on conflict (code) do nothing;


-- ============================================================
-- 2. DRIVERS
-- ============================================================
create table if not exists drivers (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz default now(),
  full_name     text not null,
  phone         text,
  license_no    text,
  vehicle_plate text,
  route_id      uuid references routes(id),
  is_pilot      boolean default false,
  is_active     boolean default true,
  notes         text
);

alter table drivers enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='drivers' and policyname='anon okuma drivers') then
    create policy "anon okuma drivers" on drivers for select using (true);
  end if;
  if not exists (select 1 from pg_policies where tablename='drivers' and policyname='anon yazma drivers') then
    create policy "anon yazma drivers" on drivers for insert with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename='drivers' and policyname='anon guncelleme drivers') then
    create policy "anon guncelleme drivers" on drivers for update using (true);
  end if;
end $$;

insert into drivers (full_name, vehicle_plate, route_id, is_pilot, is_active)
select 'Ahmet K.',  '34 AB 112', id, true, true from routes where code='HAT_A'
union all
select 'Kemal S.',  '34 BC 445', id, true, true from routes where code='HAT_A'
union all
select 'Ali R.',    '34 CD 773', id, true, true from routes where code='HAT_B'
union all
select 'Hasan D.',  '34 DE 228', id, true, true from routes where code='HAT_A'
union all
select 'Mehmet Y.', '34 EF 991', id, true, true from routes where code='HAT_B'
union all
select 'Ömer T.',   '34 FG 334', id, true, true from routes where code='HAT_B'
union all
select 'Serkan A.', '34 GH 661', id, true, true from routes where code='HAT_B'
union all
select 'Burak M.',  '34 HI 882', id, true, true from routes where code='HAT_A'
on conflict do nothing;


-- ============================================================
-- 3. ZONES
-- ============================================================
create table if not exists zones (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz default now(),
  name          text not null,
  short_code    text unique not null,
  zone_type     text not null check (zone_type in ('yukleme','bosaltma','her_ikisi')),
  description   text,
  latitude      numeric(10,7) not null,
  longitude     numeric(10,7) not null,
  radius_meters int not null default 200,
  is_active     boolean default true
);

alter table zones enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='zones' and policyname='anon okuma zones') then
    create policy "anon okuma zones" on zones for select using (true);
  end if;
  if not exists (select 1 from pg_policies where tablename='zones' and policyname='anon yazma zones') then
    create policy "anon yazma zones" on zones for insert with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename='zones' and policyname='anon silme zones') then
    create policy "anon silme zones" on zones for delete using (true);
  end if;
  if not exists (select 1 from pg_policies where tablename='zones' and policyname='anon guncelleme zones') then
    create policy "anon guncelleme zones" on zones for update using (true);
  end if;
end $$;


-- ============================================================
-- 4. CONTRACTS
-- ============================================================
create table if not exists contracts (
  id                  uuid primary key default gen_random_uuid(),
  created_at          timestamptz default now(),
  name                text not null,
  contract_code       text unique not null,
  origin_zone_id      uuid references zones(id) not null,
  destination_zone_id uuid references zones(id) not null,
  price_type          text not null default 'sabit'
                        check (price_type in ('sabit','ton_bazli','karma')),
  fixed_price_tl      numeric(10,2) default 0,
  price_per_ton_tl    numeric(10,2) default 0,
  valid_from          date not null,
  valid_until         date,
  currency            text default 'TRY',
  notes               text,
  is_active           boolean default true
);

alter table contracts enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='contracts' and policyname='anon okuma contracts') then
    create policy "anon okuma contracts" on contracts for select using (true);
  end if;
  if not exists (select 1 from pg_policies where tablename='contracts' and policyname='anon yazma contracts') then
    create policy "anon yazma contracts" on contracts for insert with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename='contracts' and policyname='anon silme contracts') then
    create policy "anon silme contracts" on contracts for delete using (true);
  end if;
  if not exists (select 1 from pg_policies where tablename='contracts' and policyname='anon guncelleme contracts') then
    create policy "anon guncelleme contracts" on contracts for update using (true);
  end if;
end $$;


-- ============================================================
-- 5. TRIPS
-- ============================================================
create table if not exists trips (
  id                   uuid primary key default gen_random_uuid(),
  created_at           timestamptz default now(),
  driver_id            uuid references drivers(id),
  route_id             uuid references routes(id),
  contract_id          uuid references contracts(id),
  vehicle_plate        text not null,
  trip_date            date not null,
  started_at           timestamptz,
  ended_at             timestamptz,
  trip_duration_hr     numeric(5,2),
  total_km             numeric(8,2),
  loaded_km            numeric(8,2),
  empty_km             numeric(8,2),
  empty_km_pct         numeric(5,2),
  fuel_liters          numeric(7,2),
  fuel_per_100km       numeric(5,2),
  idle_min             numeric(6,2),
  loading_wait_min     numeric(6,2),
  unload_wait_min      numeric(6,2),
  cargo_tons           numeric(7,2),
  cargo_tons_confirmed numeric(7,2),
  cycle_time_hr        numeric(5,2),
  trip_revenue_tl      numeric(10,2),
  origin_zone_id       uuid references zones(id),
  dest_zone_id         uuid references zones(id),
  data_source          text default 'manual'
                         check (data_source in ('manual','arvento_csv','arvento_api')),
  arvento_trip_id      text,
  is_excluded          boolean default false,
  exclude_reason       text
);

-- Otomatik hesaplama trigger'ı
create or replace function calc_trip_metrics()
returns trigger language plpgsql as $$
declare
  c contracts%rowtype;
  tons numeric;
begin
  -- Boş km % hesapla
  if new.total_km is not null and new.total_km > 0 then
    if new.empty_km is not null then
      new.empty_km_pct := round((new.empty_km / new.total_km * 100)::numeric, 2);
    end if;
    if new.fuel_liters is not null then
      new.fuel_per_100km := round((new.fuel_liters / new.total_km * 100)::numeric, 2);
    end if;
  end if;
  -- Sefer geliri hesapla
  if new.contract_id is not null then
    select * into c from contracts where id = new.contract_id;
    tons := coalesce(new.cargo_tons_confirmed, new.cargo_tons, 0);
    if c.price_type = 'sabit' then
      new.trip_revenue_tl := c.fixed_price_tl;
    elsif c.price_type = 'ton_bazli' then
      new.trip_revenue_tl := c.price_per_ton_tl * tons;
    elsif c.price_type = 'karma' then
      new.trip_revenue_tl := c.fixed_price_tl + (c.price_per_ton_tl * tons);
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_calc_trip_metrics on trips;
create trigger trg_calc_trip_metrics
before insert or update on trips
for each row execute function calc_trip_metrics();

create index if not exists idx_trips_driver   on trips(driver_id);
create index if not exists idx_trips_route    on trips(route_id);
create index if not exists idx_trips_contract on trips(contract_id);
create index if not exists idx_trips_date     on trips(trip_date);

alter table trips enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='trips' and policyname='anon okuma trips') then
    create policy "anon okuma trips" on trips for select using (true);
  end if;
  if not exists (select 1 from pg_policies where tablename='trips' and policyname='anon yazma trips') then
    create policy "anon yazma trips" on trips for insert with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename='trips' and policyname='anon guncelleme trips') then
    create policy "anon guncelleme trips" on trips for update using (true);
  end if;
  if not exists (select 1 from pg_policies where tablename='trips' and policyname='anon silme trips') then
    create policy "anon silme trips" on trips for delete using (true);
  end if;
end $$;


-- ============================================================
-- 6. ZONE_EVENTS
-- ============================================================
create table if not exists zone_events (
  id            uuid primary key default gen_random_uuid(),
  occurred_at   timestamptz not null,
  vehicle_plate text not null,
  driver_id     uuid references drivers(id),
  zone_id       uuid references zones(id) not null,
  event_type    text not null check (event_type in ('giris','cikis')),
  latitude      numeric(10,7),
  longitude     numeric(10,7),
  speed_kmh     numeric(5,1),
  arvento_data  jsonb
);

create index if not exists idx_zone_events_plate on zone_events(vehicle_plate);
create index if not exists idx_zone_events_zone  on zone_events(zone_id);
create index if not exists idx_zone_events_time  on zone_events(occurred_at);

alter table zone_events enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='zone_events' and policyname='anon okuma zone_events') then
    create policy "anon okuma zone_events" on zone_events for select using (true);
  end if;
  if not exists (select 1 from pg_policies where tablename='zone_events' and policyname='anon yazma zone_events') then
    create policy "anon yazma zone_events" on zone_events for insert with check (true);
  end if;
end $$;


-- ============================================================
-- 7. PERFORMANCE_SCORES
-- ============================================================
create table if not exists performance_scores (
  id                    uuid primary key default gen_random_uuid(),
  calculated_at         timestamptz default now(),
  driver_id             uuid references drivers(id),
  route_id              uuid references routes(id),
  period_year           int not null,
  period_month          int not null,
  avg_fuel_per_100km    numeric(5,2),
  avg_trip_duration_hr  numeric(5,2),
  avg_idle_min          numeric(6,2),
  avg_empty_km_pct      numeric(5,2),
  avg_trips_per_day     numeric(4,2),
  total_trips           int,
  total_km              numeric(10,2),
  total_revenue_tl      numeric(12,2),
  route_stddev_fuel     numeric(6,3),
  route_stddev_duration numeric(6,3),
  route_stddev_idle     numeric(6,3),
  route_stddev_empty    numeric(6,3),
  score_fuel            numeric(6,3),
  score_trip_duration   numeric(6,3),
  score_idle            numeric(6,3),
  score_empty_km        numeric(6,3),
  score_trips           numeric(6,3),
  weighted_score        numeric(6,3),
  performance_index     numeric(6,2),
  bonus_band            text check (bonus_band in ('yuksek','normal','dusuk','yok')),
  has_sufficient_data   boolean default true,
  trip_count_ok         boolean default true,
  km_ok                 boolean default true,
  unique (driver_id, period_year, period_month)
);

alter table performance_scores enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='performance_scores' and policyname='anon okuma performance_scores') then
    create policy "anon okuma performance_scores" on performance_scores for select using (true);
  end if;
  if not exists (select 1 from pg_policies where tablename='performance_scores' and policyname='anon yazma performance_scores') then
    create policy "anon yazma performance_scores" on performance_scores for insert with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename='performance_scores' and policyname='anon guncelleme performance_scores') then
    create policy "anon guncelleme performance_scores" on performance_scores for update using (true);
  end if;
end $$;


-- ============================================================
-- 8. VIEW'LAR
-- ============================================================

drop view if exists route_stats_30d cascade;
drop view if exists contract_revenue_summary cascade;
drop view if exists driver_performance_30d cascade;
drop view if exists daily_summary cascade;

create or replace view daily_summary as
select
  trip_date,
  count(*)                                    as total_trips,
  count(distinct vehicle_plate)               as active_vehicles,
  round(sum(cargo_tons)::numeric, 1)          as total_tons,
  round(avg(fuel_per_100km)::numeric, 2)      as avg_fuel_per_100km,
  round(avg(idle_min)::numeric, 1)            as avg_idle_min,
  round(avg(empty_km_pct)::numeric, 1)        as avg_empty_km_pct,
  round(avg(cycle_time_hr)::numeric, 2)       as avg_cycle_time_hr,
  round(avg(loading_wait_min)::numeric, 1)    as avg_loading_wait_min,
  round(avg(unload_wait_min)::numeric, 1)     as avg_unload_wait_min,
  round(sum(total_km)::numeric, 0)            as total_km,
  round(sum(trip_revenue_tl)::numeric, 2)     as total_revenue_tl
from trips
where is_excluded = false
group by trip_date
order by trip_date desc;

create or replace view driver_performance_30d as
select
  d.id                                              as driver_id,
  d.full_name,
  d.vehicle_plate,
  r.name                                            as route_name,
  r.code                                            as route_code,
  count(t.id)                                       as trip_count,
  round(avg(t.fuel_per_100km)::numeric, 2)          as avg_fuel,
  round(avg(t.trip_duration_hr)::numeric, 2)        as avg_duration,
  round(avg(t.idle_min)::numeric, 1)                as avg_idle,
  round(avg(t.empty_km_pct)::numeric, 1)            as avg_empty_km_pct,
  round(sum(t.trip_revenue_tl)::numeric, 2)         as total_revenue_tl,
  r.ref_fuel_per_100km,
  r.ref_trip_duration_hr,
  r.ref_idle_min,
  r.ref_empty_km_pct,
  round((r.ref_fuel_per_100km   - avg(t.fuel_per_100km))::numeric, 3)   as fuel_delta,
  round((r.ref_trip_duration_hr - avg(t.trip_duration_hr))::numeric, 3) as duration_delta,
  round((r.ref_idle_min         - avg(t.idle_min))::numeric, 3)         as idle_delta,
  round((r.ref_empty_km_pct     - avg(t.empty_km_pct))::numeric, 3)    as empty_km_delta
from drivers d
join routes r on d.route_id = r.id
left join trips t on t.driver_id = d.id
  and t.trip_date >= current_date - interval '30 days'
  and t.is_excluded = false
where d.is_active = true
group by d.id, d.full_name, d.vehicle_plate,
         r.name, r.code, r.ref_fuel_per_100km,
         r.ref_trip_duration_hr, r.ref_idle_min, r.ref_empty_km_pct;

create or replace view contract_revenue_summary as
select
  c.name                                        as contract_name,
  c.contract_code,
  c.price_type,
  oz.name                                       as origin_zone_name,
  dz.name                                       as dest_zone_name,
  count(t.id)                                   as total_trips,
  round(sum(t.cargo_tons)::numeric, 1)          as total_tons,
  round(sum(t.trip_revenue_tl)::numeric, 2)     as total_revenue_tl,
  round(avg(t.trip_revenue_tl)::numeric, 2)     as avg_revenue_per_trip,
  min(t.trip_date)                              as first_trip,
  max(t.trip_date)                              as last_trip
from contracts c
left join zones oz on oz.id = c.origin_zone_id
left join zones dz on dz.id = c.destination_zone_id
left join trips t on t.contract_id = c.id and t.is_excluded = false
where c.is_active = true
group by c.id, c.name, c.contract_code, c.price_type, oz.name, dz.name
order by total_revenue_tl desc nulls last;

create or replace view route_stats_30d as
select
  t.route_id,
  r.name                                             as route_name,
  count(t.id)                                        as trip_count,
  round(avg(t.fuel_per_100km)::numeric, 2)           as avg_fuel,
  round(stddev(t.fuel_per_100km)::numeric, 3)        as stddev_fuel,
  round(avg(t.trip_duration_hr)::numeric, 2)         as avg_duration,
  round(stddev(t.trip_duration_hr)::numeric, 3)      as stddev_duration,
  round(avg(t.idle_min)::numeric, 1)                 as avg_idle,
  round(stddev(t.idle_min)::numeric, 3)              as stddev_idle,
  round(avg(t.empty_km_pct)::numeric, 1)             as avg_empty_km,
  round(stddev(t.empty_km_pct)::numeric, 3)          as stddev_empty_km
from trips t
join routes r on r.id = t.route_id
where t.is_excluded = false
  and t.trip_date >= current_date - interval '30 days'
group by t.route_id, r.name;

-- ============================================================
-- Tamamlandı.
-- ============================================================
