// What one call of the function does: ask the database for the alerts that are still worth sending, send each one,
// report back. Everything it touches is passed in, so the tests run it against the real SQL with a stand-in for
// Resend. No state, nothing to undo: whatever is not finished is offered again by the next call.
import { oneLine, render, type Alert } from './email.ts';
import type { Mail, Sent } from './resend.ts';

type Rpc = (name: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;

export interface Deps {
  /** The shared secret the caller sent (the cron job reads it from the database). */
  secret: string | null;
  /** Whether the Resend key is set. Without it nothing is claimed (only the secret and the setup are checked), so no alert uses up a try. */
  configured: boolean;
  rpc: Rpc;
  send(mail: Mail): Promise<Sent>;
}

export interface Outcome {
  status: number;
  body: Record<string, unknown>;
}

/** "Marco Bellini" <avvisi@example.it>: the trainer's name in front of our address, so it reads as theirs. */
export function sender(trainerName: string, address: string): string {
  const name = oneLine(trainerName).split('"').join('').split(String.fromCharCode(92)).join('');
  return `"${name}" <${address}>`;
}

export async function handle(deps: Deps): Promise<Outcome> {
  if (!deps.secret) return { status: 401, body: { error: 'unauthorized' } };

  const claimed = await deps.rpc('claim_notifications', { p_secret: deps.secret, p_limit: deps.configured ? 20 : 0 });
  if (claimed.error) {
    const m = claimed.error.message;
    if (m.includes('NOT_ALLOWED')) return { status: 401, body: { error: 'unauthorized' } };
    if (m.includes('NOT_CONFIGURED')) return { status: 503, body: { error: 'not configured: run app_private.notify_setup() in the database' } };
    console.error('claim_notifications failed:', m);
    return { status: 500, body: { error: 'claim failed' } };
  }
  // the caller is who it says and the database is set up: only the key is missing, so say so, and try nothing
  if (!deps.configured) return { status: 503, body: { error: 'not configured: the Resend key (RESEND_API_KEY) is missing' } };

  const alerts = (Array.isArray(claimed.data) ? claimed.data : []) as Alert[];
  let sent = 0;
  let retry = 0;
  let failed = 0;
  for (const a of alerts) {
    let result: Sent;
    try {
      const r = render(a);
      result = await deps.send({
        from: sender(a.trainer_name, a.from_address),
        to: a.to_email,
        subject: r.subject,
        html: r.html,
        text: r.text,
        replyTo: a.reply_to,
        idempotencyKey: a.id,
      });
    } catch (e) {
      result = { ok: false, retry: true, error: `unexpected: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200) };
    }
    if (result.ok) sent++;
    else if (result.retry) retry++;
    else failed++;
    const done = await deps.rpc('finish_notification', { p_secret: deps.secret, p_id: a.id, p_error: result.ok ? null : result.error, p_retry: result.ok ? true : result.retry });
    if (done.error) console.error('finish_notification failed:', done.error.message);
    if (!result.ok) console.error(`alert ${a.id} not sent (${result.retry ? 'will retry' : 'given up'}): ${result.error}`);
  }
  return { status: 200, body: { claimed: alerts.length, sent, retry, failed } };
}
