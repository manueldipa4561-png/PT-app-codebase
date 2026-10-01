// "Da fare" in the trainer's Today tab: the places that opened for people on the waitlist, the people to remind in the
// next 48 hours (late cancels and no-shows cost the most), the packs about to end, and the clients who went quiet. One tap opens WhatsApp with the message
// already written for that person; the row then shows "Scritto" so nobody is written to twice.
import { useCallback, useState, type ReactNode } from 'react';
import { ArrowsClockwise, Bell, CalendarPlus, Check, CheckCircle, Copy, Hourglass, WhatsappLogo } from '@phosphor-icons/react';
import type { TrainerData } from '../api.ts';
import type { Client } from '../domain.ts';
import { dayWord, openSeats, quietClients, renewals, upcomingReminders, waLink } from '../followups.ts';
import { initials } from '../theme.ts';
import { counted, fmtLongDay, fmtTime, useI18n } from '../i18n.ts';
import { Empty, useApp } from '../ui.tsx';

const DAY = 86_400_000;
const REMINDED_FOR = 2 * DAY; // a reminder is not asked again for the same session
const WRITTEN_FOR = 7 * DAY; // a client written to about a pack or a long absence rests for a week

/** Who was already written to, kept on this device: the keys are booking or client ids with the kind of message. */
function useWritten(trainerId: string) {
  const key = `pt-written:${trainerId}`;
  const [map, setMap] = useState<Record<string, number>>(() => {
    try {
      return JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, number>;
    } catch {
      return {};
    }
  });
  const mark = useCallback(
    (id: string) => {
      setMap((prev) => {
        const next = { ...prev, [id]: Date.now() };
        try {
          localStorage.setItem(key, JSON.stringify(next));
        } catch {
          /* private mode: the row just shows as not written after a reload */
        }
        return next;
      });
    },
    [key],
  );
  return { map, mark };
}

interface RowProps {
  client: Client;
  sub: ReactNode;
  done: boolean;
  label: string;
  onSend(): void;
  noPhone: boolean;
}

function FollowRow({ client, sub, done, label, onSend, noPhone }: RowProps) {
  const { t } = useI18n();
  return (
    <div className={`item follow${done ? ' follow-done' : ''}`}>
      <span className="avatar" aria-hidden>
        {initials(client.name)}
      </span>
      <div className="item-main">
        <div className="item-title">{client.name}</div>
        <div className="item-sub">{sub}</div>
      </div>
      <button className={`follow-send${done ? ' is-done' : ''}`} onClick={onSend} aria-label={`${label}: ${client.name}`}>
        {done ? <Check size={16} weight="bold" aria-hidden /> : noPhone ? <Copy size={16} aria-hidden /> : <WhatsappLogo size={18} weight="fill" aria-hidden />}
        <span>{done ? t('fu.sent') : noPhone ? t('fu.copy') : label}</span>
      </button>
    </div>
  );
}

