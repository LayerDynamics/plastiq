use std::{fs, path::PathBuf};

use anyhow::{Context, Result, bail};
use walkdir::WalkDir;

use crate::config::{AppConfig, BundlerConfig, CONFIG_SCHEMA_VERSION};

use super::{
    output::{BundleManifest, BundleOutput, BundledFile},
    target::{checked_source, is_excluded},
    verifier::{sha256_file, verify_bundle},
};

pub struct Bundler<'a> {
    repo_root: PathBuf,
    config: &'a BundlerConfig,
}

impl<'a> Bundler<'a> {
    pub fn new(repo_root: PathBuf, config: &'a BundlerConfig) -> Self {
        Self { repo_root, config }
    }

    pub fn bundle(&self, app: &AppConfig) -> Result<BundleOutput> {
        let bundle_root = self.repo_root.join(&self.config.output_directory);
        let output_directory = bundle_root.join(app.target.as_str());
        prepare_output_directory(&bundle_root, &output_directory)?;

        for artifact in &app.bundle {
            let Some(source) = checked_source(&self.repo_root, &artifact.source)? else {
                if artifact.required {
                    bail!(
                        "required artifact for {} is missing: {}",
                        app.target,
                        artifact.source.display()
                    );
                }
                continue;
            };
            let destination = output_directory.join(&artifact.destination);
            self.copy_artifact(&source, &destination)?;
        }

        let files = collect_files(&output_directory)?;
        if files.is_empty() {
            bail!("bundle for {} contains no files", app.target);
        }
        let manifest = BundleManifest {
            schema: CONFIG_SCHEMA_VERSION,
            target: app.target,
            files,
        };
        let manifest_path = output_directory.join(".plastiq-bundle.yml");
        fs::write(&manifest_path, serde_yaml::to_string(&manifest)?)
            .with_context(|| format!("failed to write {}", manifest_path.display()))?;
        verify_bundle(&output_directory, &manifest)?;
        Ok(BundleOutput {
            target: app.target,
            directory: output_directory,
            manifest,
        })
    }

    fn copy_artifact(&self, source: &std::path::Path, destination: &std::path::Path) -> Result<()> {
        if source.is_file() {
            if let Some(parent) = destination.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(source, destination).with_context(|| {
                format!(
                    "failed to copy {} to {}",
                    source.display(),
                    destination.display()
                )
            })?;
            return Ok(());
        }

        for entry in WalkDir::new(source)
            .sort_by_file_name()
            .into_iter()
            .filter_entry(|entry| !is_excluded(entry.path(), &self.config.exclude_names))
        {
            let entry = entry?;
            let relative = entry.path().strip_prefix(source)?;
            let output = destination.join(relative);
            if entry.file_type().is_symlink() {
                bail!(
                    "symbolic links are not accepted in bundles: {}",
                    entry.path().display()
                );
            }
            if entry.file_type().is_dir() {
                fs::create_dir_all(&output)?;
            } else if entry.file_type().is_file() {
                if let Some(parent) = output.parent() {
                    fs::create_dir_all(parent)?;
                }
                fs::copy(entry.path(), &output)?;
            }
        }
        Ok(())
    }
}

fn prepare_output_directory(bundle_root: &std::path::Path, output: &std::path::Path) -> Result<()> {
    fs::create_dir_all(bundle_root)?;
    if output.parent() != Some(bundle_root) {
        bail!(
            "refusing to clean unmanaged bundle directory {}",
            output.display()
        );
    }
    if output.exists() {
        fs::remove_dir_all(output)?;
    }
    fs::create_dir_all(output)?;
    Ok(())
}

fn collect_files(directory: &std::path::Path) -> Result<Vec<BundledFile>> {
    let mut files = Vec::new();
    for entry in WalkDir::new(directory).sort_by_file_name() {
        let entry = entry?;
        if entry.file_type().is_file() {
            let path = entry.path();
            files.push(BundledFile {
                path: path.strip_prefix(directory)?.to_path_buf(),
                bytes: path.metadata()?.len(),
                sha256: sha256_file(path)?,
            });
        }
    }
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_to_clean_outside_managed_root() {
        assert!(
            prepare_output_directory(
                std::path::Path::new("/tmp/root"),
                std::path::Path::new("/tmp/other")
            )
            .is_err()
        );
    }
}
