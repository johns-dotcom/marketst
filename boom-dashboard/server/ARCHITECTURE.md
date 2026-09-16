# Backend Architecture Overview

## System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      Frontend (React/Vite)                       │
│                    http://localhost:5173                         │
└─────────────────────────────────────────────────────────────────┘
                                  │
                        HTTP/HTTPS with JWT
                                  │
┌─────────────────────────────────────────────────────────────────┐
│                    Express.js Server (Node)                      │
│                    http://localhost:3001                         │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ CORS Middleware - Allow frontend domains                │   │
│  │ JSON Body Parser - Parse request bodies                 │   │
│  ├──────────────────────────────────────────────────────────┤   │
│  │ Routes                                                   │   │
│  │ • /api/auth/...        - Auth & user management         │   │
│  │ • /api/releases/...    - Release checklist management   │   │
│  │ • /api/artists/...     - Artist roster                  │   │
│  │ • /api/team/...        - Team members & tasks           │   │
│  │ • /api/contracts/...   - Contract management            │   │
│  │ • /api/deals/...       - A&R pipeline                   │   │
│  │ • /api/dashboard/...   - Overview & notifications       │   │
│  ├──────────────────────────────────────────────────────────┤   │
│  │ Auth Middleware - JWT verification                      │   │
│  ├──────────────────────────────────────────────────────────┤   │
│  │ Error Handling - Consistent error responses             │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                                  │
                        PostgreSQL queries
                                  │
┌─────────────────────────────────────────────────────────────────┐
│                    PostgreSQL Database                           │
│                   (Local or Railway)                             │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ Tables                                                   │   │
│  │ • users              - 9 team members with auth         │   │
│  │ • artists            - 15 artists in roster             │   │
│  │ • releases           - 15 upcoming releases             │   │
│  │ • contracts          - 10 artist agreements             │   │
│  │ • deals              - 12 pipeline entries              │   │
│  │ • tasks              - 20 team tasks                    │   │
│  │ • activity_log       - Extensible audit trail           │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

## Request Flow

### Authenticated Request Example: Update Release Checklist

```
1. Frontend sends request:
   PUT /api/releases/1/checklist
   Authorization: Bearer eyJhbGc...
   Content-Type: application/json
   { yt_video: true, stem_pitch: true, ... }

2. Express receives request:
   ├─ CORS Middleware checks origin
   ├─ JSON Parser extracts body
   └─ Router matches /api/releases/:id/checklist

3. Auth Middleware validates JWT:
   ├─ Extracts token from Authorization header
   ├─ Verifies signature with JWT_SECRET
   └─ Attaches decoded user to req.user

4. Route Handler executes:
   ├─ Build UPDATE SQL query with 14 checklist fields
   ├─ Query database via pg connection pool
   ├─ Receive updated release row
   └─ Return { success: true, data: release }

5. Frontend receives response:
   { success: true, data: { id: 1, artist_id: 1, ... } }
```

## File Organization

### Entry Point (index.js)
- Express app initialization
- Middleware setup
- Route registration
- Error handling
- Server start

### Database Layer (db.js)
- PostgreSQL Pool creation
- Connection string from environment
- SSL config for production
- Error handling

### Middleware (middleware/auth.js)
- JWT token extraction from header
- Token verification with JWT_SECRET
- User data attachment to request
- Error responses for invalid tokens

### Routes (routes/*.js)
Each route file handles:
- HTTP method handlers (GET, POST, PUT, DELETE)
- Parameter validation
- Database queries via pg
- Error handling with try/catch
- Consistent JSON responses

Example route structure:
```javascript
router.get('/', authMiddleware, async (req, res) => {
  try {
    // Validate inputs
    // Query database
    // Return success response
  } catch (error) {
    // Log error
    // Return error response
  }
});
```

### Database Access Pattern
All routes use parameterized queries:
```javascript
// CORRECT - prevents SQL injection
await pool.query(
  'SELECT * FROM releases WHERE id = $1',
  [req.params.id]
);

// WRONG - vulnerable to SQL injection
await pool.query(`SELECT * FROM releases WHERE id = ${req.params.id}`);
```

## Authentication Flow

### Login Process
```
1. User submits email/password
2. POST /api/auth/login
3. Server queries users table for email
4. Server compares submitted password with bcrypt hash
5. If match, generate JWT with user data
6. Return token to frontend

JWT payload:
{
  id: 1,
  email: 'john@deanst.co',
  name: 'Felipe',
  role: 'Admin',
  iat: 1234567890,
  exp: 1234567890 + 86400  // 24 hours
}
```

### Protected Request Process
```
1. Frontend includes token: Authorization: Bearer <token>
2. Auth middleware extracts token from header
3. Middleware verifies JWT signature with JWT_SECRET
4. If valid, JWT payload decoded and attached: req.user = payload
5. Route handler can access req.user.id, req.user.role, etc.
6. If invalid, return 401 Unauthorized
```

## Data Models & Relationships

