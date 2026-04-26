pub trait Embedding {
    fn embed(&mut self, texts: Vec<&str>) -> anyhow::Result<Vec<Vec<f32>>>;
}

pub struct TextEmbedding {
    model: fastembed::TextEmbedding,
    batch_size: usize,
}

impl Embedding for TextEmbedding {
    fn embed(&mut self, texts: Vec<&str>) -> anyhow::Result<Vec<Vec<f32>>> {
        let result = self.model.embed(texts, Some(self.batch_size))?;
        Ok(result)
    }
}
