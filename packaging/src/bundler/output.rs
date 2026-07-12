use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::config::Target;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BundledFile {
    pub path: PathBuf,
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BundleManifest {
    pub schema: u32,
    pub target: Target,
    pub files: Vec<BundledFile>,
}

#[derive(Debug)]
pub struct BundleOutput {
    pub target: Target,
    pub directory: PathBuf,
    pub manifest: BundleManifest,
}
