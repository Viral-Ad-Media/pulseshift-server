-- PulseShift Supabase schema
-- Run this file in the Supabase SQL editor before starting the API.

begin;

create table if not exists public.organizations (
  id text primary key,
  name text not null,
  slug text not null unique,
  industry text,
  plan text not null check (plan in ('ESSENTIALS', 'TEAM', 'BUSINESS')),
  timezone text not null,
  request_limit integer not null,
  ai_credits integer not null,
  ai_used integer not null default 0,
  owner_name text,
  seats_total integer not null default 10,
  seats_used integer not null default 1,
  trial_ends_on text
);

create table if not exists public.users (
  id text primary key,
  email text not null unique,
  password_hash text not null,
  name text not null,
  avatar_url text,
  title text
);

create table if not exists public.memberships (
  user_id text not null references public.users(id) on delete cascade,
  org_id text not null references public.organizations(id) on delete cascade,
  role text not null check (role in ('ADMIN', 'NURSE')),
  primary key (user_id, org_id)
);

create table if not exists public.requests (
  id text primary key,
  org_id text not null references public.organizations(id) on delete cascade,
  user_id text not null references public.users(id) on delete cascade,
  user_name text not null,
  date text not null,
  type text not null check (type in ('WORK', 'PTO', 'SICK')),
  status text not null check (status in ('PENDING', 'APPROVED', 'REJECTED')),
  notes text,
  admin_response text,
  created_at bigint not null,
  unique (org_id, user_id, date)
);

create index if not exists memberships_org_id_idx on public.memberships (org_id);
create index if not exists memberships_user_id_idx on public.memberships (user_id);
create index if not exists requests_org_created_at_idx on public.requests (org_id, created_at desc);
create index if not exists requests_org_date_idx on public.requests (org_id, date);

alter table public.organizations enable row level security;
alter table public.users enable row level security;
alter table public.memberships enable row level security;
alter table public.requests enable row level security;

commit;
