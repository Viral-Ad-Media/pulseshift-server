import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { GoogleGenAI } from '@google/genai';
import { randomUUID } from 'crypto';
import { supabase, supabaseConfig } from './supabase.js';

const NODE_ENV = process.env.NODE_ENV || 'development';
const PORT = Number(process.env.PORT || 4000);
const DEFAULT_JWT_SECRET = 'dev-secret';
const JWT_SECRET = process.env.JWT_SECRET || DEFAULT_JWT_SECRET;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const AI_ENABLED = Boolean(GEMINI_API_KEY);
const ONE_DAY_MS = 86400000;
const REQUEST_TYPES = new Set(['WORK', 'PTO', 'SICK']);
const REQUEST_STATUSES = new Set(['PENDING', 'APPROVED', 'REJECTED']);
const PLAN_LIMITS = {
  ESSENTIALS: { requestLimit: 40, aiCredits: 0 },
  TEAM: { requestLimit: 120, aiCredits: 80 },
  BUSINESS: { requestLimit: 500, aiCredits: 200 },
};

if (NODE_ENV === 'production' && JWT_SECRET === DEFAULT_JWT_SECRET) {
  throw new Error('JWT_SECRET must be configured in production.');
}

const aiClient = AI_ENABLED ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;
const corsOrigin = CORS_ORIGIN === '*'
  ? '*'
  : CORS_ORIGIN.split(',').map((origin) => origin.trim()).filter(Boolean);

const app = express();
app.use(cors({ origin: corsOrigin, credentials: corsOrigin !== '*' }));
app.use(express.json({ limit: '1mb' }));

// --- Helpers ---------------------------------------------------------------

const asyncHandler = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

const buildError = (message, error, status) => {
  const appError = new Error(message || error?.message || 'Unexpected error');
  appError.status =
    status ||
    (error?.code === '23505' ? 409 : error?.code === '42P01' ? 500 : 500);
  appError.code = error?.code;
  appError.details = error;
  return appError;
};

const unwrap = async (query, context) => {
  const { data, error, count } = await query;
  if (error) throw buildError(context || error.message, error);
  return { data: data ?? null, count };
};

const selectRow = async (table, columns = '*', filterBuilder) => {
  let query = supabase.from(table).select(columns).limit(1);
  if (filterBuilder) query = filterBuilder(query);
  const { data } = await unwrap(query, `Unable to query ${table}`);
  return Array.isArray(data) ? data[0] || null : data;
};

const selectRows = async (table, columns = '*', filterBuilder) => {
  let query = supabase.from(table).select(columns);
  if (filterBuilder) query = filterBuilder(query);
  const { data } = await unwrap(query, `Unable to query ${table}`);
  return Array.isArray(data) ? data : [];
};

const insertRow = async (table, values, columns = '*') => {
  const { data } = await unwrap(supabase.from(table).insert(values).select(columns), `Unable to insert into ${table}`);
  return Array.isArray(data) ? data[0] || null : data;
};

const updateRow = async (table, values, filterBuilder, columns = '*') => {
  let query = supabase.from(table).update(values).select(columns);
  if (filterBuilder) query = filterBuilder(query);
  const { data } = await unwrap(query, `Unable to update ${table}`);
  return Array.isArray(data) ? data[0] || null : data;
};

const countRows = async (table, filterBuilder) => {
  let query = supabase.from(table).select('*', { count: 'exact', head: true });
  if (filterBuilder) query = filterBuilder(query);
  const { count } = await unwrap(query, `Unable to count ${table}`);
  return count || 0;
};

const normalizeEmail = (value = '') => String(value).trim().toLowerCase();
const sanitizeText = (value, maxLength = 400) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : null;
};

const slugify = (value = '') =>
  String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'workspace';

const createTrialEndDate = (days) => new Date(Date.now() + days * ONE_DAY_MS).toISOString().slice(0, 10);
const isIsoDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(`${value}T00:00:00Z`).getTime());

const getTrialStatus = (trialEndsOn) => {
  if (!trialEndsOn) return { trialStatus: 'NONE', trialDaysRemaining: undefined };

  const end = new Date(`${trialEndsOn}T00:00:00Z`).getTime();
  const diffDays = Math.ceil((end - Date.now()) / ONE_DAY_MS);
  return {
    trialStatus: diffDays >= 0 ? 'ACTIVE' : 'EXPIRED',
    trialDaysRemaining: diffDays >= 0 ? diffDays : 0,
  };
};

