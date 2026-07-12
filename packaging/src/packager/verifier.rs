use std::path::Path;

use anyhow::{Context, Result, bail};

use crate::bundler::verifier::sha256_file;

use super::output::ReleaseManifest;

pub fn verify_release(directory: &Path, manifest: &ReleaseManifest) -> Result<()> {
    if manifest.artifacts.is_empty() {
        bail!("release contains no artifacts");
    }
    for artifact in &manifest.artifacts {
        let path = directory.join(&artifact.path);
        let metadata = path
            .metadata()
            .with_context(|| format!("release artifact is missing: {}", path.display()))?;
        if metadata.len() != artifact.bytes {
            bail!("release artifact size changed: {}", path.display());
        }
        if sha256_file(&path)? != artifact.sha256 {
            bail!("release artifact checksum changed: {}", path.display());
        }
    }
    Ok(())
}
