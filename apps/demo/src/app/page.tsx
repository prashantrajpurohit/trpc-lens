export default function HomePage() {
  return (
    <main>
      <h1>trpc-lens demo</h1>
      <p>Fake data only. Each page exercises a different way of calling tRPC procedures.</p>
      <ul>
        <li>Server direct: a Server Component calls procedures through a caller (no HTTP).</li>
        <li>Server prefetch: a query is prefetched on the server and hydrated into a client component.</li>
        <li>Client: the browser calls procedures over <code>/api/trpc</code> with batching.</li>
      </ul>
    </main>
  );
}
