use serde::Serialize;
use sqlx::prelude::FromRow;

#[derive(Debug, Clone, FromRow)]
pub struct TopicCollection {
    pub name: String,
}

impl TopicCollection {
    pub fn new(name: String) -> Self {
        Self { name }
    }

    pub async fn create<'a, E>(&self, executor: E) -> anyhow::Result<Self>
    where
        E: sqlx::SqliteExecutor<'a>,
    {
        let result = sqlx::query_as::<_, Self>(
            "INSERT INTO topic_collections (name) VALUES ($1) RETURNING name",
        )
        .bind(&self.name)
        .fetch_one(executor)
        .await?;

        Ok(result)
    }

    pub async fn get_by_name<'a, E>(name: &str, executor: E) -> anyhow::Result<Self>
    where
        E: sqlx::SqliteExecutor<'a>,
    {
        let result =
            sqlx::query_as::<_, Self>("SELECT name FROM topic_collections WHERE name = $1")
                .bind(name)
                .fetch_one(executor)
                .await?;

        Ok(result)
    }

    pub async fn list<'a, E>(executor: E) -> anyhow::Result<Vec<Self>>
    where
        E: sqlx::SqliteExecutor<'a>,
    {
        let result = sqlx::query_as::<_, Self>("SELECT name FROM topic_collections")
            .fetch_all(executor)
            .await?;

        Ok(result)
    }

    pub async fn delete_by_name<'a, E>(name: &str, executor: E) -> anyhow::Result<()>
    where
        E: sqlx::SqliteExecutor<'a>,
    {
        sqlx::query("DELETE FROM topic_collections WHERE name = $1")
            .bind(name)
            .execute(executor)
            .await?;
        Ok(())
    }
}

#[derive(Debug, Clone, FromRow, Serialize)]
pub struct Message {
    pub id: i64,
    pub original_text: String,
    pub topic_name: String,
    pub summary: String,
    #[sqlx(json)]
    pub trigger_questions: Vec<String>,
    pub location: String,
}

impl Message {
    pub async fn create<'a, E>(&self, executor: E) -> anyhow::Result<Self>
    where
        E: sqlx::SqliteExecutor<'a>,
    {
        let result = sqlx::query_as::<_, Self>(
            "INSERT INTO messages (original_text, topic_name, summary, trigger_questions, location) VALUES ($1, $2, $3, $4, $5) RETURNING *",
        )
        .bind(&self.original_text)
        .bind(&self.topic_name)
        .bind(&self.summary)
        .bind(&serde_json::to_string(&self.trigger_questions)?)
        .bind(&self.location)
        .fetch_one(executor)
        .await?;

        Ok(result)
    }
}

#[derive(Debug, Clone, FromRow, Serialize)]
pub struct ChunkSegment {
    pub id: i64,
    pub message_id: i64,
    pub segment_text: String,
    #[sqlx(json)]
    pub keywords: Vec<String>,
}

impl ChunkSegment {
    pub async fn create<'a, E>(&self, executor: E) -> anyhow::Result<Self>
    where
        E: sqlx::SqliteExecutor<'a>,
    {
        let result = sqlx::query_as::<_, Self>(
            "INSERT INTO chunk_segments (message_id, segment_text, keywords) VALUES ($1, $2, $3) RETURNING *",
        )
        .bind(self.message_id)
        .bind(&self.segment_text)
        .bind(&serde_json::to_string(&self.keywords)?)
        .fetch_one(executor)
        .await?;

        Ok(result)
    }
}

#[derive(Debug, Clone, FromRow, Serialize)]
pub struct VectorIndex {
    pub id: i64,
    pub embedding: Vec<u8>,
    pub chunk_segment_id: i64,
    pub topic_metadata: String,
    #[sqlx(json)]
    pub bm25_keywords: Vec<String>,
}

impl VectorIndex {
    pub async fn create<'a, E>(&self, executor: E) -> anyhow::Result<Self>
    where
        E: sqlx::SqliteExecutor<'a>,
    {
        let result = sqlx::query_as::<_, Self>(
            "INSERT INTO vector_indices (embedding, chunk_segment_id, topic_metadata, bm25_keywords) VALUES ($1, $2, $3, $4) RETURNING *",
        )
        .bind(&self.embedding)
        .bind(self.chunk_segment_id)
        .bind(&self.topic_metadata)
        .bind(&serde_json::to_string(&self.bm25_keywords)?)
        .fetch_one(executor)
        .await?;

        Ok(result)
    }
}