const toOrg = (row) => {
  const trial = getTrialStatus(row.trial_ends_on);
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    industry: row.industry,
    plan: row.plan,
    timezone: row.timezone,
    requestLimit: row.request_limit,
    aiCredits: row.ai_credits,
    aiUsed: row.ai_used,
    ownerName: row.owner_name,
    seats: { total: row.seats_total, used: row.seats_used },
    trialEndsOn: row.trial_ends_on || undefined,
    trialStatus: trial.trialStatus,
    trialDaysRemaining: trial.trialDaysRemaining,
  };
};

const toUser = (row) => ({
  id: row.id,
  name: row.name,
  email: row.email,
  role: row.role,
  orgId: row.org_id,
  avatar: row.avatar_url,
  title: row.title,
});

const toRequest = (row) => ({
  id: row.id,
  orgId: row.org_id,
  userId: row.user_id,
  userName: row.user_name,
  date: row.date,
  type: row.type,
  status: row.status,
  notes: row.notes || undefined,
  adminResponse: row.admin_response || undefined,
  createdAt: row.created_at,
});

const signToken = (userId) => jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: '12h' });

const getMembership = async (userId, orgId) =>
  selectRow('memberships', 'user_id, org_id, role', (query) => query.eq('user_id', userId).eq('org_id', orgId));

const getOrgById = async (orgId) => selectRow('organizations', '*', (query) => query.eq('id', orgId));

const getOrganizationsByIds = async (orgIds) => {
  if (!orgIds.length) return [];
  return selectRows('organizations', '*', (query) => query.in('id', orgIds));
};

const getRequestsForOrg = async (orgId) =>
  selectRows('requests', '*', (query) => query.eq('org_id', orgId).order('created_at', { ascending: false }));

const getUsersForOrg = async (orgId) => {
  const memberships = await selectRows('memberships', 'user_id, org_id, role', (query) => query.eq('org_id', orgId));
  if (!memberships.length) return [];

  const users = await selectRows('users', '*', (query) => query.in('id', memberships.map((membership) => membership.user_id)));
  const membershipByUserId = new Map(memberships.map((membership) => [membership.user_id, membership]));

  return users
    .map((user) => {
      const membership = membershipByUserId.get(user.id);
      return toUser({ ...user, role: membership?.role, org_id: membership?.org_id });
    })
    .sort((left, right) => left.name.localeCompare(right.name));
};

const getCoverageCount = async (orgId, date) =>
  countRows('requests', (query) =>
    query
      .eq('org_id', orgId)
      .eq('date', date)
      .eq('status', 'APPROVED')
      .eq('type', 'WORK')
  );

const buildUniqueSlug = async (name) => {
  const base = slugify(name);
  let candidate = base;
  let iteration = 1;

  while (await selectRow('organizations', 'id', (query) => query.eq('slug', candidate))) {
    candidate = `${base}-${iteration}`;
    iteration += 1;
  }

  return candidate;
};

const incrementOrgAiUsage = async (orgRow) =>
  updateRow('organizations', { ai_used: orgRow.ai_used + 1 }, (query) => query.eq('id', orgRow.id), 'ai_used, ai_credits');

const runGemini = async (prompt, fallbackPayload) => {
  if (!aiClient) {
    return { text: JSON.stringify(fallbackPayload), usedAi: false };
  }

  const result = await aiClient.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: prompt,
    config: { responseMimeType: 'application/json' },
  });

  return {
    text: result.response?.text() || result.text || '{}',
    usedAi: true,
  };
};

