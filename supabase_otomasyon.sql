-- ============================================================
-- Otomatik Zamanlayıcılar — pg_cron + daily_snapshots
-- Supabase SQL Editor'e yapıştırın ve Run edin
-- ============================================================

-- 1. daily_snapshots tablosu
create table if not exists daily_snapshots (
  id            uuid primary key default gen_random_uuid(),
  snapshot_date date unique not null,
  created_at    timestamptz default now(),

  total_trips       int,
  active_vehicles   int,
  total_tons        numeric(10,2),
  total_revenue_tl  numeric(12,2),
  avg_fuel_per_100km numeric(5,2),
  avg_idle_min      numeric(6,2),
  avg_empty_km_pct  numeric(5,2),
  avg_cycle_time_hr numeric(5,2),
  total_km          numeric(10,2),
  zone_events_count int,
  auto_trips_count  int
);

alter table daily_snapshots enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='daily_snapshots' and policyname='anon okuma daily_snapshots') then
    create policy "anon okuma daily_snapshots" on daily_snapshots for select using (true);
  end if;
  if not exists (select 1 from pg_policies where tablename='daily_snapshots' and policyname='anon yazma daily_snapshots') then
    create policy "anon yazma daily_snapshots" on daily_snapshots for insert with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename='daily_snapshots' and policyname='anon guncelleme daily_snapshots') then
    create policy "anon guncelleme daily_snapshots" on daily_snapshots for update using (true);
  end if;
end $$;


-- 2. Günlük snapshot fonksiyonu
-- Her gece 23:59'da çalışır, o günün özetini kaydeder
create or replace function take_daily_snapshot()
returns void language plpgsql as $$
declare
  today date := current_date;
  snap record;
  ev_count int;
  auto_count int;
begin
  select
    count(*)                          as total_trips,
    count(distinct vehicle_plate)     as active_vehicles,
    round(sum(cargo_tons)::numeric,2) as total_tons,
    round(sum(trip_revenue_tl)::numeric,2) as total_revenue_tl,
    round(avg(fuel_per_100km)::numeric,2)  as avg_fuel,
    round(avg(idle_min)::numeric,2)        as avg_idle,
    round(avg(empty_km_pct)::numeric,2)    as avg_empty,
    round(avg(cycle_time_hr)::numeric,2)   as avg_cycle,
    round(sum(total_km)::numeric,0)        as total_km
  into snap
  from trips
  where trip_date = today and is_excluded = false;

  select count(*) into ev_count
  from zone_events
  where occurred_at::date = today;

  select count(*) into auto_count
  from trips
  where trip_date = today
    and data_source = 'arvento_api'
    and is_excluded = false;

  insert into daily_snapshots (
    snapshot_date, total_trips, active_vehicles,
    total_tons, total_revenue_tl, avg_fuel_per_100km,
    avg_idle_min, avg_empty_km_pct, avg_cycle_time_hr,
    total_km, zone_events_count, auto_trips_count
  ) values (
    today,
    coalesce(snap.total_trips, 0),
    coalesce(snap.active_vehicles, 0),
    coalesce(snap.total_tons, 0),
    coalesce(snap.total_revenue_tl, 0),
    snap.avg_fuel,
    snap.avg_idle,
    snap.avg_empty,
    snap.avg_cycle,
    coalesce(snap.total_km, 0),
    coalesce(ev_count, 0),
    coalesce(auto_count, 0)
  )
  on conflict (snapshot_date) do update set
    total_trips        = excluded.total_trips,
    active_vehicles    = excluded.active_vehicles,
    total_tons         = excluded.total_tons,
    total_revenue_tl   = excluded.total_revenue_tl,
    avg_fuel_per_100km = excluded.avg_fuel_per_100km,
    avg_idle_min       = excluded.avg_idle_min,
    avg_empty_km_pct   = excluded.avg_empty_km_pct,
    avg_cycle_time_hr  = excluded.avg_cycle_time_hr,
    total_km           = excluded.total_km,
    zone_events_count  = excluded.zone_events_count,
    auto_trips_count   = excluded.auto_trips_count;

  raise notice 'Snapshot alındı: %', today;
end;
$$;


