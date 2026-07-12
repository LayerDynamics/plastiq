use std::path::PathBuf;

use anyhow::Result;

use crate::config::{PackagingConfig, Target};

use super::{implementation::Bundler, output::BundleOutput};

pub struct BundleManager<'a> {
    bundler: Bundler<'a>,
    config: &'a PackagingConfig,
}

impl<'a> BundleManager<'a> {
    pub fn new(repo_root: PathBuf, config: &'a PackagingConfig) -> Self {
        Self {
            bundler: Bundler::new(repo_root, &config.bundler),
            config,
        }
    }

    pub fn run(&self, targets: &[Target]) -> Result<Vec<BundleOutput>> {
        targets
            .iter()
            .map(|target| self.bundler.bundle(self.config.app(*target)?))
            .collect()
    }
}
