create table "auth_users" ("id" text not null primary key, "name" text not null, "email" text not null unique, "email_verified" boolean not null, "image" text, "created_at" timestamptz default CURRENT_TIMESTAMP not null, "updated_at" timestamptz default CURRENT_TIMESTAMP not null);

create table "auth_sessions" ("id" text not null primary key, "expires_at" timestamptz not null, "token" text not null unique, "created_at" timestamptz default CURRENT_TIMESTAMP not null, "updated_at" timestamptz not null, "ip_address" text, "user_agent" text, "user_id" text not null references "auth_users" ("id") on delete cascade);

create table "auth_accounts" ("id" text not null primary key, "account_id" text not null, "provider_id" text not null, "user_id" text not null references "auth_users" ("id") on delete cascade, "access_token" text, "refresh_token" text, "id_token" text, "access_token_expires_at" timestamptz, "refresh_token_expires_at" timestamptz, "scope" text, "password" text, "created_at" timestamptz default CURRENT_TIMESTAMP not null, "updated_at" timestamptz not null);

create table "auth_verifications" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expires_at" timestamptz not null, "created_at" timestamptz default CURRENT_TIMESTAMP not null, "updated_at" timestamptz default CURRENT_TIMESTAMP not null);

create index "auth_sessions_user_id_idx" on "auth_sessions" ("user_id");

create index "auth_accounts_user_id_idx" on "auth_accounts" ("user_id");

create index "auth_verifications_identifier_idx" on "auth_verifications" ("identifier");
-- Keep application identities and foreign keys; import only real legacy accounts.
alter table public.users alter column password_hash drop not null;
create unique index auth_accounts_provider_account_idx on public.auth_accounts(provider_id,account_id);
create or replace function public.pulse_import_legacy_accounts() returns void
language plpgsql security definer set search_path=public,pg_temp as $$
begin
insert into public.auth_users(id,name,email,email_verified,image,created_at,updated_at)
 select id,name,email,false,avatar_url,now(),now() from public.users
 where id not in ('u-admin','u-jake','u-sergio','u-cgomez','u-devon') on conflict(id) do nothing;
insert into public.auth_accounts(id,account_id,provider_id,user_id,password,created_at,updated_at)
 select 'legacy-credential-'||id,id,'credential',id,password_hash,now(),now() from public.users
 where password_hash is not null and id not in ('u-admin','u-jake','u-sergio','u-cgomez','u-devon') on conflict(provider_id,account_id) do nothing;
end;$$;
revoke all on function public.pulse_import_legacy_accounts() from public;
select public.pulse_import_legacy_accounts();
-- These tables are private to the API role; there is no browser Data API.
alter table public.auth_users enable row level security;
alter table public.auth_sessions enable row level security;
alter table public.auth_accounts enable row level security;
alter table public.auth_verifications enable row level security;
revoke all on public.auth_users,public.auth_sessions,public.auth_accounts,public.auth_verifications from public;

create or replace function public.pulse_provision_workspace(p_user_id text,p_org_id text,p_org_name text,p_timezone text,p_industry text,p_invite_hash text default null) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare identity_row auth_users; slug_value text; result_org text;
begin
 select * into identity_row from auth_users where id=p_user_id for update;
 if not found then raise sqlstate 'PT403' using message='Authenticated account required'; end if;
 insert into users(id,email,name,avatar_url,title) values(identity_row.id,identity_row.email,identity_row.name,identity_row.image,'Team Member') on conflict(id) do nothing;
 -- Serializing on the identity makes setup retries safe and prevents duplicate workspaces.
 if exists(select 1 from memberships where user_id=p_user_id) then raise sqlstate 'PT409' using message='Workspace setup is already complete. Refresh to continue.'; end if;
 if p_invite_hash is not null then
  result_org=pulse_accept_invitation(p_user_id,p_invite_hash);
 else
  if p_org_name is null or length(trim(p_org_name))=0 then raise sqlstate 'PT400' using message='Workspace name required'; end if;
  slug_value=coalesce(nullif(trim(both '-' from regexp_replace(lower(p_org_name),'[^a-z0-9]+','-','g')),''),'workspace')||'-'||p_org_id;
  insert into organizations(id,name,slug,industry,plan,timezone,request_limit,ai_credits,ai_used,owner_name,seats_total,seats_used,trial_ends_on,trial_expires_at)
   values(p_org_id,p_org_name,slug_value,p_industry,'TEAM',p_timezone,120,80,0,identity_row.name,5,1,to_char((now()+interval '14 days') at time zone 'UTC','YYYY-MM-DD'),now()+interval '14 days');
  insert into memberships(user_id,org_id,role) values(p_user_id,p_org_id,'ADMIN');
  update users set title='Workspace Owner' where id=p_user_id;
  result_org=p_org_id;
 end if;
 return result_org;
end;$$;
revoke all on function public.pulse_provision_workspace(text,text,text,text,text,text) from public;

-- Session revocation is now the Better Auth database session ledger.
create or replace function public.pulse_revoke_sessions(p_user_id text) returns void
language sql security definer set search_path=public,pg_temp as $$ delete from auth_sessions where user_id=p_user_id; $$;
create or replace function public.pulse_schema_ready() returns boolean
language sql security definer set search_path=public,pg_temp as $$ select to_regclass('public.auth_users') is not null and to_regclass('public.auth_sessions') is not null and to_regclass('public.ai_events') is not null and exists(select 1 from pg_attribute where attrelid='public.requests'::regclass and attname='version'); $$;
