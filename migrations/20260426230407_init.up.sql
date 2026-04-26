-- Add up migration script here
create table if not exists topic_collections (
  name text primary key,
);

create table if not exists message (
  id integer primary key autoincrement,
  original_text text not null,
  topic_name text not null references topic_collections(name),
  summary text not null,
  trigger_questions text not null, -- string[]
  location text not null,
);

create table if not exists chunk_segment (
  id integer primary key autoincrement,
  message_id integer not null references message(id),
  segment_text text not null,
  keywords text not null, -- string[]
);

create table if not exists vector_index (
  id integer primary key autoincrement,
  embedding blob not null,
  chunk_segment_id integer not null references chunk_segment(id),
  topic_metadata text not null,
  bm25_keywords text not null, -- string[]
);