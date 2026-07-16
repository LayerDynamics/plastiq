use std::path::{Path, PathBuf};

use anyhow::{Result, bail};

pub fn checked_source(repo_root: &Path, configured: &Path) -> Result<Option<PathBuf>> {
    let source = repo_root.join(configured);
    if !source.exists() {
        return Ok(None);
    }
    let canonical_root = repo_root.canonicalize()?;
    let canonical_source = source.canonicalize()?;
    if !canonical_source.starts_with(&canonical_root) {
        bail!(
            "artifact source escapes repository: {}",
            configured.display()
        );
    }
    Ok(Some(source))
}

pub fn is_excluded(path: &Path, excluded_names: &[String]) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| excluded_names.iter().any(|excluded| excluded == name))
}
