# START HERE - Market Street Dashboard Backend

Welcome! This is a complete, production-ready backend for a record label management system.

## In 60 Seconds

```bash
# 1. Install
npm install

# 2. Setup (edit .env with your database first)
cp .env.example .env
npm run seed

# 3. Run
npm run dev

# 4. Test
curl http://localhost:3001/health
```

Server running at `http://localhost:3001`

## What You Get

### Backend Features
- 32 API endpoints (auth, releases, artists, team, contracts, deals, dashboard)
- PostgreSQL database with 7 tables
- JWT authentication
- File upload support (PDF contracts)
- Production-ready code
- Railway deployment ready

### Data Included (After Seed)
- 9 team members (Felipe is admin)
- 15 artists in roster
- 15 upcoming releases
- 10 contracts with renewal tracking
- 12 deals in A&R pipeline
- 20 tasks for team members

### Documentation
- `GETTING_STARTED.md` - Quick start guide (read this first)
- `README.md` - Complete technical reference
- `API_REFERENCE.md` - All 32 endpoints documented
- `SETUP.md` - Detailed installation
- `DEPLOYMENT_CHECKLIST.md` - Deploy to Railway
- `ARCHITECTURE.md` - System design
- `PROJECT_SUMMARY.md` - Feature overview
- `FILES_MANIFEST.md` - File listing

## Login Credentials

**Admin:**
- Email: `john@deanst.co`
- Password: `<PW_JOHN>`

**Team Members:**
- Use password: `password123`
- Emails: jesse@, bradley@, john@, soli@, georgia@, danny@, intern.marketing@, intern.ar@ (all @deanst.co)

## Files Created

```
server/
├── Core Application
│   ├── index.js              # Express server
│   ├── db.js                 # Database connection
│   ├── seed.js               # Database initialization
│   ├── package.json          # Dependencies
│   └── .env.example          # Configuration
│
├── middleware/
│   └── auth.js               # JWT authentication
│
├── routes/ (7 modules)
│   ├── auth.js               # Authentication
│   ├── releases.js           # Release management
│   ├── artists.js            # Artist roster
│   ├── team.js               # Team & tasks
│   ├── contracts.js          # Contract management
│   ├── deals.js              # A&R pipeline
│   └── dashboard.js          # Dashboard stats
│
├── uploads/                  # PDF storage
└── Documentation (8 files)
    ├── 00_START_HERE.md
    ├── GETTING_STARTED.md
    ├── README.md
    ├── API_REFERENCE.md
    ├── SETUP.md
    ├── DEPLOYMENT_CHECKLIST.md
    ├── ARCHITECTURE.md
    ├── PROJECT_SUMMARY.md
    └── FILES_MANIFEST.md
```

## Quick API Examples

### Login
```bash
curl -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"john@deanst.co","password":"<PW_JOHN>"}'
```

### Dashboard Stats
```bash
curl http://localhost:3001/api/dashboard/stats \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### List Releases
```bash
curl "http://localhost:3001/api/releases?month=2026-04" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

See `API_REFERENCE.md` for all 32 endpoints with examples.

## Environment Variables

```
DATABASE_URL      # PostgreSQL connection string (required)
JWT_SECRET        # Secret for JWT signing (required, change in production)
PORT              # Server port (default: 3001)
NODE_ENV          # development or production
FRONTEND_URL      # Frontend domain for CORS (optional)
```

## Next Steps

1. **Read `GETTING_STARTED.md`** for detailed setup
2. **Start local development** with `npm run dev`
3. **Test endpoints** using examples in `API_REFERENCE.md`
4. **Build your frontend** and point to this API
5. **Deploy to Railway** using `DEPLOYMENT_CHECKLIST.md`

## Tech Stack

- Node.js + Express.js
- PostgreSQL with pg library
- JWT authentication (jsonwebtoken)
- Password hashing (bcrypt)
- File uploads (multer)
- CORS configured
- Environment management (dotenv)

## Key Features

- All SQL queries parameterized (SQL injection safe)
- Passwords hashed with bcrypt
- JWT tokens expire in 24 hours
- Consistent JSON response format
- Comprehensive error handling
- Production database SSL support
- Idempotent database seeding
- CORS configured for production

## Common Commands

```bash
npm install         # Install dependencies
npm run dev         # Run with auto-reload (development)
npm start           # Run server (production)
npm run seed        # Initialize/reset database
```

## Support

All endpoints documented in `API_REFERENCE.md` with:
- Request examples
- Response formats
- Query parameters
- Error codes
- Required headers

System architecture explained in `ARCHITECTURE.md` with:
- Data flow diagrams
- Database relationships
- Security practices
- Scaling strategy

## Database

7 tables with relationships:
- **users** - Team members (9 after seed)
- **artists** - Roster (15 after seed)
- **releases** - Albums/EPs (15 after seed)
- **contracts** - Artist agreements (10 after seed)
- **deals** - A&R pipeline (12 after seed)
- **tasks** - Team tasks (20 after seed)
- **activity_log** - Audit trail

All data can be safely deleted and re-seeded anytime.

## Troubleshooting

**Can't connect to database?**
- Check DATABASE_URL in .env
- Ensure PostgreSQL is running

**Seed fails?**
- Safe to re-run: `npm run seed`
- Uses `ON CONFLICT DO NOTHING`

**CORS errors?**
- Update FRONTEND_URL in .env
- Must match your frontend domain

**Port already in use?**
- Change PORT in .env
- Or kill process using 3001

## Ready to Deploy?

See `DEPLOYMENT_CHECKLIST.md` for:
- Railway setup
- Environment variables
- Deployment workflow
- Monitoring & logs
- Rollback plan

## Questions?

Everything is documented:
- **Getting Started**: `GETTING_STARTED.md`
- **API Details**: `API_REFERENCE.md`
- **System Design**: `ARCHITECTURE.md`
- **Installation**: `SETUP.md`
- **Deployment**: `DEPLOYMENT_CHECKLIST.md`

Now go build something amazing!
