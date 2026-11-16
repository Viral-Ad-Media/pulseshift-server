begin;
create table public.workforce_state (
 org_id text primary key references public.organizations(id) on delete cascade,
 revision integer not null default 0,
 data jsonb not null default '{"preferences":[],"credentials":[],"vacancies":[],"swaps":[],"timesheets":[],"rates":[],"access":[],"staffUnits":[],"exceptions":[],"sites":[],"imports":[],"settings":{"currency":"USD","overtimeThresholdHours":null,"overtimeMultiplier":null,"credentialRules":[]}}'::jsonb,
 updated_at timestamptz not null default now()
);
create table public.workforce_operations (
 org_id text not null references public.organizations(id) on delete cascade,
 actor_id text not null references public.users(id), operation_id text not null,
 payload_hash text not null, result jsonb not null, created_at timestamptz not null default now(),
 primary key(org_id,actor_id,operation_id)
);
create table public.assignment_responses (
 org_id text not null references public.organizations(id) on delete cascade,shift_id text not null,
 publication_version integer not null,user_id text not null references public.users(id),decision text not null check(decision in ('ACCEPT','DECLINE')),
 responded_at timestamptz not null default now(),primary key(org_id,shift_id,publication_version,user_id)
);
alter table public.assignment_responses enable row level security;
revoke all on public.assignment_responses from public;
create table public.workforce_files (
 id text primary key,org_id text not null references public.organizations(id) on delete cascade,
 user_id text not null references public.users(id),name text not null,content_type text not null,
 content bytea not null check(octet_length(content)<=3145728),sha256 text not null,created_at timestamptz not null default now()
);
create table public.workforce_audit (
 id bigint generated always as identity primary key,org_id text not null references public.organizations(id) on delete cascade,
 actor_id text,action text not null,entity_id text,department text,details jsonb not null default '{}',created_at timestamptz not null default now()
);
create index workforce_audit_search on public.workforce_audit(org_id,created_at desc);
create table public.billing_accounts (
 org_id text primary key references public.organizations(id) on delete cascade,
 customer_id text unique,subscription_id text,status text not null default 'UNCONFIGURED',price_id text,
 last_event_created bigint not null default 0,updated_at timestamptz not null default now()
);
create table public.billing_events(id text primary key,created_at timestamptz not null default now());
alter table public.workforce_state enable row level security;
alter table public.workforce_operations enable row level security;
alter table public.workforce_files enable row level security;
alter table public.workforce_audit enable row level security;
alter table public.billing_accounts enable row level security;
alter table public.billing_events enable row level security;
revoke all on public.workforce_state,public.workforce_operations,public.workforce_files,public.workforce_audit,public.billing_accounts,public.billing_events from public;
create function public.pulse_schedule_audit() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 insert into workforce_audit(org_id,actor_id,action,entity_id,details)
 values(new.org_id,nullif(current_setting('pulseshift.actor',true),''),'SCHEDULE_REVISION',new.org_id,jsonb_build_object('revision',new.revision,'previousRevision',case when tg_op='UPDATE' then old.revision else null end));
 return new;
end;$$;
create trigger schedule_audit after insert or update on public.schedule_documents for each row execute function public.pulse_schedule_audit();
create function public.pulse_member_audit() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 insert into workforce_audit(org_id,actor_id,action,entity_id,details)
 values(coalesce(new.org_id,old.org_id),nullif(current_setting('pulseshift.actor',true),''),'MEMBERSHIP_'||tg_op,coalesce(new.user_id,old.user_id),jsonb_build_object('oldRole',case when tg_op<>'INSERT' then old.role else null end,'newRole',case when tg_op<>'DELETE' then new.role else null end));
 return coalesce(new,old);
end;$$;
create trigger member_audit after insert or update or delete on public.memberships for each row execute function public.pulse_member_audit();
revoke all on function public.pulse_schedule_audit(),public.pulse_member_audit() from public;
create or replace function public.pulse_schema_ready() returns boolean language sql security definer set search_path=public,pg_temp as $$
 select to_regclass('public.auth_sessions') is not null and to_regclass('public.schedule_documents') is not null and to_regclass('public.workforce_state') is not null;
$$;
commit;
