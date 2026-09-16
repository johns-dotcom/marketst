# Getting Started with Market Street Dashboard Backend

## What You Have

A production-ready Node.js/Express backend for a record label management system with:
- 32 API endpoints across 7 modules
- PostgreSQL database with 7 tables
- JWT-based authentication
- Pre-seeded with sample data
- Full documentation

## Quickest Start (5 minutes)

1. **Install dependencies**
```bash
npm install
```

2. **Set up database**
```bash
cp .env.example .env
# Edit .env: set DATABASE_URL to your PostgreSQL connection string
npm run seed
```

3. **Start server**
```bash
npm run dev
```

Server runs on `http://localhost:3001`

4. **Test it**
```bash
curl http://localhost:3001/health
```

## Login & Test

```bash
# Login with admin account
curl -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "john@deanst.co",
    "password": "<PW_JOHN>"
  }'
```

Copy the returned `token` and use it for other requests:
```bash
curl http://localhost:3001/api/dashboard/stats \
  -H "Authorization: Bearer YOUR_TOKEN_HERE"
```

## What's Included

### Core Files (Production Ready)
- `index.js` - Express server
- `db.js` - Database connection
- `seed.js` - Database initialization
- `middleware/auth.js` - JWT authentication
- 7 route modules (auth, releases, artists, team, contracts, deals, dashboard)

### Documentation (Comprehensive)
- `README.md` - Technical overview
- `SETUP.md` - Installation guide
- `API_REFERENCE.md` - All 32 endpoints with examples
- `ARCHITECTURE.md` - System design
- `DEPLOYMENT_CHECKLIST.md` - Railway deployment
- `PROJECT_SUMMARY.md` - Features overview
- `FILES_MANIFEST.md` - File listing

## Next Steps

### For Local Development
1. Install PostgreSQL locally
2. Create database: `createdb marketst_dashboard`
3. Follow "Quickest Start" above
4. Start frontend dev server (usually port 5173)
5. Update frontend API URL to `http://localhost:3001`

### For Deployment
1. Read `DEPLOYMENT_CHECKLIST.md`
2. Connect git repository to Railway
3. Set environment variables
4. Push code (Railway auto-deploys)
5. Run seed script in Railway console

### For Frontend Integration
1. See `API_REFERENCE.md` for all endpoint details
2. Use `http://localhost:3001/api/` as base URL (dev)
3. Include JWT token in `Authorization: Bearer <token>` header
4. Handle 401 responses (token expired)

## Default Test Credentials

**Admin Account:**
- Email: `john@deanst.co`
- Password: `<PW_JOHN>`

**Other Team Members:**
- All use password: `password123`
- Emails: `jesse@`, `bradley@`, `john@`, `soli@`, `georgia@`, `danny@`, `intern.marketing@`, `intern.ar@` (all @deanst.co)

## Database

After running `npm run seed`, you'll have:
- 9 users (team members)
- 15 artists
- 15 releases (with various checklist completion)
- 10 contracts (with renewal dates)
- 12 deals (in pipeline stages)
- 20 tasks (assigned to team members)

All safe to delete and re-seed anytime.

## API Endpoints (32 Total)

| Module | Count | Examples |
|--------|-------|----------|
| Auth | 3 | Login, register, get user |
| Releases | 5 | List, get, checklist, create, update |
| Artists | 3 | List, get with history, create |
| Team | 5 | List, get tasks, create/update/delete tasks |
| Contracts | 6 | CRUD, renewals, PDF upload |
| Deals | 4 | CRUD pipeline entries |
| Dashboard | 3 | Stats, notifications, activity |

See `API_REFERENCE.md` for full documentation with request/response examples.

## Environment Variables

```
DATABASE_URL      # PostgreSQL connection (required)
JWT_SECRET        # Secret for JWT signing (required)
PORT              # Server port (default: 3001)
NODE_ENV          # development or production
FRONTEND_URL      # Frontend domain (for CORS)
```

## Troubleshooting

### "connect ECONNREFUSED"
PostgreSQL not running. Start it:
```bash
# macOS
brew services start postgresql

# Linux
sudo systemctl start postgresql
```

### "database does not exist"
Create and seed:
```bash
createdb marketst_dashboard
npm run seed
```

### "duplicate key value" errors
Safe to re-run seed (uses `ON CONFLICT DO NOTHING`):
```bash
npm run seed
```

### CORS errors
Check `FRONTEND_URL` in `.env` matches your frontend domain.

### Token/auth errors
Make sure you're sending JWT token in header:
```
Authorization: Bearer <token>
```

## File Structure

```
.
├── index.js                 # Server entry point
├── db.js                    # Database connection
├── seed.js                  # Database initialization
├── package.json             # Dependencies
├── .env.example             # Config template
├── middleware/
│   └── auth.js              # JWT middleware
├── routes/                  # 7 API route modules
│   ├── auth.js
│   ├── releases.js
│   ├── artists.js
│   ├── team.js
│   ├── contracts.js
│   ├── deals.js
│   └── dashboard.js
├── uploads/                 # Contract PDFs
└── [documentation]
    ├── README.md
    ├── SETUP.md
    ├── API_REFERENCE.md
    ├── ARCHITECTURE.md
    ├── DEPLOYMENT_CHECKLIST.md
    ├── PROJECT_SUMMARY.md
    └── FILES_MANIFEST.md
```

## Tech Stack

- Node.js 16+
- Express 4.18+
- PostgreSQL 12+
- JWT (jsonwebtoken)
- bcrypt (password hashing)
- Multer (file uploads)
- CORS (cross-origin)

## Performance & Security

- Parameterized SQL queries (no injection risk)
- Password hashing with bcrypt (10 rounds)
- JWT token expiration (24 hours)
- CORS whitelist
- Error handling without exposing internals
- Connection pooling for database
- Railway SSL/HTTPS ready

## Scaling

Currently handles small to medium workloads. To scale:
1. Railway compute tier upgrade
2. PostgreSQL plan upgrade
3. Add caching (Redis)
4. Consider microservices (separate auth, releases, etc.)

## Support

- **Installation**: See `SETUP.md`
- **API**: See `API_REFERENCE.md`
- **Deployment**: See `DEPLOYMENT_CHECKLIST.md`
- **Architecture**: See `ARCHITECTURE.md`
- **Overview**: See `PROJECT_SUMMARY.md`

## What's Next?

After getting the backend running:

1. **Set up frontend** (React/Vite recommended)
2. **Connect to API** using endpoints in `API_REFERENCE.md`
3. **Test workflows** with provided credentials
4. **Customize** seed data or database schema as needed
5. **Deploy** to Railway following checklist

Everything is documented and ready for production use!
