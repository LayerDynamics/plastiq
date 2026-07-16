use std::{fs::File, io::Read, path::Path};

use anyhow::{Context, Result, bail};
use sha2::{Digest, Sha256};

use super::output::BundleManifest;

pub fn sha256_file(path: &Path) -> Result<String> {
    let mut file = File::open(path)
        .with_context(|| format!("failed to open {} for hashing", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

pub fn verify_bundle(directory: &Path, manifest: &BundleManifest) -> Result<()> {
    for entry in &manifest.files {
        let path = directory.join(&entry.path);
        let metadata = path
            .metadata()
            .with_context(|| format!("bundled file is missing: {}", path.display()))?;
        if metadata.len() != entry.bytes {
            bail!("bundled file size changed: {}", path.display());
        }
        if sha256_file(&path)? != entry.sha256 {
            bail!("bundled file checksum changed: {}", path.display());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::tempdir;

    use super::*;

    #[test]
    fn sha256_matches_known_value() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("value.txt");
        fs::write(&path, b"plastiq").unwrap();
        assert_eq!(
            sha256_file(&path).unwrap(),
            "84e2affd167c521bf74cad022697b6f12ac53829a3a73e2c3f396f8be3d92e8b"
        );
    }
}
