use sqlx::prelude::FromRow;

#[derive(Debug, Clone, FromRow)]
pub struct TopicCollection {
    pub name: String,
}

#[derive(Debug, Clone, FromRow)]
pub struct Message {
    pub id: i64,
    pub original_text: String,
    pub topic_name: String,
    pub summary: String,
    #[sqlx(json)]
    pub trigger_questions: Vec<String>,
    pub location: String,
}

#[derive(Debug, Clone, FromRow)]
pub struct ChunkSegment {
    pub id: i64,
    pub message_id: i64,
    pub segment_text: String,
    #[sqlx(json)]
    pub keywords: Vec<String>,
}

#[derive(Debug, Clone, FromRow)]
pub struct VectorIndex {
    pub id: i64,
    pub embedding: Vec<f32>,
    pub chunk_segment_id: i64,
    pub topic_metadata: String,
    #[sqlx(json)]
    pub bm25_keywords: Vec<String>,
}
