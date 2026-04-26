-- Add down migration script here
drop table if exists vector_index;
drop table if exists chunk_segment;
drop table if exists message;
drop table if exists topic_collections;