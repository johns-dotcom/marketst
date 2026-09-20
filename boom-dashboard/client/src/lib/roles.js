// The four roles, described from the code that enforces them. Shown on
// Settings › Roles and beside the role picker when adding a person. A role
// is a CAPABILITY tier (what verbs the API allows); which PAGES open is a
// separate axis (permission rows + presets); department only seeds the
// preset tick; hierarchy level only orders task delegation.
export const ROLES = [
  {
    id: 'Superadmin', short: 'Everything, including the label\'s secrets and other admins.',
    who: 'The owner. Keep it to one or two people.',
    pages: 'Reaches every page. Permission rows never bind a Superadmin.',
    can: [
      'Create, edit, remove and sign out Admin and Superadmin accounts, and grant any role',
      'Set page access for Admins',
      'Write the label\'s EIN and bank account number (Settings › Label); everyone else sees them masked',
      'View the app as another person (View as), and send from anyone\'s personal mailbox',
      'Read, create and edit Restricted admin documents',
      'Permanently delete an artist (Admins can only archive)',
      'Download the full archive of the database and files (Settings › Archive)',
    ],
    cannot: ['Demote or delete the last Superadmin — the system refuses so nobody is locked out'],
  },
  {
    id: 'Admin', short: 'Runs the label side of the dashboard and manages people.',
    who: 'Operations leads and whoever administers the team.',
    pages: 'Reaches every page until someone curates their page list; after that, the list is what they get.',
    can: [
      'Add, edit and remove Approvers and Users; send invites; force a sign-out; set their page access',
      'Everything an Approver can do on invoices and payments',
      'Bank statements, bank matching and bank flags (these carry account balances, so Approvers do not see them)',
      'Label settings: the label record, integrations (mail, QuickBooks, DocuSign), Market Street reps',
      'Admin documents (except Restricted), Activity log, Analytics',
      'Archive and merge artists and releases; delete anyone\'s chat message; see everyone\'s tasks',
      'Full TINs in the 1099 export and the deleted-rows ledger',
    ],
    cannot: ['Create or edit another Admin or a Superadmin', 'Write the EIN or bank account number', 'View as another person', 'Read Restricted admin documents'],
  },
  {
    id: 'Approver', short: 'A bookkeeping admin with no say over people or the app.',
    who: 'The bookkeeper or finance lead who approves and pays invoices.',
    pages: 'With no page list: Home, the Money pages, Recoupments and Campaigns. A curated list replaces that.',
    can: [
      'The whole Approvals page: approve, reject, edit, split, vendor aliases and merges',
      'Mark invoices paid and edit payment details; read a vendor\'s bank details and TIN (each read is audited)',
      'See every rep\'s invoices, not just their own',
      'Reports, categories, artist budgets, campaign pay fields, contracts in search',
      'Invoices they enter are approved on the spot instead of waiting',
    ],
    cannot: ['Manage people or settings', 'Bank statements or bank flags', 'Admin documents, Activity, Analytics', 'Delete artists or releases'],
  },
  {
    id: 'User', short: 'Sees only the pages they are granted, and only their own invoices.',
    who: 'Everyone else: A&R, marketing, coordinators.',
    pages: 'Home and Messages by default. Every other page is a grant, usually seeded by the department\'s preset when the account is made.',
    can: [
      'Everything on the pages they are granted, including detail pages under them',
      'Invoices whose rep is theirs, or a rep an admin has shared with them',
      'Enter invoices — they wait in Approvals as pending',
      'Their own settings: profile, sign-in, notifications, mailbox, theme, sidebar',
      'Delete their own messages and their own brand uploads',
    ],
    cannot: ['See another rep\'s invoices unless shared', 'Approve or pay anything', 'Open a page nobody granted'],
  },
]
export const roleById = (id) => ROLES.find((r) => r.id === id) || null
// The three other things people confuse with a role.
export const AXES = [
  ['Role', 'What the API lets you do: approve, pay, delete, administer. Set on the person.'],
  ['Pages', 'Which pages open. Granted per person, seeded by presets; a Superadmin bypasses, an Admin bypasses until curated.'],
  ['Department', 'Picks the default preset when the account is created. Never checked for access.'],
  ['Hierarchy level', 'Orders task delegation (a task to someone senior is a request). Executives are level 1. Also gates permanent release deletes at level 2 or better.'],
]
