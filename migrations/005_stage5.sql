-- Migration 005: Stage 5 duplicate alert protection
--
-- Keep the newest copy if an older install already contains duplicate alerts,
-- then prevent another alert for the same Telegram message and recipient.

with duplicates as (
  select id,
         row_number() over (
           partition by user_id, chat_id, message_id
           order by created_at desc, id desc
         ) as copy_number
  from public.alerts
  where message_id is not null
)
delete from public.alerts a
using duplicates d
where a.id = d.id
  and d.copy_number > 1;

create unique index if not exists alerts_user_chat_message_uidx
  on public.alerts (user_id, chat_id, message_id)
  where message_id is not null;
