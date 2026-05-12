-- pg_cron + pg_net — chamam os endpoints públicos da app TanStack.
-- Substitua APP_URL pelo URL publicado (ex.: https://promptfy.lovable.app)
-- Substitua APIKEY pela anon key do SELF-HOSTED Supabase (ela só serve para passar pelo gateway).

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Follow-up a cada 10 min
select cron.schedule('followup-tick', '*/10 * * * *', $$
  select net.http_post(
    url := 'APP_URL/api/public/cron/followup',
    headers := '{"Content-Type":"application/json","apikey":"APIKEY"}'::jsonb,
    body := '{}'::jsonb
  );
$$);

-- Warm-up a cada 30 min
select cron.schedule('warmup-tick', '*/30 * * * *', $$
  select net.http_post(
    url := 'APP_URL/api/public/cron/warmup',
    headers := '{"Content-Type":"application/json","apikey":"APIKEY"}'::jsonb,
    body := '{}'::jsonb
  );
$$);
