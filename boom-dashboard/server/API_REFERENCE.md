# API Reference

All endpoints return JSON with format: `{ success: true, data: ... }` or `{ success: false, error: "message" }`

**Base URL**: `http://localhost:3001` (or production URL)

**Authentication**: Most endpoints require `Authorization: Bearer <token>` header (except login)

## Authentication Endpoints

### POST /api/auth/login
Login with email and password.

**Request:**
```json
{
  "email": "john@deanst.co",
  "password": "<PW_JOHN>"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "token": "eyJhbGc...",
    "user": {
      "id": 1,
      "name": "Felipe",
      "email": "john@deanst.co",
      "role": "Admin",
      "department": "Executive"
    }
  }
}
```

### POST /api/auth/register
Create a new user (admin only).

**Request:**
```json
{
  "name": "New User",
  "email": "john@deanst.co",
  "password": "secure123",
  "role": "User",
  "department": "Operations"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": 10,
    "name": "New User",
    "email": "john@deanst.co",
    "role": "User",
    "department": "Operations"
  }
}
```

### GET /api/auth/me
Get current authenticated user.

**Response:**
```json
{
  "success": true,
  "data": {
    "id": 1,
    "name": "Felipe",
    "email": "john@deanst.co",
    "role": "Admin",
    "department": "Executive",
    "created_at": "2026-03-30T10:00:00Z"
  }
}
```

## Releases Endpoints

### GET /api/releases
List all releases with optional filters.

**Query Parameters:**
- `month` (optional): Filter by month (format: YYYY-MM)
- `artist` (optional): Filter by artist name (partial match)
- `search` (optional): Search in project name or artist name

**Example:** `GET /api/releases?month=2026-04&search=neon`

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "artist_id": 1,
      "artist_name": "Logic",
      "project_name": "Midnight Thoughts",
      "release_date": "2026-04-10",
      "yt_video": true,
      "recoup_added": false,
      "uploaded": true,
      ... (other checklist items)
      "created_at": "2026-03-30T10:00:00Z",
      "updated_at": "2026-03-30T10:00:00Z"
    }
  ]
}
```

### GET /api/releases/:id
Get single release details.

**Response:** Single release object (same as above)

### PUT /api/releases/:id/checklist
Update release checklist items.

**Request:**
```json
{
  "yt_video": true,
  "recoup_added": true,
  "uploaded": true,
  "stem_pitch": false,
  "s4a_pitch": true,
  "amazon_pitch": true,
  "pandora": false,
  "budget": true,
  "marketing_plan": false,
  "official_thread": true,
  "marquee": false,
  "content": true,
  "dsp_email": true,
  "musixmatch": false
}
```

### POST /api/releases
Create new release.

**Request:**
```json
{
  "artist_id": 1,
  "project_name": "New Album Title",
  "release_date": "2026-07-15"
}
```

### PUT /api/releases/:id
Update release details.

**Request:**
```json
{
  "project_name": "Updated Title",
  "release_date": "2026-07-20"
}
```

## Artists Endpoints

### GET /api/artists
List all artists.

**Query Parameters:**
- `search` (optional): Search by artist name
- `page` (optional): Page number (default: 1)
- `limit` (optional): Results per page (default: 50)

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "name": "Logic",
      "genre": "Hip Hop / Synthwave",
      "total_releases": 2,
      "created_at": "2026-03-30T10:00:00Z"
    }
  ]
}
```

### GET /api/artists/:id
Get artist with release history.

**Response:**
```json
{
  "success": true,
  "data": {
    "id": 1,
    "name": "Logic",
    "genre": "Hip Hop / Synthwave",
    "total_releases": 2,
    "created_at": "2026-03-30T10:00:00Z",
    "releases": [
      {
        "id": 1,
        "project_name": "Midnight Thoughts",
        "release_date": "2026-04-10",
        ... (release data)
      }
    ]
  }
}
```

### POST /api/artists
Create new artist.

**Request:**
```json
{
  "name": "New Artist",
  "genre": "Synthwave"
}
```

## Team Endpoints

### GET /api/team
List all team members.

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "name": "Felipe",
      "email": "john@deanst.co",
      "role": "Admin",
      "department": "Executive",
      "created_at": "2026-03-30T10:00:00Z"
    }
  ]
}
```

### GET /api/team/:id/tasks
Get tasks for a team member.

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "user_id": 1,
      "description": "Follow up on contract negotiations",
      "priority": "High",
      "status": "In Progress",
      "due_date": "2026-04-15",
      "created_at": "2026-03-30T10:00:00Z",
      "updated_at": "2026-03-30T10:00:00Z"
    }
  ]
}
```

### POST /api/tasks
Create task.

**Request:**
```json
{
  "user_id": 1,
  "description": "Review new artist submissions",
  "priority": "Medium",
  "status": "To Do",
  "due_date": "2026-04-20"
}
```

### PUT /api/tasks/:id
Update task.

**Request:**
```json
{
  "status": "Done",
  "priority": "High"
}
```

### DELETE /api/tasks/:id
Delete task. No request body needed.