-- 3. Aylık prim skoru fonksiyonu
-- Her ayın 1'inde önceki ayın skorlarını hesaplar ve kaydeder
create or replace function calc_monthly_scores()
returns void language plpgsql as $$
declare
  target_year  int := extract(year  from current_date - interval '1 day')::int;
  target_month int := extract(month from current_date - interval '1 day')::int;
  period_start date;
  period_end   date;
  drv          record;
  route_stats  record;
  drv_stats    record;
  s_fuel       numeric; s_dur numeric; s_idle numeric; s_empty numeric; s_trips numeric;
  weighted     numeric;
  perf_index   numeric;
  band         text;
  total_km_val numeric;
begin
  period_start := make_date(target_year, target_month, 1);
  period_end   := (period_start + interval '1 month - 1 day')::date;

  raise notice 'Aylık skor hesaplanıyor: % / %', target_month, target_year;

  for drv in
    select d.id, d.route_id, d.full_name
    from drivers d
    where d.is_active = true and d.route_id is not null
  loop
    -- Şoför metrikleri
    select
      count(*)                              as trip_count,
      round(avg(fuel_per_100km)::numeric,3) as avg_fuel,
      round(avg(trip_duration_hr)::numeric,3) as avg_dur,
      round(avg(idle_min)::numeric,3)        as avg_idle,
      round(avg(empty_km_pct)::numeric,3)    as avg_empty,
      round(sum(total_km)::numeric,2)        as total_km,
      round(sum(trip_revenue_tl)::numeric,2) as total_rev,
      count(distinct trip_date)              as active_days
    into drv_stats
    from trips
    where driver_id = drv.id
      and trip_date between period_start and period_end
      and is_excluded = false;

    -- Yeterlilik kontrolü
    total_km_val := coalesce(drv_stats.total_km, 0);
    if coalesce(drv_stats.trip_count, 0) < 10 and total_km_val < 500 then
      insert into performance_scores (
        driver_id, route_id, period_year, period_month,
        total_trips, total_km, has_sufficient_data, trip_count_ok, km_ok,
        bonus_band
      ) values (
        drv.id, drv.route_id, target_year, target_month,
        coalesce(drv_stats.trip_count, 0), total_km_val,
        false,
        coalesce(drv_stats.trip_count, 0) >= 10,
        total_km_val >= 500,
        'yok'
      )
      on conflict (driver_id, period_year, period_month) do update set
        has_sufficient_data = false, bonus_band = 'yok';
      continue;
    end if;

    -- Hat geneli istatistikler (aynı dönem, aynı hat)
    select
      round(avg(fuel_per_100km)::numeric,3)   as avg_fuel,
      round(stddev(fuel_per_100km)::numeric,3) as sd_fuel,
      round(avg(trip_duration_hr)::numeric,3)  as avg_dur,
      round(stddev(trip_duration_hr)::numeric,3) as sd_dur,
      round(avg(idle_min)::numeric,3)          as avg_idle,
      round(stddev(idle_min)::numeric,3)       as sd_idle,
      round(avg(empty_km_pct)::numeric,3)      as avg_empty,
      round(stddev(empty_km_pct)::numeric,3)   as sd_empty,
      round(
        avg(case when active_days > 0 then trip_count::numeric / active_days else null end)
      ,3) as avg_tpd,
      round(
        stddev(case when active_days > 0 then trip_count::numeric / active_days else null end)
      ,3) as sd_tpd
    into route_stats
    from (
      select
        t.driver_id,
        count(*) as trip_count,
        count(distinct t.trip_date) as active_days,
        avg(t.fuel_per_100km)   as fuel_per_100km,
        avg(t.trip_duration_hr) as trip_duration_hr,
        avg(t.idle_min)         as idle_min,
        avg(t.empty_km_pct)     as empty_km_pct
      from trips t
      where t.route_id = drv.route_id
        and t.trip_date between period_start and period_end
        and t.is_excluded = false
      group by t.driver_id
    ) route_agg;

    -- Standart skorlar (sıfır σ durumunda 0 ver)
    s_fuel  := case when coalesce(route_stats.sd_fuel,0)  > 0 then (route_stats.avg_fuel  - drv_stats.avg_fuel)  / route_stats.sd_fuel  else 0 end;
    s_dur   := case when coalesce(route_stats.sd_dur,0)   > 0 then (route_stats.avg_dur   - drv_stats.avg_dur)   / route_stats.sd_dur   else 0 end;
    s_idle  := case when coalesce(route_stats.sd_idle,0)  > 0 then (route_stats.avg_idle  - drv_stats.avg_idle)  / route_stats.sd_idle  else 0 end;
    s_empty := case when coalesce(route_stats.sd_empty,0) > 0 then (route_stats.avg_empty - drv_stats.avg_empty) / route_stats.sd_empty else 0 end;
    s_trips := case
      when coalesce(route_stats.sd_tpd,0) > 0 and drv_stats.active_days > 0
      then ((drv_stats.trip_count::numeric / drv_stats.active_days) - route_stats.avg_tpd) / route_stats.sd_tpd
      else 0
    end;

    -- Ağırlıklı skor ve endeks
    -- Yakıt %30, Süre %25, Rölanti %15, Boş km %15, Sefer %15
    weighted    := round((0.30*s_fuel + 0.25*s_dur + 0.15*s_idle + 0.15*s_empty + 0.15*s_trips)::numeric, 4);
    perf_index  := round((100 + 10 * weighted)::numeric, 2);
    band        := case
      when perf_index >= 110 then 'yuksek'
      when perf_index >= 105 then 'normal'
      when perf_index >= 100 then 'dusuk'
      else 'yok'
    end;

    insert into performance_scores (
      driver_id, route_id, period_year, period_month,
      avg_fuel_per_100km, avg_trip_duration_hr, avg_idle_min,
      avg_empty_km_pct, avg_trips_per_day,
      total_trips, total_km, total_revenue_tl,
      route_stddev_fuel, route_stddev_duration,
      route_stddev_idle, route_stddev_empty,
      score_fuel, score_trip_duration, score_idle,
      score_empty_km, score_trips,
      weighted_score, performance_index, bonus_band,
      has_sufficient_data, trip_count_ok, km_ok
    ) values (
      drv.id, drv.route_id, target_year, target_month,
      drv_stats.avg_fuel, drv_stats.avg_dur, drv_stats.avg_idle,
      drv_stats.avg_empty,
      case when drv_stats.active_days > 0 then round((drv_stats.trip_count::numeric / drv_stats.active_days)::numeric,2) else null end,
      drv_stats.trip_count, total_km_val, drv_stats.total_rev,
      route_stats.sd_fuel, route_stats.sd_dur,
      route_stats.sd_idle, route_stats.sd_empty,
      s_fuel, s_dur, s_idle, s_empty, s_trips,
      weighted, perf_index, band,
      true,
      drv_stats.trip_count >= 10,
      total_km_val >= 500
    )
    on conflict (driver_id, period_year, period_month) do update set
      avg_fuel_per_100km   = excluded.avg_fuel_per_100km,
      avg_trip_duration_hr = excluded.avg_trip_duration_hr,
      avg_idle_min         = excluded.avg_idle_min,
      avg_empty_km_pct     = excluded.avg_empty_km_pct,
      avg_trips_per_day    = excluded.avg_trips_per_day,
      total_trips          = excluded.total_trips,
      total_km             = excluded.total_km,
      total_revenue_tl     = excluded.total_revenue_tl,
      score_fuel           = excluded.score_fuel,
      score_trip_duration  = excluded.score_trip_duration,
      score_idle           = excluded.score_idle,
      score_empty_km       = excluded.score_empty_km,
      score_trips          = excluded.score_trips,
      weighted_score       = excluded.weighted_score,
      performance_index    = excluded.performance_index,
      bonus_band           = excluded.bonus_band,
      calculated_at        = now();

    raise notice 'Skor kaydedildi: % → endeks: %', drv.full_name, perf_index;
  end loop;
end;
$$;


-- 4. pg_cron zamanlayıcıları
-- NOT: Supabase'de pg_cron uzantısı zaten aktif
-- Türkiye saati UTC+3, bu yüzden 23:59 TR = 20:59 UTC

select cron.schedule(
  'gunluk-snapshot',
  '59 20 * * *',   -- Her gece 23:59 Türkiye saati
  $$select take_daily_snapshot();$$
);

select cron.schedule(
  'aylik-prim-skoru',
  '1 21 1 * *',    -- Her ayın 1'i 00:01 Türkiye saati
  $$select calc_monthly_scores();$$
);

-- Zamanlayıcıları görmek için:
-- select * from cron.job;

-- Manuel test:
-- select take_daily_snapshot();
-- select calc_monthly_scores();

-- ============================================================
-- Tamamlandı. Zamanlayıcılar aktif.
-- ============================================================
