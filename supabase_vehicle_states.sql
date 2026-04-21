-- ============================================================
-- Zone Motor — Ek Tablo
-- Supabase SQL Editor'e yapıştırıp Run edin
-- ============================================================

-- Araçların anlık zone durumunu tutar
-- Motor her konum güncellemesinde bu tabloyu okur/yazar
create table if not exists vehicle_states (
  id              uuid primary key default gen_random_uuid(),
  vehicle_plate   text unique not null,
  driver_id       uuid references drivers(id),

  -- Son bilinen konum
  last_lat        numeric(10,7),
  last_lng        numeric(10,7),
  last_speed_kmh  numeric(5,1),
  last_seen_at    timestamptz,

  -- Şu an hangi zone'da?
  current_zone_id uuid references zones(id),
  zone_entered_at timestamptz,   -- o zone'a ne zaman girdi

  -- Aktif sefer takibi
  active_trip_origin_zone_id uuid references zones(id),
  active_trip_started_at     timestamptz,

  updated_at      timestamptz default now()
);

alter table vehicle_states enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='vehicle_states' and policyname='anon okuma vehicle_states') then
    create policy "anon okuma vehicle_states" on vehicle_states for select using (true);
  end if;
  if not exists (select 1 from pg_policies where tablename='vehicle_states' and policyname='anon yazma vehicle_states') then
    create policy "anon yazma vehicle_states" on vehicle_states for insert with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename='vehicle_states' and policyname='anon guncelleme vehicle_states') then
    create policy "anon guncelleme vehicle_states" on vehicle_states for update using (true);
  end if;
end $$;

create index if not exists idx_vehicle_states_plate on vehicle_states(vehicle_plate);
create index if not exists idx_vehicle_states_zone  on vehicle_states(current_zone_id);