## Contracts Endpoints

### GET /api/contracts
List contracts with optional filters.

**Query Parameters:**
- `artist`: Filter by artist name
- `type`: Filter by contract type (Label Deal, Distribution, One-Off, JV, Sync)
- `status`: Filter by status

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "artist_id": 1,
      "artist_name": "Logic",
      "type": "Label Deal",
      "date_signed": "2024-01-15",
      "expiration_date": "2027-01-15",
      "status": "Active",
      "royalty_split": "80/20",
      "advance": "$50,000",
      "territory": "North America",
      "num_releases": "3",
      "notes": "Standard terms",
      "file_path": "/uploads/2026-03-30-contract.pdf",
      "created_at": "2026-03-30T10:00:00Z"
    }
  ]
}
```

### GET /api/contracts/:id
Get single contract.

### GET /api/contracts/renewals
Get contracts sorted by expiration date (for renewal calendar).

### POST /api/contracts
Create contract.

**Request:**
```json
{
  "artist_id": 1,
  "type": "Label Deal",
  "date_signed": "2026-01-01",
  "expiration_date": "2029-01-01",
  "status": "Active",
  "royalty_split": "80/20",
  "advance": "$100,000",
  "territory": "Worldwide",
  "num_releases": "5",
  "notes": "Special terms negotiated"
}
```

### PUT /api/contracts/:id
Update contract.

**Request:** Same fields as POST (all optional)

### POST /api/contracts/:id/upload
Upload PDF contract file.

**Content-Type:** multipart/form-data
**Form Field:** `file` (PDF only)

**Example with curl:**
```bash
curl -X POST http://localhost:3001/api/contracts/1/upload \
  -H "Authorization: Bearer TOKEN" \
  -F "file=@contract.pdf"
```

## Deals Endpoints

### GET /api/deals
List deals in pipeline.

**Query Parameters:**
- `stage`: Filter by stage (Discovery, Conversation, Evaluation, Negotiation, Ready to Sign)

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "artist_name": "Emerging Artist 1",
      "genre": "Synthwave",
      "stage": "Conversation",
      "ar_rep": "Soli",
      "source": "Referral",
      "notes": "Great potential, waiting on demo",
      "added_date": "2026-03-15",
      "created_at": "2026-03-30T10:00:00Z",
      "updated_at": "2026-03-30T10:00:00Z"
    }
  ]
}
```

### POST /api/deals
Create deal.

**Request:**
```json
{
  "artist_name": "New Artist",
  "genre": "Synthwave",
  "stage": "Discovery",
  "ar_rep": "Soli",
  "source": "Cold Outreach",
  "notes": "Promising early material"
}
```

### PUT /api/deals/:id
Update deal.

**Request:** Any fields (all optional)

### DELETE /api/deals/:id
Delete deal. No request body needed.

## Dashboard Endpoints

### GET /api/dashboard/stats
Overview statistics.

**Response:**
```json
{
  "success": true,
  "data": {
    "totalArtists": 15,
    "totalReleases": 15,
    "upcomingReleases": 8,
    "teamMembers": 9
  }
}
```

### GET /api/dashboard/notifications
System notifications.

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "type": "low-completion",
      "severity": "warning",
      "message": "Release \"Midnight Thoughts\" is only 45% complete",
      "releaseId": 1
    },
    {
      "type": "expiring-contract",
      "severity": "info",
      "message": "Label Deal contract expiring soon",
      "contractId": 5
    },
    {
      "type": "overdue-tasks",
      "severity": "error",
      "message": "3 overdue task(s)"
    }
  ]
}
```

### GET /api/dashboard/activity
Recent activity feed (last 50 entries).

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "user_id": 1,
      "user_name": "Felipe",
      "action": "updated_release",
      "detail": "Updated checklist for Midnight Thoughts",
      "created_at": "2026-03-30T14:30:00Z"
    }
  ]
}
```

## Error Responses

### 400 Bad Request
```json
{
  "success": false,
  "error": "Artist ID, project name, and release date required"
}
```

### 401 Unauthorized
```json
{
  "success": false,
  "error": "No token provided"
}
```

### 403 Forbidden
```json
{
  "success": false,
  "error": "Only admins can register users"
}
```

### 404 Not Found
```json
{
  "success": false,
  "error": "Release not found"
}
```

### 500 Internal Server Error
```json
{
  "success": false,
  "error": "Internal server error"
}
```

## Rate Limits & Pagination

- Default page limit: 50 items
- Max query results: 250 items
- No rate limiting implemented (add as needed)

## CORS Headers

The server accepts requests from:
- http://localhost:5173 (Vite dev)
- http://localhost:3001 (same domain)
- Value of FRONTEND_URL env var

## Common Status Codes

- 200: OK (GET, PUT, POST successful)
- 201: Created (successful POST)
- 204: No Content (successful DELETE)
- 400: Bad Request
- 401: Unauthorized
- 403: Forbidden
- 404: Not Found
- 409: Conflict (duplicate)
- 500: Server Error
