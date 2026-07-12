use std::{
    fs::{self, File},
    io,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, bail};
use flate2::{Compression, GzBuilder};
use tar::{Builder as TarBuilder, Header};
use walkdir::WalkDir;

use crate::{
    bundler::verifier::sha256_file,
    config::{AppConfig, PackagerConfig, Target},
};

use super::{
    output::{ArtifactKind, ReleaseArtifact},
    target::is_native_installer,
};

pub struct Packager<'a> {
    repo_root: PathBuf,
    config: &'a PackagerConfig,
}

impl<'a> Packager<'a> {
    pub fn new(repo_root: PathBuf, config: &'a PackagerConfig) -> Self {
        Self { repo_root, config }
    }

    pub fn output_root(&self) -> PathBuf {
        self.repo_root.join(&self.config.output_directory)
    }

    pub fn package_target(
        &self,
        app: &AppConfig,
        bundle_directory: &Path,
        release_directory: &Path,
    ) -> Result<Vec<ReleaseArtifact>> {
        match app.target {
            Target::Desktop => self.copy_native_installers(bundle_directory, release_directory),
            Target::Web => Ok(vec![self.archive_deployment(
                app,
                bundle_directory,
                release_directory,
                ArtifactKind::WebDeployment,
            )?]),
            Target::Services => Ok(vec![self.archive_deployment(
                app,
                bundle_directory,
                release_directory,
                ArtifactKind::ServiceDeployment,
            )?]),
        }
    }

    fn archive_deployment(
        &self,
        app: &AppConfig,
        source: &Path,
        release_directory: &Path,
        kind: ArtifactKind,
    ) -> Result<ReleaseArtifact> {
        let relative = PathBuf::from(format!(
            "{}-{}-{}.tar.gz",
            self.config.archive_prefix, app.name, app.version
        ));
        let destination = release_directory.join(&relative);
        create_tar_gz(source, &destination, "plastiq")?;
        artifact(kind, relative, &destination)
    }

    fn copy_native_installers(
        &self,
        source: &Path,
        release_directory: &Path,
    ) -> Result<Vec<ReleaseArtifact>> {
        let mut artifacts = Vec::new();
        for entry in WalkDir::new(source).sort_by_file_name() {
            let entry = entry?;
            if !entry.file_type().is_file() || !is_native_installer(entry.path()) {
                continue;
            }
            let source_relative = entry.path().strip_prefix(source)?;
            let relative = PathBuf::from("desktop").join(source_relative);
            let destination = release_directory.join(&relative);
            if let Some(parent) = destination.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(entry.path(), &destination).with_context(|| {
                format!("failed to copy native installer {}", entry.path().display())
            })?;
            artifacts.push(artifact(
                ArtifactKind::DesktopInstaller,
                relative,
                &destination,
            )?);
        }
        if artifacts.is_empty() {
            bail!(
                "desktop bundle contains no native wizard installer; run the desktop build on the target operating system"
            );
        }
        Ok(artifacts)
    }
}

fn artifact(kind: ArtifactKind, path: PathBuf, absolute_path: &Path) -> Result<ReleaseArtifact> {
    Ok(ReleaseArtifact {
        kind,
        path,
        bytes: absolute_path.metadata()?.len(),
        sha256: sha256_file(absolute_path)?,
    })
}

fn create_tar_gz(source: &Path, destination: &Path, archive_root: &str) -> Result<()> {
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)?;
    }
    let output = File::create(destination)
        .with_context(|| format!("failed to create archive {}", destination.display()))?;
    let encoder = GzBuilder::new().mtime(0).write(output, Compression::best());
    let mut archive = TarBuilder::new(encoder);

    for entry in WalkDir::new(source).sort_by_file_name() {
        let entry = entry?;
        let relative = entry.path().strip_prefix(source)?;
        if relative.as_os_str().is_empty() {
            continue;
        }
        let archive_path = Path::new(archive_root).join(relative);
        let metadata = entry.metadata()?;
        let mut header = Header::new_gnu();
        header.set_mtime(0);
        header.set_uid(0);
        header.set_gid(0);
        if entry.file_type().is_dir() {
            header.set_entry_type(tar::EntryType::Directory);
            header.set_mode(0o755);
            header.set_size(0);
            header.set_cksum();
            archive.append_data(&mut header, archive_path, io::empty())?;
        } else if entry.file_type().is_file() {
            header.set_mode(file_mode(&metadata));
            header.set_size(metadata.len());
            header.set_cksum();
            archive.append_data(&mut header, archive_path, File::open(entry.path())?)?;
        } else {
            bail!("unsupported entry in bundle: {}", entry.path().display());
        }
    }
    archive.finish()?;
    Ok(())
}

#[cfg(unix)]
fn file_mode(metadata: &fs::Metadata) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    metadata.permissions().mode()
}

#[cfg(not(unix))]
fn file_mode(_metadata: &fs::Metadata) -> u32 {
    0o644
}

#[cfg(test)]
mod tests {
    use std::io::Read;

    use flate2::read::GzDecoder;
    use tempfile::tempdir;

    use super::*;

    #[test]
    fn creates_readable_deployment_archive() {
        let directory = tempdir().unwrap();
        let source = directory.path().join("source");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("index.html"), "plastiq").unwrap();
        let output = directory.path().join("release.tar.gz");

        create_tar_gz(&source, &output, "web").unwrap();

        let decoder = GzDecoder::new(File::open(output).unwrap());
        let mut archive = tar::Archive::new(decoder);
        let mut entry = archive.entries().unwrap().next().unwrap().unwrap();
        let mut value = String::new();
        entry.read_to_string(&mut value).unwrap();
        assert_eq!(value, "plastiq");
    }
}
