# Quick Setup Guide

## Local Development Setup

### 1. Prerequisites
- Node.js 16+ installed
- PostgreSQL installed and running
- npm or yarn

### 2. Installation Steps

```bash
# Navigate to server directory
cd boom-dashboard/server

# Install dependencies
npm install

# Create environment file
cp .env.example .env

# Edit .env with your database details
# DATABASE_URL should be something like:
# postgresql://postgres:password@localhost:5432/marketst_dashboard
```

### 3. Initialize Database

```bash
# Create PostgreSQL database (if using local postgres)
createdb marketst_dashboard

# Run seed script (creates tables and seed data)
npm run seed
```

You should see output like:
```
Starting database seeding...
Creating tables...
Tables created successfully
Seeding admin user...
Seeding team members...
... (more seeding messages)
Database seeding completed successfully!
Admin user: john@deanst.co / <PW_JOHN>
```

### 4. Start the Server

```bash
# Development (with auto-reload)
npm run dev

# Or production mode
npm start
```

Server should be running at `http://localhost:3001`

## Default Test Account

After running seed script, you can login with:
- Email: `john@deanst.co`
- Password: `<PW_JOHN>`

Other team members use:
- Password: `password123`
- Emails: jesse@, bradley@, john@, soli@, georgia@, danny@, intern.marketing@, intern.ar@ (all @deanst.co)

## Test the API

```bash
# Health check
curl http://localhost:3001/health

# Login
curl -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "john@deanst.co",
    "password": "<PW_JOHN>"
  }'

# This returns a token - use it for other requests:
curl http://localhost:3001/api/dashboard/stats \
  -H "Authorization: Bearer YOUR_TOKEN_HERE"
```

## Environment Variables Explained

```
DATABASE_URL          # PostgreSQL connection string
JWT_SECRET            # Secret key for signing JWTs (change in production)
PORT                  # Port server runs on (default: 3001)
NODE_ENV              # development or production
FRONTEND_URL          # URL of frontend for CORS (optional)
```

## Deploying to Railway

1. Connect your Git repository to Railway
2. Railway auto-detects Node.js
3. Set environment variables in Railway dashboard:
   - DATABASE_URL (auto-created by Railway PostgreSQL)
   - JWT_SECRET (generate a strong random string)
   - FRONTEND_URL (your production frontend URL)
4. Railway auto-builds and deploys
5. Run seed script once via Railway console or in a deployment hook

## Database Schema at a Glance

- **users** (8 team members + admin)
- **artists** (15 with sample roster)
- **releases** (15 upcoming with varied completion)
- **contracts** (10 with various types and terms)
- **deals** (12 in pipeline)
- **tasks** (20 assigned to team)
- **activity_log** (extensible audit trail)

## Troubleshooting

**"connect ECONNREFUSED"** - PostgreSQL not running
```bash
# macOS
brew services start postgresql

# Ubuntu/Linux
sudo systemctl start postgresql

# Docker
docker run --name postgres -e POSTGRES_PASSWORD=password -d postgres
```

**"database does not exist"** - Create it first
```bash
createdb marketst_dashboard
npm run seed
```

**"duplicate key value violates unique constraint"** - Already seeded
- Seed script uses `ON CONFLICT DO NOTHING`, so it's safe to run multiple times
- Or drop and recreate database:
```bash
dropdb marketst_dashboard
createdb marketst_dashboard
npm run seed
```

**"CORS errors"** - Check FRONTEND_URL in .env and dev server URL matches

**Port already in use** - Change PORT in .env or use different port

## Next Steps

1. Start frontend development server (typically on port 5173)
2. Connect it to this backend (update API endpoints in frontend)
3. Test authentication flow
4. Build out UI features referencing these API endpoints

See README.md for full API documentation.
