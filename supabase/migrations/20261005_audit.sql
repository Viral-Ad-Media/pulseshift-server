-- Apply after schema.sql. Safe to rerun; invalid legacy dates abort the transaction.
begin;
alter table public.users add column if not exists token_version integer not null default 1;
alter table public.organizations add column if not exists trial_expires_at timestamptz;
update public.organizations set trial_expires_at = (trial_ends_on::date + 1)::timestamp at time zone 'UTC' where trial_ends_on is not null and trial_expires_at is null;
alter table public.requests add column if not exists version integer not null default 1;
alter table public.requests add column if not exists canceled_at timestamptz;
alter table public.requests drop constraint if exists requests_org_id_user_id_date_key;
create unique index if not exists requests_active_user_date_idx on public.requests(org_id,user_id,date) where canceled_at is null;
-- Strict round trip rejects JavaScript-normalized dates and noncanonical stored dates.
alter table public.requests drop constraint if exists requests_valid_date;
alter table public.requests add constraint requests_valid_date check (date ~ '^\d{4}-\d{2}-\d{2}$' and to_char(date::date,'YYYY-MM-DD') = date);
alter table public.organizations drop constraint if exists organizations_valid_limits;
alter table public.organizations add constraint organizations_valid_limits check(request_limit between 1 and 500 and ai_credits >= 0 and ai_used >= 0 and seats_total > 0);
create table if not exists public.invitations (
 id text primary key, org_id text not null references public.organizations(id) on delete cascade,
 email text not null, role text not null check(role in ('ADMIN','NURSE')),
 token_hash text not null unique, invited_by text not null references public.users(id),
 expires_at timestamptz not null, accepted_at timestamptz, revoked_at timestamptz,
 unique(org_id,email)
);
create table if not exists public.request_events (
 id bigint generated always as identity primary key,
 org_id text not null references public.organizations(id) on delete cascade,
 request_id text not null references public.requests(id), actor_id text not null references public.users(id),
 action text not null, old_status text, new_status text, request_type text, created_at timestamptz not null default now()
);
create table if not exists public.ai_events (
 id text primary key, org_id text not null references public.organizations(id) on delete cascade,
 user_id text not null references public.users(id), kind text not null check(kind in ('ANALYZE','RESPOND')),
 status text not null default 'RESERVED' check(status in ('RESERVED','SUCCEEDED','FAILED')),
 created_at timestamptz not null default now(), finished_at timestamptz
);
alter table public.invitations enable row level security;
alter table public.request_events enable row level security;
alter table public.ai_events enable row level security;
create index if not exists invitations_org_idx on public.invitations(org_id);
create index if not exists request_events_org_idx on public.request_events(org_id,created_at);
create index if not exists ai_events_org_idx on public.ai_events(org_id,created_at);

create or replace function public.pulse_assert_member(p_org_id text,p_user_id text,p_admin boolean default false) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare member_role text;
begin
 select role into member_role from memberships where org_id=p_org_id and user_id=p_user_id;
 if member_role is null or (p_admin and member_role<>'ADMIN') then raise sqlstate 'PT403' using message='Workspace access denied'; end if;
 return member_role;
end;$$;

create or replace function public.pulse_accept_invitation(p_user_id text,p_hash text) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare invite invitations; org organizations; user_email text; used integer;
begin
 select * into invite from invitations where token_hash=p_hash;
 if not found then raise sqlstate 'PT404' using message='Invitation not found'; end if;
 select * into org from organizations where id=invite.org_id for update;
 select * into invite from invitations where token_hash=p_hash for update;
 if invite.accepted_at is not null or invite.revoked_at is not null or invite.expires_at<=now() then raise sqlstate 'PT409' using message='Invitation is expired or already used'; end if;
 select email into user_email from users where id=p_user_id;
 if user_email is distinct from invite.email then raise sqlstate 'PT403' using message='Sign in with the email address on this invitation'; end if;
 if exists(select 1 from memberships where org_id=invite.org_id and user_id=p_user_id) then raise sqlstate 'PT409' using message='Already a member'; end if;
 select count(*) into used from memberships where org_id=invite.org_id;
 if used>=org.seats_total then raise sqlstate 'PT403' using message='No available workspace seats'; end if;
 insert into memberships(user_id,org_id,role) values(p_user_id,invite.org_id,invite.role);
 update invitations set accepted_at=now() where id=invite.id;
 update organizations set seats_used=used+1 where id=invite.org_id;
 return invite.org_id;
end;$$;