const authMiddleware = (req, res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing auth token' });

  try {
    const token = header.slice('Bearer '.length);
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.sub;
    return next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

const ensureMembership = asyncHandler(async (req, res, next) => {
  const orgId = req.params.orgId || req.body.orgId;
  if (!orgId) return res.status(400).json({ error: 'Missing orgId' });

  const membership = await getMembership(req.userId, orgId);
  if (!membership) return res.status(403).json({ error: 'Not a member of this organization' });

  req.membership = membership;
  req.orgId = orgId;
  return next();
});

const ensureAdmin = (req, res, next) => {
  if (req.membership?.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  return next();
};

const ensureDatabaseReady = async () => {
  const { error } = await supabase.from('users').select('id', { count: 'exact', head: true });
  if (!error) return;

  if (error.code === '42P01') {
    throw new Error('Supabase tables are missing. Run supabase/schema.sql in the SQL editor before starting the API.');
  }

  throw buildError('Unable to connect to Supabase', error);
};

const seedData = async () => {
  const userCount = await countRows('users');
  if (userCount > 0) return;

  const orgSummit = {
    id: 'org-summit',
    name: 'Summit Health Network',
    slug: 'summit-health',
    industry: 'Hospitals',
    plan: 'TEAM',
    timezone: 'America/New_York',
    request_limit: PLAN_LIMITS.TEAM.requestLimit,
    ai_credits: PLAN_LIMITS.TEAM.aiCredits,
    ai_used: 4,
    owner_name: 'Bruce Parks',
    seats_total: 12,
    seats_used: 9,
    trial_ends_on: null,
  };
  const orgLumen = {
    id: 'org-lumen',
    name: 'Lumen Home Care',
    slug: 'lumen-home',
    industry: 'Home Health',
    plan: 'ESSENTIALS',
    timezone: 'America/Chicago',
    request_limit: PLAN_LIMITS.ESSENTIALS.requestLimit,
    ai_credits: PLAN_LIMITS.ESSENTIALS.aiCredits,
    ai_used: 0,
    owner_name: 'Carla Gomez',
    seats_total: 8,
    seats_used: 5,
    trial_ends_on: createTrialEndDate(10),
  };

  const users = [
    { id: 'u-admin', email: 'bruce@summit.com', name: 'Bruce Parks', role: 'ADMIN', orgId: orgSummit.id, avatar: 'https://i.pravatar.cc/150?u=admin', title: 'Director', password: 'password123' },
    { id: 'u-jake', email: 'jake@summit.com', name: 'Jake Avery', role: 'NURSE', orgId: orgSummit.id, avatar: 'https://i.pravatar.cc/150?u=jake', title: 'Field RN', password: 'password123' },
    { id: 'u-sergio', email: 'sergio@summit.com', name: 'Sergio Good', role: 'NURSE', orgId: orgSummit.id, avatar: 'https://i.pravatar.cc/150?u=sergio', title: 'Infusion RN', password: 'password123' },
    { id: 'u-cgomez', email: 'carla@lumen.com', name: 'Carla Gomez', role: 'ADMIN', orgId: orgLumen.id, avatar: 'https://i.pravatar.cc/150?u=carla', title: 'Clinical Ops', password: 'password123' },
    { id: 'u-devon', email: 'devon@lumen.com', name: 'Devon Isaacs', role: 'NURSE', orgId: orgLumen.id, avatar: 'https://i.pravatar.cc/150?u=devon', title: 'RN Case Manager', password: 'password123' },
  ];

  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const tomorrowStr = new Date(Date.now() + ONE_DAY_MS).toISOString().slice(0, 10);

  await unwrap(
    supabase.from('organizations').upsert([orgSummit, orgLumen], { onConflict: 'id' }),
    'Unable to seed organizations'
  );

  await unwrap(
    supabase.from('users').upsert(
      users.map((user) => ({
        id: user.id,
        email: user.email,
        password_hash: bcrypt.hashSync(user.password, 10),
        name: user.name,
        avatar_url: user.avatar,
        title: user.title,
      })),
      { onConflict: 'id' }
    ),
    'Unable to seed users'
  );

  await unwrap(
    supabase.from('memberships').upsert(
      users.map((user) => ({ user_id: user.id, org_id: user.orgId, role: user.role })),
      { onConflict: 'user_id,org_id' }
    ),
    'Unable to seed memberships'
  );

  await unwrap(
    supabase.from('requests').upsert(
      [
        { id: 'req-1', org_id: orgSummit.id, user_id: 'u-jake', user_name: 'Jake Avery', date: todayStr, type: 'WORK', status: 'APPROVED', notes: 'OR coverage', created_at: Date.now() - 3000 },
        { id: 'req-2', org_id: orgSummit.id, user_id: 'u-sergio', user_name: 'Sergio Good', date: todayStr, type: 'WORK', status: 'APPROVED', notes: 'Cath lab follow-up', created_at: Date.now() - 4000 },
        { id: 'req-3', org_id: orgSummit.id, user_id: 'u-jake', user_name: 'Jake Avery', date: tomorrowStr, type: 'SICK', status: 'PENDING', notes: 'Pre-op appointment', created_at: Date.now() - 5000 },
        { id: 'req-4', org_id: orgLumen.id, user_id: 'u-devon', user_name: 'Devon Isaacs', date: tomorrowStr, type: 'PTO', status: 'PENDING', notes: 'Family event', created_at: Date.now() - 6000 },
      ],
      { onConflict: 'id' }
    ),
    'Unable to seed requests'
  );
};

// --- Auth Routes -----------------------------------------------------------

app.post('/auth/signup', asyncHandler(async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || '');
  const name = String(req.body.name || '').trim();
  const orgName = String(req.body.orgName || '').trim();
  const timezone = String(req.body.timezone || 'America/Chicago').trim() || 'America/Chicago';
  const industry = sanitizeText(req.body.industry, 80) || 'Healthcare';

  if (!email || !password || !name || !orgName) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const exists = await selectRow('users', 'id', (query) => query.eq('email', email));
  if (exists) return res.status(409).json({ error: 'User already exists' });

  const orgId = `org-${randomUUID().slice(0, 8)}`;
  const userId = `u-${randomUUID().slice(0, 8)}`;
  const plan = 'TEAM';
  const planConfig = PLAN_LIMITS[plan];
  const passwordHash = bcrypt.hashSync(password, 10);
  const slug = await buildUniqueSlug(orgName);
  const avatar = `https://i.pravatar.cc/150?u=${userId}`;
  const trialEndsOn = createTrialEndDate(14);

  try {
    const orgRow = await insertRow('organizations', {
      id: orgId,
      name: orgName,
      slug,
      industry,
      plan,
      timezone,
      request_limit: planConfig.requestLimit,
      ai_credits: planConfig.aiCredits,
      ai_used: 0,
      owner_name: name,
      seats_total: 5,
      seats_used: 1,
      trial_ends_on: trialEndsOn,
    });

    await insertRow('users', {
      id: userId,
      email,
      password_hash: passwordHash,
      name,
      avatar_url: avatar,
      title: 'Workspace Owner',
    });

    await insertRow('memberships', {
      user_id: userId,
      org_id: orgId,
      role: 'ADMIN',
    });

    const token = signToken(userId);
    return res.json({
      token,
      user: { id: userId, email, name, role: 'ADMIN', orgId, avatar, title: 'Workspace Owner' },
      orgs: [toOrg(orgRow)],
      memberships: [{ orgId, role: 'ADMIN' }],
    });
  } catch (error) {
    await supabase.from('memberships').delete().eq('user_id', userId).eq('org_id', orgId);
    await supabase.from('users').delete().eq('id', userId);
    await supabase.from('organizations').delete().eq('id', orgId);
    throw error;
  }
}));

app.post('/auth/login', asyncHandler(async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const { password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Missing credentials' });

  const user = await selectRow('users', '*', (query) => query.eq('email', email));
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  const valid = bcrypt.compareSync(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

  const memberships = await selectRows('memberships', 'org_id, role', (query) => query.eq('user_id', user.id));
  const orgRows = await getOrganizationsByIds(memberships.map((membership) => membership.org_id));

  return res.json({
    token: signToken(user.id),
    user: { id: user.id, email: user.email, name: user.name, avatar: user.avatar_url, title: user.title },
    orgs: orgRows.map(toOrg),
    memberships: memberships.map((membership) => ({ orgId: membership.org_id, role: membership.role })),
  });
}));

app.get('/me', authMiddleware, asyncHandler(async (req, res) => {
  const user = await selectRow('users', 'id, email, name, avatar_url, title', (query) => query.eq('id', req.userId));
  if (!user) return res.status(404).json({ error: 'User not found' });

  const memberships = await selectRows('memberships', 'org_id, role', (query) => query.eq('user_id', req.userId));
  const orgRows = await getOrganizationsByIds(memberships.map((membership) => membership.org_id));

  return res.json({
    user: { ...user, avatar: user.avatar_url },
    orgs: orgRows.map(toOrg),
    memberships: memberships.map((membership) => ({ orgId: membership.org_id, role: membership.role })),
  });
}));

// --- Org + Requests --------------------------------------------------------

app.get('/orgs/:orgId/full', authMiddleware, ensureMembership, asyncHandler(async (req, res) => {
  const orgRow = await getOrgById(req.orgId);
  if (!orgRow) return res.status(404).json({ error: 'Org not found' });

  const [users, requests] = await Promise.all([getUsersForOrg(req.orgId), getRequestsForOrg(req.orgId)]);
  return res.json({ org: toOrg(orgRow), users, requests: requests.map(toRequest) });
}));

app.get('/orgs/:orgId/requests', authMiddleware, ensureMembership, asyncHandler(async (req, res) => {
  const requests = await getRequestsForOrg(req.orgId);
  return res.json({ requests: requests.map(toRequest) });
}));

app.post('/orgs/:orgId/requests', authMiddleware, ensureMembership, asyncHandler(async (req, res) => {
  const date = String(req.body.date || '').trim();
  const type = String(req.body.type || '').trim();
  const notes = sanitizeText(req.body.notes);

  if (!isIsoDate(date) || !REQUEST_TYPES.has(type)) {
    return res.status(400).json({ error: 'A valid date and request type are required' });
  }

  const orgRow = await getOrgById(req.orgId);
  if (!orgRow) return res.status(404).json({ error: 'Org not found' });

  const requestCount = await countRows('requests', (query) => query.eq('org_id', req.orgId));
  if (requestCount >= orgRow.request_limit) {
    return res.status(403).json({ error: 'Request limit reached for this workspace' });
  }

  const existing = await selectRow('requests', 'id', (query) =>
    query.eq('org_id', req.orgId).eq('user_id', req.userId).eq('date', date)
  );
  if (existing) {
    return res.status(409).json({ error: 'A request already exists for this date. Edit the existing request instead.' });
  }

  const userRow = await selectRow('users', 'name', (query) => query.eq('id', req.userId));
  const created = await insertRow('requests', {
    id: `req-${randomUUID().slice(0, 8)}`,
    org_id: req.orgId,
    user_id: req.userId,
    user_name: userRow?.name || 'Unknown User',
    date,
    type,
    status: 'PENDING',
    notes,
    created_at: Date.now(),
  });

  return res.status(201).json({ request: toRequest(created) });
}));

app.put('/orgs/:orgId/requests/:requestId', authMiddleware, ensureMembership, asyncHandler(async (req, res) => {
  const requestRow = await selectRow('requests', '*', (query) =>
    query.eq('id', req.params.requestId).eq('org_id', req.orgId)
  );
  if (!requestRow) return res.status(404).json({ error: 'Request not found' });

  const nextType = req.body.type ? String(req.body.type).trim() : null;
  const nextStatus = req.body.status ? String(req.body.status).trim() : null;
  if (nextType && !REQUEST_TYPES.has(nextType)) {
    return res.status(400).json({ error: 'Invalid request type' });
  }
  if (nextStatus && !REQUEST_STATUSES.has(nextStatus)) {
    return res.status(400).json({ error: 'Invalid request status' });
  }

  const isOwner = requestRow.user_id === req.userId;
  const isAdmin = req.membership.role === 'ADMIN';
  const updates = {};

  if (isAdmin) {
    if (nextStatus) updates.status = nextStatus;
    if (req.body.adminResponse !== undefined) {
      updates.admin_response = sanitizeText(req.body.adminResponse, 240);
    }
  }

  if (isOwner && requestRow.status === 'PENDING') {
    if (nextType) updates.type = nextType;
    if (req.body.notes !== undefined) updates.notes = sanitizeText(req.body.notes);
  }

  if (!Object.keys(updates).length) {
    return res.status(400).json({ error: 'No allowed fields to update' });
  }

  const updated = await updateRow('requests', updates, (query) =>
    query.eq('id', req.params.requestId).eq('org_id', req.orgId)
  );

  return res.json({ request: toRequest(updated) });
}));

app.delete('/orgs/:orgId/requests/:requestId', authMiddleware, ensureMembership, asyncHandler(async (req, res) => {
  const requestRow = await selectRow('requests', '*', (query) =>
    query.eq('id', req.params.requestId).eq('org_id', req.orgId)
  );
  if (!requestRow) return res.status(404).json({ error: 'Request not found' });

  const isOwner = requestRow.user_id === req.userId;
  const isAdmin = req.membership.role === 'ADMIN';
  if (!isOwner && !isAdmin) return res.status(403).json({ error: 'Forbidden' });

  await unwrap(
    supabase.from('requests').delete().eq('id', req.params.requestId).eq('org_id', req.orgId),
    'Unable to delete request'
  );
  return res.json({ ok: true });
}));

// --- AI Proxy --------------------------------------------------------------

app.post('/ai/analyze', authMiddleware, ensureMembership, asyncHandler(async (req, res) => {
  const { orgId } = req.body;
  const date = String(req.body.date || '').trim();
  const type = String(req.body.type || '').trim();

  if (!orgId || !isIsoDate(date) || !REQUEST_TYPES.has(type)) {
    return res.status(400).json({ error: 'orgId, date, and type are required' });
  }

  const orgRow = await getOrgById(orgId);
  if (!orgRow) return res.status(404).json({ error: 'Org not found' });
  if (orgRow.plan === 'ESSENTIALS') return res.status(403).json({ error: 'AI checks are not available on this plan.' });
  if (orgRow.ai_used >= orgRow.ai_credits) return res.status(403).json({ error: 'AI credit exhausted.' });

  const approvedCoverage = await getCoverageCount(orgId, date);
  const prompt = `
    You are a staffing assistant for a healthcare scheduling SaaS.
    Requested date: ${date}
    Request type: ${type}
    Approved clinical shifts already scheduled for that date: ${approvedCoverage}
    Return strict JSON:
    {
      "isHighDemand": boolean,
      "message": "short human-friendly recommendation"
    }
  `;

  try {
    const response = await runGemini(prompt, {
      isHighDemand: false,
      message: 'AI assistant unavailable. Standard availability checks passed.',
    });
    const parsed = JSON.parse(response.text || '{}');

    const usage = response.usedAi
      ? await incrementOrgAiUsage(orgRow)
      : { ai_used: orgRow.ai_used, ai_credits: orgRow.ai_credits };

    return res.json({
      allowed: !parsed.isHighDemand,
      message: parsed.message || 'Date processed.',
      aiUsed: usage.ai_used,
      aiCredits: usage.ai_credits,
    });
  } catch (error) {
    console.error('Gemini analyze failed', error);
    return res.json({
      allowed: true,
      message: 'Standard availability check.',
      aiUsed: orgRow.ai_used,
      aiCredits: orgRow.ai_credits,
    });
  }
}));

app.post('/ai/respond', authMiddleware, ensureMembership, ensureAdmin, asyncHandler(async (req, res) => {
  const orgId = String(req.body.orgId || '').trim();
  const userName = String(req.body.userName || '').trim();
  const date = String(req.body.date || '').trim();
  const type = String(req.body.type || '').trim();
  const decision = String(req.body.decision || '').trim();
  const reason = sanitizeText(req.body.reason, 180);

  if (!orgId || !userName || !isIsoDate(date) || !REQUEST_TYPES.has(type) || !['APPROVE', 'REJECT'].includes(decision)) {
    return res.status(400).json({ error: 'Missing or invalid fields' });
  }

  const orgRow = await getOrgById(orgId);
  if (!orgRow) return res.status(404).json({ error: 'Org not found' });
  if (orgRow.plan === 'ESSENTIALS') return res.status(403).json({ error: 'AI responses unavailable on this plan.' });
  if (orgRow.ai_used >= orgRow.ai_credits) return res.status(403).json({ error: 'AI credit exhausted.' });

  const prompt = `
    Draft a short, professional, and empathetic notification for ${userName}.
    Their ${type} request for ${date} has been ${decision}D.
    ${reason ? `Reason: ${reason}` : ''}
    Keep it under 2 sentences.
    Return JSON: { "message": "..." }
  `;

  try {
    const response = await runGemini(prompt, {
      message: `Your ${type.toLowerCase()} request for ${date} has been ${decision.toLowerCase()}d.`,
    });
    const parsed = JSON.parse(response.text || '{}');

    const usage = response.usedAi
      ? await incrementOrgAiUsage(orgRow)
      : { ai_used: orgRow.ai_used, ai_credits: orgRow.ai_credits };

    return res.json({
      message: parsed.message || 'Update sent.',
      aiUsed: usage.ai_used,
      aiCredits: usage.ai_credits,
    });
  } catch (error) {
    console.error('Gemini respond failed', error);
    return res.json({
      message: `Your ${type.toLowerCase()} request for ${date} has been ${decision.toLowerCase()}d.`,
      aiUsed: orgRow.ai_used,
      aiCredits: orgRow.ai_credits,
    });
  }
}));

// --- Start -----------------------------------------------------------------

app.get('/health', (_, res) => {
  res.json({
    ok: true,
    ai: AI_ENABLED,
    environment: NODE_ENV,
    database: 'supabase',
    projectHost: new URL(supabaseConfig.url).host,
  });
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(error.status || 500).json({ error: error.message || 'Internal server error' });
});

const start = async () => {
  await ensureDatabaseReady();
  await seedData();

  app.listen(PORT, () => {
    console.log(`PulseShift API listening on http://localhost:${PORT}`);
    console.log(`PulseShift data provider: Supabase (${new URL(supabaseConfig.url).host})`);
    if (!AI_ENABLED) {
      console.log('GEMINI_API_KEY not set; AI endpoints will return fallback responses.');
    }
  });
};

start().catch((error) => {
  console.error('Failed to start PulseShift API', error);
  process.exit(1);
});
