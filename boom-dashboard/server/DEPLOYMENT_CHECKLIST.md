# Railway Deployment Checklist

## Pre-Deployment

- [ ] All code committed to git
- [ ] `.env` file created locally and tested
- [ ] Database seeded successfully locally: `npm run seed`
- [ ] API tested locally: `npm run dev` and `curl http://localhost:3001/health`
- [ ] Frontend URL known and confirmed

## Railway Setup

- [ ] Create Railway account (railway.app)
- [ ] Create new project
- [ ] Add PostgreSQL plugin to project
- [ ] Connect git repository
- [ ] Railway auto-detects Node.js

## Environment Variables in Railway

Set these in Railway project settings:

```
DATABASE_URL          # Auto-populated by PostgreSQL plugin
JWT_SECRET            # Generate strong random string, e.g., $(openssl rand -base64 32)
PORT                  # Optional, defaults to 3001
NODE_ENV              # production
FRONTEND_URL          # Your production frontend domain
```

### Generating JWT_SECRET

```bash
# macOS/Linux
openssl rand -base64 32

# Or use any strong random generator
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

## Deployment Steps

1. **Push to Git**
   ```bash
   git add .
   git commit -m "Deploy Market Street Dashboard backend"
   git push
   ```

2. **Railway Auto-Build**
   - Railway automatically detects changes
   - Builds with `npm install`
   - Starts with `npm start`
   - Watch deployment progress in Railway dashboard

3. **Verify Build Success**
   - Check Railway logs for errors
   - Should see: "Market Street Dashboard server running on port 3001"

4. **Run Seed Script** (One-time, after first deploy)

   Option A: Via Railway Console
   ```bash
   npm run seed
   ```

   Option B: Add deployment hook in railway.toml
   ```toml
   [build]
   builder = "nixpacks"

   [deploy]
   startCommand = "npm run seed && npm start"
   ```

5. **Test Production API**
   ```bash
   curl https://your-railway-domain/health

   # Login
   curl -X POST https://your-railway-domain/api/auth/login \
     -H "Content-Type: application/json" \
     -d '{"email":"john@deanst.co","password":"<PW_JOHN>"}'
   ```

## Post-Deployment

- [ ] Health check endpoint responds
- [ ] Login works with admin credentials
- [ ] Database has data (check seed ran)
- [ ] CORS headers correct (test from frontend domain)
- [ ] SSL certificate active (HTTPS)
- [ ] Logs show no errors

## Frontend Configuration

Update frontend to use production API:

```javascript
// Example in frontend .env
VITE_API_URL=https://your-railway-domain
```

Or hardcode in API client:
```javascript
const API_URL = process.env.VITE_API_URL || 'https://your-railway-domain';
```

## Monitoring

### View Logs
Railway dashboard → Deployments → Logs

### Common Issues

**Database Connection Failed**
- Verify DATABASE_URL is set in Railway
- Check PostgreSQL plugin is active
- Ensure SSL: { rejectUnauthorized: false } in db.js (already configured)

**JWT Errors**
- Verify JWT_SECRET is set
- Check frontend is sending token correctly: `Authorization: Bearer <token>`

**CORS Errors**
- Verify FRONTEND_URL matches frontend domain exactly
- Check browser console for full error message
- Ensure frontend is making requests to correct domain

**Port Issues**
- Railway auto-assigns port, don't hardcode
- Code reads from PORT env var (already configured)

**Seed Data Not Present**
- Run seed script: `npm run seed` in Railway console
- Verify seed completes successfully
- Check database has users table

### Viewing Production Database

Via Railway console:
```bash
# Connect to PostgreSQL
psql $DATABASE_URL

# Check tables exist
\dt

# Count records
SELECT COUNT(*) FROM users;
SELECT COUNT(*) FROM releases;
```

## Rollback Plan

If deployment fails:
1. Check Railway logs for specific error
2. Revert git commit if code issue
3. Rerun `npm run seed` if data issue
4. Redeploy: `git push` (automatic)

## Scaling

As usage grows:
- PostgreSQL: Auto-scales, upgrade plan if needed
- Node.js: Currently single instance, Railway can add replicas
- File uploads: Consider S3 instead of local `/uploads`

## Security Checklist

- [ ] JWT_SECRET is strong (32+ characters)
- [ ] DATABASE_URL not logged anywhere
- [ ] HTTPS enforced (Railway default)
- [ ] CORS whitelist only includes trusted domains
- [ ] Admin password changed from seed default
- [ ] NODE_ENV set to "production"
- [ ] Error messages don't expose system details
- [ ] File uploads validated (PDF only)

## Maintenance

### Regular Tasks

**Weekly:**
- Monitor disk usage for uploads
- Review error logs

**Monthly:**
- Check contract expiration notifications
- Archive old activity logs (if needed)

**Quarterly:**
- Review and update security settings
- Upgrade dependencies: `npm update`

### Backup

Railway PostgreSQL includes automatic backups. To manually backup:

```bash
# Via Railway console
pg_dump $DATABASE_URL > backup.sql

# Restore
psql $DATABASE_URL < backup.sql
```

## Cost Estimation

Railway pricing (as of 2026):
- PostgreSQL: ~$7/month base
- Node.js instance: ~$5/month
- File storage: Included

Total monthly estimate: ~$12+

## Support

- Railway docs: railway.app/docs
- PostgreSQL docs: postgresql.org/docs
- Node.js docs: nodejs.org/docs
- Contact Railway support if infrastructure issues

## Deployment Summary

```bash
# Full deployment workflow
git add .
git commit -m "Deploy to production"
git push                              # Triggers Railway build
# Wait for Railway build to complete...
# Run in Railway console:
npm run seed                          # Initialize database
# Test:
curl https://your-domain/health      # Should return success
```

**Estimated time:** 5-10 minutes from git push to live API
