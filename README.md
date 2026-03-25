# PulseShift Server

`pulseshift-server` is the standalone backend app for PulseShift. It exposes the Express API used by the frontend, stores tenant data in Supabase, seeds demo tenants, and proxies Gemini-powered staffing helpers.

## Stack

- Node.js + Express
- Supabase via `@supabase/supabase-js`
- JWT auth + `bcryptjs`
- Gemini via `@google/genai`

## Files

- `server.js`: API routes, auth, workspace enforcement, request CRUD, AI endpoints, seed bootstrap
- `supabase.js`: Supabase client setup
- `supabase/schema.sql`: database schema to run in Supabase before startup

## Prerequisites

- Node.js 18+
- npm
- A Supabase project

## Setup

1. Install dependencies:

```bash
npm install
```

2. Copy the env template and fill in real values:

```bash
cp .env.example .env
```

3. Run `supabase/schema.sql` in your Supabase SQL editor.

4. Start the API:

```bash
npm run dev
```

The server listens on `http://localhost:4000` by default.

## Scripts

- `npm run dev`: start the API with file watching
- `npm run start`: start the API once

## Required Environment Variables

| Variable | Purpose |
| --- | --- |
| `PORT` | API port, defaults to `4000` |
| `JWT_SECRET` | Signs app JWTs |
| `CORS_ORIGIN` | Allowed frontend origin(s) |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-side Supabase access key |
| `GEMINI_API_KEY` | Optional, enables AI analysis and response drafting |

## Demo Accounts

When the database is empty, the API seeds demo data automatically:

- `bruce@summit.com` / `password123`
- `jake@summit.com` / `password123`
- `carla@lumen.com` / `password123`
- `devon@lumen.com` / `password123`
