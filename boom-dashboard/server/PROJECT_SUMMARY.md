# Market Street Dashboard - Backend Project Summary

## Project Overview

Complete Node.js/Express backend for a record label management dashboard. Includes authentication, release management, artist roster, team collaboration, contract tracking, and A&R pipeline management.

## Completed Deliverables

### Core Files
- ✅ **package.json** - All dependencies configured (Express, PostgreSQL, JWT, bcrypt, multer, CORS, dotenv)
- ✅ **index.js** - Main server with Express app, middleware, routes, error handling
- ✅ **.env.example** - Environment configuration template
- ✅ **db.js** - PostgreSQL connection pool with Railway SSL support
- ✅ **seed.js** - Database initialization with mock data

### Authentication & Middleware
- ✅ **middleware/auth.js** - JWT verification middleware with token validation

### Routes (7 modules)
- ✅ **routes/auth.js** - Login, register (admin), current user
- ✅ **routes/releases.js** - CRUD + release checklist management
- ✅ **routes/artists.js** - Artist listing, detail, creation
- ✅ **routes/team.js** - Team members, task management
- ✅ **routes/contracts.js** - Contract CRUD + PDF upload + renewal calendar
- ✅ **routes/deals.js** - A&R pipeline with 5 stages
- ✅ **routes/dashboard.js** - Stats, notifications, activity feed

### Database Schema (7 tables)
- ✅ **users** - Team members with auth (9 total after seed)
- ✅ **artists** - Roster with genres (15 artists)
- ✅ **releases** - Albums/EPs with 14-item checklist (15 releases)
- ✅ **tasks** - Team member action items (20 seeded)
- ✅ **contracts** - Artist agreements with terms (10 seeded)
- ✅ **deals** - A&R pipeline entries (12 seeded)
- ✅ **activity_log** - Extensible audit trail

### Documentation
- ✅ **README.md** - Complete technical documentation
- ✅ **SETUP.md** - Quick start guide for local development
- ✅ **API_REFERENCE.md** - Full endpoint documentation with examples
- ✅ **PROJECT_SUMMARY.md** - This file

### Additional Files
- ✅ **.gitignore** - Node/environment files excluded
- ✅ **uploads/.gitkeep** - Directory for contract PDFs

## API Endpoints Summary

### Authentication (3 endpoints)
```
POST   /api/auth/login              - User login with email/password
POST   /api/auth/register           - Create user (admin only)
GET    /api/auth/me                 - Get current user
```

### Releases (5 endpoints)
```
GET    /api/releases                - List with filters (month, artist, search)
GET    /api/releases/:id            - Single release
PUT    /api/releases/:id/checklist  - Update checklist items
POST   /api/releases                - Create release
PUT    /api/releases/:id            - Update release
```

### Artists (3 endpoints)
```
GET    /api/artists                 - List with pagination
GET    /api/artists/:id             - Artist with release history
POST   /api/artists                 - Create artist
```

### Team & Tasks (5 endpoints)
```
GET    /api/team                    - List team members
GET    /api/team/:id/tasks          - User's tasks
POST   /api/tasks                   - Create task
PUT    /api/tasks/:id               - Update task
DELETE /api/tasks/:id               - Delete task
```

### Contracts (6 endpoints)
```
GET    /api/contracts               - List with filters
GET    /api/contracts/:id           - Single contract
POST   /api/contracts               - Create contract
PUT    /api/contracts/:id           - Update contract
GET    /api/contracts/renewals      - Sorted by expiration
POST   /api/contracts/:id/upload    - Upload PDF
```

### Deals (4 endpoints)
```
GET    /api/deals                   - List by stage
POST   /api/deals                   - Create deal
PUT    /api/deals/:id               - Update deal
DELETE /api/deals/:id               - Delete deal
```

### Dashboard (3 endpoints)
```
GET    /api/dashboard/stats         - Overview stats
GET    /api/dashboard/notifications - System alerts
GET    /api/dashboard/activity      - Activity feed
```

**Total: 32 API endpoints**

## Seed Data Included

### Users (9 total)
1. Felipe (Admin, CEO) - john@deanst.co / <PW_JOHN>
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
Distributed across artists with various checklist completion percentages for testing

### Contracts (10)
Various types (Label Deal, Distribution, One-Off, JV, Sync), territories, and expiration dates for testing renewals

### Deals (12)
In different pipeline stages with various AR reps and sources

### Tasks (20)
Assigned to team members with priorities and due dates

## Technology Stack

