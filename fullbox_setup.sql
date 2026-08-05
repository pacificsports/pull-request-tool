-- ═══ Full Box Inventory 테이블 (Supabase SQL Editor에서 1회 실행) ═══
-- 박스 1개 = 레코드 1개. 각 박스에 location이 붙고,
-- 출고하면 status='OUT'으로 바뀌며 어떤 PO로 나갔는지 기록됩니다 (삭제 안 함 → 이력/복원 가능).

create extension if not exists pgcrypto;

create table if not exists public.pr_boxes (
  id      uuid primary key default gen_random_uuid(),
  style   text not null,
  color   text not null,
  size    text not null,
  pcs     int  not null default 72,          -- 박스입수 (한 박스에 몇 장)
  loc     text not null default '',          -- 박스 location (예: A-12)
  status  text not null default 'IN',        -- IN = 재고 · OUT = 출고됨
  note    text not null default '',
  in_at   timestamptz not null default now(),
  in_by   text not null default '',
  out_at  timestamptz,
  out_by  text,
  out_po  text
);

create index if not exists pr_boxes_lookup on public.pr_boxes (status, style, color, size);

alter table public.pr_boxes enable row level security;

-- 로그인한 직원만 접근 (pr_pcroom과 동일한 방식 — 만약 pr_pcroom에 더 엄격한
-- policy를 쓰고 있다면 그거에 맞춰 아래를 바꿔주세요)
drop policy if exists pr_boxes_auth_all on public.pr_boxes;
create policy pr_boxes_auth_all on public.pr_boxes
  for all to authenticated using (true) with check (true);
