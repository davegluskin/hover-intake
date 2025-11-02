export default function Home() {
  return (
    <main style={{
      fontFamily: 'sans-serif',
      padding: '2rem',
      lineHeight: 1.6,
      maxWidth: '600px'
    }}>
      <h1>Hover Bureau Intake</h1>
      <p>This project is live on Vercel and connected to Supabase.</p>
      <ul>
        <li><a href="/api/health">Health check → /api/health</a></li>
        <li>Form webhook endpoint → <code>/api/intake</code> (POST only)</li>
      </ul>
      <p>If you see this page, everything is deployed correctly.</p>
    </main>
  );
}
