# Market Street Dashboard - Backend

A comprehensive Node.js/Express backend for managing a record label's operations, including releases, artists, contracts, deals, and team management.

## Tech Stack

- **Runtime**: Node.js
- **Framework**: Express.js
- **Database**: PostgreSQL (pg library - raw SQL queries)
- **Authentication**: JWT (jsonwebtoken)
- **Security**: bcrypt for password hashing
- **File Uploads**: multer
- **Environment**: dotenv

## Installation

1. Install dependencies:
```bash
npm install
```

2. Create a `.env` file based on `.env.example`:
```bash
cp .env.example .env
```

3. Update `.env` with your database URL:
```
DATABASE_URL=postgresql://user:password@localhost:5432/marketst_dashboard
JWT_SECRET=your-super-secret-key-change-in-production
PORT=3001
NODE_ENV=development
FRONTEND_URL=http://localhost:5173
```

## Database Setup

### Local Development

1. Create a PostgreSQL database:
```bash
createdb marketst_dashboard
```

2. Run the seed script to initialize tables and seed data:
```bash
npm run seed
```

This creates:
- All required tables
- Admin user: `john@deanst.co` / `<PW_JOHN>`
- 8 team members with default password `password123`
- 15 artists
- 15 releases with various completion states
- 10 contracts with varying types and expiration dates
- 12 deals in different pipeline stages
- 20 tasks assigned to team members

### Production (Railway)

1. Set the `DATABASE_URL` environment variable in Railway
2. Run the seed script once on deployment:
```bash
npm run seed
```

## Running the Server

### Development
```bash
npm run dev
```
Uses nodemon for auto-reloading on file changes.

### Production
```bash
npm start
```

Server runs on port 3001 (or `PORT` env var)

## API Endpoints

### Authentication
- `POST /api/auth/login` - Login with email/password
- `POST /api/auth/register` - Create new user (admin only)
- `GET /api/auth/me` - Get current user info

### Releases
- `GET /api/releases` - List all releases (filters: ?month=, ?artist=, ?search=)
- `GET /api/releases/:id` - Get single release
- `PUT /api/releases/:id/checklist` - Update release checklist items
- `POST /api/releases` - Create new release
- `PUT /api/releases/:id` - Update release

### Artists
- `GET /api/artists` - List artists (pagination: ?page=, ?limit=)
- `GET /api/artists/:id` - Get artist with release history
- `POST /api/artists` - Create artist

### Team
- `GET /api/team` - List all team members
- `GET /api/team/:id/tasks` - Get tasks for a team member
- `POST /api/tasks` - Create task
- `PUT /api/tasks/:id` - Update task
- `DELETE /api/tasks/:id` - Delete task

### Contracts
- `GET /api/contracts` - List contracts (filters: ?artist=, ?type=, ?status=)
- `GET /api/contracts/:id` - Get single contract
- `POST /api/contracts` - Create contract
- `PUT /api/contracts/:id` - Update contract
- `GET /api/contracts/renewals` - Get contracts sorted by expiration date
- `POST /api/contracts/:id/upload` - Upload PDF contract (multipart/form-data)

### Deals
- `GET /api/deals` - List deals (filter: ?stage=)
- `POST /api/deals` - Create deal
- `PUT /api/deals/:id` - Update deal
- `DELETE /api/deals/:id` - Delete deal

### Dashboard
- `GET /api/dashboard/stats` - Overview statistics
- `GET /api/dashboard/notifications` - System notifications
- `GET /api/dashboard/activity` - Recent activity feed

### Health Check
- `GET /health` - Server status

## Response Format

All endpoints return consistent JSON structure:

Success:
```json
{
  "success": true,
  "data": { ... }
}
```

Error:
```json
{
  "success": false,
  "error": "Error message"
}
```

## Authentication

Most endpoints require a JWT token in the Authorization header:
```
Authorization: Bearer <token>
```

The token is obtained from `/api/auth/login` and is valid for 24 hours.

## Database Schema

### users
User accounts with authentication credentials and role/department info.

### artists
Record label roster with genre and release count.

### releases
Album/EP releases with 14-item checklist tracking:
- yt_video, recoup_added, uploaded
- stem_pitch, s4a_pitch, amazon_pitch
- pandora, budget, marketing_plan
- official_thread, marquee, content
- dsp_email, musixmatch

### tasks
Team member tasks with priority, status, and due dates.

### contracts
Artist contracts with terms, expiration dates, and optional PDF files.

### deals
A&R pipeline deals in various stages (Discovery → Ready to Sign).

### activity_log
Audit trail of user actions (extensible for logging).

## File Uploads

PDF contract files are stored in the `/uploads` directory with timestamped filenames. The file path is saved in the contracts table.

## Error Handling

All routes include try/catch blocks and return appropriate HTTP status codes:
- 400: Bad request (missing required fields)
- 401: Unauthorized (invalid/missing token)
- 403: Forbidden (insufficient permissions)
- 404: Not found
- 409: Conflict (duplicate entry)
- 500: Internal server error

## CORS

The server allows requests from:
- http://localhost:5173 (Vite dev server)
- http://localhost:3001 (self)
- Value of FRONTEND_URL env var (production)

## Security Notes

- All database queries use parameterized queries to prevent SQL injection
- Passwords are hashed with bcrypt (10 salt rounds)
- JWTs are signed with a secret key (change in production)
- The `/uploads` directory should be served securely in production
- HTTPS should be enforced in production (Railway handles this)

## Development Notes

- All routes are protected with authMiddleware except `/api/auth/login` and `/health`
- The seed script uses `ON CONFLICT DO NOTHING` to allow idempotent runs
- Database connection pool handles connection management
- SSL is automatically enabled in production via Railway's DATABASE_URL

## Deployment to Railway

1. Push code to git repository
2. Connect repository to Railway
3. Set environment variables:
   - DATABASE_URL (auto-generated by Railway)
   - JWT_SECRET (generate a strong random string)
   - FRONTEND_URL (your frontend domain)
4. Set start command: `npm start`
5. Run seed script in deployment hook or manually via console

## Troubleshooting

**Connection refused**: Check DATABASE_URL and ensure PostgreSQL is running
**Table doesn't exist**: Run `npm run seed` to initialize database
**JWT errors**: Verify JWT_SECRET matches between .env files
**CORS errors**: Check FRONTEND_URL in env vars and browser console for details
**File upload failures**: Ensure `/uploads` directory is writable

## Future Enhancements

- Activity logging on all data changes
- Pagination for large datasets
- File storage integration (S3, etc.)
- Email notifications for contract renewals
- Advanced search and filtering
- Batch operations for releases
- Report generation (PDF exports)
