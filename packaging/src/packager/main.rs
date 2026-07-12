use std::{fs, path::Path};

use anyhow::{Context, Result, bail};

use crate::{
    config::{CONFIG_SCHEMA_VERSION, PackagingConfig, Target},
    packager::{
        engine::Packager,
        output::{PackageOutput, ReleaseManifest},
        target::HostPlatform,
        verifier::verify_release,
    },
};

pub fn create_release(
    repo_root: &Path,
    config: &PackagingConfig,
    targets: &[Target],
) -> Result<PackageOutput> {
    let versions: std::collections::BTreeSet<_> = targets
        .iter()
        .map(|target| config.app(*target).map(|app| app.version.as_str()))
        .collect::<Result<_>>()?;
    if versions.len() != 1 {
        bail!("all targets in one release must use the same version");
    }
    let version = versions.into_iter().next().expect("targets are non-empty");
    let platform = HostPlatform::current();
    let packager = Packager::new(repo_root.to_path_buf(), &config.packager);
    let release_directory = packager.output_root().join(version).join(format!(
        "{}-{}",
        platform,
        std::env::consts::ARCH
    ));
    prepare_release_directory(&packager.output_root(), &release_directory)?;

    let bundle_root = repo_root.join(&config.bundler.output_directory);
    let mut artifacts = Vec::new();
    for target in targets {
        let app = config.app(*target)?;
        let bundle_directory = bundle_root.join(target.as_str());
        if !bundle_directory.is_dir() {
            bail!(
                "bundle for {target} is missing at {}; run bundle first",
                bundle_directory.display()
            );
        }
        artifacts.extend(packager.package_target(app, &bundle_directory, &release_directory)?);
    }

    let manifest = ReleaseManifest {
        schema: CONFIG_SCHEMA_VERSION,
        product: "Plastiq".to_owned(),
        version: version.to_owned(),
        platform,
        architecture: std::env::consts::ARCH.to_owned(),
        artifacts,
    };
    let manifest_path = release_directory.join("release-manifest.yml");
    fs::write(&manifest_path, serde_yaml::to_string(&manifest)?)
        .with_context(|| format!("failed to write {}", manifest_path.display()))?;
    verify_release(&release_directory, &manifest)?;
    Ok(PackageOutput {
        directory: release_directory,
        manifest_path,
        manifest,
    })
}

fn prepare_release_directory(root: &Path, release: &Path) -> Result<()> {
    fs::create_dir_all(root)?;
    if !release.starts_with(root) || release == root {
        bail!(
            "refusing to clean unmanaged release directory {}",
            release.display()
        );
    }
    if release.exists() {
        fs::remove_dir_all(release)?;
    }
    fs::create_dir_all(release)?;
    Ok(())
}