export function FollowUps({ data }: { data: TrainerData }) {
  const { api, trainer, types, toast } = useApp();
  const { t, lang } = useI18n();
  const { map, mark } = useWritten(trainer.id);
  const now = Date.now();
  const tz = trainer.timezone;
  const typeName = (id: string) => types.find((x) => x.id === id)?.name ?? '';
  const appLink = api.mode === 'demo' ? `${location.origin}/?t=${trainer.slug}` : location.origin;

  const recent = (id: string, within: number) => now - (map[id] ?? 0) < within;
  const byDone = <T extends { id: string; within: number }>(a: T, b: T) => Number(recent(a.id, a.within)) - Number(recent(b.id, b.within));

  async function send(id: string, client: Client, text: string) {
    mark(id);
    if (api.mode === 'demo') return toast(t('fu.demo'));
    const href = waLink(client.phone, text);
    if (href) return void window.open(href, '_blank', 'noopener,noreferrer');
    try {
      await navigator.clipboard.writeText(text);
      toast(t('fu.copied'));
    } catch {
      toast(text); // no clipboard: show it, so it can be copied by hand
    }
  }

  const seats = openSeats(data.waitlist, data.clients, now)
    .map((s) => ({ ...s, id: `seat:${s.entry.id}`, within: WRITTEN_FOR }))
    .sort(byDone); // a stable sort: the ones not written to yet come first, each keeping its place in line
  const reminders = upcomingReminders(data.bookings, data.clients, now)
    .map((r) => ({ ...r, id: `remind:${r.booking.id}`, within: REMINDED_FOR }))
    .sort(byDone);
  const renew = renewals(data.clients, data.ledger)
    .map((r) => ({ ...r, id: `renew:${r.client.id}`, within: WRITTEN_FOR }))
    .sort(byDone);
  const quiet = quietClients(data.clients, data.bookings, data.ledger, now)
    .map((q) => ({ ...q, id: `quiet:${q.client.id}`, within: WRITTEN_FOR }))
    .sort(byDone);

  if (!seats.length && !reminders.length && !renew.length && !quiet.length) {
    return <Empty icon={<CheckCircle size={26} />} title={t('fu.allClear')} body={t('fu.allClearBody')} />;
  }

  const count = (n: number) => <span className="badge follow-count">{n}</span>;
  const away = (days: number) => (days >= 14 ? t('fu.weeks', { n: Math.floor(days / 7) }) : t('fu.days', { n: days }));

  return (
    <div className="stack" style={{ gap: 22 }}>
      {seats.length > 0 && (
        <section>
          <h2 className="section-title follow-title">
            <CalendarPlus size={16} aria-hidden /> {t('fu.seats')} {count(seats.length)}
          </h2>
          <div className="list">
            {seats.map(({ entry, client, id, within }) => {
              const word = dayWord(entry.startsAt, now, tz);
              const day = word ? t(`fu.${word}` as 'fu.today') : fmtLongDay(entry.startsAt, tz, lang);
              const time = fmtTime(entry.startsAt, tz, lang);
              const text = t('fu.seatMsg', { name: client.name.split(/\s+/)[0], when: `${day} ${t('fu.atTime')} ${time}`, link: appLink });
              return (
                <FollowRow
                  key={id}
                  client={client}
                  sub={
                    <>
                      <b className="follow-lead tabular">{time}</b> {day} · {typeName(entry.sessionTypeId)} · {t('wl.place', { n: entry.position })}
                    </>
                  }
                  done={recent(id, within)}
                  label={t('fu.seat')}
                  noPhone={!waLink(client.phone, 'x')}
                  onSend={() => send(id, client, text)}
                />
              );
            })}
          </div>
        </section>
      )}

      {reminders.length > 0 && (
        <section>
          <h2 className="section-title follow-title">
            <Bell size={16} aria-hidden /> {t('fu.reminders')} {count(reminders.length)}
          </h2>
          <div className="list">
            {reminders.map(({ booking, client, id, within }) => {
              const word = dayWord(booking.startsAt, now, tz);
              const day = word ? t(`fu.${word}` as 'fu.today') : fmtLongDay(booking.startsAt, tz, lang);
              const time = fmtTime(booking.startsAt, tz, lang);
              const text = t('fu.remindMsg', {
                name: client.name.split(/\s+/)[0],
                when: `${day} ${t('fu.atTime')} ${time}`,
                place: booking.location ? ` ${t('fu.at')} ${booking.location}` : '',
              });
              return (
                <FollowRow
                  key={id}
                  client={client}
                  sub={
                    <>
                      <b className="follow-lead tabular">{time}</b> {day} · {typeName(booking.sessionTypeId)}
                      {booking.location ? `, ${booking.location}` : ''}
                    </>
                  }
                  done={recent(id, within)}
                  label={t('fu.remind')}
                  noPhone={!waLink(client.phone, 'x')}
                  onSend={() => send(id, client, text)}
                />
              );
            })}
          </div>
        </section>
      )}

      {renew.length > 0 && (
        <section>
          <h2 className="section-title follow-title">
            <ArrowsClockwise size={16} aria-hidden /> {t('fu.renewals')} {count(renew.length)}
          </h2>
          <div className="list">
            {renew.map(({ client, balance, id, within }) => {
              const first = client.name.split(/\s+/)[0];
              const text =
                balance < 0
                  ? t('fu.renewOwedMsg', { name: first, n: counted(t, lang, 'sessions', -balance) })
                  : balance === 0
                    ? t('fu.renew0Msg', { name: first })
                    : balance === 1
                      ? t('fu.renew1Msg', { name: first })
                      : t('fu.renewNMsg', { name: first, n: counted(t, lang, 'sessions', balance) });
              const sub = balance < 0 ? t('fu.owed', { n: counted(t, lang, 'sessions', -balance) }) : balance === 0 ? t('fu.finished') : counted(t, lang, 'left', balance);
              return <FollowRow key={id} client={client} sub={sub} done={recent(id, within)} label={t('fu.write')} noPhone={!waLink(client.phone, 'x')} onSend={() => send(id, client, text)} />;
            })}
          </div>
        </section>
      )}

      {quiet.length > 0 && (
        <section>
          <h2 className="section-title follow-title">
            <Hourglass size={16} aria-hidden /> {t('fu.quiet')} {count(quiet.length)}
          </h2>
          <div className="list">
            {quiet.map(({ client, days, id, within }) => {
              const text = t('fu.quietMsg', { name: client.name.split(/\s+/)[0], away: away(days), link: appLink });
              return (
                <FollowRow
                  key={id}
                  client={client}
                  sub={t('fu.away', { n: away(days) })}
                  done={recent(id, within)}
                  label={t('fu.write')}
                  noPhone={!waLink(client.phone, 'x')}
                  onSend={() => send(id, client, text)}
                />
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
