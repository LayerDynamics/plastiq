use std::path::PathBuf;

use anyhow::Result;

use crate::config::{PackagingConfig, Target};

use super::{implementation::Builder, output::BuildOutput};

pub struct BuildManager<'a> {
    builder: Builder<'a>,
    config: &'a PackagingConfig,
}

impl<'a> BuildManager<'a> {
    pub fn new(repo_root: PathBuf, config: &'a PackagingConfig) -> Self {
        Self {
            builder: Builder::new(repo_root, &config.builder),
            config,
        }
    }

    pub fn run(&self, targets: &[Target]) -> Result<Vec<BuildOutput>> {
        targets
            .iter()
            .map(|target| self.builder.build(self.config.app(*target)?))
            .collect()
    }
}
