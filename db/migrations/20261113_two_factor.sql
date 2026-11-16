begin;
alter table public.auth_users add column two_factor_enabled boolean not null default false;
create table public.auth_two_factors (
 id text primary key,secret text not null,backup_codes text not null,
 user_id text not null references public.auth_users(id) on delete cascade,
 verified boolean default true,failed_verification_count integer default 0,locked_until timestamptz
);
create index auth_two_factors_user on public.auth_two_factors(user_id);
create table public.auth_challenges (
 token_hash text primary key,cookie text not null,expires_at timestamptz not null,attempts integer not null default 0
);
alter table public.auth_two_factors enable row level security;
alter table public.auth_challenges enable row level security;
revoke all on public.auth_two_factors,public.auth_challenges from public;
commit;