```
users (team members)
  id, name, email, password_hash, role, department, created_at

artists (roster)
  id, name, genre, total_releases, created_at

  ├─ releases (one artist → many releases)
  │   id, artist_id FK, project_name, release_date
  │   yt_video, recoup_added, uploaded, stem_pitch, s4a_pitch
  │   amazon_pitch, pandora, budget, marketing_plan
  │   official_thread, marquee, content, dsp_email, musixmatch
  │   created_at, updated_at
  │
  └─ contracts (one artist → many contracts)
      id, artist_id FK, type, date_signed, expiration_date
      status, royalty_split, advance, territory, num_releases
      notes, file_path, created_at

tasks (assigned to users)
  id, user_id FK, description, priority, status, due_date
  created_at, updated_at

deals (A&R pipeline, not linked to artists until signed)
  id, artist_name, genre, stage, ar_rep, source, notes
  added_date, created_at, updated_at

activity_log (audit trail)
  id, user_id FK, action, detail, created_at
```

## Error Handling Strategy

### Validation Layer
```javascript
if (!email || !password) {
  return res.status(400).json({
    success: false,
    error: 'Email and password required'
  });
}
```

### Database Errors
```javascript
try {
  const result = await pool.query(...);
} catch (error) {
  if (error.code === '23505') {  // Unique constraint
    return res.status(400).json({ error: 'Email already exists' });
  }
  console.error('Database error:', error);
  return res.status(500).json({ error: 'Internal server error' });
}
```

### Auth Errors
```javascript
const decoded = jwt.verify(token, process.env.JWT_SECRET);
// If invalid: throws error → caught by catch block
// Return 401 Unauthorized
```

## Response Format Standards

### Success Response (200/201)
```json
{
  "success": true,
  "data": { /* model or array of models */ }
}
```

### Error Response (4xx/5xx)
```json
{
  "success": false,
  "error": "Human-readable error message"
}
```

### No sensitive info in errors
```javascript
// GOOD
console.error('Database error:', error);
return res.status(500).json({ error: 'Internal server error' });

// BAD - exposes system details
return res.status(500).json({ error: error.message });
```

## Performance Considerations

### Connection Pooling
- pg.Pool manages database connections
- Reuses connections instead of creating new ones
- Configurable pool size for scaling

### Query Optimization
- Foreign key indexes auto-created for constraints
- SELECT queries specify needed columns (not SELECT *)
- LIMIT clauses on list endpoints
- ORDER BY for consistent results

### Caching Opportunities (Future)
- User roles/permissions (minimal change)
- Artist catalog (changes rarely)
- Release calendar (updates once per publish)

## Security Architecture

### Password Security
```
User password → bcrypt hash (10 rounds) → store in database
Login: compare(input, hash) → boolean
```

### Token Security
```
Login success → sign JWT with JWT_SECRET → expires in 24h
Request: verify JWT signature → extract user data
Expired token → 401 Unauthorized → redirect to login
```

### SQL Injection Prevention
All queries use parameterized placeholders:
```javascript
$1, $2, $3, ... instead of string interpolation
```

### CORS Security
Only allow specific origins:
```javascript
['http://localhost:5173', process.env.FRONTEND_URL]
```

### Environment Secrets
- JWT_SECRET never in code
- DATABASE_URL never in code
- Loaded from .env at runtime
- Railway secrets managed separately

## Database Maintenance

### Idempotent Seeding
```sql
INSERT ... ON CONFLICT DO NOTHING
INSERT ... ON CONFLICT (email) DO NOTHING
```
Safe to run multiple times without duplicates.

### Backup Strategy
- Railway PostgreSQL auto-backups
- Manual exports via pg_dump
- Consider scheduled backups for critical data

### Migration Path (if needed)
- Add new column: `ALTER TABLE table ADD COLUMN ...`
- Rename column: `ALTER TABLE table RENAME COLUMN ...`
- Update seed.js for new data structure

## Deployment Architecture

### Local Development
```
.env (local database)
  ↓
npm run dev (nodemon watches files)
  ↓
http://localhost:3001
```

### Production (Railway)
```
GitHub repository
  ↓
Push to main branch
  ↓
Railway webhook triggered
  ↓
Build: npm install
  ↓
Start: npm start
  ↓
https://your-railway-domain.railway.app
  ↓
PostgreSQL (Railway plugin)
```

## Scaling Strategy

### Current Architecture
- Single Node process
- Connection pooling to database
- Can handle moderate load

### Scaling Path
1. **Vertical**: Increase Railway compute tier
2. **Horizontal**:
   - Multiple Node instances (Railway can scale)
   - Load balancer (automatic with Railway)
   - Shared database (already using pool)
3. **Database**:
   - Upgrade PostgreSQL tier
   - Read replicas for heavy queries
   - Migrate to managed service if needed

## Monitoring & Debugging

### Logs
- Railway dashboard shows real-time logs
- console.error/log calls visible
- Useful for debugging in production

### Error Tracking (Future Enhancement)
```javascript
// Example: integrate Sentry
import * as Sentry from "@sentry/node";
Sentry.captureException(error);
```

### Health Checks
```
GET /health
Returns: { success: true, message: 'Server is running' }
Use: Monitoring services, load balancers
```

## API Gateway Pattern (Future)

If frontend needs multiple services:
```
Frontend
  ↓
API Gateway (Express middleware)
  ↓
Auth Service, Release Service, Artist Service, etc.
```

Currently all in one Express app, can be split if needed.

## Summary

This architecture provides:
- Clear separation of concerns (routes, middleware, database)
- Security best practices (JWT, bcrypt, parameterized queries)
- Scalability (connection pooling, modular structure)
- Reliability (error handling, try/catch blocks)
- Maintainability (consistent patterns, documentation)
- Production-ready (Railway deployment, environment config)
