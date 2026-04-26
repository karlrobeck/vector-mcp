use markdown::{ParseOptions, mdast::Node};

pub trait Parser {
    type Output;
    fn parse(&self) -> anyhow::Result<Self::Output>;
}

pub struct MarkdownParser {
    text: String,
    options: ParseOptions,
}

impl MarkdownParser {
    pub fn new(text: String) -> Self {
        Self {
            text,
            options: ParseOptions::default(),
        }
    }

    pub fn new_with_options(text: String, options: ParseOptions) -> Self {
        Self { text, options }
    }
}

impl Parser for MarkdownParser {
    type Output = Node;

    fn parse(&self) -> anyhow::Result<Self::Output> {
        let result = markdown::to_mdast(&self.text, &self.options).expect("never throws");
        Ok(result)
    }
}
