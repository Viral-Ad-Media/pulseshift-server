-- Timed schedules are separate from date-only availability and leave.
begin;
create table public.schedule_documents (
 org_id text primary key references public.organizations(id) on delete cascade,
 revision integer not null default 0,
 data jsonb not null default '{"shifts":[],"published":[],"profiles":[],"templates":[]}'::jsonb,
 updated_at timestamptz not null default now()
);
create table public.schedule_operations (
 org_id text not null references public.organizations(id) on delete cascade,
 actor_id text not null references public.users(id), operation_id text not null,
 payload_hash text not null, revision integer not null, created_at timestamptz not null default now(),
 primary key(org_id,actor_id,operation_id)
);
create table public.shift_acknowledgements (
 org_id text not null references public.organizations(id) on delete cascade,
 shift_id text not null, publication_version integer not null,
 user_id text not null references public.users(id), acknowledged_at timestamptz not null default now(),
 primary key(org_id,shift_id,publication_version,user_id)
);
create table public.notifications (
 id bigint generated always as identity primary key,
 org_id text not null references public.organizations(id) on delete cascade,
 user_id text not null references public.users(id),
 kind text not null, message text not null, entity_id text,
 dedupe_key text not null, created_at timestamptz not null default now(), read_at timestamptz,
 unique(org_id,user_id,dedupe_key)
);
create index notifications_inbox_idx on public.notifications(org_id,user_id,created_at desc);
alter table public.schedule_documents enable row level security;
alter table public.schedule_operations enable row level security;
alter table public.shift_acknowledgements enable row level security;
alter table public.notifications enable row level security;

-- Guard approved leave even when the existing request functions are called directly.
-- All HTTP scheduling/request mutations take this same transaction lock before org locks.
create function public.pulse_request_schedule_guard() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare zone text;
begin
 if new.status='APPROVED' and new.type in ('PTO','SICK') and new.canceled_at is null then
   perform pg_advisory_xact_lock(hashtext('pulseshift-scheduling'));
   select timezone into zone from organizations where id=new.org_id;
   if exists(
     select 1 from schedule_documents d,
       jsonb_array_elements(d.data->'published') s,
       jsonb_array_elements(s->'assignments') a
     where a->>'userId'=new.user_id
       and (s->>'startsAt')::timestamptz < ((new.date::date+1)::timestamp at time zone zone)
       and (s->>'endsAt')::timestamptz > (new.date::timestamp at time zone zone)
   ) then raise sqlstate 'PT409' using message='Approved leave conflicts with a published assignment. Unassign and publish the schedule change first.'; end if;
 end if;
 return new;
end;$$;
create trigger requests_schedule_guard before insert or update on public.requests
 for each row execute function public.pulse_request_schedule_guard();

create function public.pulse_request_notification() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare action text; recipients text[]; target text;
begin
 if tg_op='INSERT' then action='submitted';
 elsif old.canceled_at is null and new.canceled_at is not null then action='cancelled';
 elsif old.status is distinct from new.status then action=lower(new.status);
 else action='updated'; end if;
 select array_agg(user_id) into recipients from memberships where org_id=new.org_id and role='ADMIN';
 recipients=array_append(coalesce(recipients,array[]::text[]),new.user_id);
 foreach target in array recipients loop
   insert into notifications(org_id,user_id,kind,message,entity_id,dedupe_key)
   values(new.org_id,target,'REQUEST',new.user_name || ' — ' || case when new.type='WORK' then 'availability' else new.type end || ' request for ' || new.date || ' ' || action || '.',new.id,'request:' || new.id || ':' || new.version)
   on conflict do nothing;
 end loop;
 return new;
end;$$;
create trigger requests_notifications after insert or update on public.requests
 for each row execute function public.pulse_request_notification();

-- The runtime account owns these tables. Public database roles get no access.
revoke all on public.schedule_documents,public.schedule_operations,public.shift_acknowledgements,public.notifications from public;
revoke all on function public.pulse_request_schedule_guard(),public.pulse_request_notification() from public;
create or replace function public.pulse_schema_ready() returns boolean
language sql security definer set search_path=public,pg_temp as $$
 select to_regclass('public.auth_sessions') is not null
 and to_regclass('public.schedule_documents') is not null
 and exists(select 1 from pg_attribute where attrelid='public.requests'::regclass and attname='version');
$$;
commit;
