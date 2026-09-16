# Market Street Dashboard - Backend Files Manifest

## Complete File Listing

### Core Application Files

#### Entry Point & Configuration
- **index.js** (253 lines)
  - Express app initialization
  - Middleware setup (CORS, JSON parser)
  - Route registration
  - Error handling
  - Server startup

- **package.json**
  - Dependencies: express, pg, bcrypt, jsonwebtoken, cors, dotenv, multer
  - Dev dependencies: nodemon
  - Scripts: start, dev, seed

- **.env.example**
  - DATABASE_URL
  - JWT_SECRET
  - PORT
  - NODE_ENV
  - FRONTEND_URL

- **.gitignore**
  - node_modules/
  - .env files
  - uploads/* (except .gitkeep)

#### Database
- **db.js** (16 lines)
  - PostgreSQL Pool setup
  - SSL configuration for Railway
  - Connection pooling

- **seed.js** (320+ lines)
  - Creates all 7 tables with IF NOT EXISTS
  - Seeds admin user (Felipe)
  - Seeds 8 team members
  - Seeds 15 artists
  - Seeds 15 releases with varied completion
  - Seeds 10 contracts with types/territories
  - Seeds 12 A&R pipeline deals
  - Seeds 20 tasks
  - Idempotent (safe to run multiple times)

### Middleware
- **middleware/auth.js** (20 lines)
  - JWT verification middleware
  - Token extraction from Authorization header
  - User data attachment to req.user
  - 401 error responses

### Routes (7 modules, 32 endpoints total)

#### Authentication
- **routes/auth.js** (70+ lines)
  - POST /api/auth/login
  - POST /api/auth/register (admin only)
  - GET /api/auth/me

#### Release Management
- **routes/releases.js** (150+ lines)
  - GET /api/releases (with filters: month, artist, search)
  - GET /api/releases/:id
  - PUT /api/releases/:id/checklist (14-item form)
  - POST /api/releases
  - PUT /api/releases/:id

#### Artist Management
- **routes/artists.js** (90+ lines)
  - GET /api/artists (with pagination)
  - GET /api/artists/:id (with release history)
  - POST /api/artists

#### Team & Tasks
- **routes/team.js** (130+ lines)
  - GET /api/team
  - GET /api/team/:id/tasks
  - POST /api/tasks
  - PUT /api/tasks/:id
  - DELETE /api/tasks/:id

#### Contract Management
- **routes/contracts.js** (180+ lines)
  - GET /api/contracts (with filters)
  - GET /api/contracts/:id
  - POST /api/contracts
  - PUT /api/contracts/:id
  - GET /api/contracts/renewals
  - POST /api/contracts/:id/upload (PDF with multer)

#### Deal Pipeline
- **routes/deals.js** (100+ lines)
  - GET /api/deals (by stage)
  - POST /api/deals
  - PUT /api/deals/:id
  - DELETE /api/deals/:id

#### Dashboard
- **routes/dashboard.js** (100+ lines)
  - GET /api/dashboard/stats
  - GET /api/dashboard/notifications
  - GET /api/dashboard/activity

### File Uploads
- **uploads/.gitkeep**
  - Directory for contract PDFs
  - Served as static files

### Documentation

#### Setup & Deployment
- **README.md** (300+ lines)
  - Complete technical documentation
  - Installation instructions
  - API endpoints summary
  - Database schema
  - Security notes
  - Troubleshooting

- **SETUP.md** (150+ lines)
  - Quick start guide
  - Prerequisites
  - Step-by-step installation
  - Database initialization
  - Testing instructions
  - Troubleshooting

- **DEPLOYMENT_CHECKLIST.md** (200+ lines)
  - Pre-deployment checklist
  - Railway setup steps
  - Environment variables
  - Deployment workflow
  - Post-deployment verification
  - Monitoring & logging
  - Rollback plan
  - Security checklist

#### API Documentation
- **API_REFERENCE.md** (400+ lines)
  - All 32 endpoints documented
  - Request/response examples
  - Query parameters
  - Authentication details
  - Error codes
  - Rate limiting notes
  - Common status codes

#### Architecture & Overview
- **PROJECT_SUMMARY.md** (300+ lines)
  - Project overview
  - Completed deliverables
  - API endpoints summary (32 total)
  - Seed data included
  - Technology stack
  - Database features
  - Quick start commands
  - Future enhancements

- **ARCHITECTURE.md** (400+ lines)
  - System architecture diagram
  - Request flow examples
  - File organization
  - Database models & relationships
  - Error handling strategy
  - Security architecture
  - Performance considerations
  - Deployment architecture
  - Scaling strategy

- **FILES_MANIFEST.md** (this file)
  - Complete file listing
  - File descriptions and line counts
  - Database schema
  - API endpoints summary

## Database Schema Summary

### Tables (7 total)

**users** - Team members with authentication
- id, name, email (UNIQUE), password_hash, role, department, created_at

**artists** - Record label roster
- id, name (UNIQUE), genre, total_releases, created_at

**releases** - Albums/EPs with release checklist
- id, artist_id (FK), project_name, release_date
- 14 boolean checklist fields (yt_video, recoup_added, etc.)
- created_at, updated_at

**tasks** - Team member action items
- id, user_id (FK), description, priority, status, due_date
- created_at, updated_at

**contracts** - Artist agreements and terms
- id, artist_id (FK), type, date_signed, expiration_date, status
- royalty_split, advance, territory, num_releases, notes, file_path
- created_at

**deals** - A&R pipeline entries
- id, artist_name, genre, stage, ar_rep, source, notes, added_date
- created_at, updated_at

**activity_log** - Extensible audit trail
- id, user_id (FK), action, detail, created_at

## Seed Data Summary

### Users (9)
1. Felipe (Admin, CEO)
2. Jesse (COO)
3. Bradley (Ops Manager)
4. John (Ops Coordinator)
5. Soli (VP A&R)
6. Georgia (A&R Coordinator)
7. Danny (Marketing Coordinator)
8. Marketing Intern
9. A&R Intern

### Artists (15)
Logic, Chandler Leighton, Darci, Oxis, Polar Bears, The Midnight, Kavinsky, Lazerhawk, FM-84, Powerglove, Gunship, Carpenter Brut, Perturbator, Dan Terminus, Gost

### Releases (15)
Distributed across artists with release dates in April-June 2026

### Contracts (10)
Types: Label Deal, Distribution, One-Off, JV, Sync
Territories: North America, Worldwide, EMEA, APAC, Latin America

### Deals (12)
Stages: Discovery, Conversation, Evaluation, Negotiation, Ready to Sign
Sources: Direct Pitch, Referral, Conference, Cold Outreach, Management

### Tasks (20)
Various priorities and statuses assigned to team members

## API Endpoints Summary (32 total)

### Authentication (3)
- POST /api/auth/login
- POST /api/auth/register
- GET /api/auth/me

### Releases (5)
- GET /api/releases
- GET /api/releases/:id
- PUT /api/releases/:id/checklist
- POST /api/releases
- PUT /api/releases/:id

### Artists (3)
- GET /api/artists
- GET /api/artists/:id
- POST /api/artists

### Team (5)
- GET /api/team
- GET /api/team/:id/tasks
- POST /api/tasks
- PUT /api/tasks/:id
- DELETE /api/tasks/:id

### Contracts (6)
- GET /api/contracts
- GET /api/contracts/:id
- POST /api/contracts
- PUT /api/contracts/:id
- GET /api/contracts/renewals
- POST /api/contracts/:id/upload

### Deals (4)
- GET /api/deals
- POST /api/deals
- PUT /api/deals/:id
- DELETE /api/deals/:id

### Dashboard (3)
- GET /api/dashboard/stats
- GET /api/dashboard/notifications
- GET /api/dashboard/activity

## File Statistics

- **Total files**: 18
  - JS files: 10 (index, db, seed, middleware, 7 routes)
  - JSON: 1 (package.json)
  - Markdown: 6 (README, SETUP, API_REFERENCE, PROJECT_SUMMARY, ARCHITECTURE, FILES_MANIFEST)
  - Config: 2 (.env.example, .gitignore)
  - Directory: 1 (uploads)

- **Total lines of code**: 1500+
  - Core application: 700+
  - Routes: 800+

- **Total documentation**: 2000+ lines
  - Comprehensive guides and examples

- **Test data**: 9 users, 15 artists, 15 releases, 10 contracts, 12 deals, 20 tasks

## Development Workflow

```bash
# Initial setup
npm install
cp .env.example .env
# Edit .env with your database
npm run seed

# Development
npm run dev
# Server runs on http://localhost:3001

# Production
npm start
```

## Deployment

All files ready for Railway deployment:
- Code structured for Express.js
- Database setup automated with seed.js
- Environment configuration via .env
- CORS configured for production URLs
- SSL/HTTPS ready (Railway handles automatically)

## Next Steps

1. Set up local database and run seed
2. Start development server with `npm run dev`
3. Test API endpoints with provided examples
4. Connect frontend to API base URL
5. Deploy to Railway following checklist
6. Update frontend environment variables

## File Structure
```
server/
├── index.js                          # Main server
├── db.js                             # Database connection
├── seed.js                           # Database initialization
├── package.json                      # Dependencies
├── .env.example                      # Config template
├── .gitignore                        # Git exclusions
├── middleware/
│   └── auth.js                       # JWT middleware
├── routes/
│   ├── auth.js                       # Auth endpoints
│   ├── releases.js                   # Release endpoints
│   ├── artists.js                    # Artist endpoints
│   ├── team.js                       # Team & task endpoints
│   ├── contracts.js                  # Contract endpoints
│   ├── deals.js                      # Deal endpoints
│   └── dashboard.js                  # Dashboard endpoints
├── uploads/
│   └── .gitkeep                      # PDF storage
└── documentation/
    ├── README.md                     # Technical docs
    ├── SETUP.md                      # Quick start
    ├── API_REFERENCE.md              # Endpoint docs
    ├── PROJECT_SUMMARY.md            # Overview
    ├── ARCHITECTURE.md               # System design
    ├── DEPLOYMENT_CHECKLIST.md       # Deploy guide
    └── FILES_MANIFEST.md             # This file
```