| Category | Technology |
|----------|-----------|
| Runtime | Node.js 16+ |
| Framework | Express.js 4.18+ |
| Database | PostgreSQL with pg library |
| Authentication | JWT (jsonwebtoken) |
| Passwords | bcrypt |
| File Uploads | multer |
| Environment | dotenv |
| Cross-Origin | cors |

## Database Features

- Parameterized queries (prevents SQL injection)
- Connection pooling
- SSL support for Railway
- Idempotent seeding (safe to run multiple times)
- Timestamps on all tables
- Foreign key relationships
- Unique constraints on critical fields

## Security Features

- JWT-based authentication
- Password hashing with bcrypt (10 rounds)
- Auth middleware on protected routes
- Parameterized SQL queries
- CORS configuration
- Environment variable management
- Error handling without exposing system details

## Response Format

All endpoints return consistent JSON:

**Success:**
```json
{
  "success": true,
  "data": { /* endpoint-specific data */ }
}
```

**Error:**
```json
{
  "success": false,
  "error": "Human-readable error message"
}
```

## Deployment Ready

### Local Development
- Run with `npm run dev` (nodemon auto-reload)
- Seed database with `npm run seed`
- Full CORS support for frontend dev server

### Production (Railway)
- Auto-builds from git
- PostgreSQL database included
- SSL/HTTPS automatic
- Environment variables configured
- Just run seed script once

## File Structure

```
server/
├── index.js                 # Main Express app
├── db.js                    # Database connection
├── package.json             # Dependencies
├── seed.js                  # Database initialization
├── .env.example             # Config template
├── .gitignore               # Git exclusions
├── middleware/
│   └── auth.js              # JWT middleware
├── routes/
│   ├── auth.js              # Authentication
│   ├── releases.js          # Releases CRUD
│   ├── artists.js           # Artists CRUD
│   ├── team.js              # Team & tasks
│   ├── contracts.js         # Contracts + uploads
│   ├── deals.js             # A&R pipeline
│   └── dashboard.js         # Dashboard stats
├── uploads/                 # PDF contract storage
│   └── .gitkeep
└── documentation/
    ├── README.md            # Full technical docs
    ├── SETUP.md             # Quick start
    ├── API_REFERENCE.md     # Endpoint docs
    └── PROJECT_SUMMARY.md   # This file
```

## Quick Start Commands

```bash
# Install and setup
npm install
cp .env.example .env
npm run seed

# Development
npm run dev

# Production
npm start

# Test
curl http://localhost:3001/health
curl -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"john@deanst.co","password":"<PW_JOHN>"}'
```

## Error Handling

All endpoints include try/catch with appropriate HTTP status codes:
- 200/201: Success
- 400: Bad Request (missing fields)
- 401: Unauthorized (no/invalid token)
- 403: Forbidden (insufficient permissions)
- 404: Not Found
- 409: Conflict (duplicate entry)
- 500: Internal Server Error

## Environment Variables

```
DATABASE_URL      # PostgreSQL connection string (required)
JWT_SECRET        # Secret for signing tokens (required, change in production)
PORT              # Server port (default: 3001)
NODE_ENV          # development or production
FRONTEND_URL      # Frontend domain for CORS (optional)
```

## Notes for Frontend Integration

1. **Auth Flow:**
   - POST login endpoint, get token
   - Store token in localStorage/sessionStorage
   - Include in all subsequent requests: `Authorization: Bearer <token>`

2. **Base URL:**
   - Dev: `http://localhost:3001`
   - Prod: Your Railway domain

3. **CORS:**
   - Frontend must be on allowed origin
   - Update FRONTEND_URL env var in production

4. **File Uploads:**
   - Use multipart/form-data for contract PDFs
   - Only PDFs accepted

5. **Pagination:**
   - Default 50 items per page
   - Implement client-side pagination as needed

## Future Enhancement Opportunities

- Email notifications (contract renewals, task reminders)
- Advanced analytics and reporting
- Release calendar with DSP release scheduling
- Contract template management
- Bulk operations (batch release updates)
- Activity timeline with filtering
- S3 integration for contract storage
- Real-time notifications (WebSocket)
- Advanced search and filtering
- Audit logging with user tracking

## Testing Credentials

**Admin:**
- Email: john@deanst.co
- Password: <PW_JOHN>

**Regular Users:**
- All have password: password123
- Emails: jesse@, bradley@, john@, soli@, georgia@, danny@, intern.marketing@, intern.ar@ (all @deanst.co)

## Support & Documentation

- **Setup**: See SETUP.md for installation
- **API**: See API_REFERENCE.md for all endpoints
- **Tech**: See README.md for technical details
- **Code**: Well-commented, consistent structure