create or replace function public.pulse_signup(p_user_id text,p_org_id text,p_email text,p_password_hash text,p_name text,p_org_name text,p_timezone text,p_industry text,p_invite_hash text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare new_user users; slug_value text;
begin
 -- A failure rolls back every write; never performs compensating deletes.
 insert into users(id,email,password_hash,name,title) values(p_user_id,p_email,p_password_hash,p_name,case when p_invite_hash is null then 'Workspace Owner' else 'Team Member' end) returning * into new_user;
 if p_invite_hash is not null then
   perform pulse_accept_invitation(p_user_id,p_invite_hash);
 else
   if p_org_name is null or length(trim(p_org_name))=0 then raise sqlstate 'PT400' using message='Workspace name required'; end if;
   slug_value=coalesce(nullif(trim(both '-' from regexp_replace(lower(p_org_name),'[^a-z0-9]+','-','g')),''),'workspace') || '-' || p_org_id;
   insert into organizations(id,name,slug,industry,plan,timezone,request_limit,ai_credits,ai_used,owner_name,seats_total,seats_used,trial_ends_on,trial_expires_at)
     values(p_org_id,p_org_name,slug_value,p_industry,'TEAM',p_timezone,120,80,0,p_name,5,1,to_char((now()+interval '14 days') at time zone 'UTC','YYYY-MM-DD'),now()+interval '14 days');
   insert into memberships(user_id,org_id,role) values(p_user_id,p_org_id,'ADMIN');
 end if;
 return to_jsonb(new_user);
end;$$;

create or replace function public.pulse_revoke_sessions(p_user_id text) returns void
language sql security definer set search_path = public, pg_temp as $$ update users set token_version=token_version+1 where id=p_user_id; $$;

create or replace function public.pulse_create_request(p_id text,p_org_id text,p_user_id text,p_date text,p_type text,p_notes text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare org organizations; result requests; cap integer; user_name_value text;
begin
 select * into org from organizations where id=p_org_id for update;
 perform pulse_assert_member(p_org_id,p_user_id);
 cap=case when org.trial_expires_at<=now() then 40 else org.request_limit end;
 if (select count(*) from requests where org_id=p_org_id and canceled_at is null)>=cap then raise sqlstate 'PT403' using message='Active request limit reached'; end if;
 select name into user_name_value from users where id=p_user_id;
 insert into requests(id,org_id,user_id,user_name,date,type,status,notes,created_at) values(p_id,p_org_id,p_user_id,user_name_value,p_date,p_type,'PENDING',p_notes,(extract(epoch from clock_timestamp())*1000)::bigint) returning * into result;
 insert into request_events(org_id,request_id,actor_id,action,new_status,request_type) values(p_org_id,p_id,p_user_id,'CREATE','PENDING',p_type);
 return to_jsonb(result);
end;$$;

create or replace function public.pulse_update_request(p_org_id text,p_id text,p_user_id text,p_version integer,p_type text default null,p_notes text default null,p_set_notes boolean default false,p_status text default null,p_response text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare record requests; member_role text; old_status_value text;
begin
 -- All membership mutation and request writes lock the org first for consistent ordering.
 perform 1 from organizations where id=p_org_id for update;
 member_role=pulse_assert_member(p_org_id,p_user_id);
 select * into record from requests where org_id=p_org_id and id=p_id and canceled_at is null for update;
 if not found then raise sqlstate 'PT404' using message='Request not found'; end if;
 if record.version<>p_version or record.status<>'PENDING' then raise sqlstate 'PT409' using message='Request changed or already decided. Refresh before editing.'; end if;
 old_status_value=record.status;
 if p_status is not null then
   if member_role<>'ADMIN' then raise sqlstate 'PT403' using message='Admin access required'; end if;
   if p_status not in ('APPROVED','REJECTED') then raise sqlstate 'PT400' using message='Invalid decision'; end if;
   if p_type is not null or p_set_notes then raise sqlstate 'PT400' using message='Decisions cannot edit request details'; end if;
   record.status=p_status; record.admin_response=p_response;
 else
   if record.user_id<>p_user_id then raise sqlstate 'PT403' using message='Only the owner may edit request details'; end if;
   if p_type is null and not p_set_notes then raise sqlstate 'PT400' using message='No update fields'; end if;
   if p_type is not null then record.type=p_type; end if;
   if p_set_notes then record.notes=p_notes; end if;
 end if;
 update requests set type=record.type,notes=record.notes,status=record.status,admin_response=record.admin_response,version=version+1 where id=p_id returning * into record;
 insert into request_events(org_id,request_id,actor_id,action,old_status,new_status,request_type) values(p_org_id,p_id,p_user_id,case when p_status is null then 'EDIT' else 'DECIDE' end,old_status_value,record.status,record.type);
 return to_jsonb(record);
end;$$;

create or replace function public.pulse_cancel_request(p_org_id text,p_id text,p_user_id text,p_version integer) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare record requests; member_role text;
begin
 perform 1 from organizations where id=p_org_id for update;
 member_role=pulse_assert_member(p_org_id,p_user_id);
 select * into record from requests where org_id=p_org_id and id=p_id and canceled_at is null for update;
 if not found then raise sqlstate 'PT404' using message='Request not found'; end if;
 if record.user_id<>p_user_id and member_role<>'ADMIN' then raise sqlstate 'PT403' using message='Request access denied'; end if;
 if record.version<>p_version then raise sqlstate 'PT409' using message='Request changed. Refresh before canceling.'; end if;
 update requests set canceled_at=now(),version=version+1 where id=p_id;
 insert into request_events(org_id,request_id,actor_id,action,old_status,request_type) values(p_org_id,p_id,p_user_id,'CANCEL',record.status,record.type);
end;$$;

create or replace function public.pulse_reserve_ai(p_id text,p_org_id text,p_user_id text,p_kind text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare org organizations;
begin
 select * into org from organizations where id=p_org_id for update;
 perform pulse_assert_member(p_org_id,p_user_id,p_kind='RESPOND');
 if org.plan='ESSENTIALS' or org.trial_expires_at<=now() then raise sqlstate 'PT403' using message='AI unavailable on this plan or expired trial'; end if;
 if org.ai_used>=org.ai_credits then raise sqlstate 'PT403' using message='AI credits exhausted'; end if;
 insert into ai_events(id,org_id,user_id,kind) values(p_id,p_org_id,p_user_id,p_kind);
 update organizations set ai_used=ai_used+1 where id=p_org_id returning * into org;
 return jsonb_build_object('id',p_id,'ai_used',org.ai_used,'ai_credits',org.ai_credits);
end;$$;
create or replace function public.pulse_finish_ai(p_id text,p_status text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
 if p_status not in ('SUCCEEDED','FAILED') then raise sqlstate 'PT400' using message='Invalid AI completion'; end if;
 update ai_events set status=p_status,finished_at=now() where id=p_id and status='RESERVED';
end;$$;

create or replace function public.pulse_create_invitation(p_id text,p_org_id text,p_user_id text,p_email text,p_role text,p_hash text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare org organizations; used integer; result invitations;
begin
 select * into org from organizations where id=p_org_id for update;
 perform pulse_assert_member(p_org_id,p_user_id,true);
 if exists(select 1 from memberships m join users u on u.id=m.user_id where m.org_id=p_org_id and u.email=p_email) then raise sqlstate 'PT409' using message='This user is already a member'; end if;
 select (select count(*) from memberships where org_id=p_org_id)+(select count(*) from invitations where org_id=p_org_id and email<>p_email and accepted_at is null and revoked_at is null and expires_at>now()) into used;
 if used>=org.seats_total then raise sqlstate 'PT403' using message='No available workspace seats'; end if;
 insert into invitations(id,org_id,email,role,token_hash,invited_by,expires_at) values(p_id,p_org_id,p_email,p_role,p_hash,p_user_id,now()+interval '7 days')
 on conflict(org_id,email) do update set token_hash=excluded.token_hash,role=excluded.role,invited_by=excluded.invited_by,expires_at=excluded.expires_at,accepted_at=null,revoked_at=null returning * into result;
 return jsonb_build_object('id',result.id,'email',result.email,'role',result.role,'expires_at',result.expires_at);
end;$$;
create or replace function public.pulse_revoke_invitation(p_org_id text,p_id text,p_user_id text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
 perform 1 from organizations where id=p_org_id for update;
 perform pulse_assert_member(p_org_id,p_user_id,true);
 update invitations set revoked_at=now() where id=p_id and org_id=p_org_id and accepted_at is null;
end;$$;
create or replace function public.pulse_manage_member(p_org_id text,p_actor_id text,p_user_id text,p_role text,p_remove boolean) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare old_role text; used integer;
begin
 perform 1 from organizations where id=p_org_id for update;
 perform pulse_assert_member(p_org_id,p_actor_id,true);
 select role into old_role from memberships where org_id=p_org_id and user_id=p_user_id;
 if not found then raise sqlstate 'PT404' using message='Member not found'; end if;
 if old_role='ADMIN' and (p_remove or p_role<>'ADMIN') and (select count(*) from memberships where org_id=p_org_id and role='ADMIN')<=1 then raise sqlstate 'PT409' using message='Keep at least one workspace administrator'; end if;
 if p_remove then delete from memberships where org_id=p_org_id and user_id=p_user_id;
 else update memberships set role=p_role where org_id=p_org_id and user_id=p_user_id; end if;
 select count(*) into used from memberships where org_id=p_org_id;
 update organizations set seats_used=used where id=p_org_id;
end;$$;
create or replace function public.pulse_schema_ready() returns boolean
language sql security definer set search_path = public, pg_temp as $$ select exists(select 1 from pg_attribute where attrelid='public.requests'::regclass and attname='version') and to_regclass('public.ai_events') is not null and to_regclass('public.invitations') is not null; $$;

-- Functions use elevated access only through the authenticated application server.
-- Postgres grants EXECUTE to PUBLIC by default, so revoke every exact pulse signature.
do $$ declare fn record;
begin
 for fn in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'pulse_%' loop
   execute format('revoke all on function %s from public, anon, authenticated',fn.signature);
   execute format('grant execute on function %s to service_role',fn.signature);
 end loop;
end;$$;
commit;
