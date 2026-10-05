create table if not exists public.payment_release_notifications (
  id uuid primary key default gen_random_uuid(),
  payment_transaction_id text not null unique,
  telegram_payment_id text,
  user_id uuid not null,
  order_id text not null,
  trx_id text,
  amount_usd numeric(12, 2) not null default 0,
  diamonds integer not null default 0 check (diamonds >= 0),
  title text not null default 'Payment Released',
  message_text text not null,
  telegram_status text not null default 'pending'
    check (telegram_status in ('pending', 'sent', 'failed')),
  telegram_attempts integer not null default 0
    check (telegram_attempts >= 0),
  telegram_last_error text,
  telegram_last_attempt_at timestamptz,
  telegram_sent_at timestamptz,
  telegram_chat_id text,
  telegram_reply_to_message_id text,
  telegram_message_id text,
  admin_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists payment_release_notifications_telegram_payment_idx
  on public.payment_release_notifications (telegram_payment_id)
  where telegram_payment_id is not null;

create index if not exists payment_release_notifications_created_idx
  on public.payment_release_notifications (created_at desc);

create index if not exists payment_release_notifications_delivery_idx
  on public.payment_release_notifications (telegram_status, created_at desc);

create or replace function public.touch_payment_release_notification_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_payment_release_notifications_updated_at
  on public.payment_release_notifications;

create trigger trg_payment_release_notifications_updated_at
before update on public.payment_release_notifications
for each row
execute function public.touch_payment_release_notification_updated_at();

alter table public.payment_release_notifications enable row level security;
