use std::path::PathBuf;

use anyhow::Result;

use crate::config::{PackagingConfig, Target};

use super::{output::PackageOutput, release::create_release};

pub struct PackageManager<'a> {
    repo_root: PathBuf,
    config: &'a PackagingConfig,
}

impl<'a> PackageManager<'a> {
    pub fn new(repo_root: PathBuf, config: &'a PackagingConfig) -> Self {
        Self { repo_root, config }
    }

    pub fn run(&self, targets: &[Target]) -> Result<PackageOutput> {
        create_release(&self.repo_root, self.config, targets)
    }
}
