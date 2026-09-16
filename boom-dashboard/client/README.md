# Market Street Admin Dashboard

A professional React-based admin dashboard for managing the Market Street label operations.

## Tech Stack

- **Frontend Framework**: React 18 with Vite
- **Routing**: React Router v6
- **Styling**: Tailwind CSS
- **Charts**: Recharts
- **Icons**: Lucide React
- **HTTP Client**: Axios

## Project Structure

```
src/
├── main.jsx              # Entry point with BrowserRouter
├── App.jsx              # Route definitions and auth guard
├── api.js               # Axios instance with JWT interceptor
├── index.css            # Tailwind CSS imports
├── context/
│   └── AuthContext.jsx  # Authentication state management
├── components/
│   └── Layout.jsx       # Sidebar + main layout
└── pages/
    ├── Login.jsx        # Login form
    ├── Dashboard.jsx    # Overview with stats and charts
    ├── Releases.jsx     # Release pipeline with checklist
    ├── Artists.jsx      # Artist roster
    ├── DealPipeline.jsx # Deal pipeline management
    ├── Team.jsx         # Team management with tasks
    ├── Contracts.jsx    # Contracts vault
    └── Renewals.jsx     # Contract renewal calendar
```

## Features

### Dashboard
- Quick stats cards (artists, releases, team)
- Release pipeline bar chart
- Notifications panel with severity levels
- Recent activity feed

### Release Pipeline
- Search and filter by month
- Expandable 14-item release checklist
- Real-time progress tracking
- Batch operations support

### Artists
- Search and pagination
- Artist detail view with release history
- Genre and release count tracking

### Deal Pipeline
- Kanban-style stage view
- Multiple filter options
- Add/edit/delete deals
- Stage transitions

### Team Management
- Team member cards
- Task assignment and tracking
- Priority levels and due dates
- Task status workflow (To Do → In Progress → Done)
- Overdue task highlighting

### Contracts Vault
- Search by artist name
- Filter by type and status
- Contract detail view
- PDF upload capability
- Key terms display (territory, royalty split, advance)

### Contract Renewals
- Expiration date tracking
- Color-coded status indicators
- Multiple filter views
- Sorted by expiration date

## Development

### Setup

```bash
npm install
npm run dev
```

The dev server runs on `http://localhost:5173`.

### Build

```bash
npm run build
```

Production-ready build outputs to the `dist/` directory.

### Preview Build

```bash
npm run preview
```

## API Integration

All API calls use the axios instance configured in `api.js`:

- **Base URL**: `http://localhost:3001/api`
- **Authentication**: JWT token from localStorage
- **Header**: `Authorization: Bearer <token>`

The backend server should be running on port 3001.

## Styling

The dashboard uses a red and white theme:

- **Primary Color**: Red (red-600, red-900)
- **Background**: Light gray (gray-50)
- **Cards**: White with shadows
- **Sidebar**: Dark red (red-900)

All styling is done with Tailwind CSS utility classes for consistency and easy maintenance.

## Authentication

The auth context manages:

- User login/logout
- Token storage in localStorage
- Automatic token attachment to requests
- User state and profile data

Protected routes redirect unauthenticated users to `/login`.

## Notes

- The dashboard is responsive but primarily optimized for desktop viewing
- Charts use Recharts for data visualization
- Icons come from Lucide React
- The app uses React Router v6 for client-side routing
- All forms include proper validation and error handling
