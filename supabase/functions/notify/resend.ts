// One email through Resend (https://resend.com/docs/api-reference/emails/send-email). `fetch` is passed in so the
// tests can stand in for Resend.

export interface Mail {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo: string | null;
  /** The queue row's id: if a retry sends the same alert again after a timeout, Resend knows it is the same one. */
  idempotencyKey: string;
}

/** Sent, or not: `retry` says whether another try can help (a busy or down service) or not (a bad address). */
export type Sent = { ok: true } | { ok: false; retry: boolean; error: string };

export async function sendWithResend(fetchFn: typeof fetch, apiKey: string, mail: Mail): Promise<Sent> {
  let res: Response;
  try {
    res = await fetchFn('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': mail.idempotencyKey },
      body: JSON.stringify({
        from: mail.from,
        to: [mail.to],
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
        ...(mail.replyTo ? { reply_to: mail.replyTo } : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    return { ok: false, retry: true, error: `network: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200) };
  }
  if (res.ok) return { ok: true };
  const detail = Array.from(await res.text().catch(() => ''), (c) => (c.charCodeAt(0) < 33 ? ' ' : c)).join('').split(' ').filter(Boolean).join(' ').slice(0, 160);
  // A busy service, an outage, a key or a sender not set up yet are worth another try; a rejected address or
  // message will be rejected again.
  const retry = res.status === 401 || res.status === 403 || res.status === 429 || res.status >= 500;
  return { ok: false, retry, error: `resend ${res.status}: ${detail}` };
}
