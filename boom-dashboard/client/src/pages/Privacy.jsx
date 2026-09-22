export default function Privacy() {
  return (
    <div style={{ maxWidth: 800, margin: '0 auto', padding: '48px 24px', fontFamily: 'system-ui, sans-serif', color: '#333', lineHeight: 1.7 }}>
      <h1 style={{ fontSize: 28, fontWeight: 800, marginBottom: 8 }}>Privacy Policy</h1>
      <p style={{ color: '#888', fontSize: 14, marginBottom: 32 }}>Last updated: April 13, 2026</p>

      <p>market.st ("market.st," "we," "us," or "our") operates the market.st Dashboard application (the "Service"). This Privacy Policy explains how we collect, use, disclose, and safeguard your information when you use our Service.</p>

      <h2 style={{ fontSize: 20, fontWeight: 700, marginTop: 32, marginBottom: 12 }}>1. Information We Collect</h2>
      <p><strong>Account Information:</strong> When you create an account, we collect your name, email address, and role within the organization.</p>
      <p><strong>Financial Data:</strong> The Service processes invoice data, payment records, vendor information, expense tracking, and related financial documents that you upload or enter.</p>
      <p><strong>Third-Party Integrations:</strong> When you connect third-party services (such as QuickBooks, Spotify, or Google), we receive and store authentication tokens and the data necessary to provide the integration features you request.</p>
      <p><strong>Usage Data:</strong> We automatically collect information about how you interact with the Service, including activity logs, IP addresses, and timestamps.</p>

      <h2 style={{ fontSize: 20, fontWeight: 700, marginTop: 32, marginBottom: 12 }}>2. How We Use Your Information</h2>
      <p>We use the information we collect to:</p>
      <ul style={{ paddingLeft: 24 }}>
        <li>Provide, operate, and maintain the Service</li>
        <li>Process invoices, expenses, and financial transactions</li>
        <li>Sync data with connected third-party services (e.g., QuickBooks)</li>
        <li>Send transactional notifications (e.g., payment confirmations)</li>
        <li>Generate reports and analytics for your organization</li>
        <li>Maintain audit logs for accountability and compliance</li>
        <li>Improve and develop new features</li>
      </ul>

      <h2 style={{ fontSize: 20, fontWeight: 700, marginTop: 32, marginBottom: 12 }}>3. Data Sharing</h2>
      <p>We do not sell your personal information. We may share data with:</p>
      <ul style={{ paddingLeft: 24 }}>
        <li><strong>Third-party service providers</strong> that you explicitly connect (e.g., QuickBooks, Spotify, Google) — only the data necessary for the integration</li>
        <li><strong>AI processing services</strong> (Anthropic) for invoice parsing and document analysis — documents are processed but not stored by the AI provider</li>
        <li><strong>Infrastructure providers</strong> (Railway, PostgreSQL hosting) that host the Service</li>
        <li><strong>Legal authorities</strong> if required by law, regulation, or legal process</li>
      </ul>

      <h2 style={{ fontSize: 20, fontWeight: 700, marginTop: 32, marginBottom: 12 }}>4. Data Security</h2>
      <p>We implement industry-standard security measures including:</p>
      <ul style={{ paddingLeft: 24 }}>
        <li>SSL/TLS encryption for all data in transit</li>
        <li>JWT-based authentication with session invalidation</li>
        <li>Parameterized database queries to prevent injection</li>
        <li>Rate limiting on all API endpoints</li>
        <li>Input sanitization and security headers (Helmet)</li>
        <li>Role-based access control</li>
      </ul>
      <p>While we strive to protect your data, no method of transmission over the Internet is 100% secure.</p>

      <h2 style={{ fontSize: 20, fontWeight: 700, marginTop: 32, marginBottom: 12 }}>5. Data Retention</h2>
      <p>We retain your data for as long as your account is active or as needed to provide the Service. Financial records are retained in accordance with applicable tax and accounting regulations. You may request deletion of your account and associated data by contacting us.</p>

      <h2 style={{ fontSize: 20, fontWeight: 700, marginTop: 32, marginBottom: 12 }}>6. Your Rights</h2>
      <p>Depending on your jurisdiction, you may have the right to:</p>
      <ul style={{ paddingLeft: 24 }}>
        <li>Access the personal data we hold about you</li>
        <li>Request correction of inaccurate data</li>
        <li>Request deletion of your data</li>
        <li>Object to or restrict certain processing</li>
        <li>Data portability</li>
      </ul>
      <p>To exercise these rights, contact us at the address below.</p>

      <h2 style={{ fontSize: 20, fontWeight: 700, marginTop: 32, marginBottom: 12 }}>7. Cookies</h2>
      <p>The Service uses localStorage for authentication tokens and user preferences. We do not use third-party tracking cookies.</p>

      <h2 style={{ fontSize: 20, fontWeight: 700, marginTop: 32, marginBottom: 12 }}>8. Changes to This Policy</h2>
      <p>We may update this Privacy Policy from time to time. We will notify users of material changes by updating the "Last updated" date at the top of this page.</p>

      <h2 style={{ fontSize: 20, fontWeight: 700, marginTop: 32, marginBottom: 12 }}>9. Contact Us</h2>
      <p>If you have questions about this Privacy Policy, contact us at:</p>
      <p style={{ marginTop: 8 }}>
        <strong>market.st</strong><br />
        1119 Poinsettia Drive, Unit 01<br />
        Los Angeles, CA 90046-5794<br />
        Email: john@deanst.co
      </p>
    </div>
  )
}
