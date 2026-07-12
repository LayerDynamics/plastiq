use std::{collections::BTreeMap, path::PathBuf};

use anyhow::{Context, Result};

use super::{
    AppConfig, BuilderConfig, BundlerConfig, PackagerConfig, PackagingConfig,
    config_parser::parse_yaml, verifier::verify_config,
};

pub struct ConfigManager {
    config_directory: PathBuf,
}

impl ConfigManager {
    pub fn new(config_directory: PathBuf) -> Self {
        Self { config_directory }
    }

    pub fn load(&self) -> Result<PackagingConfig> {
        let app_paths = [
            self.config_directory.join("apps/web.yaml"),
            self.config_directory.join("apps/desktop.yml"),
            self.config_directory.join("apps/services.yml"),
        ];
        let mut apps = BTreeMap::new();
        for path in app_paths {
            let app: AppConfig = parse_yaml(&path)?;
            if apps.insert(app.target, app).is_some() {
                anyhow::bail!("duplicate application target in {}", path.display());
            }
        }

        let tooling = self.config_directory.join("tooling");
        let config = PackagingConfig {
            apps,
            builder: parse_yaml::<BuilderConfig>(&tooling.join("builder.yml"))?,
            bundler: parse_yaml::<BundlerConfig>(&tooling.join("bundler.yml"))?,
            packager: parse_yaml::<PackagerConfig>(&tooling.join("packager.yml"))?,
        };
        verify_config(&config).context("packaging configuration is invalid")?;
        Ok(config)
    }

    pub fn default_directory(repo_root: &std::path::Path) -> PathBuf {
        repo_root.join("packaging/src/config")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_directory_is_repo_relative() {
        assert_eq!(
            ConfigManager::default_directory(std::path::Path::new("/repo")),
            PathBuf::from("/repo/packaging/src/config")
        );
    }
}
