-- SuperAdmin roles — cole no SQL Editor do seu Supabase self-hosted DEPOIS dos 0001/0002.
-- Depois, insira seu user como superadmin:
--   insert into public.user_roles(user_id, role) values ('SEU_AUTH_USER_ID', 'superadmin');

create type if not exists public.app_role as enum ('superadmin', 'user');

create table if not exists public.user_roles (
  id      uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  role    public.app_role not null,
  unique (user_id, role)
);

alter table public.user_roles enable row level security;

create or replace function public.has_role(_user_id uuid, _role public.app_role)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.user_roles
    where user_id = _user_id and role = _role
  )
$$;

-- usuários autenticados podem ler somente o seu próprio role
drop policy if exists "user_roles_select_self" on public.user_roles;
create policy "user_roles_select_self" on public.user_roles
  for select to authenticated
  using (user_id = auth.uid());
