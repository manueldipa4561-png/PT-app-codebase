// Supabase Edge Function (Deno): sends the alerts waiting in the database queue. Called every minute by pg_cron
// (through pg_net) when something is waiting; the call carries a secret that only the database and this function's
// caller know, checked by the database itself. It needs one secret of its own, RESEND_API_KEY (Project Settings >
// Edge Functions > Secrets). Deploy with JWT verification off: the secret is the check.
//   supabase functions deploy notify --no-verify-jwt
import { createClient } from 'npm:@supabase/supabase-js@2';
import { handle } from './handler.ts';
import { sendWithResend } from './resend.ts';

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
  const apiKey = Deno.env.get('RESEND_API_KEY') ?? null;
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const out = await handle({
    secret: req.headers.get('x-notify-secret'),
    configured: apiKey !== null,
    rpc: (name, args) => supabase.rpc(name, args),
    send: (mail) => sendWithResend(fetch, apiKey!, mail),
  });
  return new Response(JSON.stringify(out.body), { status: out.status, headers: { 'Content-Type': 'application/json' } });
});
